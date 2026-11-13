// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/siteAuditWorkflowPhases.ts
//   src/server/workflows/siteAuditStart.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { safeFetch } from "../http/safeFetch.ts";
import { getOrigin, isSameOrigin } from "./urlUtils.ts";
import { isCrawlableUrl, isOwnedHost, isShopifyHost, resolveStartUrlRedirects } from "./urlPolicy.ts";
import { fetchRobots, parseAuditRobots, crawlerAllows, pathAndQuery } from "./robotsFile.ts";
import { discoverUrls } from "./discovery.ts";
import { checkLlmsTxt } from "./llmsTxt.ts";
import { aiAccessRows, blockedAiBots } from "./aiAccess.ts";
import { captureAuditEvent } from "./telemetry.ts";
import { AuditPhaseError } from "./errors.ts";
import { AUDIT_ROBOTS_TOKEN } from "../../shared/audit.ts";
import type { AuditRow, AuditStore } from "./store.ts";
import type { DetectedIssue } from "./issues/pageReporters.ts";
import { selectLighthouseSample, failedLighthouseFetch, fetchLighthouseResult as fetchAuditLighthouse, storeLighthouseResult } from "./lighthouse.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";

export interface PhaseDeps {
  safeFetch?: any;
  lookup?: (hostname: string) => Promise<string[]>;
  now?: () => number;
}

/**
 * Resolves the start URL through up to 5 redirects, enforces the owned-host boundary,
 * and detects Shopify.
 */
export async function resolveAuditStart(
  audit: AuditRow,
  deps?: PhaseDeps,
): Promise<{
  startUrl: string;
  origin: string;
  sitePlatform: "shopify" | null;
}> {
  const probe = await resolveStartUrlRedirects(audit.start_url, {
    safeFetch: deps?.safeFetch ?? safeFetch,
    lookup: deps?.lookup,
  });

  const finalUrl = probe.url;
  const initialHost = audit.start_host;
  let finalHost: string;
  try {
    finalHost = new URL(finalUrl).hostname.toLowerCase();
  } catch {
    throw new AuditPhaseError("start_failed", "starting", `Invalid redirect target: ${finalUrl}`);
  }

  if (!isOwnedHost(finalHost, initialHost)) {
    throw new AuditPhaseError(
      "start_url_off_site",
      "starting",
      `Redirect target ${finalHost} is outside owned website ${initialHost}`,
    );
  }

  let sitePlatform: "shopify" | null = null;
  if (
    probe.poweredBy?.toLowerCase().includes("shopify") ||
    (await isShopifyHost(finalHost, { lookup: deps?.lookup }))
  ) {
    sitePlatform = "shopify";
  }

  const origin = getOrigin(finalUrl);
  return {
    startUrl: finalUrl,
    origin,
    sitePlatform,
  };
}

/**
 * Runs discovery: reads robots.txt, discovers URLs via sitemaps, seeds the start URL
 * and sitemap URLs into the frontier, and advances phase to "crawling".
 */
export async function runDiscoveryPhase(
  audit: AuditRow,
  origin: string,
  store: AuditStore,
  jobId: string,
  deps?: PhaseDeps,
): Promise<{
  seededCount: number;
  discoveryTruncated: boolean;
  robotsText: string | null;
  robotsStatus: "found" | "missing" | "error" | "unreachable" | "malformed";
}> {
  await store.updateAudit(audit.id, jobId, { current_phase: "discovery" });

  const robotsRes = await fetchRobots(origin, {
    safeFetch: deps?.safeFetch ?? safeFetch,
    lookup: deps?.lookup,
  });

  const parsedRobots = parseAuditRobots(robotsRes.text);
  const robotsStatus = parsedRobots.malformed ? "malformed" : robotsRes.status;

  const discoveryRes = await discoverUrls(origin, audit.max_pages, null, {
    safeFetch: (deps?.safeFetch as any) ?? safeFetch,
    lookup: deps?.lookup,
  });

  let seededCount = 0;
  if (crawlerAllows(parsedRobots, audit.start_url)) {
    await store.seedStart(audit.id, audit.start_url);
    seededCount += 1;
  }

  const sitemapBatch: string[] = [];
  for (const rawUrl of discoveryRes.urls) {
    if (
      isSameOrigin(rawUrl, origin) &&
      isCrawlableUrl(rawUrl) &&
      crawlerAllows(parsedRobots, rawUrl) &&
      rawUrl !== audit.start_url
    ) {
      sitemapBatch.push(rawUrl);
    }
  }

  // Seed sitemap URLs in batches of 2,000
  for (let i = 0; i < sitemapBatch.length; i += 2000) {
    const chunk = sitemapBatch.slice(i, i + 2000);
    await store.seedSitemap(audit.id, chunk);
  }
  seededCount += sitemapBatch.length;

  const discoveryTruncated = !!(discoveryRes as any).truncated;

  await store.updateAudit(audit.id, jobId, {
    robots_status: robotsStatus,
    robots_http_status: robotsRes.httpStatus,
    robots_txt: robotsRes.text,
    discovery_truncated: discoveryTruncated,
    pages_total: Math.min(seededCount, audit.max_pages),
    current_phase: "crawling",
  });

  return {
    seededCount,
    discoveryTruncated,
    robotsText: robotsRes.text,
    robotsStatus,
  };
}

/**
 * Runs site-level checks: llms.txt, AI crawler access on start URL, and site-level issues.
 */
export async function runSiteChecks(
  audit: AuditRow,
  store: AuditStore,
  jobId: string,
  deps?: PhaseDeps,
): Promise<{ siteIssues: number }> {
  const origin = getOrigin(audit.start_url);
  const startPath = pathAndQuery(audit.start_url);

  const parsedRobots = parseAuditRobots(audit.robots_txt);
  const robotsUsable = audit.robots_status === "found" || audit.robots_status === "missing";

  const llmsRes = await checkLlmsTxt(origin, {
    safeFetch: deps?.safeFetch ?? safeFetch,
    lookup: deps?.lookup,
  });

  const aiRows = aiAccessRows(parsedRobots, startPath);
  const blocked = blockedAiBots(parsedRobots, startPath);

  const issues: DetectedIssue[] = [];
  const reportSiteIssue = (issueType: any, details?: Record<string, unknown>) => {
    issues.push({
      issueType,
      pageId: null,
      pageUrl: audit.start_url,
      dedupeKey: "site",
      details,
    });
  };

  // 1. crawl-blocked-by-robots
  if (!crawlerAllows(parsedRobots, audit.start_url)) {
    reportSiteIssue("crawl-blocked-by-robots");
  } else if (robotsUsable && blocked.training.length > 0) {
    // 2. ai-training-crawler-blocked (only if robots is usable and start page is allowed)
    reportSiteIssue("ai-training-crawler-blocked", { bots: blocked.training });
  }

  // 3. robots-txt-unavailable
  if (audit.robots_status === "error" || audit.robots_status === "unreachable") {
    reportSiteIssue("robots-txt-unavailable", {
      status: audit.robots_status,
      httpStatus: audit.robots_http_status,
    });
  }

  // 4. robots-txt-malformed
  if (audit.robots_status === "malformed") {
    reportSiteIssue("robots-txt-malformed");
  }

  // 5. llms-txt-missing
  if (llmsRes.status === "missing") {
    reportSiteIssue("llms-txt-missing");
  }

  // 6. llms-txt-invalid
  if (llmsRes.status === "invalid") {
    reportSiteIssue("llms-txt-invalid", {
      contentType: llmsRes.contentType,
      firstLine: llmsRes.firstLine ? llmsRes.firstLine.slice(0, 100) : null,
    });
  }

  if (issues.length > 0) {
    await store.insertIssues({ id: audit.id, brandKey: audit.brand_key }, issues);
  }

  await store.updateAudit(audit.id, jobId, {
    ai_access: aiRows,
    llms_txt: {
      status: llmsRes.status,
      httpStatus: llmsRes.httpStatus,
      contentType: llmsRes.contentType,
      firstLine: llmsRes.firstLine,
    },
  });

  return { siteIssues: issues.length };
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Runs the Lighthouse phase if requested.
 */
export async function runLighthousePhase(...args: any[]): Promise<any> {
  // Normalize arguments: support (ctx, params) and legacy (audit, store, jobId).
  let ctx: any = args[0];
  let params: any = args[1];
  if (!ctx || typeof ctx.step?.do !== "function") {
    const jobId = (params && (params.jobId ?? params?.audit?.id)) ?? "job";
    ctx = { jobId, step: { do: async (_n: string, _o: any, fn: any) => fn(), sleep: async () => {} } };
  }
  let audit: any = params?.audit ?? params;
  let store: any = params?.store ?? params?.auditStore;
  const admin = params?.admin;
  const deps = params?.deps;
  const jobId = params?.jobId ?? ctx.jobId;

  if (!audit || !store || !audit.run_lighthouse) {
    return { pages: [] };
  }

  const candidates = await store.lighthouseCandidates(audit.id);
  const sampleUrls = selectLighthouseSample(
    candidates.map((c: any) => ({ url: c.url, statusCode: c.statusCode, fetchClass: c.fetchClass })),
    audit.start_url,
    "auto",
  );
  const samplePages = candidates.filter((c: any) => sampleUrls.includes(c.url)) as any[];

  try {
    await store.updateAudit(audit.id, jobId, { lighthouse_total: 2 * samplePages.length });
  } catch {
    // ignore
  }

  const LIGHTHOUSE_LIVE_USD = 0.005;
  let completed = 0;
  let failed = 0;
  const waves = chunkArray(samplePages, 5);

  for (let w = 0; w < waves.length; w++) {
    const wavePages = waves[w];
    const calls = wavePages.length * 2;
    const approved = Number(audit.lighthouse_approved_usd ?? 0);

    const waveResult = await ctx.step.do(
      `lighthouse-wave-${w + 1}`,
      { timeoutMs: 140_000, retries: 0, billed: true },
      async () => {
        const spent = (completed + failed) * LIGHTHOUSE_LIVE_USD;
        if (spent + calls * LIGHTHOUSE_LIVE_USD > approved + 0.000001) {
          return { skipped: true, results: [] as any[] };
        }
        const results: any[] = [];
        for (const page of wavePages as any[]) {
          for (const strategy of ["mobile", "desktop"] as const) {
            try {
              const fetched = await fetchAuditLighthouse(page.url, page.id, strategy);
              const stored = await storeLighthouseResult({ auditId: audit.id, pageId: page.id, strategy, fetched });
              results.push(stored ?? fetched.result);
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              const fr = failedLighthouseFetch(page.url, page.id, strategy, msg);
              results.push(fr.result);
            }
          }
        }
        return { skipped: false, results };
      },
    );

    if (waveResult?.skipped) continue;

    await ctx.step.do(`lighthouse-persist-${w + 1}`, DB_STEP, async () => {
      const rows = waveResult?.results ?? [];
      try {
        await store.insertLighthouse({ id: audit.id, brandKey: audit.brand_key }, rows);
      } catch {
        // ignore
      }
      for (const r of rows) {
        if (r?.errorMessage) failed += 1;
        else completed += 1;
      }
      try {
        await store.updateAudit(audit.id, jobId, {
          lighthouse_completed: completed,
          lighthouse_failed: failed,
        });
      } catch {
        // ignore
      }
      return { completed: rows.filter((r: any) => !r?.errorMessage).length, failed: rows.filter((r: any) => r?.errorMessage).length };
    });
  }

  return { pages: samplePages.map((p: any) => ({ id: p.id, url: p.url })) };
}

/**
 * Finalizes the audit: computes final status, updates pages_total, completed_at,
 * and emits the site_audit:complete telemetry event.
 */
export async function finalizeAudit(
  audit: AuditRow,
  crawlOutcome: {
    rateLimited: boolean;
    cancelled: boolean;
    crawlCompleted: boolean;
  },
  store: AuditStore,
  jobId: string,
): Promise<{ status: "completed" | "partial" | "cancelled" }> {
  const currentAudit = (await store.getAudit(audit.id)) ?? audit;
  const isCancelled = crawlOutcome.cancelled || !!currentAudit.cancel_requested_at;
  const isPartial =
    !isCancelled && (crawlOutcome.rateLimited || (currentAudit.pages_abandoned ?? 0) > 0);

  const status = isCancelled ? "cancelled" : isPartial ? "partial" : "completed";
  const completedAt = new Date().toISOString();
  const finalPhase = status === "partial" ? "completed" : status;

  await store.updateAudit(audit.id, jobId, {
    status,
    current_phase: finalPhase,
    pages_total: currentAudit.pages_crawled,
    crawl_completed: crawlOutcome.crawlCompleted,
    completed_at: completedAt,
  });

  const blockedCount = await store.countPagesByFetchClass(audit.id, "blocked");
  const rateLimitedCount = await store.countPagesByFetchClass(audit.id, "rate_limited");

  await captureAuditEvent("site_audit:complete", {
    status,
    pages_crawled: currentAudit.pages_crawled,
    pages_total: currentAudit.pages_crawled,
    crawl_completed: crawlOutcome.crawlCompleted,
    pages_blocked: blockedCount,
    pages_rate_limited: rateLimitedCount,
    pages_abandoned: currentAudit.pages_abandoned ?? 0,
    lighthouse: currentAudit.run_lighthouse,
    render_js: currentAudit.render_javascript,
    error_code: null,
    failed_phase: null,
  });

  return { status };
}
