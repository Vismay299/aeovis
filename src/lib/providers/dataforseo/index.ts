// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/index.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export {
  createDataforseoClient,
  meter,
  meterBatch,
  type DataforseoCallContext,
  type Metered,
  type MeteredBatch,
  type DataforseoClientDeps,
} from "./client.ts";

export {
  fetchLiveSerp,
  fetchRankCheckSerp,
  postRankCheckTasks,
  fetchRankCheckTaskResult,
  fetchLocalSerp,
  postLocalSerpTasks,
  fetchLocalSerpTaskResult,
  SERP_ANALYSIS_DEPTH,
  clampSerpDepth,
  type SerpLiveItem,
  type RankCheckResult,
  type RankCheckTaskInput,
  type PostedRankCheckTask,
  type LocalSerpTaskOutcome,
  type RankCheckTaskOutcome,
  type FetchLiveSerpInput,
  type FetchRankCheckSerpInput,
  type PostRankCheckInput,
  type LocalSerpInput,
  type PostLocalSerpInput,
} from "./serp.ts";

export {
  CHATGPT_LOCATION_CODE,
  CHATGPT_LANGUAGE_CODE,
  MAX_TASKS_PER_POST,
  buildLlmTarget,
  type LlmPlatform,
  type LlmTarget,
} from "./shared.ts";

export {
  DATAFORSEO_API_BASE,
  DATAFORSEO_SANDBOX_BASE,
  dataforseoPost,
  dataforseoGet,
  type DataforseoRequestOptions,
  type DataforseoErrorClassifier,
} from "./core.ts";

export {
  assertOk,
  buildTaskBilling,
  dataforseoEndpoint,
  type DataforseoApiResponse,
  type DataforseoApiCallCost,
  type DataforseoTaskLike,
  type DataforseoResponseLike,
  type DataforseoItemsResult,
  type DataforseoItemsTask,
} from "./envelope.ts";

export { fetchUserData } from "./appendix.ts";

export {
  DATAFORSEO_LOCATION_BY_COUNTRY,
  ISO_BY_COUNTRY,
  dataforseoMarket,
} from "./locations.ts";
