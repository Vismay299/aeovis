-- F22: cross-spec compatibility for F25's email milestone query.
--
-- F25 migration 161's `email_milestone_candidates` reads
-- `assistant_turns.created_at`, while F22 §6.1 names the turn start
-- `started_at`. Migrations run in filename order, so a replacement function in
-- the F22 range (145-149) would be overwritten by 161's `CREATE OR REPLACE`.
-- Instead, mirror the value under the name F25 already reads. 145 stays
-- verbatim; 161 stays untouched; both features work.
ALTER TABLE public.assistant_turns
  ADD COLUMN IF NOT EXISTS created_at timestamptz GENERATED ALWAYS AS (started_at) STORED;
COMMENT ON COLUMN public.assistant_turns.created_at IS 'Generated mirror of started_at for F25 email_milestone_candidates; do not write.';
NOTIFY pgrst, 'reload schema';
