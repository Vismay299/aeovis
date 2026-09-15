-- 017: cost_unmeasured_calls on scans (R3.6.8).
-- Plan: R3.6.8 — the counter stats.cost_unmeasured_calls is written by
-- openai.js/noteUnmeasuredCost but never reaches the persisted scan row,
-- so a run where nothing could be priced looks identical to a run that
-- genuinely cost nothing. This column makes the two distinguishable.
-- Safe to re-run.

ALTER TABLE scans ADD COLUMN IF NOT EXISTS cost_unmeasured_calls integer DEFAULT 0;
