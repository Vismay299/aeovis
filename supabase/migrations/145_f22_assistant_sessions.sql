-- F22: assistant sessions, messages and turns. Customer content; private to the session's user.
CREATE TABLE IF NOT EXISTS public.assistant_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New chat' CHECK (char_length(title) BETWEEN 1 AND 80),
  summary text CHECK (summary IS NULL OR char_length(summary) <= 24000),
  compacted_through_seq bigint CHECK (compacted_through_seq IS NULL OR compacted_through_seq > 0),
  kickoff jsonb CHECK (kickoff IS NULL OR (jsonb_typeof(kickoff) = 'object' AND pg_column_size(kickoff) < 8192)),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((summary IS NULL) = (compacted_through_seq IS NULL))
);
COMMENT ON COLUMN public.assistant_sessions.summary IS 'Compaction summary of messages with seq <= compacted_through_seq; sent to the model instead of them.';
COMMENT ON COLUMN public.assistant_sessions.kickoff IS 'First message the assistant page sends automatically, e.g. {"kind":"generate_report","templateId":"…"} (F23). Cleared when consumed.';
CREATE INDEX IF NOT EXISTS assistant_sessions_list_idx
  ON public.assistant_sessions (brand_key, user_id, updated_at DESC, id DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS assistant_sessions_updated_idx ON public.assistant_sessions (updated_at);
DROP TRIGGER IF EXISTS assistant_sessions_touch ON public.assistant_sessions;
CREATE TRIGGER assistant_sessions_touch BEFORE UPDATE ON public.assistant_sessions
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.assistant_messages (
  session_id uuid NOT NULL REFERENCES public.assistant_sessions(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  parts jsonb NOT NULL CHECK (jsonb_typeof(parts) = 'array' AND pg_column_size(parts) < 1048576),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) < 16384),
  turn_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id)
);
COMMENT ON COLUMN public.assistant_messages.parts IS 'AI SDK UIMessage parts. Tool outputs are the F22 envelope (§6.2.4), already capped.';
CREATE UNIQUE INDEX IF NOT EXISTS assistant_messages_order_idx ON public.assistant_messages (session_id, seq);

CREATE TABLE IF NOT EXISTS public.assistant_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.assistant_sessions(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'streaming' CHECK (status IN ('streaming','completed','stopped','error','interrupted')),
  stop_reason text CHECK (stop_reason IS NULL OR stop_reason IN
    ('finished','awaiting_approval','step_limit','turn_cap','deadline','user_stop','rewound','error','interrupted')),
  user_message_id text,
  assistant_message_id text,
  model text CHECK (model IS NULL OR char_length(model) <= 200),
  steps integer NOT NULL DEFAULT 0 CHECK (steps >= 0),
  tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_usd numeric(12,6) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  cost_known boolean NOT NULL DEFAULT false,
  compacted boolean NOT NULL DEFAULT false,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,64}$'),
  cancel_requested_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status = 'streaming') = (finished_at IS NULL))
);
COMMENT ON COLUMN public.assistant_turns.cost_known IS 'true only when every step reported a cost; cost_usd NULL means unknown, never zero.';
CREATE UNIQUE INDEX IF NOT EXISTS assistant_turns_one_streaming_idx ON public.assistant_turns (session_id) WHERE status = 'streaming';
CREATE INDEX IF NOT EXISTS assistant_turns_user_idx ON public.assistant_turns (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS assistant_turns_brand_idx ON public.assistant_turns (brand_key, started_at DESC);
CREATE INDEX IF NOT EXISTS assistant_turns_heartbeat_idx ON public.assistant_turns (heartbeat_at) WHERE status = 'streaming';

-- Start a turn: interrupt a stale streaming turn first, then insert. Raises 'turn_in_progress' on a live one.
CREATE OR REPLACE FUNCTION public.begin_assistant_turn(p_session uuid, p_brand text, p_user uuid, p_stale_seconds integer DEFAULT 90)
RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM 1 FROM assistant_sessions WHERE id = p_session AND brand_key = p_brand AND user_id = p_user AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;
  UPDATE assistant_turns SET status = 'interrupted', stop_reason = 'interrupted', finished_at = now()
   WHERE session_id = p_session AND status = 'streaming' AND heartbeat_at < now() - make_interval(secs => p_stale_seconds);
  BEGIN
    INSERT INTO assistant_turns (session_id, brand_key, user_id) VALUES (p_session, p_brand, p_user) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'turn_in_progress';
  END;
  RETURN v_id;
END $$;

-- Rewind: delete a message and everything after it. Returns the number of messages deleted.
CREATE OR REPLACE FUNCTION public.rewind_assistant_session(p_session uuid, p_user uuid, p_message_id text)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_seq bigint; v_at timestamptz; v_count integer;
BEGIN
  PERFORM 1 FROM assistant_sessions WHERE id = p_session AND user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;
  SELECT seq, created_at INTO v_seq, v_at FROM assistant_messages WHERE session_id = p_session AND id = p_message_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'message_not_found'; END IF;
  DELETE FROM assistant_messages WHERE session_id = p_session AND seq >= v_seq;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE assistant_sessions SET summary = NULL, compacted_through_seq = NULL
   WHERE id = p_session AND compacted_through_seq >= v_seq;
  IF to_regclass('public.assistant_approvals') IS NOT NULL THEN
    EXECUTE 'UPDATE assistant_approvals SET status = ''expired'' WHERE session_id = $1 AND status = ''pending'' AND created_at >= $2'
      USING p_session, v_at;
  END IF;
  UPDATE assistant_sessions SET updated_at = now() WHERE id = p_session;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION public.prune_assistant_sessions(p_before timestamptz, p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (SELECT id FROM assistant_sessions WHERE updated_at < p_before ORDER BY updated_at LIMIT p_limit)
  DELETE FROM assistant_sessions s USING old WHERE s.id = old.id;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;

ALTER TABLE public.assistant_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_turns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.assistant_sessions, public.assistant_messages, public.assistant_turns FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.assistant_sessions, public.assistant_messages, public.assistant_turns TO authenticated;
GRANT ALL ON public.assistant_sessions, public.assistant_messages, public.assistant_turns TO service_role;
DROP POLICY IF EXISTS assistant_sessions_read ON public.assistant_sessions;
CREATE POLICY assistant_sessions_read ON public.assistant_sessions FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key) AND user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS assistant_turns_read ON public.assistant_turns;
CREATE POLICY assistant_turns_read ON public.assistant_turns FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key) AND user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS assistant_messages_read ON public.assistant_messages;
CREATE POLICY assistant_messages_read ON public.assistant_messages FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key) AND EXISTS (
    SELECT 1 FROM public.assistant_sessions s WHERE s.id = session_id AND s.user_id = (SELECT auth.uid())));
REVOKE ALL ON FUNCTION public.begin_assistant_turn(uuid,text,uuid,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rewind_assistant_session(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_assistant_sessions(timestamptz,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_assistant_turn(uuid,text,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rewind_assistant_session(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_assistant_sessions(timestamptz,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
