-- F22: SSE frames of the turn in progress, so a reloaded page can resume the stream. Deleted 10 minutes after the turn ends.
CREATE TABLE IF NOT EXISTS public.assistant_stream_chunks (
  turn_id uuid NOT NULL REFERENCES public.assistant_turns(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 0),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  data text NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 262144),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (turn_id, seq)
);
ALTER TABLE public.assistant_stream_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.assistant_stream_chunks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.assistant_stream_chunks TO authenticated;
GRANT ALL ON public.assistant_stream_chunks TO service_role;
DROP POLICY IF EXISTS assistant_stream_chunks_read ON public.assistant_stream_chunks;
CREATE POLICY assistant_stream_chunks_read ON public.assistant_stream_chunks FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key) AND EXISTS (
    SELECT 1 FROM public.assistant_turns t WHERE t.id = turn_id AND t.user_id = (SELECT auth.uid())));
CREATE OR REPLACE FUNCTION public.prune_assistant_stream_chunks(p_finished_before timestamptz, p_limit integer DEFAULT 5000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (
    SELECT c.turn_id, c.seq FROM assistant_stream_chunks c JOIN assistant_turns t ON t.id = c.turn_id
     WHERE t.finished_at IS NOT NULL AND t.finished_at < p_finished_before LIMIT p_limit)
  DELETE FROM assistant_stream_chunks c USING old WHERE c.turn_id = old.turn_id AND c.seq = old.seq;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.prune_assistant_stream_chunks(timestamptz,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_assistant_stream_chunks(timestamptz,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
