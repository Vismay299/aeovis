// Scoring weights and parameters for the Visibility Score calculation.
// Phase 1: Composite Weighted Score.

export const POSITION_WEIGHTS = {
  recommended: 1.0,
  compared: 0.6,
  cited: 0.3,
  omitted: 0.0,
};

export const SENTIMENT_WEIGHTS = {
  positive: 1.0,
  neutral: 0.5,
  negative: 0.0,
};

export const CITATION_BONUS = 0.15;
export const CITATION_SHARE_WEIGHT = 0.15;

export const SCORING_VERSION = "v5-multi-engine";
export const PROBE_TEMPERATURE = 0.4;
const parsedRuns = parseInt(process.env.PROBE_RUNS, 10);
export const PROBE_RUNS = Number.isFinite(parsedRuns) && parsedRuns >= 1 ? parsedRuns : 3;

export const INTENT_WEIGHTS = {
  high_intent: 3.0,
  comparison: 2.0,
  problem_aware: 1.5,
  exploratory: 1.0,
  branded: 0.5,
};
