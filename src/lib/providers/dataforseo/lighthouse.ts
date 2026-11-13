// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/lighthouse.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { dataforseoPost } from "./core.ts";
import { assertOk, buildTaskBilling } from "./envelope.ts";
import { ChargedCallError } from "../../spend/errors.ts";

export type LighthouseStrategy = "mobile" | "desktop";

export const requestCategories = [
  "performance",
  "accessibility",
  "best_practices",
  "seo",
] as const;

const LIGHTHOUSE_PATH = "/v3/on_page/lighthouse/live/json";
const REQUEST_TIMEOUT_MS = 60_000;

export interface StoredLighthousePayload {
  version: number;
  source: string;
  hasIssueDetails: boolean;
  metadata: {
    requestedUrl: string;
    finalUrl: string;
    strategy: LighthouseStrategy;
    fetchedAt: string;
    lighthouseVersion: string | null;
    taskId: string | null;
    cost: number | null;
  };
  scores: {
    performance: number | null;
    accessibility: number | null;
    "best-practices": number | null;
    seo: number | null;
  };
  metrics: Record<string, { score: number | null; displayValue: string | null; numericValue: number | null }>;
  issues: Array<Record<string, unknown>>;
}

function scoreToPercent(score: unknown): number | null {
  if (typeof score !== "number" || Number.isNaN(score)) return null;
  return Math.round(score * 100);
}

function parsePayload(body: unknown, input: { url: string; strategy: LighthouseStrategy }): StoredLighthousePayload {
  const task = (body as any)?.tasks?.[0] ?? {};
  const result = task?.result?.[0] ?? {};
  const categories = result?.categories ?? {};
  const audits = result?.audits ?? {};
  const fetchedAt = new Date().toISOString();

  const payload: StoredLighthousePayload = {
    version: 2,
    source: "dataforseo-lighthouse",
    hasIssueDetails: false,
    metadata: {
      requestedUrl: result?.requestedUrl ?? input.url,
      finalUrl: result?.finalUrl ?? input.url,
      strategy: input.strategy,
      fetchedAt,
      lighthouseVersion: result?.lighthouseVersion ?? null,
      taskId: task?.id ?? null,
      cost: typeof task?.cost === "number" ? task.cost : null,
    },
    scores: {
      performance: scoreToPercent(categories?.performance?.score),
      accessibility: scoreToPercent(categories?.accessibility?.score),
      "best-practices": scoreToPercent(categories?.["best-practices"]?.score ?? categories?.best_practices?.score),
      seo: scoreToPercent(categories?.seo?.score),
    },
    metrics: {
      largestContentfulPaint: {
        score: null,
        displayValue: audits?.["largest-contentful-paint"]?.displayValue ?? null,
        numericValue: typeof audits?.["largest-contentful-paint"]?.numericValue === "number"
          ? audits["largest-contentful-paint"].numericValue
          : null,
      },
    },
    issues: [],
  };
  return payload;
}

export async function fetchLighthouseResult(input: {
  url: string;
  strategy: LighthouseStrategy;
}): Promise<{ data: StoredLighthousePayload; billing: { path: string[]; costUsd: number } }> {
  const body = await dataforseoPost(LIGHTHOUSE_PATH, [
    {
      url: input.url,
      for_mobile: input.strategy === "mobile",
      categories: [...requestCategories],
    },
  ], { timeoutMs: REQUEST_TIMEOUT_MS });

  const task = assertOk(body as any);
  const billing = buildTaskBilling(task as any);

  try {
    const data = parsePayload(body, input);
    return { data, billing };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ChargedCallError(message, {
      actualUsd: billing.costUsd,
      provider: "dataforseo",
      endpoint: LIGHTHOUSE_PATH,
      status: 502,
      code: "dataforseo_lighthouse_parse_failed",
    });
  }
}