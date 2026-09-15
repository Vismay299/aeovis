-- 007: seal the duplicate-scan race.
-- Plan: docs/plans/2026-08-29-rebuild-roadmap.md R0.1.5.
-- Safe to re-run: IF NOT EXISTS throughout.

-- ---------------------------------------------------------------------------
-- R0.1.5 (finding B11) — one running scan per brand, enforced by the DATABASE.
--
-- src/lib/db.js hasActiveScanForBrand is a read-then-write check with two
-- holes: it fails OPEN on any DB error (a broken check silently allows every
-- duplicate), and even when it works there is a TOCTOU window between the
-- SELECT and the INSERT in which two concurrent requests both see "no active
-- scan" and both enqueue. Each duplicate spends a full Bright Data + LLM
-- scan budget.
--
-- The predicate lists the running statuses from SCAN_JOB_RUNNING in
-- src/lib/db.js:318. Keep the two in step — a status added there and not here
-- reopens the race.
--
-- On the deliberately-absent heartbeat condition: a partial index predicate
-- must be IMMUTABLE, so freshness (HEARTBEAT_STALE_MS) cannot live in it. A
-- crashed job left in 'probing' would therefore block its brand forever. That
-- is handled in application code instead: createScanJob catches the unique
-- violation, and if the blocking job's heartbeat is stale it fails that job
-- and retries once. See src/lib/db.js createScanJob.
CREATE UNIQUE INDEX IF NOT EXISTS scan_jobs_one_running_per_brand
  ON scan_jobs (lower(btrim(brand)))
  WHERE status IN ('pending', 'generating_prompts', 'probing', 'scoring');
