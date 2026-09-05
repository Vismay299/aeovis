-- 013: brand_metrics_daily.sov_state / sov_state_reason — a stored share of
-- voice now says whether it is a MEASUREMENT or a TAUTOLOGY.
-- Plan: docs/plans/2026-08-29-rebuild-roadmap.md R4.3.2 (carried from R0.3.2).
-- Code that needs it: src/lib/analytics/rollup.js (computeBrandRollups /
-- summaryToMetricsRow / buildMetricsRows), whose rows go straight into
-- brand_metrics_daily via upsertBrandMetricsDaily (src/lib/db/analytics.js).
-- Safe to re-run.
--
-- ADDITIVE: two nullable text columns, three CHECK constraints, and a
-- one-time re-derivation of existing rows. Nothing is dropped or renamed.
-- `ADD COLUMN ... text` with no default does not rewrite the table, so the
-- ACCESS EXCLUSIVE lock lasts a catalog write, not a table scan.
--
-- STANDING RULE 4: this file ships in the same commit as the rollup change.
-- The upsert in upsertBrandMetricsDaily passes the row object through
-- verbatim, so a deploy WITHOUT this migration makes every scan finalize fail
-- its brand_metrics_daily write with PostgREST's PGRST204 ("column
-- sov_state ... does not exist"). That is the predicted symptom; add it to
-- docs/PROD_MIGRATIONS.md's table when this lands.
--
-- ---------------------------------------------------------------------------
-- WHY THESE COLUMNS EXIST
-- ---------------------------------------------------------------------------
-- `sov_pct` was self mentions / all tracked-brand mentions. When the tracked
-- roster contains nobody but the customer's own brand -- the COMMON case, not
-- an edge one: no user-supplied competitor and an extractor that found nothing
-- or was offline -- the numerator IS the denominator and the stored value is
-- exactly 100. Durable, exportable, and plotted on a trend chart as though a
-- brand had beaten rivals it was never measured against.
--
-- The scoring path already refuses that number: computeEngineSummary returns
-- share_of_voice_pct = null without a rival roster, and R2.7.1 made the
-- dashboard donut render "not available". This table did not, so the two
-- surfaces disagreed and the durable one told the flattering lie.
--
-- A null on its own is not enough, because a null is also what "we have no
-- per-brand source for this historical scan" looks like, and what a genuine
-- "nobody was mentioned at all" looks like. So the state travels WITH the
-- number, in the vocabulary R2.1.1 froze in src/lib/scoring/enginePipeline.js
-- (ENGINE_MEASUREMENT_STATE / ENGINE_STATE_REASONS) and the dashboard's
-- SHARE_STATE already renders. No third vocabulary was invented; one reason
-- token, 'self_only_roster', was added for the condition computeEngineSummary
-- handles without naming.
--
--   sov_state         measured | measured_zero | not_assessed | failed
--   sov_state_reason  no_results | no_non_branded_prompts | empty_eliciting_pool
--                     | high_error_rate | low_coverage | brand_not_visible
--                     | self_only_roster
--
-- measured_zero is the one that must not collapse into not_assessed: rivals
-- were named and we never were, which is a real 0 and a real finding.
--
-- ---------------------------------------------------------------------------
-- CATALOG VERIFICATION -- is 013 applied to THIS database?
-- ---------------------------------------------------------------------------
-- Read pg_catalog, never a head probe (docs/PROD_MIGRATIONS.md, rule 1);
-- pg_attribute rather than information_schema.columns, because
-- information_schema hides columns the calling role cannot select and would
-- report an applied migration as missing.
--
--   SELECT a.attname
--     FROM pg_attribute a
--    WHERE a.attrelid = 'public.brand_metrics_daily'::regclass
--      AND a.attname IN ('sov_state', 'sov_state_reason')
--      AND NOT a.attisdropped;
--
-- Two rows = applied. Zero rows = not applied. One row = a partial apply;
-- re-run this file (it is idempotent).
--
--   SELECT conname
--     FROM pg_constraint
--    WHERE conrelid = 'public.brand_metrics_daily'::regclass
--      AND conname IN ('brand_metrics_daily_sov_state_check',
--                      'brand_metrics_daily_sov_state_reason_check',
--                      'brand_metrics_daily_sov_state_pct_agreement_check');
--
-- Three rows = the constraints are there too. A column present without its
-- constraints is the "table exists, function absent" shape 009 was found in.
--
-- `scripts/setup-supabase.mjs` verifies this migration through
-- `brand_metrics_daily_sov_unverified_idx` (see below for why an index rather
-- than the columns themselves).

ALTER TABLE brand_metrics_daily
  ADD COLUMN IF NOT EXISTS sov_state text,
  ADD COLUMN IF NOT EXISTS sov_state_reason text;

-- The catalog probe in scripts/setup-supabase.mjs sees tables, indexes and
-- functions -- NOT columns -- and columns are the whole point of this
-- migration. 012 solved the same problem the same way: an index ON the column
-- cannot exist unless the column does, so the index is the checkable proof.
--
-- Both columns are added by the single ALTER above, inside the one transaction
-- the runner wraps each migration in, so this index existing proves BOTH of
-- them exist. It is not a formality either: this is the "which stored shares
-- can I not trust" query. A row with sov_state NULL predates 013 and could not
-- be re-derived; one that ALSO still carries a sov_pct is a number an operator
-- may be reading as a measurement when it might be the self-only tautology.
CREATE INDEX IF NOT EXISTS brand_metrics_daily_sov_unverified_idx
  ON brand_metrics_daily (brand, date)
  WHERE sov_state IS NULL AND sov_pct IS NOT NULL;

COMMENT ON COLUMN brand_metrics_daily.sov_state IS
  'R4.3.2. Whether sov_pct is a measurement, and if not, why there is no number: '
  'measured | measured_zero | not_assessed | failed (ENGINE_MEASUREMENT_STATE, '
  'src/lib/scoring/enginePipeline.js). NULL means the row was written before '
  'migration 013 AND its provenance could not be re-derived (no scan_id, or no '
  'surviving result_brands rows for that scan) -- on such a row sov_pct is '
  'UNRELIABLE and in particular a 100 may be a self-only-roster tautology '
  'rather than a share. Do not plot or export a NULL-state sov_pct as a '
  'measurement.';

COMMENT ON COLUMN brand_metrics_daily.sov_state_reason IS
  'R4.3.2. WHY the row is in the state sov_state names. ENGINE_STATE_REASONS '
  'plus self_only_roster (the roster held no non-self brand, so share of voice '
  'is undefined -- not 0 and not 100). NULL is correct only for '
  'sov_state=''measured'', or alongside a NULL sov_state (pre-013, unverified).';

-- ---------------------------------------------------------------------------
-- BACKFILL -- re-derive the rows we can PROVE, and say so out loud.
-- ---------------------------------------------------------------------------
-- The proof lives in result_brands (one row per answer x tracked brand, with
-- is_self), joined to prompt_results for the engine and the branded/non-branded
-- split -- the same non-branded pool computeBrandRollups scopes to. For an
-- 'all' row the roster question spans every engine, which is why the engine
-- predicate is `m.engine = 'all' OR pr.engine = m.engine`.
--
-- Rows this CANNOT reach keep their sov_pct and are left with sov_state NULL,
-- which the column comment above defines as "unreliable". They are counted and
-- reported by the DO block at the end rather than passed over in silence: a
-- backfill that skipped 400 rows and a backfill that had nothing to do must not
-- look the same in the log.

-- (1) Proven self-only roster: the slice WAS judged, and every tracked brand in
--     it is us. The stored number is numerator/numerator. Erase it.
UPDATE brand_metrics_daily m
   SET sov_pct = NULL,
       sov_state = 'not_assessed',
       sov_state_reason = 'self_only_roster'
 WHERE m.sov_state IS NULL
   AND m.scan_id IS NOT NULL
   AND EXISTS (
         SELECT 1
           FROM result_brands rb
           JOIN prompt_results pr ON pr.id = rb.result_id
          WHERE rb.scan_id = m.scan_id
            AND pr.is_branded_query IS NOT TRUE
            AND (m.engine = 'all' OR pr.engine = m.engine))
   AND NOT EXISTS (
         SELECT 1
           FROM result_brands rb
           JOIN prompt_results pr ON pr.id = rb.result_id
          WHERE rb.scan_id = m.scan_id
            AND pr.is_branded_query IS NOT TRUE
            AND (m.engine = 'all' OR pr.engine = m.engine)
            AND rb.is_self IS NOT TRUE);

-- (2) Proven rival roster: the number stands, and now says it is a measurement.
--     0 is measured_zero (rivals named, we were not) -- a real finding, not an
--     absence, and it must never collapse into not_assessed.
UPDATE brand_metrics_daily m
   SET sov_state = CASE WHEN m.sov_pct = 0 THEN 'measured_zero' ELSE 'measured' END,
       sov_state_reason = CASE WHEN m.sov_pct = 0 THEN 'brand_not_visible' ELSE NULL END
 WHERE m.sov_state IS NULL
   AND m.sov_pct IS NOT NULL
   AND m.scan_id IS NOT NULL
   AND EXISTS (
         SELECT 1
           FROM result_brands rb
           JOIN prompt_results pr ON pr.id = rb.result_id
          WHERE rb.scan_id = m.scan_id
            AND pr.is_branded_query IS NOT TRUE
            AND (m.engine = 'all' OR pr.engine = m.engine)
            AND rb.is_self IS NOT TRUE);

-- ---------------------------------------------------------------------------
-- CONSTRAINTS -- added AFTER the backfill so they describe the table as it now
-- is. Guarded by pg_constraint rather than a bare ADD CONSTRAINT, because
-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS and this file must re-run.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.brand_metrics_daily'::regclass
                    AND conname = 'brand_metrics_daily_sov_state_check') THEN
    ALTER TABLE brand_metrics_daily
      ADD CONSTRAINT brand_metrics_daily_sov_state_check
      CHECK (sov_state IS NULL
             OR sov_state IN ('measured', 'measured_zero', 'not_assessed', 'failed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.brand_metrics_daily'::regclass
                    AND conname = 'brand_metrics_daily_sov_state_reason_check') THEN
    ALTER TABLE brand_metrics_daily
      ADD CONSTRAINT brand_metrics_daily_sov_state_reason_check
      CHECK (sov_state_reason IS NULL
             OR sov_state_reason IN ('no_results', 'no_non_branded_prompts',
                                     'empty_eliciting_pool', 'high_error_rate',
                                     'low_coverage', 'brand_not_visible',
                                     'self_only_roster'));
  END IF;

  -- The one that makes the fix un-regressable at the storage layer: a row may
  -- not claim it was not measured AND carry a number, nor claim a measurement
  -- and carry none. This is what stops a future writer re-introducing a
  -- confident 100 under a not_assessed label. A NULL state (pre-013) is
  -- exempt -- those rows are documented unreliable, not asserted consistent.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.brand_metrics_daily'::regclass
                    AND conname = 'brand_metrics_daily_sov_state_pct_agreement_check') THEN
    ALTER TABLE brand_metrics_daily
      ADD CONSTRAINT brand_metrics_daily_sov_state_pct_agreement_check
      CHECK (sov_state IS NULL
             OR (sov_state IN ('measured', 'measured_zero') AND sov_pct IS NOT NULL)
             OR (sov_state IN ('not_assessed', 'failed') AND sov_pct IS NULL));
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
         count(*) FILTER (WHERE sov_state IS NOT NULL),
         count(*) FILTER (WHERE sov_state IS NULL),
         count(*) FILTER (WHERE sov_state IS NULL AND sov_pct IS NOT NULL)
    INTO v_total, v_stated, v_unverified, v_suspect
    FROM brand_metrics_daily;

  RAISE NOTICE '013: brand_metrics_daily rows=% stated=% unverified=% (of which % still carry a sov_pct)',
    v_total, v_stated, v_unverified, v_suspect;

  IF v_suspect > 0 THEN
    RAISE NOTICE '013: those % row(s) predate this migration and could not be re-derived '
                 '(no scan_id, or no surviving result_brands rows). Their sov_pct is '
                 'UNRELIABLE -- a 100 there may be a self-only-roster tautology. '
                 'sov_state IS NULL is the marker; see the column comment.', v_suspect;
  ELSIF v_total = 0 THEN
    RAISE NOTICE '013: brand_metrics_daily is empty -- nothing to re-derive, which is not '
                 'the same as nothing needing it.';
  END IF;
END $$;
