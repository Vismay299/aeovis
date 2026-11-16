-- F22: human approvals for paid or external tool calls requested by the assistant.
CREATE TABLE IF NOT EXISTS public.assistant_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.assistant_sessions(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES public.assistant_turns(id) ON DELETE SET NULL,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tool_name text NOT NULL CHECK (tool_name ~ '^[a-z][a-z0-9_]{2,63}$'),
  tool_call_id text NOT NULL CHECK (char_length(tool_call_id) BETWEEN 1 AND 128),
  kind text NOT NULL CHECK (kind IN ('price','confirm')),
  priced_action text CHECK (priced_action IS NULL OR priced_action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object' AND pg_column_size(input) < 65536),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  quote_input jsonb CHECK (quote_input IS NULL OR pg_column_size(quote_input) < 65536),
  quote jsonb CHECK (quote IS NULL OR pg_column_size(quote) < 16384),
  quoted_usd numeric(12,6) CHECK (quoted_usd IS NULL OR quoted_usd >= 0),
  approved_max_usd numeric(12,6) CHECK (approved_max_usd IS NULL OR approved_max_usd > 0),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','executed','failed','declined','expired')),
  result jsonb CHECK (result IS NULL OR pg_column_size(result) < 131072),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,64}$'),
  decided_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'price') = (priced_action IS NOT NULL)),
  CHECK (kind = 'confirm' OR quote IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_approvals_call_idx ON public.assistant_approvals (session_id, tool_call_id);
CREATE INDEX IF NOT EXISTS assistant_approvals_pending_idx ON public.assistant_approvals (expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS assistant_approvals_running_idx ON public.assistant_approvals (decided_at) WHERE status = 'running';

-- Atomic pending → running. Raises approval_not_found | approval_expired | approval_not_pending.
CREATE OR REPLACE FUNCTION public.claim_assistant_approval(p_id uuid, p_user uuid, p_brand text, p_max numeric)
RETURNS public.assistant_approvals LANGUAGE plpgsql SET search_path = public AS $$
DECLARE a assistant_approvals;
BEGIN
  UPDATE assistant_approvals SET status = 'running', decided_at = now(), approved_max_usd = p_max
   WHERE id = p_id AND user_id = p_user AND brand_key = p_brand AND status = 'pending' AND expires_at > now()
  RETURNING * INTO a;
  IF FOUND THEN RETURN a; END IF;
  SELECT * INTO a FROM assistant_approvals WHERE id = p_id AND user_id = p_user AND brand_key = p_brand;
  IF NOT FOUND THEN RAISE EXCEPTION 'approval_not_found'; END IF;
  IF a.status = 'pending' THEN
    UPDATE assistant_approvals SET status = 'expired' WHERE id = p_id;
    RAISE EXCEPTION 'approval_expired';
  END IF;
  RAISE EXCEPTION 'approval_not_pending';
END $$;

-- Maintenance: expire pending past expiry; fail running rows stuck for 10 minutes.
CREATE OR REPLACE FUNCTION public.expire_assistant_approvals(p_now timestamptz DEFAULT now(), p_limit integer DEFAULT 1000)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_exp integer; v_fail integer;
BEGIN
  WITH x AS (SELECT id FROM assistant_approvals WHERE status = 'pending' AND expires_at <= p_now LIMIT p_limit)
  UPDATE assistant_approvals a SET status = 'expired' FROM x WHERE a.id = x.id;
  GET DIAGNOSTICS v_exp = ROW_COUNT;
  WITH y AS (SELECT id FROM assistant_approvals WHERE status = 'running' AND decided_at < p_now - interval '10 minutes' LIMIT p_limit)
  UPDATE assistant_approvals a SET status = 'failed', error_code = 'interrupted', finished_at = p_now FROM y WHERE a.id = y.id;
  GET DIAGNOSTICS v_fail = ROW_COUNT;
  RETURN jsonb_build_object('expired', v_exp, 'failed', v_fail);
END $$;

ALTER TABLE public.assistant_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.assistant_approvals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.assistant_approvals TO authenticated;
GRANT ALL ON public.assistant_approvals TO service_role;
DROP POLICY IF EXISTS assistant_approvals_read ON public.assistant_approvals;
CREATE POLICY assistant_approvals_read ON public.assistant_approvals FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key) AND user_id = (SELECT auth.uid()));
REVOKE ALL ON FUNCTION public.claim_assistant_approval(uuid,uuid,text,numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_assistant_approvals(timestamptz,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_assistant_approval(uuid,uuid,text,numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_assistant_approvals(timestamptz,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
