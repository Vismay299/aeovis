// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/siteAuditWorkflowCrawl.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import dns from "node:dns/promises";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import { StepFailedError } from "../jobs/runner.ts";
import type { JobContext } from "../jobs/types.ts";
import {
  CRAWL_WINDOW,
  RETRY_CRAWL_WINDOW,
  clampCrawlWindow,
  adjustCrawlWindow,
} from "./crawlWindow.ts";
import {
  createCrawlThrottle,
  type CrawlThrottleState,
} from "./crawlThrottle.ts";
import { crawlPage, createCachedLookup, type CrawlPageOptions } from "./fetchPage.ts";
import { safeFetch } from "../http/safeFetch.ts";
import { parseAuditRobots, crawlerAllows } from "./robotsFile.ts";
import { runPageReporters, type DetectedIssue } from "./issues/pageReporters.ts";
import { deterministicUuid } from "./ids.ts";
import { getOrigin, isSameOrigin } from "./urlUtils.ts";
import { isCrawlableUrl } from "./urlPolicy.ts";
import { createCancelProbe } from "./cancel.ts";
import { AuditPhaseError } from "./errors.ts";
import { renderPage } from "./renderedPage.ts";
import type { AuditRow, AuditStore, ClaimedUrl } from "./store.ts";
import type { CrawledPageResult } from "./types.ts";

const MAX_QUEUED_PERSIST_BATCHES = 2;
const FIRST_PERSIST_BATCH_SIZE = 5;
const SUBSEQUENT_PERSIST_BATCH_SIZE = 25;
const CHUNK_DEADLINE_MS = 90_000;
const MAX_STORED_LINKS_PER_PAGE = 500;
const MAX_DISCOVERED_LINKS_PER_BATCH = 20_000;
const MAX_COOLDOWN_MS = 30 * 60_000;

export interface CrawlDeps {
  safeFetch?: any;
  lookup?: (hostname: string) => Promise<string[]>;
  initialIntervalMs?: number;
  now?: () => number;
  createCancelProbe?: typeof createCancelProbe;
  firecrawlApiKey?: string;
  firecrawlFetchImpl?: typeof fetch;
  renderPage?: typeof renderPage;
}

export interface CrawlChunkInput {
  auditId: string;
  chunkNo: number;
  jobId: string;
  store: AuditStore;
  admin?: any;
  windowHint?: number;
  throttleState?: CrawlThrottleState;
  deps?: CrawlDeps;
  ctx?: JobContext<any>;
}

export interface CrawlChunkOutput {
  attemptedInChunk: number;
  attempted: number;
  pending: number;
  seen: number;
  endWindow: number;
  rateLimited: boolean;
  throttleState: CrawlThrottleState;
  resumeAt: number | null;
  finishedAt: number;
  renderUsage: { attempts: number; billed: number };
  cancelled: boolean;
}

/**
 * Runs a single crawl chunk bounded by time (90 s soft deadline) and max URLs (200).
 */
export async function runCrawlChunk(input: CrawlChunkInput): Promise<CrawlChunkOutput> {
  const { auditId, chunkNo, jobId, store, deps, ctx } = input;
  const audit = await store.getAudit(auditId);
  if (!audit) {
    throw new AuditPhaseError("job_lost", "crawling", `Audit ${auditId} not found`);
  }

  const previousThrottle = audit.throttle_state ?? input.throttleState;
  const attemptedBefore = audit.pages_crawled ?? 0;
  const claimLimit = Math.min(200, Math.max(0, audit.max_pages - attemptedBefore));

  if (claimLimit <= 0) {
    const stats = await store.stats(auditId);
    return {
      attemptedInChunk: 0,
      attempted: stats.attempted,
      pending: stats.pending,
      seen: stats.seen,
      endWindow: input.windowHint ?? CRAWL_WINDOW.initial,
      rateLimited: false,
      throttleState: previousThrottle ?? {
        intervalMs: 1000,
        nextRequestAt: 0,
        pausedUntil: 0,
        consecutiveRateLimits: 0,
        cooldownMs: 0,
      },
      resumeAt: null,
      finishedAt: Date.now(),
      renderUsage: { attempts: 0, billed: 0 },
      cancelled: false,
    };
  }

  const { urls: claimedUrls, isRetry } = await store.claimChunk(auditId, chunkNo, claimLimit);
  const deadline = Date.now() + CHUNK_DEADLINE_MS;

  const limits = isRetry ? RETRY_CRAWL_WINDOW : CRAWL_WINDOW;
  if (isRetry && previousThrottle) {
    previousThrottle.nextRequestAt = Math.max(
      previousThrottle.nextRequestAt,
      Date.now() + previousThrottle.intervalMs,
    );
  }

  let currentWindow = clampCrawlWindow(
    input.windowHint ?? (isRetry ? RETRY_CRAWL_WINDOW.initial : CRAWL_WINDOW.initial),
    limits,
  );

  const throttle = createCrawlThrottle(
    deadline,
    previousThrottle,
    (st) => store.saveThrottle(auditId, st),
    {
      initialIntervalMs:
        deps?.initialIntervalMs ??
        (process.env.SITE_AUDIT_REQUEST_INTERVAL_MS
          ? Math.max(250, Number(process.env.SITE_AUDIT_REQUEST_INTERVAL_MS))
          : undefined),
    },
  );

  const probe = deps?.createCancelProbe
    ? deps.createCancelProbe(input.admin ?? store, auditId)
    : createCancelProbe(input.admin ?? store, auditId);

  const defaultLookup = async (h: string): Promise<string[]> => {
    try {
      const res = await dns.lookup(h, { all: true });
      return res.map((r) => r.address);
    } catch {
      return [];
    }
  };

  const lookupFn = deps?.lookup ?? defaultLookup;
  const cachedLookup = createCachedLookup(lookupFn);
  const renderUsage = { attempts: 0, billed: 0 };
  const baseRenderAttempts = audit.render_attempts ?? 0;
  const baseRenderBilled = audit.render_billed ?? 0;
  const renderImpl = deps?.renderPage ?? renderPage;
  const shouldRender = Boolean(audit.render_javascript) && Boolean(audit.render_hold_id);
  const firecrawlApiKey =
    deps?.firecrawlApiKey ?? (typeof process !== "undefined" ? (process.env as any)?.FIRECRAWL_API_KEY : undefined);
  const renderFn = shouldRender && firecrawlApiKey
    ? async (url: string) => {
        const rendered = await renderImpl(url, {
          apiKey: firecrawlApiKey as string,
          usage: renderUsage,
          fetchImpl: deps?.firecrawlFetchImpl,
          auditId,
        });
        return { html: rendered.html, status: rendered.status ?? undefined };
      }
    : undefined;
  const fetchOptions: CrawlPageOptions = {
    deps: {
      safeFetch: (deps?.safeFetch as any) ?? safeFetch,
      lookup: cachedLookup,
      now: deps?.now ?? (() => Date.now()),
    },
    ...(renderFn
      ? {
          render: renderFn,
          renderThrottled: audit.site_platform === "shopify",
        }
      : {}),
  };

  const parsedRobots = parseAuditRobots(audit.robots_txt);
  const reporterCtx = {
    robots: parsedRobots,
    robotsUsable: audit.robots_status === "found" || audit.robots_status === "missing",
  };
  const origin = getOrigin(audit.start_url);

  const queue: ClaimedUrl[] = [...claimedUrls];
  const inFlight = new Set<Promise<CrawledPageResult | null>>();
  const completedBatch: CrawledPageResult[] = [];
  const queuedPersists: Promise<void>[] = [];
  let persistedBatches = 0;
  let attemptedInChunk = 0;
  let cancelled = false;
  let lastCancelCheck = 0;

  async function flushPersistBatch(batchToPersist: CrawledPageResult[]): Promise<void> {
    if (batchToPersist.length === 0) return;

    for (const p of batchToPersist) {
      p.id = deterministicUuid(audit!.id, p.url);
    }

    const batchIssues: DetectedIssue[] = [];
    for (const p of batchToPersist) {
      batchIssues.push(...runPageReporters(p, reporterCtx));
    }

    await store.upsertPages({ id: audit!.id, brandKey: audit!.brand_key }, batchToPersist);
    if (batchIssues.length > 0) {
      await store.insertIssues({ id: audit!.id, brandKey: audit!.brand_key }, batchIssues);
    }

    const links = batchToPersist.map((p) => ({
      pageId: p.id,
      url: p.url,
      targets: p.links
        .filter((l) => isSameOrigin(l.targetUrl, origin))
        .slice(0, MAX_STORED_LINKS_PER_PAGE)
        .map((l) => l.targetUrl),
    }));

    const discovered: Array<{ url: string; depth: number | null }> = [];
    for (const p of batchToPersist) {
      for (const l of p.links) {
        if (discovered.length >= MAX_DISCOVERED_LINKS_PER_BATCH) break;
        if (
          isSameOrigin(l.targetUrl, origin) &&
          isCrawlableUrl(l.targetUrl) &&
          crawlerAllows(parsedRobots, l.targetUrl)
        ) {
          discovered.push({
            url: l.targetUrl,
            depth: p.crawlDepth != null ? p.crawlDepth + 1 : null,
          });
        }
      }
    }

    const newStats = await store.recordBatch(audit!.id, {
      crawledUrls: batchToPersist.map((p) => p.url),
      links,
      discovered,
    });

    await store.updateAudit(audit!.id, jobId, {
      pages_crawled: newStats.attempted,
      pages_total: Math.min(newStats.seen, audit!.max_pages),
      pages_seen: newStats.seen,
      render_attempts: baseRenderAttempts + renderUsage.attempts,
      render_billed: baseRenderBilled + renderUsage.billed,
    });

    ctx?.progress?.(newStats.attempted, Math.min(newStats.seen, audit!.max_pages), "Crawling pages");
    currentWindow = adjustCrawlWindow(currentWindow, batchToPersist, limits);
    persistedBatches++;
  }

  while (queue.length > 0 && !cancelled && !throttle.stopped && Date.now() < deadline) {
    const now = Date.now();
    if (now - lastCancelCheck >= 5_000) {
      lastCancelCheck = now;
      if (await probe()) {
        cancelled = true;
        break;
      }
    }

    while (inFlight.size >= currentWindow || queuedPersists.length >= MAX_QUEUED_PERSIST_BATCHES) {
      try {
        await Promise.race([...inFlight, ...queuedPersists]);
      } catch (err) {
        if (throttle.checkpointFailed) {
          throw new AuditPhaseError("db_error", "crawling", "Throttle checkpoint failed to persist");
        }
        throw err;
      }
    }

    if (queue.length === 0 || cancelled || throttle.stopped || Date.now() >= deadline) {
      break;
    }

    const ready = await throttle.ready();
    if (!ready) {
      break;
    }

    const item = queue.shift()!;
    attemptedInChunk++;

    const fetchPromise = crawlPage(
      item.url,
      item.depth,
      item.inSitemap,
      throttle,
      fetchOptions,
    ).then((res) => {
      inFlight.delete(fetchPromise);
      if (res) {
        completedBatch.push(res);
        const threshold =
          persistedBatches === 0 ? FIRST_PERSIST_BATCH_SIZE : SUBSEQUENT_PERSIST_BATCH_SIZE;
        if (completedBatch.length >= threshold) {
          const batch = completedBatch.splice(0);
          const persistP = flushPersistBatch(batch).finally(() => {
            const idx = queuedPersists.indexOf(persistP);
            if (idx !== -1) queuedPersists.splice(idx, 1);
          });
          queuedPersists.push(persistP);
        }
      }
      return res;
    }).catch((err) => {
      inFlight.delete(fetchPromise);
      if (throttle.checkpointFailed) {
        throw new AuditPhaseError("db_error", "crawling", "Throttle checkpoint failed to persist");
      }
      throw err;
    });

    inFlight.add(fetchPromise);
  }

  // Wait for all outstanding fetches in flight
  try {
    await Promise.all(inFlight);
  } catch (err) {
    if (throttle.checkpointFailed) {
      throw new AuditPhaseError("db_error", "crawling", "Throttle checkpoint failed to persist");
    }
    throw err;
  }

  // Flush remaining completed pages
  if (completedBatch.length > 0) {
    const finalBatch = completedBatch.splice(0);
    const finalPersistP = flushPersistBatch(finalBatch).finally(() => {
      const idx = queuedPersists.indexOf(finalPersistP);
      if (idx !== -1) queuedPersists.splice(idx, 1);
    });
    queuedPersists.push(finalPersistP);
  }

  // Await all queued persists
  await Promise.all(queuedPersists);

  // Release any unattempted URLs back to pending
  if (queue.length > 0) {
    await store.releaseUrls(
      audit.id,
      queue.map((q) => q.url),
    );
  }

  if (throttle.checkpointFailed) {
    throw new AuditPhaseError("db_error", "crawling", "Throttle checkpoint failed to persist");
  }

  const finalStats = await store.stats(audit.id);
  const finishedAt = Date.now();
  const resumeAt = throttle.state.pausedUntil > finishedAt ? throttle.state.pausedUntil : null;
  const rateLimited =
    throttle.stopped ||
    throttle.state.consecutiveRateLimits > 3 ||
    throttle.state.cooldownMs > MAX_COOLDOWN_MS;

  return {
    attemptedInChunk,
    attempted: finalStats.attempted,
    pending: finalStats.pending,
    seen: finalStats.seen,
    endWindow: currentWindow,
    rateLimited,
    throttleState: throttle.state,
    resumeAt,
    finishedAt,
    renderUsage: { ...renderUsage },
    cancelled,
  };
}

/**
 * Runs the crawl phase loop: continues claiming and running crawl chunks
 * until the frontier is exhausted, max_pages is reached, rate limited, or cancelled.
 */
export async function runCrawlPhase(
  ctx: JobContext<any>,
  params: {
    audit: AuditRow;
    store: AuditStore;
    admin?: any;
    deps?: CrawlDeps;
  },
): Promise<{
  attempted: number;
  rateLimited: boolean;
  cancelled: boolean;
  crawlCompleted: boolean;
}> {
  const { audit, store, admin, deps } = params;
  let chunkNo = 0;
  let consecutiveZeroProgress = 0;
  let currentWindow = audit.window_hint ?? CRAWL_WINDOW.initial;
  let throttleState = audit.throttle_state ?? undefined;
  let rateLimited = false;
  let cancelled = false;
  let abandonedChunks = 0;
  let lastStats = await ctx.step.do("crawl-stats-start", DB_STEP, async () => {
    return store.stats(audit.id);
  });

  while (lastStats.pending > 0 && lastStats.attempted < audit.max_pages) {
    chunkNo += 1;
    const chunkStepName = `crawl-chunk-${chunkNo}`;
    const chunkOptions = audit.render_javascript
      ? { timeoutMs: 150_000, retries: 0, billed: true }
      : { timeoutMs: 150_000, retries: 1 };

    let chunkOutput: CrawlChunkOutput;
    try {
      chunkOutput = await ctx.step.do(chunkStepName, chunkOptions, async () => {
        return runCrawlChunk({
          auditId: audit.id,
          chunkNo,
          jobId: ctx.jobId,
          store,
          admin,
          windowHint: currentWindow,
          throttleState,
          deps,
          ctx,
        });
      });
    } catch (err: unknown) {
      if (err instanceof StepFailedError) {
        await ctx.step.do(`crawl-abandon-${chunkNo}`, DB_STEP, async () => {
          return store.abandonChunk(audit.id, chunkNo);
        });
        abandonedChunks += 1;
        if (abandonedChunks >= 3) {
          throw new AuditPhaseError("step_attempts_exhausted", "crawling", "Three crawl chunks failed permanently");
        }
        lastStats = await ctx.step.do(`crawl-stats-after-abandon-${chunkNo}`, DB_STEP, async () => {
          return store.stats(audit.id);
        });
        continue;
      }
      throw err;
    }

    currentWindow = chunkOutput.endWindow;
    throttleState = chunkOutput.throttleState;
    lastStats = {
      attempted: chunkOutput.attempted,
      pending: chunkOutput.pending,
      seen: chunkOutput.seen,
      abandoned: lastStats.abandoned,
    };

    if (chunkOutput.cancelled) {
      cancelled = true;
      break;
    }

    if (chunkOutput.attemptedInChunk === 0) {
      consecutiveZeroProgress += 1;
      if (consecutiveZeroProgress >= 2) {
        break;
      }
    } else {
      consecutiveZeroProgress = 0;
    }

    if (chunkOutput.rateLimited) {
      rateLimited = true;
      break;
    }

    if (chunkOutput.resumeAt && chunkOutput.resumeAt > chunkOutput.finishedAt) {
      const sleepSeconds = Math.ceil((chunkOutput.resumeAt - chunkOutput.finishedAt) / 1000);
      if (sleepSeconds > 0) {
        await ctx.step.sleep(`crawl-cooldown-${chunkNo}`, sleepSeconds);
      }
    }
  }

  const crawlCompleted =
    lastStats.pending === 0 &&
    !rateLimited &&
    !cancelled &&
    lastStats.attempted <= audit.max_pages;

  return {
    attempted: lastStats.attempted,
    rateLimited,
    cancelled,
    crawlCompleted,
  };
}
