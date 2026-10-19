-- Keep one report identity even if a worker dies after insert and before stamp.
ALTER TABLE scans ADD COLUMN IF NOT EXISTS origin_job_id uuid REFERENCES scan_jobs(id);
DROP INDEX IF EXISTS scans_origin_job_idx;
-- A full unique constraint is the PostgREST upsert conflict target. NULL legacy
-- identities remain distinct; no historic report is guessed or rewritten.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='scans_origin_job_key') THEN
  ALTER TABLE scans ADD CONSTRAINT scans_origin_job_key UNIQUE(origin_job_id);
 END IF;
END $$;
NOTIFY pgrst,'reload schema';
