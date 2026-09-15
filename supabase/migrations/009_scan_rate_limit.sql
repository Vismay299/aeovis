-- 009: per-IP rate limit for the anonymous free scan.
-- Plan: docs/plans/2026-08-29-rebuild-roadmap.md R0.1.4 (finding S17).
-- Safe to re-run.

-- R0.1.4 (finding S17) — per-IP rate limit for POST /api/scan.
--
-- The free scan has no cap at all today: one anonymous caller can start
-- unlimited scans, each spending real Bright Data + Perplexity + LLM budget.
-- A DB-backed fixed-window counter rather than a new dependency — this table
-- is the whole infrastructure.
CREATE TABLE IF NOT EXISTS scan_rate_limits (
  bucket_key   text        NOT NULL,   -- the client identifier (hashed IP)
  window_start timestamptz NOT NULL,   -- start of the fixed window this row counts
  hits         integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_key, window_start)
);

-- Sweeping old windows: cheap, and the only maintenance this table needs.
CREATE INDEX IF NOT EXISTS scan_rate_limits_window_idx
  ON scan_rate_limits (window_start);

ALTER TABLE scan_rate_limits ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'scan_rate_limits' AND policyname = 'Allow anon all on scan_rate_limits'
  ) THEN
    CREATE POLICY "Allow anon all on scan_rate_limits" ON scan_rate_limits
      FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Atomic "add one and tell me the new count". PostgREST has no verb for an
-- upsert that returns the incremented value, and doing it as read-then-write
-- from the route would reintroduce exactly the TOCTOU that migration 007 just
-- closed for duplicate scans: two concurrent requests both reading 4 and both
-- proceeding. ON CONFLICT DO UPDATE ... RETURNING is one statement, so the
-- database serializes it.
CREATE OR REPLACE FUNCTION increment_scan_rate_limit(p_bucket_key text, p_window_start timestamptz)
RETURNS integer
LANGUAGE sql
AS $$
  INSERT INTO scan_rate_limits (bucket_key, window_start, hits, updated_at)
  VALUES (p_bucket_key, p_window_start, 1, now())
  ON CONFLICT (bucket_key, window_start)
  DO UPDATE SET hits = scan_rate_limits.hits + 1, updated_at = now()
  RETURNING hits;
$$;
