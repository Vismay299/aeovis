-- 021: prompt_results carries the probe's evidence ids (R1.5.2).
-- Plan: docs/plans/2026-08-29-rebuild-roadmap.md R1.5.2.
-- Bucket and layout: 019_probe_evidence_bucket.sql, docs/runbooks/probe-evidence.md.
--
-- PURELY ADDITIVE and safe to re-run: five nullable columns on prompt_results,
-- every one ADD COLUMN IF NOT EXISTS. No default, no backfill, no constraint,
-- no index, nothing rewritten -- ADD COLUMN with no default does not rewrite
-- the table, so this takes only a brief catalog lock on a table full of
-- customer scans.
--
-- WHY THE NAMES ARE THE CONTRACT'S NAMES
-- Probe Result Contract v2 §3.7 (docs/contracts/probe-result.md:495-515) freezes
-- the evidence object the fleet already reports:
--   evidence: { screenshot_id, dom_id, har_id, raw_id }, each string|null,
-- and states that the ids are "opaque object keys in the `probe-evidence`
-- bucket" -- i.e. an id IS the object path `createSignedUrl` takes. So the four
-- columns are those four ids, prefixed `evidence_`, and the promotion in
-- src/app/api/internal/_lib/probeResultContract.js toPromptResultRow() is a
-- straight copy with no renaming step to get wrong. Naming them
-- `..._screenshot_path` / `..._html_path` instead would have invented a fifth
-- vocabulary for the same four values and left `har_id` and `raw_id` -- which
-- are what an `api`-surface probe has INSTEAD of a screenshot -- with nowhere
-- to land. `dom_id` is the gzipped HTML capture.
--
-- WHY THE IDS ARE PROMOTED AT ALL WHEN `raw` ALREADY HOLDS THEM
-- The whole v2 result is stored verbatim in prompt_results.raw, so the values
-- are not new data. R1.5.3 renders a "View evidence" link per answer row, and
-- reaching into a jsonb blob for the path of every row on a dashboard page is
-- neither indexable nor selectable; promoted columns are what let that read ask
-- for the four strings and nothing else.
--
-- EVERY COLUMN IS NULLABLE, AND NULL MEANS SOMETHING
-- NULL = this row has no capture of that kind (a pre-R1.5.2 row, a v1 scan-
-- worker row, or an `api`-surface probe that has a raw_id and no screenshot).
-- The writer must never substitute '' or a fabricated path: R1.5.3's viewer
-- distinguishes "no evidence" (em dash, standing rule 5) from a path it can
-- sign, and an empty string would be a link to nothing. There is deliberately
-- no DEFAULT for the same reason.
--
-- evidence_captured_at is the probe's own §3.1 `probed_at` -- the instant the
-- capture was taken -- and is written ONLY when at least one id is present, so
-- it can never claim a capture time for a row that has no capture. It is not
-- created_at: created_at is when the ingest row was written, which on a retried
-- batch is minutes later and on a backfill is days.
--
-- Applied ⇔ this returns five rows (four text, one timestamptz):
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'prompt_results'
--      AND column_name LIKE 'evidence\_%';
--
-- information_schema rather than the pg_attribute/pg_class/pg_namespace form
-- used elsewhere, deliberately: src/lib/migrationsRunner.test.mjs's pg stub
-- recognises the runner's OWN catalog probe by that three-way join, and a
-- migration whose comment contains it is mistaken for a probe. Same answer,
-- and the file stays distinguishable from the verifier that checks it.

ALTER TABLE prompt_results
  -- §3.7 screenshot_id — full-page PNG. Object key in `probe-evidence`.
  ADD COLUMN IF NOT EXISTS evidence_screenshot_id text,
  -- §3.7 dom_id — the gzipped rendered HTML (`.html.gz`).
  ADD COLUMN IF NOT EXISTS evidence_dom_id text,
  -- §3.7 har_id — network capture, when an adapter records one.
  ADD COLUMN IF NOT EXISTS evidence_har_id text,
  -- §3.7 raw_id — the vendor's raw response; REQUIRED for engine_surface 'api',
  -- which is the surface that has no screenshot to show.
  ADD COLUMN IF NOT EXISTS evidence_raw_id text,
  -- §3.1 probed_at of the probe that produced the capture. NULL when no id is
  -- present, so it is never a capture time for a capture that does not exist.
  ADD COLUMN IF NOT EXISTS evidence_captured_at timestamptz;

COMMENT ON COLUMN prompt_results.evidence_screenshot_id IS
  'Probe Result Contract v2 §3.7 evidence.screenshot_id: object key in the private `probe-evidence` bucket (019). NULL = no screenshot captured; never '''' and never a fabricated path.';
COMMENT ON COLUMN prompt_results.evidence_dom_id IS
  'v2 §3.7 evidence.dom_id: object key of the gzipped rendered HTML in `probe-evidence`. NULL = not captured.';
COMMENT ON COLUMN prompt_results.evidence_har_id IS
  'v2 §3.7 evidence.har_id: object key of the HAR capture in `probe-evidence`. NULL = not captured.';
COMMENT ON COLUMN prompt_results.evidence_raw_id IS
  'v2 §3.7 evidence.raw_id: object key of the raw vendor response in `probe-evidence`. Required by the contract for engine_surface = ''api''. NULL = not captured.';
COMMENT ON COLUMN prompt_results.evidence_captured_at IS
  'The §3.1 probed_at of the probe that took the capture. Written only when at least one evidence id is non-NULL. Not created_at, which is when the ingest row landed.';
