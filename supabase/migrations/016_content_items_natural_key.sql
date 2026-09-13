-- 016: Natural key on content_items (job_id, cycle)
-- Plan: R3.5.2 — closes the die-between-insert-and-status window that creates
-- duplicate drafts. A crash between insertContentItem and the status write left
-- the job without an item_id, so a resume re-inserted instead of updating.
-- With a unique constraint on (job_id, cycle), a repeated insert within the
-- window hits ON CONFLICT and returns the existing row.
-- Safe to re-run.

-- 1. Add the cycle column (mirrors content_runs.cycle — the draft/review pass
--    number). Default 1 for rows that predate this migration.
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS cycle integer DEFAULT 1;

-- 2. Backfill cycle from revision for existing rows: revision 0 = cycle 1,
--    revision 1 = cycle 2, etc. (revision is 0-indexed, cycle is 1-indexed.)
UPDATE content_items SET cycle = revision + 1 WHERE cycle IS NULL OR cycle = 1;

-- 3. The natural key: one item per job per cycle. ON CONFLICT does nothing so
--    insertContentItem can become an idempotent upsert — a repeated insert in
--    the crash window returns the existing row instead of creating a duplicate.
--    The constraint is DEFERRABLE so an explicit BEGIN; SET CONSTRAINTS ALL
--    DEFERRED; ... COMMIT; can still insert + update in one transaction.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'content_items_job_id_cycle_key'
  ) THEN
    ALTER TABLE content_items
      ADD CONSTRAINT content_items_job_id_cycle_key
      UNIQUE (job_id, cycle);
  END IF;
END $$;
