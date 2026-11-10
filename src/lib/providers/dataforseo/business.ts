// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/business.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { dataforseoGet, dataforseoPost, type DataforseoRequestOptions } from "./core.ts";
import {
  assertOk,
  buildTaskBilling,
  isNoResultsTask,
  isRecord,
  isTaskInProgress,
  type DataforseoApiResponse,
  type DataforseoItemsTask,
  type DataforseoResponseLike,
  type DataforseoTaskLike,
} from "./envelope.ts";
import { AppError } from "../../http/appError.ts";
import { meter } from "./client.ts";
import { dataforseoPricing } from "../../pricing/dataforseo.ts";

export type BusinessListingItem = Record<string, unknown>;

export type BusinessLocationInput = {
  locationCoordinate?: string;
  locationCode?: number;
  languageCode: string;
};

function locationParams(input: BusinessLocationInput): Record<string, unknown> {
  return input.locationCoordinate
    ? { location_coordinate: input.locationCoordinate }
    : { location_code: input.locationCode };
}

export async function fetchBusinessListingsSearch(
  input: {
    categories?: string[];
    title?: string;
    locationCoordinate: string;
    isClaimed?: boolean;
    filters?: unknown[];
    orderBy?: string[];
    limit: number;
    offset?: number;
  },
  options?: DataforseoRequestOptions,
): Promise<DataforseoApiResponse<BusinessListingItem[]>> {
  const response = await dataforseoPost<DataforseoItemsTask<BusinessListingItem>>(
    "/v3/business_data/business_listings/search/live",
    [
      {
        categories: input.categories,
        title: input.title,
        location_coordinate: input.locationCoordinate,
        is_claimed: input.isClaimed,
        filters: input.filters,
        order_by: input.orderBy,
        limit: input.limit,
        offset: input.offset,
      },
    ],
    options,
  );
  const task = assertOk(response, { treatNoResultsAsEmpty: true });
  return {
    data: task.result?.[0]?.items ?? [],
    billing: buildTaskBilling(task),
  };
}

const questionsResultSchema = z
  .object({
    items: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    items_without_answers: z
      .array(z.record(z.string(), z.unknown()))
      .nullable()
      .optional(),
  })
  .passthrough();

function combinedQuestionItems(results: unknown): Record<string, unknown>[] {
  const list = Array.isArray(results) ? results : [];
  return list.flatMap((result) => {
    const parsed = questionsResultSchema.safeParse(result ?? {});
    if (!parsed.success) return [];
    return [
      ...(parsed.data.items ?? []),
      ...(parsed.data.items_without_answers ?? []),
    ];
  });
}

export async function fetchQuestionsAnswers(
  input: {
    keyword: string;
    locationCoordinate: string;
    languageCode: string;
    depth: number;
  },
  options?: DataforseoRequestOptions,
): Promise<DataforseoApiResponse<Record<string, unknown>[]>> {
  const response = await dataforseoPost(
    "/v3/business_data/google/questions_and_answers/live",
    [
      {
        keyword: input.keyword,
        location_coordinate: input.locationCoordinate,
        language_code: input.languageCode,
        depth: input.depth,
      },
    ],
    options,
  );
  const task = assertOk(response, { treatNoResultsAsEmpty: true });
  return {
    data: combinedQuestionItems(task.result),
    billing: buildTaskBilling(task),
  };
}

export async function fetchMyBusinessInfo(
  input: { keyword: string } & BusinessLocationInput,
  options?: DataforseoRequestOptions,
): Promise<DataforseoApiResponse<Record<string, unknown> | null>> {
  const response = await dataforseoPost<DataforseoItemsTask<unknown>>(
    "/v3/business_data/google/my_business_info/live",
    [
      {
        keyword: input.keyword,
        ...locationParams(input),
        language_code: input.languageCode,
      },
    ],
    options,
  );
  const task = assertOk(response, { treatNoResultsAsEmpty: true });
  const entry = task.result?.[0];
  const item = entry?.items?.[0];
  if (!isRecord(item)) {
    return { data: null, billing: buildTaskBilling(task) };
  }
  if (item.check_url == null) item.check_url = entry?.check_url;
  return { data: item, billing: buildTaskBilling(task) };
}

const TASK_PRIORITY_HIGH = 2;

function postedTaskId<T extends DataforseoTaskLike & { id?: string }>(
  response: DataforseoResponseLike<T> | null,
): DataforseoApiResponse<string> {
  const task = assertOk(response, { okTaskStatusCode: 20100 });
  if (!task.id) {
    throw new AppError(502, "dataforseo_task_failed", "DataForSEO did not return a task id");
  }
  return { data: task.id, billing: buildTaskBilling(task) };
}

export type BusinessTaskEndpoint =
  | "reviews"
  | "extended_reviews"
  | "my_business_updates";

export type BusinessIdentifierInput = {
  keyword?: string;
  cid?: string;
  placeId?: string;
};

export async function postGoogleReviewsTask(
  input: BusinessIdentifierInput &
    BusinessLocationInput & {
      depth: number;
      sortBy?: string;
      includeOtherSources: boolean;
    },
  options?: DataforseoRequestOptions,
): Promise<DataforseoApiResponse<string>> {
  if (input.includeOtherSources) {
    return postedTaskId(
      await dataforseoPost<DataforseoTaskLike & { id?: string }>(
        "/v3/business_data/google/extended_reviews/task_post",
        [
          {
            keyword: input.keyword,
            cid: input.cid,
            place_id: input.placeId,
            ...locationParams(input),
            language_code: input.languageCode,
            depth: input.depth,
            priority: TASK_PRIORITY_HIGH,
          },
        ],
        options,
      ),
    );
  }
  return postedTaskId(
    await dataforseoPost<DataforseoTaskLike & { id?: string }>(
      "/v3/business_data/google/reviews/task_post",
      [
        {
          keyword: input.keyword,
          cid: input.cid,
          place_id: input.placeId,
          ...locationParams(input),
          language_code: input.languageCode,
          depth: input.depth,
          sort_by: input.sortBy,
          priority: TASK_PRIORITY_HIGH,
        },
      ],
      options,
    ),
  );
}

export async function postMyBusinessUpdatesTask(
  input: { keyword: string; depth: number } & BusinessLocationInput,
  options?: DataforseoRequestOptions,
): Promise<DataforseoApiResponse<string>> {
  return postedTaskId(
    await dataforseoPost<DataforseoTaskLike & { id?: string }>(
      "/v3/business_data/google/my_business_updates/task_post",
      [
        {
          keyword: input.keyword,
          ...locationParams(input),
          language_code: input.languageCode,
          depth: input.depth,
          priority: TASK_PRIORITY_HIGH,
        },
      ],
      options,
    ),
  );
}

export type BusinessTaskOutcome = {
  status: "pending" | "completed";
  result: Record<string, unknown> | null;
};

export async function fetchBusinessDataTaskResult(
  input: {
    endpoint: BusinessTaskEndpoint;
    taskId: string;
  },
  options?: DataforseoRequestOptions,
): Promise<BusinessTaskOutcome> {
  const path = `/v3/business_data/google/${input.endpoint}/task_get/${encodeURIComponent(input.taskId)}`;
  const response = await dataforseoGet(path, options);

  const task = response?.tasks?.[0];
  if (!response || response.status_code !== 20000 || !task) {
    if (response) {
      assertOk(response, { classifyPath: path });
    }
    throw new AppError(502, "dataforseo_task_failed", "DataForSEO task_get failed");
  }

  if (isTaskInProgress(task)) return { status: "pending", result: null };

  if (task.status_code !== 20000) {
    if (!isNoResultsTask(task)) {
      throw new AppError(
        502,
        "dataforseo_task_failed",
        task.status_message || `DataForSEO task failed (${task.status_code})`,
      );
    }
    return { status: "completed", result: null };
  }

  const first = task.result?.[0];
  return { status: "completed", result: isRecord(first) ? first : null };
}

const businessCategorySchema = z
  .object({
    category_name: z.string(),
    business_count: z.number().nullable().optional(),
  })
  .passthrough();

export type BusinessCategoryRow = {
  category: string;
  businessCount: number | null;
};

export async function fetchBusinessListingsCategories(
  options?: DataforseoRequestOptions,
): Promise<DataforseoApiResponse<BusinessCategoryRow[]>> {
  const response = await dataforseoGet(
    "/v3/business_data/business_listings/categories",
    options,
  );
  const task = assertOk(response);
  const rows = (task.result ?? []).flatMap((entry) => {
    const parsed = businessCategorySchema.safeParse(entry);
    if (!parsed.success) return [];
    return [
      {
        category: parsed.data.category_name,
        businessCount: parsed.data.business_count ?? null,
      },
    ];
  });
  return { data: rows, billing: buildTaskBilling(task) };
}

export function createBusinessClient(deps?: { meter?: typeof meter }) {
  const m = deps?.meter ?? meter;
  return {
    businessListings: m(
      fetchBusinessListingsSearch,
      (i: Parameters<typeof fetchBusinessListingsSearch>[0]) =>
        dataforseoPricing.business.businessListings({ limit: i.limit }),
      "local.business",
    ),
    myBusinessInfo: m(
      fetchMyBusinessInfo,
      () => dataforseoPricing.business.myBusinessInfo({}),
      "local.business",
    ),
    questionsAnswers: m(
      fetchQuestionsAnswers,
      (i: Parameters<typeof fetchQuestionsAnswers>[0]) =>
        dataforseoPricing.business.questionsAnswers({ depth: i.depth }),
      "local.business",
    ),
    reviewsTaskPost: m(
      postGoogleReviewsTask,
      (i: Parameters<typeof postGoogleReviewsTask>[0]) =>
        dataforseoPricing.business.reviewsTaskPost({
          depth: i.depth,
          includeOtherSources: i.includeOtherSources,
        }),
      "local.reviews",
    ),
    updatesTaskPost: m(
      postMyBusinessUpdatesTask,
      (i: Parameters<typeof postMyBusinessUpdatesTask>[0]) =>
        dataforseoPricing.business.updatesTaskPost({ depth: i.depth }),
      "local.business",
    ),
  };
}
export type BusinessClient = ReturnType<typeof createBusinessClient>;
