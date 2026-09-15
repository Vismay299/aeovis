-- 018: gsc_connections + gsc_daily — weekly Google Search Console ingest.
-- Plan: docs/plans/2026-08-29-rebuild-roadmap.md R4.1.1.
-- Code that needs it: src/lib/db/gsc.js, src/lib/gsc/ingest.js,
-- src/app/api/gsc/worker/route.js, src/app/api/brands/[brand]/gsc/route.js.
-- Connect flow: docs/vendors/gsc.md.
-- Safe to re-run.
--
-- ADDITIVE: two new tables, one index, RLS policies matching the rest of the
-- schema (the Next app holds only the anon key). Nothing existing is touched.
--
-- gsc_connections is the "connected brand" the acceptance names: a brand is
-- connected only once an operator has resolved it to a Search Console property
-- the service account can actually read. Having a key is not being connected.
--
-- gsc_daily holds one row per brand x day x query, as Google reports it. Google
-- omits anonymised queries from query-dimension rows, so a day's sum here is
-- NOT the property's total clicks -- never present it as one.

CREATE TABLE IF NOT EXISTS gsc_connections (
  brand             text        PRIMARY KEY,   -- resolveBrandKey() output
  site_url          text        NOT NULL,      -- "sc-domain:x.com" or "https://x.com/"
  enabled           boolean     NOT NULL DEFAULT true,
  connected_at      timestamptz NOT NULL DEFAULT now(),
  -- Outcome of the most recent ingest attempt. last_status NULL = never ran,
  -- which is a different fact from 'ok' with rows_written 0 (a measured zero).
  last_attempt_at   timestamptz,
  last_status       text CHECK (last_status IS NULL OR last_status IN ('ok', 'failed')),
  last_error        text,
  last_rows_written integer CHECK (last_rows_written IS NULL OR last_rows_written >= 0),
  -- The newest GSC date successfully ingested; the next run overlaps from here.
  last_ingested_through date
);

CREATE TABLE IF NOT EXISTS gsc_daily (
  brand       text        NOT NULL,
  date        date        NOT NULL,
  query       text        NOT NULL,
  site_url    text        NOT NULL,
  clicks      integer     NOT NULL CHECK (clicks >= 0),
  impressions integer     NOT NULL CHECK (impressions >= 0),
  ctr         numeric     NOT NULL,
  position    numeric     NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand, date, query)
);

CREATE INDEX IF NOT EXISTS gsc_daily_brand_date_idx ON gsc_daily (brand, date DESC);

ALTER TABLE gsc_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE gsc_daily ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'gsc_connections' AND policyname = 'Allow anon all on gsc_connections') THEN
    CREATE POLICY "Allow anon all on gsc_connections" ON gsc_connections
      FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'gsc_daily' AND policyname = 'Allow anon all on gsc_daily') THEN
    CREATE POLICY "Allow anon all on gsc_daily" ON gsc_daily
      FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;
