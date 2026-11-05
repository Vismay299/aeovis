-- F09: approved maxima for paid runs. Additive; P0 functions untouched.
ALTER TABLE public.scan_jobs ADD COLUMN IF NOT EXISTS approved_max_usd numeric(12,6)
  CHECK (approved_max_usd IS NULL OR approved_max_usd > 0);
ALTER TABLE public.scan_jobs ADD COLUMN IF NOT EXISTS price_quote jsonb
  CHECK (price_quote IS NULL OR pg_column_size(price_quote) < 16384);
COMMENT ON COLUMN public.scan_jobs.approved_max_usd IS 'Customer-approved maximum; becomes p_scan_cap (min with SCAN_MAX_COST_PER_SCAN).';

CREATE TABLE IF NOT EXISTS public.price_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  approved_max_usd numeric(12,6) NOT NULL CHECK (approved_max_usd > 0),
  quoted_usd numeric(12,6) NOT NULL CHECK (quoted_usd >= 0),
  source text NOT NULL CHECK (source IN ('dialog','implicit','schedule')),
  quote jsonb NOT NULL CHECK (pg_column_size(quote) < 16384),
  price_version text NOT NULL,
  subject_kind text CHECK (subject_kind IS NULL OR subject_kind ~ '^[a-z_]+$'),
  subject_id text,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_approvals_brand_idx ON public.price_approvals (brand_key, created_at DESC);
CREATE INDEX IF NOT EXISTS price_approvals_subject_idx ON public.price_approvals (subject_kind, subject_id)
  WHERE subject_kind IS NOT NULL;
ALTER TABLE public.price_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.price_approvals FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.price_approvals TO service_role;
GRANT SELECT ON public.price_approvals TO authenticated;
DROP POLICY IF EXISTS price_approvals_read ON public.price_approvals;
CREATE POLICY price_approvals_read ON public.price_approvals FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));

CREATE OR REPLACE FUNCTION public.prune_price_approvals(p_before timestamptz, p_limit integer DEFAULT 5000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (SELECT id FROM price_approvals WHERE created_at < p_before ORDER BY created_at LIMIT p_limit)
  DELETE FROM price_approvals p USING old WHERE p.id = old.id;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.prune_price_approvals(timestamptz,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_price_approvals(timestamptz,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
