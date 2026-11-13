// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/lighthouse.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { fetchLighthouseResult as fetchProviderLighthouse } from "../providers/dataforseo/lighthouse.ts";
import type { LighthouseResult } from "./types.ts";
import { canonicalUrlKey, detectUrlTemplate as detectTemplate } from "./urlUtils.ts";

function canonicalUrlKeyWithoutTrailingSlash(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/$/, "");
    return parsed.toString();
  } catch {
    return url;
  }
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

export async function fetchLighthouseResult(
  url: string,
  pageId: string,
  strategy: "mobile" | "desktop",
  _billingCustomer?: unknown,
): Promise<LighthouseFetchResult> {
  try {
    const { data } = await fetchProviderLighthouse({ url, strategy });
    const scores = (data as any)?.scores ?? {};
    const metrics = (data as any)?.metrics ?? {};
    return {
      result: {
        url,
        pageId,
        strategy,
        performanceScore: scores.performance ?? null,
        accessibilityScore: scores.accessibility ?? null,
        bestPracticesScore: scores["best-practices"] ?? null,
        seoScore: scores.seo ?? null,
        lcpMs: metrics?.largestContentfulPaint?.numericValue ?? null,
        cls: metrics?.cumulativeLayoutShift?.numericValue ?? null,
        inpMs: metrics?.interactionToNextPaint?.numericValue ?? null,
        ttfbMs: metrics?.serverResponseTime?.numericValue ?? null,
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
  auditId?: string;
  pageId?: string;
  strategy?: "mobile" | "desktop";
  fetched?: LighthouseFetchResult;
  [key: string]: any;
}): Promise<LighthouseResult> {
  const fetched = input.fetched ?? (input as any);
  if (!fetched?.result) return fetched?.result;
  const result = { ...fetched.result } as LighthouseResult;
  if (fetched.payloadJson) {
    result.r2Key = null;
    result.payloadSizeBytes = fetched.payloadJson.length;
  }
  return result;
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
    validPages.find((p) => {
      try { return new URL(p.url).toString() === new URL(startUrl).toString(); } catch { return false; }
    }) ??
    validPages.find((p) => canonicalUrlKeyWithoutTrailingSlash(p.url) === canonicalUrlKeyWithoutTrailingSlash(startUrl));

  if (startPage) selected.add(startPage.url);

  const templateGroups = new Map<string, { url: string }>();
  if (startPage) {
    templateGroups.set(detectTemplate(new URL(startPage.url).pathname), startPage);
  }
  for (const page of validPages) {
    if (selected.has(page.url)) continue;
    const template = detectTemplate(new URL(page.url).pathname);
    if (!templateGroups.has(template)) {
      templateGroups.set(template, page);
    }
  }

  for (const [, page] of templateGroups) {
    if (selected.size >= 10) break;
    selected.add(page.url);
  }

  return Array.from(selected);
}

