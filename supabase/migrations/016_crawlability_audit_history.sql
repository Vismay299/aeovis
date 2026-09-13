-- 016: crawlability_audits — history and change detection for robots.txt audits.
-- Plan: docs/plans/2026-08-29-rebuild-roadmap.md R4.3.1.
-- Code that needs it: src/lib/db/crawlability.js, src/lib/crawlabilityChanges.js,
-- and src/app/api/brands/[brand]/crawlability/route.js (which persists each audit).
-- Safe to re-run.
--
-- RATIONALE: GET /api/brands/[brand]/crawlability currently hits the brand's own
-- robots.txt on every call and returns the result ephemerally. An operator who
-- audits on Monday and again on Thursday cannot tell whether anything changed
-- without eyeballing two browser tabs. This migration stores each audit so the
-- system can detect and surface changes — "Your site started blocking GPTBot on
-- Tuesday" — as the first detector in the product.
--
-- ADDITIVE: one table, two indexes, no drops or renames. `CREATE TABLE IF NOT
-- EXISTS` with no default means an ACCESS EXCLUSIVE lock on catalog write only,
-- not a table scan.
--
-- STANDING RULE 4: this file ships in the same commit as the code that writes
-- to it. A deploy without this migration makes the persist call fail with
-- PostgREST PGRST204 ("column ... does not exist") on every audit.
--
-- APPLIED STATE: unverified from the environment that wrote this file. Nothing
-- in this repository can reach the production catalog. Do not assume.

CREATE TABLE IF NOT EXISTS crawlability_audits (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  domain          text        NOT NULL,        -- the audited hostname (lowercased)
  test_path       text        NOT NULL DEFAULT '/', -- the path tested
  audited_at      timestamptz NOT NULL DEFAULT now(),

  -- fetch outcome
  fetched_ok      boolean     NOT NULL,
  robots_txt_status text,                      -- "found" | "missing" | "error"
  robots_malformed boolean   NOT NULL DEFAULT false,
  fetch_error     text,                         -- null on success; "blocked"|"unresolved"|"timeout"|"network_error"|"http_<N>"

  -- llms.txt
  llms_txt_present boolean,

  -- per-bot summary
  summary         jsonb       NOT NULL,         -- { open, partial, blocked, total }

  -- full per-bot detail (the bots array from auditDomain)
  bots            jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- compact diff snapshot: which bots changed status vs. previous audit
  -- null on the very first audit for a domain; populated from the second onward
  diff            jsonb
);

-- Fast lookup for "latest N audits for this domain"
CREATE INDEX IF NOT EXISTS crawlability_audits_domain_idx
  ON crawlability_audits (domain, audited_at DESC);

-- Unique constraint: at most one audit per domain per minute (prevents
-- duplicate writes from rapid UI refreshes while still allowing history)
CREATE UNIQUE INDEX IF NOT EXISTS crawlability_audits_domain_minute_idx
  ON crawlability_audits (domain, date_trunc('minute', audited_at));

ALTER TABLE crawlability_audits ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'crawlability_audits' AND policyname = 'Allow anon all on crawlability_audits'
  ) THEN
    CREATE POLICY "Allow anon all on crawlability_audits" ON crawlability_audits
      FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;
