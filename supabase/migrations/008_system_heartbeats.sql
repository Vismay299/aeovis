-- 008: a place to record that a scheduled job actually fired.
-- Plan: docs/plans/2026-08-29-rebuild-roadmap.md R0.1.7 (/api/health).
-- Safe to re-run.

-- Before this there was no way to answer "is the cron alive?". The nearest
-- proxies — max(scan_jobs.heartbeat_at), max(scan_schedules.last_run_at) —
-- only move when a scan actually STARTS, so a cron firing every hour with
-- nothing due looked identical to a cron that had stopped firing at all.
-- Reporting a proxy as if it were a tick is the same class of lie as
-- reporting an unmeasured share as 100%: one row per named ticker instead.
CREATE TABLE IF NOT EXISTS system_heartbeats (
  name         text        PRIMARY KEY,   -- 'scan-worker' | 'content-worker'
  last_tick_at timestamptz NOT NULL,
  detail       jsonb
);

ALTER TABLE system_heartbeats ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'system_heartbeats' AND policyname = 'Allow anon all on system_heartbeats'
  ) THEN
    CREATE POLICY "Allow anon all on system_heartbeats" ON system_heartbeats
      FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;
