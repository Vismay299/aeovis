// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/ai-tracking.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../http/appError.ts";
import { dataforseoGet, dataforseoPost } from "./core.ts";
import {
  assertOk,
  dataforseoEndpoint,
  isNoResultsTask,
  isTaskInProgress,
  isUpstreamFailureStatus,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
} from "./envelope.ts";
import { MAX_TASKS_PER_POST } from "./shared.ts";
import {
  aiEngineUsesModelApi,
  type AiEngine,
  type AiModelApiEngine,
} from "../../../shared/ai-visibility-pricing.ts";

export const AI_TRACKING_ENDPOINTS: Record<
  Exclude<AiEngine, AiModelApiEngine>,
  string
> = {
  chatgpt: "/v3/ai_optimization/chat_gpt/llm_scraper",
  gemini: "/v3/ai_optimization/gemini/llm_scraper",
  google_ai_overview: "/v3/serp/google/organic",
};

export type AiTrackingTaskInput = {
  tag: string;
  prompt: string;
};

export type AiTrackingMarket = {
  locationCode: number;
  languageCode: string;
};

export interface PostedAiTrackingTask {
  tag: string;
  taskId: string;
}

export type RejectedAiTrackingTask = {
  tag: string;
  statusCode: number;
  message: string;
  costUsd: number;
};

export type AiTrackingAnswer =
  | {
      status: "failed";
      message: string;
      code: "dataforseo_unavailable" | "dataforseo_task_failed";
      retryable: boolean;
      statusCode?: number;
    }
  | { status: "completed"; result: unknown; statusCode?: number };

export type AiTrackingTaskOutcome =
  | { status: "pending" }
  | (AiTrackingAnswer & { costUsd?: number });

const LIVE_REQUEST_TIMEOUT_MS = 140_000;

function trackingEndpoint(engine: AiEngine): string {
  if (aiEngineUsesModelApi(engine)) {
    throw new AppError(
      422,
      "dataforseo_engine_not_supported",
      "This engine uses the LLM Responses endpoint and cannot use the scraper queue.",
    );
  }
  return AI_TRACKING_ENDPOINTS[engine];
}

export function providerLanguageCode(engine: AiEngine, languageCode: string): string {
  if (engine === "google_ai_overview") return languageCode;
  if (languageCode === "nb") return "no";
  if (languageCode === "tl") return "fil";
  if (languageCode === "pt" && engine !== "chatgpt") return "pt-BR";
  return languageCode;
}

export function aiTrackingTaskBody(
  engine: AiEngine,
  market: AiTrackingMarket,
  task: AiTrackingTaskInput,
): Record<string, unknown> {
  return {
    keyword: task.prompt.replace(/%/g, "%25").replace(/\+/g, "%2B"),
    location_code: market.locationCode,
    language_code: providerLanguageCode(engine, market.languageCode),
    ...(engine === "google_ai_overview"
      ? { depth: 10, load_async_ai_overview: true }
      : {}),
    tag: task.tag,
  };
}

function finiteCost(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function taskTag(task: DataforseoTaskLike): string | null {
  return typeof task.data?.tag === "string" ? task.data.tag : null;
}

export async function postAiTrackingTasks(
  input: AiTrackingMarket & {
    engine: AiEngine;
    tasks: AiTrackingTaskInput[];
  },
): Promise<DataforseoApiResponse<{
  posted: PostedAiTrackingTask[];
  rejected: RejectedAiTrackingTask[];
}>> {
  if (input.tasks.length < 1 || input.tasks.length > MAX_TASKS_PER_POST) {
    throw new AppError(
      422,
      "dataforseo_task_count_invalid",
      "task_post accepts 1-" + MAX_TASKS_PER_POST + " tasks.",
    );
  }
  const endpoint = trackingEndpoint(input.engine) + "/task_post";
  const response = await dataforseoPost<
    DataforseoTaskLike & { id?: string; data?: Record<string, unknown> }
  >(
    endpoint,
    input.tasks.map((task) => aiTrackingTaskBody(input.engine, input, task)),
  );

  if (!response || response.status_code !== 20000) {
    assertOk(response, { classifyPath: endpoint });
  }

  const posted: PostedAiTrackingTask[] = [];
  const rejected: RejectedAiTrackingTask[] = [];
  let costUsd = 0;

  for (const entry of response?.tasks ?? []) {
    const entryCost = finiteCost(entry.cost);
    costUsd += entryCost;
    const tag = taskTag(entry);
    if (entry.status_code === 20100 && entry.id && tag !== null) {
      posted.push({ tag, taskId: entry.id });
      continue;
    }
    rejected.push({
      tag: tag ?? "",
      statusCode: entry.status_code ?? 0,
      message: entry.status_message ?? "DataForSEO rejected the task.",
      costUsd: entryCost,
    });
  }

  return {
    data: { posted, rejected },
    billing: {
      path: endpoint.slice(1).split("/"),
      costUsd,
    },
  };
}

export async function fetchAiTrackingTaskResult(input: {
  engine: AiEngine;
  taskId: string;
}): Promise<AiTrackingTaskOutcome> {
  const endpoint =
    trackingEndpoint(input.engine) +
    "/task_get/advanced/" +
    encodeURIComponent(input.taskId);
  const response = await dataforseoGet(endpoint);
  const task = response?.tasks?.[0];
  if (!response || response.status_code !== 20000 || !task) {
    assertOk(response, { classifyPath: endpoint });
    throw new AppError(502, "dataforseo_bad_response", "DataForSEO task_get omitted its task.");
  }
  if (isTaskInProgress(task)) return { status: "pending" };
  const answer = aiTrackingAnswer(task);
  return { ...answer, costUsd: finiteCost(task.cost) };
}

function aiTrackingAnswer(task: DataforseoTaskLike): AiTrackingAnswer {
  const statusCode = typeof task.status_code === "number" ? { statusCode: task.status_code } : {};
  if (task.status_code !== 20000) {
    if (isNoResultsTask(task)) return { status: "completed", result: null, ...statusCode };
    const retryable = isUpstreamFailureStatus(task.status_code);
    return {
      status: "failed",
      message: task.status_message || "DataForSEO task failed.",
      code: retryable ? "dataforseo_unavailable" : "dataforseo_task_failed",
      retryable,
      ...statusCode,
    };
  }
  return { status: "completed", result: task.result?.[0] ?? null, ...statusCode };
}

export async function fetchAiTrackingLiveAnswer(
  input: AiTrackingMarket & {
    engine: AiEngine;
    task: AiTrackingTaskInput;
  },
): Promise<DataforseoApiResponse<AiTrackingAnswer>> {
  const endpoint = trackingEndpoint(input.engine) + "/live/advanced";
  const response = await dataforseoPost<
    DataforseoTaskLike & { result?: unknown[] | null }
  >(
    endpoint,
    [aiTrackingTaskBody(input.engine, input, input.task)],
    { timeoutMs: LIVE_REQUEST_TIMEOUT_MS },
  );
  const task = response?.tasks?.[0];
  if (!response || response.status_code !== 20000 || !task) {
    assertOk(response, { classifyPath: endpoint });
    throw new AppError(502, "dataforseo_bad_response", "DataForSEO live response omitted its task.");
  }
  return {
    data: aiTrackingAnswer(task),
    billing: {
      path: endpoint.slice(1).split("/"),
      costUsd: finiteCost(task.cost),
    },
  };
}

export function dataforseoPathForEngine(engine: AiEngine): string {
  return dataforseoEndpoint(trackingEndpoint(engine));
}
