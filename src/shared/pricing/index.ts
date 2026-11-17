import { toMicros } from "../spend/money.ts";

export { PRICE_TABLE_VERSION } from "./version.ts";

export {
  BACKLINKS_DEFAULT_LIMIT,
  BACKLINKS_ROW_USD,
  BACKLINKS_TASK_USD,
  BUSINESS_LISTINGS_ROW_USD,
  BUSINESS_LISTINGS_TASK_USD,
  EXTENDED_REVIEWS_PRIORITY_PER_20_USD,
  GOOGLE_ADS_LIVE_TASK_USD,
  LABS_ROW_USD,
  LABS_TASK_USD,
  LIGHTHOUSE_LIVE_USD,
  LIVE_BASE_PAGE_COST_USD,
  LIVE_EXTRA_PAGE_COST_USD,
  LLM_MENTIONS_ROW_USD,
  LLM_MENTIONS_TASK_USD,
  LOCAL_SERP_PAGE_USD,
  LOCAL_SERP_TASK_USD,
  MY_BUSINESS_INFO_LIVE_USD,
  QUESTIONS_ANSWERS_PER_20_USD,
  QUEUED_BASE_PAGE_COST_USD,
  QUEUED_EXTRA_PAGE_COST_USD,
  REVIEWS_PRIORITY_PER_10_USD,
  REVIEWS_PRIORITY_TASK_USD,
  SERP_ANALYSIS_DEPTH,
  SERP_OPERATOR_KEYWORD_MULTIPLIER,
  UPDATES_PRIORITY_PER_10_USD,
  UPDATES_PRIORITY_TASK_USD,
  clampSerpDepth,
  costPerSerpAtDepth,
  dataforseoPricing,
  llmResponseUsd,
  resolveLlmMentionsLimit,
  serpKeywordCostMultiplier,
} from "./dataforseo.ts";

export {
  AI_ENGINE_LABELS,
  AI_LIVE_RECORD_COST_USD,
  AI_RECORD_COST_USD,
  LLM_RESPONSE_USD,
  aiAnswerUsd,
  aiCostForAnswers,
  aiEngineUsesModelApi,
  scheduledChecksPerMonth,
} from "../ai-visibility-pricing.ts";
export type {
  AiEngine,
  AiModelApiEngine,
  AiScheduleInterval,
  LlmResponseModelSlug,
  PerceevEngine,
} from "../ai-visibility-pricing.ts";

export { formatUsd } from "../money.ts";

export {
  PERCEEV_ENGINE_PROVIDERS,
  aioMaxQueriesPerAttempt,
  engineProvider,
  modelCallUsd,
  serpQueryUsd,
  toolFeeUsd,
} from "./perceev.ts";
export type { PriceEnv, SerpPriceProvider } from "./perceev.ts";

/**
 * How a settled actual compares with the estimate the call was held at. A
 * stale price constant surfaces as an undershoot, never as a silent pass; the
 * comparison is exact in micro-dollars, the ledger's own unit.
 */
export function costAccuracy(
  estimateUsd: number,
  actualUsd: number | null,
): "unknown" | "within" | "undershoot" {
  if (actualUsd === null) return "unknown";
  return toMicros(actualUsd) > toMicros(estimateUsd) ? "undershoot" : "within";
}
