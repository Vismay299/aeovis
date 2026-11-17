// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/ai.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { AppError } from "../../http/appError.ts";
import { dataforseoPost } from "./core.ts";
import { createDataforseoBillingClassifier } from "./billingClassification.ts";
import {
  assertOk,
  buildTaskBilling,
  isRecord,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
} from "./envelope.ts";
import {
  llmAggregatedTotalSchema,
  llmCrossAggregatedItemSchema,
  llmMentionItemSchema,
  llmResponseResultSchema,
  llmTopPagesItemSchema,
  type LlmAggregatedTotal,
  type LlmCrossAggregatedItem,
  type LlmMentionItem,
  type LlmResponseResult,
  type LlmTopPagesItem,
} from "./llmSchemas.ts";
import { isKnownLlmModelName, type LlmResponseModelSlug } from "./llm-models.ts";
import type { LlmPlatform, LlmTarget } from "./shared.ts";
import { supportsWebSearchCountry } from "../../web-search-countries.ts";

const classifyAiSearchError = createDataforseoBillingClassifier({
  pathPrefix: "/ai_optimization/",
  billingIssueCode: "dataforseo_balance",
  billingIssueMessage: "The connected DataForSEO account has a billing or balance issue.",
});

function assertOptions(path: string) {
  return { classify: classifyAiSearchError, classifyPath: path };
}

function clampLimit(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function resolveLlmMentionsLimit(limit?: number): number {
  return clampLimit(limit ?? 100, 1, 1000);
}

export const LLM_RESPONSE_WEB_SEARCH_DEFAULT = true;

function targetList(target: LlmTarget): LlmTarget[] {
  return [target];
}

function firstResult(task: DataforseoTaskLike): Record<string, unknown> | null {
  const first = task.result?.[0];
  return isRecord(first) ? first : null;
}

export type LlmMentionsSearchInput = {
  target: LlmTarget;
  platform: LlmPlatform;
  locationCode: number;
  languageCode: string;
  limit?: number;
  orderBy?: string[];
};

export async function fetchLlmMentionsSearch(
  input: LlmMentionsSearchInput,
): Promise<DataforseoApiResponse<LlmMentionItem[]>> {
  const path = "/v3/ai_optimization/llm_mentions/search/live";
  const response = await dataforseoPost(
    path,
    [{
      target: targetList(input.target),
      platform: input.platform,
      location_code: input.locationCode,
      language_code: input.languageCode,
      limit: resolveLlmMentionsLimit(input.limit),
      order_by: input.orderBy,
    }],
    { classify: classifyAiSearchError },
  );
  const task = assertOk(response, assertOptions(path));
  const parsed = z.array(llmMentionItemSchema).safeParse(firstResult(task)?.items ?? []);
  if (!parsed.success) {
    throw new AppError(502, "dataforseo_bad_response", "DataForSEO llm_mentions/search returned an invalid shape.");
  }
  return { data: parsed.data, billing: buildTaskBilling(task) };
}

export type LlmAggregatedMetricsInput = {
  target: LlmTarget;
  platform: LlmPlatform;
  locationCode: number;
  languageCode: string;
  internalListLimit?: number;
};

export async function fetchLlmAggregatedMetrics(
  input: LlmAggregatedMetricsInput,
): Promise<DataforseoApiResponse<LlmAggregatedTotal>> {
  const path = "/v3/ai_optimization/llm_mentions/aggregated_metrics/live";
  const response = await dataforseoPost(
    path,
    [{
      target: targetList(input.target),
      platform: input.platform,
      location_code: input.locationCode,
      language_code: input.languageCode,
      internal_list_limit: clampLimit(input.internalListLimit ?? 10, 1, 20),
    }],
    { classify: classifyAiSearchError },
  );
  const task = assertOk(response, assertOptions(path));
  const parsed = llmAggregatedTotalSchema.safeParse(firstResult(task)?.total ?? {});
  if (!parsed.success) {
    throw new AppError(502, "dataforseo_bad_response", "DataForSEO llm_mentions/aggregated_metrics returned an invalid shape.");
  }
  return { data: parsed.data, billing: buildTaskBilling(task) };
}

export type LlmTopPagesInput = {
  target: LlmTarget;
  platform: LlmPlatform;
  locationCode: number;
  languageCode: string;
  itemsListLimit?: number;
};

export async function fetchLlmTopPages(
  input: LlmTopPagesInput,
): Promise<DataforseoApiResponse<LlmTopPagesItem[]>> {
  const path = "/v3/ai_optimization/llm_mentions/top_pages/live";
  const response = await dataforseoPost(
    path,
    [{
      target: targetList(input.target),
      platform: input.platform,
      location_code: input.locationCode,
      language_code: input.languageCode,
      links_scope: "sources",
      items_list_limit: clampLimit(input.itemsListLimit ?? 10, 1, 10),
      internal_list_limit: 5,
    }],
    { classify: classifyAiSearchError },
  );
  const task = assertOk(response, assertOptions(path));
  const parsed = z.array(llmTopPagesItemSchema).safeParse(firstResult(task)?.items ?? []);
  if (!parsed.success) {
    throw new AppError(502, "dataforseo_bad_response", "DataForSEO llm_mentions/top_pages returned an invalid shape.");
  }
  return { data: parsed.data, billing: buildTaskBilling(task) };
}

export type LlmCrossAggregatedMetricsInput = {
  groups: Array<{ key: string; target: LlmTarget }>;
  platform: LlmPlatform;
  locationCode: number;
  languageCode: string;
  internalListLimit?: number;
};

export async function fetchLlmCrossAggregatedMetrics(
  input: LlmCrossAggregatedMetricsInput,
): Promise<DataforseoApiResponse<LlmCrossAggregatedItem[]>> {
  if (input.groups.length < 2 || input.groups.length > 10) {
    throw new AppError(
      422,
      "dataforseo_target_count_invalid",
      "DataForSEO llm_mentions/cross_aggregated_metrics requires 2 to 10 target groups.",
    );
  }
  const path = "/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live";
  const response = await dataforseoPost(
    path,
    [{
      targets: input.groups.map((group) => ({
        aggregation_key: group.key,
        target: targetList(group.target),
      })),
      platform: input.platform,
      location_code: input.locationCode,
      language_code: input.languageCode,
      internal_list_limit: clampLimit(input.internalListLimit ?? 5, 1, 10),
    }],
    { classify: classifyAiSearchError },
  );
  const task = assertOk(response, assertOptions(path));
  const parsed = z.array(llmCrossAggregatedItemSchema).safeParse(firstResult(task)?.items ?? []);
  if (!parsed.success) {
    throw new AppError(502, "dataforseo_bad_response", "DataForSEO llm_mentions/cross_aggregated_metrics returned an invalid shape.");
  }
  return { data: parsed.data, billing: buildTaskBilling(task) };
}

export type LlmResponsesInput = {
  userPrompt: string;
  modelSlug: LlmResponseModelSlug;
  modelName: string;
  webSearch?: boolean;
  maxOutputTokens?: number;
  webSearchCountryCode?: string;
  timeoutMs?: number;
};

type LlmResponseRequestFields = {
  user_prompt: string;
  model_name: string;
  web_search: boolean;
  force_web_search?: boolean;
  max_output_tokens: number;
  web_search_country_iso_code?: string;
};

export async function fetchLlmResponse(
  input: LlmResponsesInput,
): Promise<DataforseoApiResponse<LlmResponseResult>> {
  if (!(await isKnownLlmModelName(input.modelSlug, input.modelName))) {
    throw new AppError(
      422,
      "dataforseo_model_unsupported",
      "The requested DataForSEO model is not listed in the provider catalogue.",
    );
  }

  const webSearch = input.webSearch ?? LLM_RESPONSE_WEB_SEARCH_DEFAULT;
  if (
    webSearch &&
    input.webSearchCountryCode &&
    !supportsWebSearchCountry(input.modelSlug, input.webSearchCountryCode)
  ) {
    throw new AppError(
      422,
      "dataforseo_country_unsupported",
      "The requested web-search country is not supported for this model.",
    );
  }

  const fields: LlmResponseRequestFields = {
    user_prompt: input.userPrompt,
    model_name: input.modelName,
    web_search: webSearch,
    ...(webSearch && input.modelSlug === "claude"
      ? { force_web_search: true }
      : {}),
    max_output_tokens: clampLimit(input.maxOutputTokens ?? 1024, 256, 4096),
    ...(webSearch && input.webSearchCountryCode && input.modelSlug !== "gemini"
      ? { web_search_country_iso_code: input.webSearchCountryCode }
      : {}),
  };

  const path = "/v3/ai_optimization/" + input.modelSlug + "/llm_responses/live";
  const response = await dataforseoPost(path, [fields], {
    classify: classifyAiSearchError,
    timeoutMs: input.timeoutMs,
  });
  const task = assertOk(response, assertOptions(path));
  const parsed = llmResponseResultSchema.safeParse(firstResult(task) ?? {});
  if (!parsed.success) {
    throw new AppError(502, "dataforseo_bad_response", "DataForSEO llm_responses returned an invalid response shape.");
  }
  return { data: parsed.data, billing: buildTaskBilling(task) };
}
