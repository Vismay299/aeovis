-- Agent control plane — durable job leases + per-block run ledger
-- (plan: docs/plans/2026-07-28-agent-control-plane.md, T1 + T3)
-- Safe to re-run: IF NOT EXISTS / idempotent column adds throughout.

-- ---------------------------------------------------------------------------
-- T1. Durable lease columns (structural single-flight, L1)
--
-- content_jobs previously had NO exclusivity mechanism: the cron dispatched
-- startContentJob() fire-and-forget after a `created_at > 5 minutes` filter,
-- so a healthy job still mid-pipeline was re-picked and run twice — two
-- executions racing one row, each spending up to the full per-item cost cap
-- and each inserting a content_items row (D1).
--
-- The lease is claimed with a single conditional UPDATE (see src/lib/jobLease.js)
-- so exactly one caller can win. Columns are nullable: an unleased row has
-- lease_owner IS NULL, which is the "free" state the acquire predicate tests.
-- ---------------------------------------------------------------------------
ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

-- scan_jobs gets the columns now so adopting the same primitive later is a
-- code-only change (L2). Nothing writes them yet: the scan pipeline keeps its
-- existing heartbeat + claimJobStatus() single-flight.
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

-- The heartbeat index 005 created for scan_jobs but not for content_jobs, even
-- though listResumableContentJobs now sweeps on heartbeat staleness.
CREATE INDEX IF NOT EXISTS content_jobs_heartbeat_idx ON content_jobs (heartbeat_at);

-- Rescue sweep hot path: "running jobs whose lease is expired or absent".
CREATE INDEX IF NOT EXISTS content_jobs_lease_idx ON content_jobs (lease_expires_at);

-- ---------------------------------------------------------------------------
-- T3. Per-block run ledger
--
-- One row per block execution. Before this, cost lived in a closure variable
-- and only a single job-level total was persisted, so "which block eats the
-- $0.15" was unanswerable (D4) — which blocks both prompt optimisation and
-- honest tier pricing.
--
-- `cycle` distinguishes the draft→review passes (the bounded revision loop
-- runs draft and review up to MAX_DRAFT_REVIEW_CYCLES times), so a job's
-- ledger reads as a true execution history rather than a set of unique blocks.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_runs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id uuid REFERENCES content_jobs(id) ON DELETE CASCADE,
  brand text NOT NULL,
  block text NOT NULL,                -- block slug: coordinate|research|benchmark|draft|review|fact_check|translate|...
  cycle integer DEFAULT 1,            -- draft/review pass number; 1 for single-pass blocks
  status text NOT NULL,               -- running|succeeded|failed
  cost numeric DEFAULT 0,             -- USD spent by THIS block (stats.cost delta)
  tokens integer DEFAULT 0,
  duration_ms integer,
  error text,
  started_at timestamptz DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS content_runs_job_idx ON content_runs (job_id, started_at);
CREATE INDEX IF NOT EXISTS content_runs_brand_block_idx ON content_runs (brand, block);

-- RLS: house style until auth lands — every new table gets ENABLE ROW LEVEL
-- SECURITY + an "Allow anon all" policy, matching 001/002/004/005.
ALTER TABLE content_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'content_runs' AND policyname = 'Allow anon all on content_runs'
  ) THEN
    CREATE POLICY "Allow anon all on content_runs" ON content_runs FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;
