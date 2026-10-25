// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/envelope.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { AppError } from "../../http/appError.ts";
import {
  AmbiguousCallError,
  ChargedCallError,
  UnbilledCallError,
} from "../../spend/errors.ts";
import type { DataforseoErrorClassifier } from "./core.ts";

export type DataforseoApiCallCost = {
  path: string[];
  costUsd: number;
};

export type DataforseoApiResponse<T> = {
  data: T;
  billing: DataforseoApiCallCost;
};

const billingSchema = z.object({
  path: z.array(z.string()).min(1),
  cost: z.number().finite().nonnegative(),
});

export interface DataforseoTaskLike {
  status_code?: number;
  status_message?: string;
  path?: string[];
  cost?: number;
  result_count?: number;
  result?: unknown[] | null;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DataforseoResponseLike<T extends DataforseoTaskLike = DataforseoTaskLike> {
  status_code?: number;
  status_message?: string;
  tasks?: T[];
  [key: string]: unknown;
}

export interface DataforseoItemsResult<TItem> {
  items?: TItem[] | null;
  total_count?: number | null;
  [key: string]: unknown;
}

export interface DataforseoItemsTask<TItem> extends DataforseoTaskLike {
  result?: DataforseoItemsResult<TItem>[];
}

export function dataforseoEndpoint(path: string[] | string): string {
  const value = Array.isArray(path) ? path.join("/") : path;
  return value.startsWith("/") ? value : "/" + value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildTaskBilling(task: DataforseoTaskLike): DataforseoApiCallCost {
  const parsed = billingSchema.safeParse(task);
  if (!parsed.success) {
    throw new AppError(
      502,
      "dataforseo_bad_response",
      "DataForSEO task is missing valid billing metadata.",
      { details: { providerCode: "dataforseo_billing_metadata_missing" } },
    );
  }
  return { path: parsed.data.path, costUsd: parsed.data.cost };
}

const INVALID_FIELD_RE = /Invalid Field:\s*'([^']+)'/i;

export function invalidFieldName(message: string): string | null {
  return message.match(INVALID_FIELD_RE)?.[1] ?? null;
}

export function isNoResultsTask(task: DataforseoTaskLike): boolean {
  return task.status_code === 40501 &&
    (task.status_message?.toLowerCase().includes("no search results") ?? false);
}

const UPSTREAM_FAILURE_STATUS_CODES = new Set([
  40101,
  40103,
  50000,
  50301,
  50302,
  50303,
  50304,
  50401,
  50402,
]);

export function isUpstreamFailureStatus(statusCode: number | undefined): boolean {
  return statusCode !== undefined && UPSTREAM_FAILURE_STATUS_CODES.has(statusCode);
}

const TASK_IN_PROGRESS_STATUS_CODES = new Set([20100, 40601, 40602]);

export function isTaskInProgress(task: DataforseoTaskLike): boolean {
  return task.status_code !== undefined &&
    TASK_IN_PROGRESS_STATUS_CODES.has(task.status_code);
}

type AssertOkOptions = {
  classify?: DataforseoErrorClassifier;
  classifyPath?: string;
  treatNoResultsAsEmpty?: boolean;
  okTaskStatusCode?: number;
};

function pathFor(task: DataforseoTaskLike, fallback?: string): string {
  return fallback ?? (task.path ? dataforseoEndpoint(task.path) : "");
}

function invalidFieldMessage(message: string): string {
  const field = invalidFieldName(message);
  return field ? "DataForSEO rejected the request field " + field + "." : message;
}

function assertErrorClassified(error: Error): never {
  throw error;
}

export function assertOk<T extends DataforseoTaskLike>(
  response: DataforseoResponseLike<T> | null,
  options: AssertOkOptions = {},
): T {
  if (!response) {
    throw new AppError(
      502,
      "dataforseo_bad_response",
      "DataForSEO returned an empty response.",
    );
  }

  const classifyPath = options.classifyPath ?? "";
  if (response.status_code !== 20000) {
    const message = response.status_message || "DataForSEO request failed.";
    const classified = options.classify?.(
      response.status_code,
      message,
      classifyPath,
    );
    if (classified) assertErrorClassified(classified);
    throw new UnbilledCallError(message);
  }

  const task = response.tasks?.[0];
  if (!task) {
    throw new AppError(
      502,
      "dataforseo_bad_response",
      "DataForSEO response is missing its task.",
    );
  }

  if (task.status_code !== (options.okTaskStatusCode ?? 20000)) {
    if (options.treatNoResultsAsEmpty && isNoResultsTask(task)) return task;

    const message = task.status_message || "DataForSEO task failed.";
    const path = pathFor(task, options.classifyPath);
    const classified = options.classify?.(task.status_code, message, path);
    if (classified) assertErrorClassified(classified);

    const field = invalidFieldName(message);
    const billing = billingSchema.safeParse(task);
    if (field && billing.success && billing.data.cost === 0) {
      throw new UnbilledCallError(invalidFieldMessage(message));
    }
    if (billing.success) {
      throw new ChargedCallError(invalidFieldMessage(message), {
        actualUsd: billing.data.cost,
        provider: "dataforseo",
        endpoint: dataforseoEndpoint(billing.data.path),
      });
    }
    throw new AmbiguousCallError(invalidFieldMessage(message));
  }

  return task;
}

export function parseTaskTotalCount(task: DataforseoTaskLike): number | null {
  const first = task.result?.[0];
  if (!isRecord(first)) return null;
  return typeof first.total_count === "number" ? first.total_count : null;
}

export function parseTaskItems<T extends z.ZodType>(
  endpoint: string,
  task: DataforseoTaskLike,
  itemSchema: T,
): Array<z.infer<T>> {
  const first = task.result?.[0];
  const rawItems = isRecord(first) ? first.items : [];
  const parsed = z.array(itemSchema).safeParse(rawItems ?? []);
  if (!parsed.success) {
    throw new AppError(
      502,
      "dataforseo_bad_response",
      "DataForSEO " + endpoint + " returned an invalid response shape.",
      { details: { providerCode: "dataforseo_invalid_payload" } },
    );
  }
  return parsed.data;
}
