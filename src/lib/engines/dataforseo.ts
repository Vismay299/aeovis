import { AppError } from "../http/appError.ts";
import { normalizeUrl, extractBrandDomain } from "../scoring/citations.js";
import { classifyProviderFailure, sanitizeProviderText } from "./providerFailure.js";
import { dataforseoMarket, type ISO_BY_COUNTRY } from "../providers/dataforseo/locations.ts";
import { providerLanguageCode } from "../providers/dataforseo/ai-tracking.ts";
import {
  parseDataforseoAnswer,
  parseLlmResponseAnswer,
  type ParsedAiAnswer,
} from "../providers/dataforseo/dataforseoEvidence.ts";
import {
  resolveLatestLlmModelName,
  type LlmResponseModelSlug,
} from "../providers/dataforseo/llm-models.ts";
import { dataforseoPost } from "../providers/dataforseo/core.ts";
import {
  assertOk,
  isNoResultsTask,
  type DataforseoTaskLike,
} from "../providers/dataforseo/envelope.ts";
import { llmResponseResultSchema } from "../providers/dataforseo/llmSchemas.ts";

export type DataforseoRouteMode =
  | "scraper_live"
  | "scraper_queued"
  | "serp_live"
  | "serp_queued"
  | "model_live";

export type DfsProbeOptions = {
  stats?: object;
  deadlineAt?: number;
  measurementContext: { country: string; language: string };
  captureEvidence?: (i: {
    payload: unknown;
    provider: "dataforseo";
    surface: string;
    requestId: string | null;
  }) => Promise<void>;
  model?: string | null; // frozen llm_responses model name
  webSearch?: boolean; // llm_responses only; default true (scans always true; F11 may pass false)
  countryIso?: string | null; // llm_responses web_search_country_iso_code; default ISO_BY_COUNTRY[measurementContext.country]; null = none
  maxOutputTokens?: number; // llm_responses only; default 4096 (clamped 256-4096)
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
};

export interface TextProbeResult {
  text: string;
  answer_markdown: string | null;
  citations: string[];
  references: Array<{ href: string; title: string; source: string; domain?: string }>;
  model: string | null;
  requested_model: string | null;
  returned_model: string | null;
  provider_request_id: string | null;
  provider_task_id: string | null;
  search_requests: number | null;
  cost: number | null;
  cost_source: "gateway" | null;
  cost_state: "measured" | "unknown_billed" | "probe_failed" | null;
  cost_state_detail: string | null;
  error: string | null;
  error_kind: string | null;
  provider_failure: unknown | null;
  citations_state: "verified" | "unverified" | null;
  citations_state_reason: string | null;
  citations_state_detail: string | null;
  gateway: "dataforseo";
  measurement_method: "consumer_capture" | "model_api" | "google_serp";
  fan_out_queries: string[];
  output_tokens: number | null;
  web_search: boolean | null;
  location_code: number | null;
}

export type AioSerpData = {
  task: { id: string; cost: number | null; data?: unknown };
  parsedAnswer: ParsedAiAnswer | null;
  items: unknown[];
  organic: Array<{ rank_group: number; domain: string; url: string }>;
  serp_state: "valid_serp" | "unknown_schema";
  aio_present: boolean;
  cost: number | null;
  gateway: "dataforseo";
  provider_request_id: string | null;
  location_code: number | null;
};

export type DataforseoMarket = {
  locationCode: number;
  languageCode: string;
  isoCountry: string;
};

export type PostOutcome = {
  posted: Array<{ observationId: string; taskId: string }>;
  rejected: Array<{ observationId: string; statusCode: number; message: string; costUsd: number }>;
  costUsd: number;
};

export type CollectOutcome =
  | { status: "pending" }
  | { status: "completed"; result: unknown; statusCode?: number; costUsd?: number }
  | { status: "failed"; message: string; statusCode?: number; costUsd?: number };

type DataforseoEngineTask = DataforseoTaskLike & {
  id?: string;
  status_code?: number;
  status_message?: string;
  cost?: number;
  data?: Record<string, unknown>;
  result?: unknown[] | null;
};

function updateStats(stats: object | undefined, cost: number | null): void {
  if (!stats) return;
  const s = stats as Record<string, unknown>;
  if (cost !== null) {
    s.cost = (Number(s.cost) || 0) + cost;
  } else {
    s.cost_unmeasured_calls = (Number(s.cost_unmeasured_calls) || 0) + 1;
  }
}

export function dataforseoTextResult(
  engine: string,
  answer: ParsedAiAnswer,
  task: { id: string; cost?: number | null; data?: unknown },
  meta: {
    method: "consumer_capture" | "model_api";
    requestedModel: string | null;
    returnedModel: string | null;
    webSearch: boolean | null;
    fanOut: string[];
    outputTokens: number | null;
    locationCode?: number | null;
  },
): TextProbeResult {
  const references = (answer.citations || []).map((c) => ({
    href: c.url,
    title: c.title ?? "",
    source: c.domain,
  }));
  const citations = references
    .map((r) => normalizeUrl(r.href))
    .filter((url): url is string => Boolean(url));

  const hasReferences = references.length > 0;
  const citationsState = hasReferences ? "verified" : "unverified";
  const citationsStateReason = hasReferences
    ? null
    : meta.webSearch === false
      ? "web_search_not_used"
      : "none_returned";

  const requestedModel =
    meta.requestedModel ??
    (meta.method === "consumer_capture"
      ? `dataforseo:llm_scraper:${engine}`
      : null);
  const returnedModel = meta.returnedModel ?? null;
  const model = returnedModel ?? requestedModel;

  const cost =
    typeof task.cost === "number" && Number.isFinite(task.cost) ? task.cost : null;
  const costState = cost !== null ? "measured" : "unknown_billed";

  const searchRequests =
    meta.method === "consumer_capture"
      ? null
      : meta.webSearch === true
        ? 1
        : 0;

  return {
    text: answer.answerText ?? "",
    answer_markdown: answer.answerMarkdown ?? null,
    citations,
    references,
    model,
    requested_model: requestedModel,
    returned_model: returnedModel,
    provider_request_id: task.id || null,
    provider_task_id: task.id || null,
    search_requests: searchRequests,
    cost,
    cost_source: cost !== null ? "gateway" : null,
    cost_state: costState,
    cost_state_detail: null,
    error: null,
    error_kind: null,
    provider_failure: null,
    citations_state: citationsState,
    citations_state_reason: citationsStateReason,
    citations_state_detail: null,
    gateway: "dataforseo",
    measurement_method: meta.method,
    fan_out_queries: meta.fanOut ?? [],
    output_tokens: meta.outputTokens ?? null,
    web_search: meta.webSearch,
    location_code: meta.locationCode ?? null,
  };
}

function failureTextResult(
  engine: string,
  method: "consumer_capture" | "model_api",
  requestedModel: string | null,
  err: unknown,
  task?: { id?: string; cost?: number },
  locationCode?: number | null,
): TextProbeResult {
  const failure = classifyProviderFailure({ provider: "dataforseo", error: err });
  const message =
    sanitizeProviderText((err as any)?.message || failure.message) ||
    "DataForSEO probe failed";
  const cost =
    typeof task?.cost === "number" && Number.isFinite(task.cost) ? task.cost : null;
  return {
    text: "",
    answer_markdown: null,
    citations: [],
    references: [],
    model: requestedModel,
    requested_model: requestedModel,
    returned_model: null,
    provider_request_id: task?.id || null,
    provider_task_id: task?.id || null,
    search_requests: method === "consumer_capture" ? null : 0,
    cost,
    cost_source: cost !== null ? "gateway" : null,
    cost_state: cost !== null ? "measured" : "probe_failed",
    cost_state_detail: message,
    error: message,
    error_kind: failure.kind,
    provider_failure: failure,
    citations_state: null,
    citations_state_reason: null,
    citations_state_detail: null,
    gateway: "dataforseo",
    measurement_method: method,
    fan_out_queries: [],
    output_tokens: null,
    web_search: null,
    location_code: locationCode ?? null,
  };
}

export async function probeDataforseoScraper(
  engine: "chatgpt" | "gemini",
  query: string,
  o: DfsProbeOptions,
): Promise<TextProbeResult> {
  const requestedModel = `dataforseo:llm_scraper:${engine}`;
  let taskInfo: { id?: string; cost?: number } | undefined;
  let locationCode: number | null = null;

  try {
    const market = dataforseoMarket(o.measurementContext);
    locationCode = market.locationCode;

    const apiEngine = engine === "chatgpt" ? "chat_gpt" : "gemini";
    const path = `/v3/ai_optimization/${apiEngine}/llm_scraper/live/advanced`;

    const body = [
      {
        keyword: query.replace(/%/g, "%25").replace(/\+/g, "%2B"),
        location_code: market.locationCode,
        language_code: providerLanguageCode(engine, market.languageCode),
      },
    ];

    const response = await dataforseoPost<DataforseoEngineTask>(path, body, {
      timeoutMs: 140_000,
      env: o.env,
      fetchImpl: o.fetchImpl,
    });

    const task = response?.tasks?.[0];
    if (task) {
      taskInfo = { id: task.id, cost: typeof task.cost === "number" ? task.cost : undefined };
    }

    if (!response || response.status_code !== 20000 || !task) {
      assertOk(response, { classifyPath: path });
      throw new AppError(502, "dataforseo_bad_response", "DataForSEO live response omitted its task.");
    }

    if (o.captureEvidence) {
      await o.captureEvidence({
        payload: task,
        provider: "dataforseo",
        surface: engine,
        requestId: task.id || null,
      });
    }

    if (task.status_code !== 20000) {
      if (!isNoResultsTask(task)) {
        throw new AppError(
          502,
          "dataforseo_task_failed",
          task.status_message || "DataForSEO task failed.",
          { details: { providerCode: `dataforseo_${task.status_code}` } },
        );
      }
    }

    const parsed = parseDataforseoAnswer(task.result?.[0] ?? null, engine);
    const result = dataforseoTextResult(
      engine,
      parsed ?? {
        answerMarkdown: null,
        answerText: "",
        citations: [],
        collectedAt: null,
        fanOutQueries: [],
        outputTokens: null,
        webSearch: false,
        modelName: null,
      },
      { id: task.id || "", cost: task.cost, data: task.data },
      {
        method: "consumer_capture",
        requestedModel,
        returnedModel: null,
        webSearch: null,
        fanOut: [],
        outputTokens: null,
        locationCode: market.locationCode,
      },
    );

    updateStats(o.stats, result.cost);
    return result;
  } catch (err) {
    const failureResult = failureTextResult(
      engine,
      "consumer_capture",
      requestedModel,
      err,
      taskInfo,
      locationCode,
    );
    updateStats(o.stats, failureResult.cost);
    return failureResult;
  }
}

export async function probeDataforseoModel(
  engine: "perplexity" | "chatgpt" | "gemini",
  query: string,
  o: DfsProbeOptions,
): Promise<TextProbeResult> {
  const slug: LlmResponseModelSlug = engine === "chatgpt" ? "chat_gpt" : engine;
  let modelName = o.model ?? null;
  let taskInfo: { id?: string; cost?: number } | undefined;
  let locationCode: number | null = null;

  try {
    const market = o.measurementContext ? dataforseoMarket(o.measurementContext) : null;
    locationCode = market?.locationCode ?? null;

    if (!modelName) {
      modelName = await resolveLatestLlmModelName(slug, {
        env: o.env,
        fetchImpl: o.fetchImpl,
      });
    }

    const webSearch = o.webSearch ?? true;
    const countryIso =
      o.countryIso !== undefined
        ? o.countryIso
        : market?.isoCountry ?? null;
    const maxOutputTokens = Math.min(
      4096,
      Math.max(256, Math.floor(o.maxOutputTokens ?? 4096)),
    );

    const fields: Record<string, unknown> = {
      user_prompt: query,
      model_name: modelName,
      web_search: webSearch,
      max_output_tokens: maxOutputTokens,
      ...(webSearch && countryIso && slug !== "gemini"
        ? { web_search_country_iso_code: countryIso }
        : {}),
    };

    const path = `/v3/ai_optimization/${slug}/llm_responses/live`;
    const response = await dataforseoPost<DataforseoEngineTask>(path, [fields], {
      timeoutMs: 100_000,
      env: o.env,
      fetchImpl: o.fetchImpl,
    });

    const task = response?.tasks?.[0];
    if (task) {
      taskInfo = { id: task.id, cost: typeof task.cost === "number" ? task.cost : undefined };
    }

    const okTask = assertOk(response, { classifyPath: path });

    if (o.captureEvidence) {
      await o.captureEvidence({
        payload: okTask,
        provider: "dataforseo",
        surface: engine,
        requestId: okTask.id || null,
      });
    }

    const first = okTask.result?.[0];
    const parsedSchema = llmResponseResultSchema.safeParse(first ?? {});
    if (!parsedSchema.success) {
      throw new AppError(
        502,
        "dataforseo_bad_response",
        "DataForSEO llm_responses returned an invalid response shape.",
      );
    }

    const answer = parseLlmResponseAnswer(parsedSchema.data);
    const result = dataforseoTextResult(
      engine,
      answer,
      { id: okTask.id || "", cost: okTask.cost, data: okTask.data },
      {
        method: "model_api",
        requestedModel: modelName,
        returnedModel: answer.modelName,
        webSearch: answer.webSearch,
        fanOut: answer.fanOutQueries,
        outputTokens: answer.outputTokens,
        locationCode,
      },
    );

    updateStats(o.stats, result.cost);
    return result;
  } catch (err) {
    const failureResult = failureTextResult(
      engine,
      "model_api",
      modelName,
      err,
      taskInfo,
      locationCode,
    );
    updateStats(o.stats, failureResult.cost);
    return failureResult;
  }
}

export async function fetchDataforseoAioSerp(
  query: string,
  o: DfsProbeOptions,
): Promise<AioSerpData> {
  const market = dataforseoMarket(o.measurementContext);
  const path = "/v3/serp/google/organic/live/advanced";

  const fields = {
    keyword: query.replace(/%/g, "%25").replace(/\+/g, "%2B"),
    location_code: market.locationCode,
    language_code: providerLanguageCode("google_ai_overview", market.languageCode),
    depth: 10,
    load_async_ai_overview: true,
  };

  const response = await dataforseoPost<DataforseoEngineTask & {
    result?: Array<{ items?: unknown[] }> | null;
  }>(path, [fields], {
    timeoutMs: 140_000,
    env: o.env,
    fetchImpl: o.fetchImpl,
  });

  const task = response?.tasks?.[0];
  if (!response || response.status_code !== 20000 || !task) {
    assertOk(response, { classifyPath: path });
    throw new AppError(502, "dataforseo_bad_response", "DataForSEO AIO response omitted its task.");
  }

  if (o.captureEvidence) {
    await o.captureEvidence({
      payload: task,
      provider: "dataforseo",
      surface: "aio",
      requestId: task.id || null,
    });
  }

  if (task.status_code !== 20000) {
    throw new AppError(
      502,
      "dataforseo_task_failed",
      task.status_message || "DataForSEO AIO task failed.",
      { details: { providerCode: `dataforseo_${task.status_code}` } },
    );
  }

  const first = task.result?.[0];
  const items = Array.isArray(first?.items) ? first.items : [];
  if (items.length === 0) {
    throw Object.assign(
      new AppError(502, "dataforseo_empty_serp", "DataForSEO SERP returned no items"),
      { serp_state: "unknown_schema" },
    );
  }

  const organic = items
    .filter((it: any) => it && it.type === "organic")
    .map((it: any) => ({
      rank_group: it.rank_group ?? it.rank_absolute ?? 0,
      domain: it.domain || extractBrandDomain(it.url) || "",
      url: it.url || "",
    }));

  const parsedAnswer = parseDataforseoAnswer(first ?? null, "google_ai_overview");
  const aioPresent = Boolean(parsedAnswer?.answerMarkdown);

  const cost = typeof task.cost === "number" && Number.isFinite(task.cost) ? task.cost : null;
  updateStats(o.stats, cost);

  return {
    task: { id: task.id || "", cost: task.cost ?? null, data: task.data },
    parsedAnswer,
    items,
    organic,
    serp_state: "valid_serp",
    aio_present: aioPresent,
    cost,
    gateway: "dataforseo",
    provider_request_id: task.id || null,
    location_code: market.locationCode,
  };
}

export async function postDataforseoBatch(
  _engine: "chatgpt" | "gemini" | "google_ai_overview",
  _rows: { observationId: string; query: string }[],
  _market: DataforseoMarket,
  _o?: unknown,
): Promise<PostOutcome> {
  throw new Error("postDataforseoBatch is implemented in Phase 4");
}

export async function collectDataforseoTask(
  _engine: unknown,
  _taskId: string,
  _o?: unknown,
): Promise<CollectOutcome> {
  throw new Error("collectDataforseoTask is implemented in Phase 4");
}
