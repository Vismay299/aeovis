-- FIXTURE for src/lib/migrationsRunner.test.mjs (R6.2.6). Not a real migration:
-- it is never in supabase/migrations, it is copied into a sandbox migrations
-- directory by the test and executed against the stubbed `pg` client only.
--
-- Where it came from: supabase/migrations/021_prompt_results_evidence.sql, as
-- the R1.5.2 implementer first wrote it. Its header documented the applied-check
-- an operator should run by hand, and that check is the catalog probe the test
-- stub used to recognise by regex-matching the WHOLE statement text. The comment
-- below therefore emitted a phantom __PROBE sentinel before the verify banner
-- and turned 5 of 21 runner tests red without one character of SQL changing.
-- 021 worked around it by rephrasing against information_schema; this fixture
-- keeps the original phrasing alive so the stub's fix cannot quietly regress.
--
-- What makes it interesting: the pg_attribute/pg_class/pg_namespace shape occurs
-- EXACTLY ONCE in this file and it is inside a `--` comment. There is no
-- executable SELECT anywhere. Anything the stub reports as a probe here is
-- something it read out of a comment.
--
-- Applied-check (run this by hand against production):
--   SELECT 1 FROM pg_attribute a
--     JOIN pg_class c     ON c.oid = a.attrelid
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public'
--      AND c.relname = 'prompt_results'
--      AND a.attname = 'evidence_raw_id'
--      AND a.attnum > 0
--      AND NOT a.attisdropped LIMIT 1;

/* And the same shape once more inside a block comment, because the naive
   `strip only -- lines` fix passes the test above and still fails this:
   SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace LIMIT 1; */

CREATE TABLE IF NOT EXISTS r626_comment_probe_fixture (
  id uuid PRIMARY KEY,
  -- a trailing comment mentioning to_regclass('public.r626_comment_probe_fixture') too
  note text
);
