-- 015: brand_metrics_daily.citation_denominator / citation_state /
-- citation_state_reason — a stored citation share now says whether its
-- DENOMINATOR was measured, measured as zero, or never recorded at all.
-- Plan: docs/plans/2026-08-29-rebuild-roadmap.md R4.3.3.
-- Code that needs it: src/lib/analytics/rollup.js (summaryToMetricsRow /
-- buildMetricsRows) and src/lib/analytics/historicalBackfill.js, whose rows go
-- into brand_metrics_daily via upsertBrandMetricsDaily
-- (src/lib/db/analytics.js) and via scripts/backfill-analytics.mjs.
-- Safe to re-run.
--
-- ADDITIVE: one integer column, two nullable text columns, four CHECK
-- constraints and one partial index. Nothing is dropped, renamed or rewritten.
-- `ADD COLUMN ... ` with no default does not rewrite the table, so the ACCESS
-- EXCLUSIVE lock lasts a catalog write, not a table scan.
--
-- STANDING RULE 4: this file ships in the same commit as the rollup change.
-- upsertBrandMetricsDaily passes the row object through verbatim and ends with
-- `if (error) throw error`, so a deploy WITHOUT this migration makes every scan
-- finalize fail its brand_metrics_daily write with PostgREST PGRST204 ("column
-- citation_denominator ... does not exist"), exactly as 013 would. Same for
-- scripts/backfill-analytics.mjs, which now also READS these three columns
-- before writing and fails with a message naming this file.
--
-- APPLIED STATE: unverified from the environment that wrote this file. Nothing
-- in this repository can reach the production catalog. Do not assume.
--
-- ---------------------------------------------------------------------------
-- WHY THESE COLUMNS EXIST
-- ---------------------------------------------------------------------------
-- `citation_share_pct` is cited-answers / OPPORTUNITIES-TO-BE-CITED. R2.2.2
-- established that the second number is not the answered count on an engine
-- whose citation leg can die on its own: Perplexity fetches citations with a
-- separate /search call, and an answered row whose /search died carries
-- `citations: []` meaning "we could not look", not "we looked and found none".
-- Dividing by every answered row therefore reports an OUTAGE as a confirmed
-- "the brand was not cited here".
--
-- So the pool is emitted on each engine slice as `citation_denominator`, and
-- rollup.js refuses to compute a share without it. Three distinct things then
-- all arrived at this table as the SAME value — a NULL citation_share_pct:
--
--   (a) the denominator is a real 0: nothing answered, or every citation leg
--       died, so there were no observed citation lists. A MEASUREMENT.
--   (b) the denominator is unknown: the row replays a scan written before
--       R2.2.2, whose engine summaries carry no denominator and whose per-probe
--       rows carry no `citations_state` marker either (both landed in the same
--       commit, so they are missing together). The number is GONE.
--   (c) nothing was written for this row at all.
--
-- (a) and (b) must never collapse. `citation_denominator` is what keeps them
-- apart in storage — 0 versus NULL — and the agreement CHECK below makes the
-- pairing un-forgeable by a future writer:
--
--   citation_state         measured | measured_zero | not_assessed | failed
--                          (ENGINE_MEASUREMENT_STATE, src/lib/scoring/enginePipeline.js)
--   citation_state_reason  brand_not_cited | no_observed_citation_pool
--                          | citation_denominator_unrecoverable
--                          (CITATION_STATE_REASONS, src/lib/analytics/rollup.js)
--
--   measured        share is a number over a pool > 0            (reason NULL)
--   measured_zero   pool > 0, every list read, we are in none     brand_not_cited
--   not_assessed    pool is a measured 0                          no_observed_citation_pool
--   not_assessed    pool is unknown, share NULL, denominator NULL citation_denominator_unrecoverable
--
-- measured_zero is the one that must not be softened into not_assessed: the
-- lists WERE read and the brand is in none of them. That is a real, bad, and
-- actionable finding, and it is not the same as having nothing to read.
--
-- ---------------------------------------------------------------------------
-- CATALOG VERIFICATION -- is 015 applied to THIS database?
-- ---------------------------------------------------------------------------
-- Read pg_catalog, never a head probe (docs/PROD_MIGRATIONS.md, rule 1);
-- pg_attribute rather than information_schema.columns, because
-- information_schema hides columns the calling role cannot select and would
-- report an applied migration as missing.
--
--   SELECT a.attname
--     FROM pg_attribute a
--    WHERE a.attrelid = 'public.brand_metrics_daily'::regclass
--      AND a.attname IN ('citation_denominator', 'citation_state',
--                        'citation_state_reason')
--      AND NOT a.attisdropped;
--
-- Three rows = applied. Zero rows = not applied. One or two = a partial apply;
-- re-run this file (it is idempotent).
--
--   SELECT conname
--     FROM pg_constraint
--    WHERE conrelid = 'public.brand_metrics_daily'::regclass
--      AND conname LIKE 'brand_metrics_daily_citation%';
--
-- Four rows = the constraints are there too. A column present without its
-- constraints is the "table exists, function absent" shape 009 was found in.
--
-- `scripts/setup-supabase.mjs` verifies this migration through
-- `brand_metrics_daily_citation_unverified_idx` (see below for why an index
-- rather than the columns themselves).

ALTER TABLE brand_metrics_daily
  ADD COLUMN IF NOT EXISTS citation_denominator integer,
  ADD COLUMN IF NOT EXISTS citation_state text,
  ADD COLUMN IF NOT EXISTS citation_state_reason text;

-- The catalog probe in scripts/setup-supabase.mjs sees tables, indexes and
-- functions -- NOT columns -- and columns are the whole point of this
-- migration. 012 and 013 solved the same problem the same way: an index ON the
-- columns cannot exist unless they do, so the index is the checkable proof.
-- (014 shipped no such index and is consequently unverifiable by `setup:db`;
-- that gap is documented in docs/OPERATOR_LEDGER.md § C and is not repeated
-- here.) All three columns come from the single ALTER above, inside the one
-- transaction the runner wraps each migration in, so this index existing
-- proves all three exist.
--
-- It is also the real audit query: "which stored citation shares can I not
-- trust". A row with citation_state NULL predates 015 and its
-- citation_share_pct may have been divided by an answered count that included
-- rows whose citation list was never observed.
CREATE INDEX IF NOT EXISTS brand_metrics_daily_citation_unverified_idx
  ON brand_metrics_daily (brand, date)
  WHERE citation_state IS NULL AND citation_share_pct IS NOT NULL;

COMMENT ON COLUMN brand_metrics_daily.citation_denominator IS
  'R4.3.3. The number of OPPORTUNITIES to be cited that citation_share_pct was '
  'computed over: answered non-branded rows whose citation list was actually '
  'observed (R2.2.2). 0 is a MEASUREMENT -- there were no opportunities. NULL '
  'is NOT a zero: it means the denominator could not be reconstructed (a '
  'pre-R2.2.2 scan replayed by scripts/backfill-analytics.mjs, whose per-probe '
  'rows carry no citations_state), or the row predates this migration. Never '
  'coerce this column to 0; read citation_state to tell the two apart.';

COMMENT ON COLUMN brand_metrics_daily.citation_state IS
  'R4.3.3. Whether citation_share_pct is a measurement, and if not, why there '
  'is no number: measured | measured_zero | not_assessed | failed '
  '(ENGINE_MEASUREMENT_STATE, src/lib/scoring/enginePipeline.js). NULL means '
  'the row was written before migration 015 -- on such a row citation_share_pct '
  'is UNRELIABLE, because a pre-R2.2.2 writer may have divided by an answered '
  'count that counted a dead citation leg as a confirmed "not cited".';

COMMENT ON COLUMN brand_metrics_daily.citation_state_reason IS
  'R4.3.3. WHY the row is in the state citation_state names: brand_not_cited '
  '(every list read, we are in none -- a real 0), no_observed_citation_pool '
  '(the denominator is a measured 0), citation_denominator_unrecoverable (the '
  'denominator is unknown and cannot be reconstructed). NULL is correct only '
  'for citation_state=''measured'', or alongside a NULL citation_state '
  '(pre-015, unverified).';

-- ---------------------------------------------------------------------------
-- NO SQL BACKFILL HERE, AND THAT IS A DECISION, NOT AN OMISSION.
-- ---------------------------------------------------------------------------
-- 013 could re-derive its state in SQL because the evidence (result_brands
-- joined to prompt_results) lives in this database. The citation denominator's
-- evidence does not: deciding whether a pre-R2.2.2 perplexity slice is
-- re-derivable needs the scan's stored per-probe rows AND the engine summary
-- they were counted into, and it needs to notice when the surviving rows are a
-- DIFFERENT population from the one the summary was computed over. That
-- comparison lives in src/lib/analytics/historicalBackfill.js
-- (rederiveCitationDenominator), which scripts/backfill-analytics.mjs runs
-- over scans.raw_results and which reports the split it found.
--
-- Writing a second, weaker copy of that logic in SQL is how two hand-kept
-- copies drift -- the exact failure src/lib/analytics/rollup.js's header
-- exists to prevent. So: apply this migration, then run
--
--   node --env-file=.env.local scripts/backfill-analytics.mjs --dry-run
--   node --env-file=.env.local scripts/backfill-analytics.mjs
--
-- and read its "Citation denominator (R4.3.3)" block for the real split.
-- Until that runs, rows keep citation_state NULL, which the column comment
-- above defines as unverified. The index above enumerates them.

-- ---------------------------------------------------------------------------
-- CONSTRAINTS. Guarded by pg_constraint rather than a bare ADD CONSTRAINT,
-- because PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS and this file must
-- re-run. Added after the columns so they describe the table as it now is.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.brand_metrics_daily'::regclass
                    AND conname = 'brand_metrics_daily_citation_state_check') THEN
    ALTER TABLE brand_metrics_daily
      ADD CONSTRAINT brand_metrics_daily_citation_state_check
      CHECK (citation_state IS NULL
             OR citation_state IN ('measured', 'measured_zero', 'not_assessed', 'failed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.brand_metrics_daily'::regclass
                    AND conname = 'brand_metrics_daily_citation_state_reason_check') THEN
    ALTER TABLE brand_metrics_daily
      ADD CONSTRAINT brand_metrics_daily_citation_state_reason_check
      CHECK (citation_state_reason IS NULL
             OR citation_state_reason IN ('brand_not_cited',
                                          'no_observed_citation_pool',
                                          'citation_denominator_unrecoverable'));
  END IF;

  -- A denominator is a count. It is never negative, and a negative one would
  -- pass every other check here while poisoning any average taken over it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.brand_metrics_daily'::regclass
                    AND conname = 'brand_metrics_daily_citation_denominator_check') THEN
    ALTER TABLE brand_metrics_daily
      ADD CONSTRAINT brand_metrics_daily_citation_denominator_check
      CHECK (citation_denominator IS NULL OR citation_denominator >= 0);
  END IF;

  -- THE ONE THAT MAKES THE FIX UN-REGRESSABLE AT THE STORAGE LAYER.
  --
  -- Every state must agree with BOTH the share and the denominator, so a
  -- future writer cannot store an unknown denominator as a zero (the eighth
  -- instance of the coercion this rebuild keeps finding), nor claim a
  -- measurement it has no pool for. A NULL state (pre-015) is exempt: those
  -- rows are documented unreliable, not asserted consistent.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.brand_metrics_daily'::regclass
                    AND conname = 'brand_metrics_daily_citation_agreement_check') THEN
    ALTER TABLE brand_metrics_daily
      ADD CONSTRAINT brand_metrics_daily_citation_agreement_check
      CHECK (
        citation_state IS NULL
        -- measured: a pool, and a non-zero share over it.
        OR (citation_state = 'measured'
            AND citation_denominator > 0
            AND citation_share_pct IS NOT NULL
            AND citation_share_pct <> 0
            AND citation_state_reason IS NULL)
        -- measured_zero: a pool that WAS read, and we are in none of it.
        OR (citation_state = 'measured_zero'
            AND citation_denominator > 0
            AND citation_share_pct = 0
            AND citation_state_reason = 'brand_not_cited')
        -- not_assessed, measured empty pool: the count is 0 and it is REAL.
        OR (citation_state = 'not_assessed'
            AND citation_state_reason = 'no_observed_citation_pool'
            AND citation_denominator = 0
            AND citation_share_pct IS NULL)
        -- not_assessed, unknown pool: no count exists. NULL, never 0.
        OR (citation_state = 'not_assessed'
            AND citation_state_reason = 'citation_denominator_unrecoverable'
            AND citation_denominator IS NULL
            AND citation_share_pct IS NULL)
        -- failed: reserved by the shared vocabulary; no producer emits it yet,
        -- and it may not carry a number if one ever does.
        OR (citation_state = 'failed'
            AND citation_share_pct IS NULL
            AND citation_denominator IS NULL)
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Report. A migration that touched nothing and a migration that could not
-- reach anything are different outcomes and must read differently.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_total      bigint;
  v_stated     bigint;
  v_unverified bigint;
  v_suspect    bigint;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE citation_state IS NOT NULL),
         count(*) FILTER (WHERE citation_state IS NULL),
         count(*) FILTER (WHERE citation_state IS NULL AND citation_share_pct IS NOT NULL)
    INTO v_total, v_stated, v_unverified, v_suspect
    FROM brand_metrics_daily;

  RAISE NOTICE '015: brand_metrics_daily rows=% stated=% unverified=% (of which % still carry a citation_share_pct)',
    v_total, v_stated, v_unverified, v_suspect;

  IF v_unverified > 0 THEN
    RAISE NOTICE '015: % row(s) predate this migration. Their citation_state is NULL and this '
                 'file does NOT re-derive it -- run scripts/backfill-analytics.mjs and read its '
                 '"Citation denominator (R4.3.3)" block. Until then treat their '
                 'citation_share_pct as unverified.', v_unverified;
  ELSIF v_total = 0 THEN
    RAISE NOTICE '015: brand_metrics_daily is empty -- nothing to state, which is not the same '
                 'as nothing needing it.';
  END IF;
END $$;
