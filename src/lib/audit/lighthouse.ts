// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/lighthouse.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { fetchLighthouseResult as fetchProviderLighthouse } from "../providers/dataforseo/lighthouse.ts";
import type { LighthouseResult } from "./types.ts";
import { canonicalUrlKey, detectUrlTemplate } from "./urlUtils.ts";

export const LIGHTHOUSE_ENDPOINT = "/v3/on_page/lighthouse/live/json";

export async function fetchPaidLighthouseData(
  input: { url: string; strategy: "mobile" | "desktop" },
  options?: Parameters<typeof fetchProviderLighthouse>[1],
) {
  const { data } = await fetchProviderLighthouse(input, options);
  const actualUsd =
    (data as unknown as { metadata?: { cost?: number | null } }).metadata?.cost ?? null;
  return { data, actualUsd, endpoint: LIGHTHOUSE_ENDPOINT };
}

export interface LighthouseFetchResult {
  result: LighthouseResult;
  payloadJson: string | null;
}

export function failedLighthouseFetch(
  url: string,
  pageId: string,
  strategy: "mobile" | "desktop",
  errorMessage: string,
): LighthouseFetchResult {
  return {
    result: {
      url,
      pageId,
      strategy,
      performanceScore: null,
      accessibilityScore: null,
      bestPracticesScore: null,
      seoScore: null,
      lcpMs: null,
      cls: null,
      inpMs: null,
      ttfbMs: null,
      errorMessage,
    },
    payloadJson: null,
  };
}

function canonicalUrlKeyWithoutTrailingSlash(url: string): string {
  try {
    const parsed = new URL(canonicalUrlKey(url));
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.replace(/\/$/, "");
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export type LighthouseFetcher = (input: {
  url: string;
  strategy: "mobile" | "desktop";
}) => Promise<{ data: { scores: Record<string, number | null>; metrics: Record<string, { numericValue?: number | null }> } }>;

export async function fetchLighthouseResult(
  url: string,
  pageId: string,
  strategy: "mobile" | "desktop",
  fetcher?: LighthouseFetcher,
): Promise<LighthouseFetchResult> {
  const run = fetcher ?? fetchProviderLighthouse;
  try {
    const { data } = await run({ url, strategy });
    const scores = (data as { scores?: Record<string, number | null> }).scores ?? {};
    const metrics = (data as { metrics?: Record<string, { numericValue?: number | null }> }).metrics ?? {};
    const num = (key: string): number | null => {
      const v = metrics[key]?.numericValue;
      return typeof v === "number" ? v : null;
    };
    return {
      result: {
        url,
        pageId,
        strategy,
        performanceScore: scores.performance ?? null,
        accessibilityScore: scores.accessibility ?? null,
        bestPracticesScore: scores["best-practices"] ?? null,
        seoScore: scores.seo ?? null,
        lcpMs: num("largestContentfulPaint"),
        cls: num("cumulativeLayoutShift"),
        inpMs: num("interactionToNextPaint"),
        ttfbMs: num("serverResponseTime"),
        errorMessage: null,
      },
      payloadJson: JSON.stringify(data),
    };
  } catch (error) {
    const failed = error instanceof Error ? error : new Error(String(error));
    return failedLighthouseFetch(url, pageId, strategy, failed.message);
  }
}

export async function storeLighthouseResult(input: {
  fetched: LighthouseFetchResult;
}): Promise<LighthouseResult> {
  return input.fetched.result;
}

export function selectLighthouseSample(
  pages: Array<{ url: string; statusCode: number; fetchClass: string }>,
  startUrl: string,
  strategy: "auto" | "none" | string,
): string[] {
  if (strategy === "none") return [];
  const validPages = pages.filter(
    (p) => p.statusCode >= 200 && p.statusCode < 300 && p.fetchClass === "ok",
  );
  const selected = new Set<string>();
  const startKey = canonicalUrlKey(startUrl);
  const startPage =
    validPages.find((p) => canonicalUrlKey(p.url) === startKey) ??
    validPages.find(
      (p) => canonicalUrlKeyWithoutTrailingSlash(p.url) === canonicalUrlKeyWithoutTrailingSlash(startUrl),
    );
  if (startPage) selected.add(startPage.url);
  const templateGroups = new Map<string, { url: string }>();
  if (startPage) {
    try {
      templateGroups.set(detectUrlTemplate(new URL(startPage.url).pathname), startPage);
    } catch {
      templateGroups.set(startPage.url, startPage);
    }
  }
  for (const page of validPages) {
    if (selected.has(page.url)) continue;
    let template: string;
    try {
      template = detectUrlTemplate(new URL(page.url).pathname);
    } catch {
      continue;
    }
    if (!templateGroups.has(template)) templateGroups.set(template, page);
  }
  for (const [, page] of templateGroups) {
    if (selected.size >= 10) break;
    selected.add(page.url);
  }
  return Array.from(selected);
}
