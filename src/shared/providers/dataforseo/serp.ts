// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/serp.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { dataforseoGet, dataforseoPost, type DataforseoRequestOptions } from "./core.ts";
import { MAX_TASKS_PER_POST } from "./shared.ts";
import {
  assertOk,
  buildTaskBilling,
  dataforseoEndpoint,
  invalidFieldName,
  isNoResultsTask,
  isTaskInProgress,
  parseTaskItems,
  type DataforseoApiResponse,
  type DataforseoItemsTask,
  type DataforseoTaskLike,
} from "./envelope.ts";
import { createDataforseoBillingClassifier } from "./billingClassification.ts";
import { AppError } from "../../http/appError.ts";
import { ChargedCallError, UnbilledCallError } from "../../spend/errors.ts";
import { clampSerpDepth, SERP_ANALYSIS_DEPTH } from "../../pricing/dataforseo.ts";

export { clampSerpDepth, SERP_ANALYSIS_DEPTH };

const classifySerpError = createDataforseoBillingClassifier({
  pathPrefix: "/serp/",
  billingIssueCode: "dataforseo_balance",
  billingIssueMessage: "The connected DataForSEO account has a billing or balance issue.",
});

/**
 * Stop crawling SERP pages once the target domain is found — DataForSEO only
 * bills the pages crawled, so a page-1 ranking at depth 20 costs one page
 * instead of two. Matching is restricted to organic results and uses
 * with_subdomains, mirroring buildRankCheckResult exactly.
 */
function stopCrawlOnTarget(targetDomain: string) {
  return {
    stop_crawl_on_match: [
      { match_value: targetDomain, match_type: "with_subdomains" },
    ],
    find_targets_in: ["organic"],
  };
}

const serpSnapshotItemSchema = z
  .object({
    type: z.string(),
    rank_group: z.number().nullable().optional(),
    rank_absolute: z.number().nullable().optional(),
    domain: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    breadcrumb: z.string().nullable().optional(),
    etv: z.number().nullable().optional(),
    estimated_paid_traffic_cost: z.number().nullable().optional(),
    backlinks_info: z
      .object({
        referring_domains: z.number().nullable().optional(),
        backlinks: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    rank_changes: z
      .object({
        previous_rank_absolute: z.number().nullable().optional(),
        is_new: z.boolean().nullable().optional(),
        is_up: z.boolean().nullable().optional(),
        is_down: z.boolean().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type SerpLiveItem = z.infer<typeof serpSnapshotItemSchema>;

export type FetchLiveSerpInput = {
  keyword: string;
  locationCode: number;
  languageCode: string;
  depth?: number;
  locationName?: string;
  device?: "desktop" | "mobile";
};

export async function fetchLiveSerp(
  input: FetchLiveSerpInput,
  options?: DataforseoRequestOptions,
): Promise<DataforseoApiResponse<SerpLiveItem[]>> {
  const device = input.device ?? "desktop";
  const locationParams = input.locationName
    ? { location_name: input.locationName }
    : { location_code: input.locationCode };
  const path = "/v3/serp/google/organic/live/advanced";
  const response = await dataforseoPost(
    path,
    [
      {
        keyword: input.keyword,
        ...locationParams,
        language_code: input.languageCode,
        device,
        os: device === "desktop" ? "windows" : "android",
        depth: clampSerpDepth(input.depth ?? SERP_ANALYSIS_DEPTH),
      },
    ],
    { classify: classifySerpError, ...options },
  );

  const task = assertOk(response, {
    classify: classifySerpError,
    classifyPath: path,
    treatNoResultsAsEmpty: true,
  });

  return {
    data: parseTaskItems(
      "google-organic-live-advanced",
      task,
      serpSnapshotItemSchema,
    ),
    billing: buildTaskBilling(task),
  };
}

export interface RankCheckResult {
  keywordId: string;
  keyword: string;
  position: number | null;
  url: string | null;
  serpFeatures: string[];
}

function buildRankCheckResult(
  input: { keywordId: string; keyword: string; targetDomain: string },
  items: SerpLiveItem[],
): RankCheckResult {
  const target = input.targetDomain.toLowerCase();
  const organicMatch = items.find((item) => {
    if (item.type !== "organic" || item.domain == null) return false;
    const domain = item.domain.toLowerCase();
    return domain === target || domain.endsWith(`.${target}`);
  });

  return {
    keywordId: input.keywordId,
    keyword: input.keyword,
    position: organicMatch
      ? (organicMatch.rank_group ?? organicMatch.rank_absolute ?? null)
      : null,
    url: organicMatch?.url ?? null,
    serpFeatures: [...new Set(items.map((item) => item.type).filter(Boolean))],
  };
}

export type FetchRankCheckSerpInput = {
  keyword: string;
  keywordId: string;
  locationCode: number;
  languageCode: string;
  locationName?: string;
  device: "desktop" | "mobile";
  targetDomain: string;
  depth: number;
};

export async function fetchRankCheckSerp(
  input: FetchRankCheckSerpInput,
  options?: DataforseoRequestOptions,
): Promise<DataforseoApiResponse<RankCheckResult>> {
  const depth = clampSerpDepth(input.depth);
  const locationParams = input.locationName
    ? { location_name: input.locationName }
    : { location_code: input.locationCode };
  const path = "/v3/serp/google/organic/live/advanced";
  const response = await dataforseoPost(
    path,
    [
      {
        keyword: input.keyword,
        ...locationParams,
        language_code: input.languageCode,
        device: input.device,
        os: input.device === "desktop" ? "windows" : "android",
        depth,
        ...stopCrawlOnTarget(input.targetDomain),
      },
    ],
    { classify: classifySerpError, ...options },
  );

  const task = assertOk(response, {
    classify: classifySerpError,
    classifyPath: path,
    treatNoResultsAsEmpty: true,
  });
  const items = parseTaskItems(
    "google-organic-live-advanced",
    task,
    serpSnapshotItemSchema,
  );

  return {
    data: buildRankCheckResult(input, items),
    billing: buildTaskBilling(task),
  };
}

export interface RankCheckTaskInput {
  keyword: string;
  keywordId: string;
  device: "desktop" | "mobile";
}

export interface PostedRankCheckTask extends RankCheckTaskInput {
  taskId: string;
}

export type PostRankCheckInput = {
  tasks: RankCheckTaskInput[];
  locationCode: number;
  languageCode: string;
  locationName?: string;
  depth: number;
  targetDomain: string;
};

export async function postRankCheckTasks(
  input: PostRankCheckInput,
  options?: DataforseoRequestOptions,
): Promise<DataforseoApiResponse<PostedRankCheckTask[]>> {
  if (input.tasks.length === 0 || input.tasks.length > MAX_TASKS_PER_POST) {
    // Unbilled: refused before dispatch, so a metered caller releases the hold.
    throw new UnbilledCallError(
      `task_post accepts 1-${MAX_TASKS_PER_POST} tasks, got ${input.tasks.length}`,
      { status: 400, code: "dataforseo_invalid_request" },
    );
  }
  const depth = clampSerpDepth(input.depth);
  const locationParams = input.locationName
    ? { location_name: input.locationName }
    : { location_code: input.locationCode };
  const path = "/v3/serp/google/organic/task_post";
  const response = await dataforseoPost<
    DataforseoTaskLike & { id?: string; data?: Record<string, unknown> }
  >(
    path,
    input.tasks.map((task) => ({
      keyword: task.keyword,
      ...locationParams,
      language_code: input.languageCode,
      device: task.device,
      os: task.device === "desktop" ? "windows" : "android",
      depth,
      ...stopCrawlOnTarget(input.targetDomain),
      tag: `${task.keywordId}:${task.device}`,
    })),
    { classify: classifySerpError, ...options },
  );

  if (!response || response.status_code !== 20000) {
    if (response) {
      assertOk(response, { classify: classifySerpError, classifyPath: path });
    }
    throw new AppError(502, "dataforseo_bad_response", "DataForSEO task_post failed");
  }

  const byTag = new Map(
    input.tasks.map((task) => [`${task.keywordId}:${task.device}`, task]),
  );
  const posted: PostedRankCheckTask[] = [];
  let costUsd = 0;
  for (const entry of response.tasks ?? []) {
    costUsd += entry.cost ?? 0;
    const tag: unknown = entry.data?.tag;
    const task = typeof tag === "string" ? byTag.get(tag) : undefined;
    if (entry.status_code !== 20100 || !entry.id || !task) {
      console.warn(
        `[dataforseo] task_post rejected entry (${entry.status_code}): ${entry.status_message}`,
      );
      continue;
    }
    posted.push({ ...task, taskId: entry.id });
  }

  return {
    data: posted,
    billing: {
      path: ["v3", "serp", "google", "organic", "task_post"],
      costUsd,
    },
  };
}

export type RankCheckTaskOutcome =
  | { status: "pending" }
  | { status: "failed"; message: string }
  | { status: "completed"; result: RankCheckResult };

export async function fetchRankCheckTaskResult(
  input: {
    taskId: string;
    keywordId: string;
    keyword: string;
    targetDomain: string;
  },
  options?: DataforseoRequestOptions,
): Promise<RankCheckTaskOutcome> {
  const path = `/v3/serp/google/organic/task_get/advanced/${encodeURIComponent(input.taskId)}`;
  const response = await dataforseoGet(path, {
    classify: classifySerpError,
    ...options,
  });
  const task = response?.tasks?.[0];
  if (!response || response.status_code !== 20000 || !task) {
    if (response) {
      assertOk(response, { classify: classifySerpError, classifyPath: path });
    }
    throw new AppError(502, "dataforseo_bad_response", "DataForSEO task_get failed");
  }

  if (isTaskInProgress(task)) {
    return { status: "pending" };
  }

  if (task.status_code !== 20000) {
    if (!isNoResultsTask(task)) {
      return {
        status: "failed",
        message:
          task.status_message || `DataForSEO task failed (${task.status_code})`,
      };
    }
    return {
      status: "completed",
      result: buildRankCheckResult(input, []),
    };
  }

  const items = parseTaskItems(
    "google-organic-task-get-advanced",
    task,
    serpSnapshotItemSchema,
  );
  return { status: "completed", result: buildRankCheckResult(input, items) };
}

export type LocalSerpInput = {
  keyword: string;
  locationCoordinate?: string;
  languageCode: string;
  searchType: "maps" | "local_finder";
  device: "desktop" | "mobile";
  depth: number;
  searchPlaces?: boolean;
};

export async function fetchLocalSerp(
  input: LocalSerpInput,
  options?: DataforseoRequestOptions,
): Promise<DataforseoApiResponse<Record<string, unknown>[]>> {
  const os = input.device === "desktop" ? "windows" : "android";

  if (input.searchType === "maps") {
    const path = "/v3/serp/google/maps/live/advanced";
    const response = await dataforseoPost<
      DataforseoItemsTask<Record<string, unknown>>
    >(
      path,
      [
        {
          keyword: input.keyword,
          location_coordinate: input.locationCoordinate,
          language_code: input.languageCode,
          device: input.device,
          os,
          depth: input.depth,
          search_places: input.searchPlaces,
        },
      ],
      { classify: classifySerpError, ...options },
    );
    const task = assertOk(response, {
      classify: classifySerpError,
      classifyPath: path,
      treatNoResultsAsEmpty: true,
    });
    return {
      data: task.result?.[0]?.items ?? [],
      billing: buildTaskBilling(task),
    };
  }

  const path = "/v3/serp/google/local_finder/live/advanced";
  const response = await dataforseoPost<
    DataforseoItemsTask<Record<string, unknown>>
  >(
    path,
    [
      {
        keyword: input.keyword,
        location_coordinate: input.locationCoordinate,
        language_code: input.languageCode,
        device: input.device,
        os,
        depth: input.depth,
      },
    ],
    { classify: classifySerpError, ...options },
  );
  const task = assertOk(response, {
    classify: classifySerpError,
    classifyPath: path,
    treatNoResultsAsEmpty: true,
  });
  return {
    data: task.result?.[0]?.items ?? [],
    billing: buildTaskBilling(task),
  };
}

const LOCAL_TASK_PRIORITY_HIGH = 2;

export type PostLocalSerpInput = {
  keyword: string;
  locationCoordinates: string[];
  languageCode: string;
  device: "desktop" | "mobile";
  depth: number;
};

export async function postLocalSerpTasks(
  input: PostLocalSerpInput,
  options?: DataforseoRequestOptions,
): Promise<DataforseoApiResponse<Array<string | null>>> {
  const count = input.locationCoordinates.length;
  if (count === 0 || count > MAX_TASKS_PER_POST) {
    throw new UnbilledCallError(
      `task_post accepts 1-${MAX_TASKS_PER_POST} tasks, got ${count}`,
      { status: 400, code: "dataforseo_invalid_request" },
    );
  }
  const path = "/v3/serp/google/maps/task_post";
  const response = await dataforseoPost<
    DataforseoTaskLike & { id?: string; data?: Record<string, unknown> }
  >(
    path,
    input.locationCoordinates.map((coordinate, index) => ({
      keyword: input.keyword,
      location_coordinate: coordinate,
      language_code: input.languageCode,
      device: input.device,
      os: input.device === "desktop" ? "windows" : "android",
      depth: input.depth,
      search_places: false,
      priority: LOCAL_TASK_PRIORITY_HIGH,
      tag: String(index),
    })),
    { classify: classifySerpError, ...options },
  );

  if (!response || response.status_code !== 20000) {
    if (response) {
      assertOk(response, { classify: classifySerpError, classifyPath: path });
    }
    throw new AppError(502, "dataforseo_bad_response", "DataForSEO task_post failed");
  }

  const taskIds: Array<string | null> = input.locationCoordinates.map(
    () => null,
  );
  let costUsd = 0;
  for (const entry of response.tasks ?? []) {
    costUsd += entry.cost ?? 0;
    const index = Number(entry.data?.tag);
    if (entry.status_code === 20100 && entry.id && taskIds[index] === null) {
      taskIds[index] = entry.id;
    } else {
      console.warn(
        `[dataforseo] task_post rejected entry (${entry.status_code}): ${entry.status_message}`,
      );
    }
  }
  const billing = {
    path: ["v3", "serp", "google", "maps", "task_post"],
    costUsd,
  };
  if (taskIds.every((id) => id === null)) {
    const firstTask = response.tasks?.[0];
    const message = firstTask?.status_message || "DataForSEO created no tasks";
    const field = invalidFieldName(message);
    if (field && billing.costUsd === 0) {
      throw new UnbilledCallError("DataForSEO rejected an invalid request field.", {
        status: 422,
        code: "dataforseo_invalid_field",
        details: {
          field,
          providerCode: firstTask?.status_code ? `dataforseo_${firstTask.status_code}` : undefined,
        },
      });
    }
    const err = new ChargedCallError(message, {
      actualUsd: billing.costUsd,
      provider: "dataforseo",
      endpoint: dataforseoEndpoint(billing.path),
      status: 502,
      code: "dataforseo_task_failed",
      details: {
        providerCode: firstTask?.status_code ? `dataforseo_${firstTask.status_code}` : undefined,
      },
    });
    (err as unknown as { billing: typeof billing }).billing = billing;
    throw err;
  }
  return { data: taskIds, billing };
}

export type LocalSerpTaskOutcome =
  | { status: "pending" }
  | { status: "failed"; message: string }
  | { status: "completed"; items: Record<string, unknown>[] };

export async function fetchLocalSerpTaskResult(
  taskId: string,
  options?: DataforseoRequestOptions,
): Promise<LocalSerpTaskOutcome> {
  const path = `/v3/serp/google/maps/task_get/advanced/${encodeURIComponent(taskId)}`;
  const response = await dataforseoGet<
    DataforseoItemsTask<Record<string, unknown>>
  >(path, { classify: classifySerpError, ...options });
  const task = response?.tasks?.[0];
  if (!response || response.status_code !== 20000 || !task) {
    if (response) {
      assertOk(response, { classify: classifySerpError, classifyPath: path });
    }
    throw new AppError(502, "dataforseo_bad_response", "DataForSEO task_get failed");
  }

  if (isTaskInProgress(task)) return { status: "pending" };
  if (task.status_code !== 20000) {
    if (isNoResultsTask(task)) return { status: "completed", items: [] };
    return {
      status: "failed",
      message:
        task.status_message || `DataForSEO task failed (${task.status_code})`,
    };
  }
  return { status: "completed", items: task.result?.[0]?.items ?? [] };
}
