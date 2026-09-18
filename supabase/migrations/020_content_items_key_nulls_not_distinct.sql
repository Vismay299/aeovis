-- 020: content_items natural key treats a NULL job_id as a value (R3.5.5)
--
-- 016 added UNIQUE (job_id, cycle) so insertContentItem can upsert on the
-- natural key and a crash between insert and the status write cannot leave a
-- duplicate draft (R3.5.2). But content_items.job_id is nullable — 002 declares
-- it `REFERENCES content_jobs(id) ON DELETE SET NULL` — and a plain UNIQUE
-- constraint treats NULLs as distinct, so any number of (NULL, 1) rows are
-- accepted and the upsert never matches them. This recreates the key with
-- NULLS NOT DISTINCT (Postgres 15+; Supabase runs 15/17) so the guarantee holds
-- for a row with no job too.
--
-- Data-dependent: the new constraint fails mid-transaction if the table already
-- holds two rows with (NULL, same cycle). Catalog query run by the operator
-- against production on 2026-09-18 BEFORE this file was written:
--   select count(*) from content_items where job_id is null;   -- 0
-- Recorded in docs/PROD_MIGRATIONS.md. Re-run it before applying.
--
-- NOT deferrable, on purpose. 016's comment says DEFERRABLE but its SQL never
-- was, and that accident is load-bearing: ON CONFLICT cannot use a deferrable
-- unique constraint as its arbiter, and insertContentItem upserts with
-- onConflict "job_id,cycle" (src/lib/db/content.js:527). Safe to re-run: the
-- block is a no-op once the new definition is in place.
--
-- Applied ⇔ this returns one row whose definition contains NULLS NOT DISTINCT:
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint where conname = 'content_items_job_id_cycle_key';

DO $$
DECLARE
  current_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO current_def
  FROM pg_constraint
  WHERE conname = 'content_items_job_id_cycle_key';

  IF current_def IS NOT NULL AND current_def LIKE '%NULLS NOT DISTINCT%' THEN
    RETURN; -- already applied
  END IF;

  IF current_def IS NOT NULL THEN
    ALTER TABLE content_items DROP CONSTRAINT content_items_job_id_cycle_key;
  END IF;

  ALTER TABLE content_items
    ADD CONSTRAINT content_items_job_id_cycle_key
    UNIQUE NULLS NOT DISTINCT (job_id, cycle);
END $$;
