// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/siteAuditWorkflowCrawl.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { runCrawlChunk, runCrawlPhase } from "./crawlPhase.ts";
import { createMemoryAuditStore } from "./memoryStore.ts";
import { AuditPhaseError } from "./errors.ts";
import type { AuditRow } from "./store.ts";
import type { SafeFetchResult } from "../http/safeFetch.ts";

function makeAudit(id: string, patch?: Partial<AuditRow>): AuditRow {
  return {
    id,
    brand_key: "qa-brand",
    job_id: "job-1",
    status: "running",
    current_phase: "crawling",
    start_url: "https://example.com/",
    start_host: "example.com",
    max_pages: 50,
    run_lighthouse: false,
    render_javascript: false,
    site_platform: null,
    robots_status: "found",
    robots_txt: "User-agent: *\nAllow: /",
    window_hint: 2,
    throttle_state: null,
    render_hold_id: null,
    render_approved_usd: null,
    render_attempts: 0,
    render_billed: 0,
    render_settled_at: null,
    lighthouse_approved_usd: null,
    pages_crawled: 0,
    pages_total: 50,
    pages_abandoned: 0,
    link_graph_complete: true,
    cancel_requested_at: null,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
    ...patch,
  };
}

function mockHtml(url: string, title = "Test Page", links: string[] = []): SafeFetchResult {
  const linkTags = links.map((l) => `<a href="${l}">Link</a>`).join("\n");
  const html = `<!DOCTYPE html><html><head><title>${title}</title></head><body><h1>${title}</h1>${linkTags}</body></html>`;
  const body = new TextEncoder().encode(html);
  return {
    url,
    status: 200,
    headers: new Headers({ "content-type": "text/html" }),
    body,
    truncated: false,
    text: () => html,
    json: <T>() => ({}) as unknown as T,
  };
}

function mockRateLimit(url: string, retryAfter?: string): SafeFetchResult {
  const headers = new Headers({ "content-type": "text/html" });
  if (retryAfter) headers.set("retry-after", retryAfter);
  return {
    url,
    status: 429,
    headers,
    body: new Uint8Array(),
    truncated: false,
    text: () => "Too Many Requests",
    json: <T>() => ({}) as unknown as T,
  };
}

test("crawlPhase: spacing and slower pacing retained across chunks", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000001";
  store.seedAudit(
    makeAudit(auditId, {
      throttle_state: {
        intervalMs: 2000,
        nextRequestAt: 0,
        pausedUntil: 0,
        consecutiveRateLimits: 1,
        cooldownMs: 5000,
      },
    }),
  );

  await store.seedStart(auditId, "https://example.com/");
  await store.seedSitemap(auditId, [
    "https://example.com/p1",
    "https://example.com/p2",
  ]);

  const output = await runCrawlChunk({
    auditId,
    chunkNo: 1,
    jobId: "job-1",
    store,
    deps: {
      initialIntervalMs: 50,
      safeFetch: async (u: any) => mockHtml(u.toString()),
      lookup: async () => ["93.184.216.34"],
    },
  });

  assert.equal(output.throttleState.intervalMs, 2000, "Retains slower interval across chunks");
  assert.equal(output.throttleState.cooldownMs, 5000);
  assert.ok(output.attempted >= 2);
});

test("crawlPhase: replaying a chunk writes no duplicates and maxPages is never exceeded", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000002";
  store.seedAudit(makeAudit(auditId, { max_pages: 2 }));

  await store.seedStart(auditId, "https://example.com/");
  await store.seedSitemap(auditId, [
    "https://example.com/a",
    "https://example.com/b",
  ]);

  // Run chunk 1
  const out1 = await runCrawlChunk({
    auditId,
    chunkNo: 1,
    jobId: "job-1",
    store,
    deps: {
      initialIntervalMs: 0,
      safeFetch: async (u: any) => mockHtml(u.toString()),
      lookup: async () => ["93.184.216.34"],
    },
  });

  const pagesAfterFirst = await store.listSlimPages(auditId, null, 100);
  assert.equal(pagesAfterFirst.length, 2);

  // Replay chunk 1
  const out2 = await runCrawlChunk({
    auditId,
    chunkNo: 1,
    jobId: "job-1",
    store,
    deps: {
      initialIntervalMs: 0,
      safeFetch: async (u: any) => mockHtml(u.toString()),
      lookup: async () => ["93.184.216.34"],
    },
  });

  const pagesAfterReplay = await store.listSlimPages(auditId, null, 100);
  assert.equal(pagesAfterReplay.length, 2, "Replaying chunk writes no duplicate pages");
  assert.ok(out2.attempted <= 2, "Max pages never exceeded");
});

test("crawlPhase: cancel probe stops crawl and marks output cancelled", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000003";
  store.seedAudit(makeAudit(auditId));

  await store.seedStart(auditId, "https://example.com/");
  await store.seedSitemap(auditId, [
    "https://example.com/p1",
    "https://example.com/p2",
  ]);

  const output = await runCrawlChunk({
    auditId,
    chunkNo: 1,
    jobId: "job-1",
    store,
    deps: {
      initialIntervalMs: 0,
      safeFetch: async (u: any) => mockHtml(u.toString()),
      lookup: async () => ["93.184.216.34"],
      createCancelProbe: () => async () => true, // Cancelled immediately
    },
  });

  assert.equal(output.cancelled, true);
});

test("crawlPhase: checkpoint failure stops chunk and throws db_error", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000004";
  store.seedAudit(makeAudit(auditId));
  await store.seedStart(auditId, "https://example.com/");

  // Make saveThrottle fail
  store.saveThrottle = async () => {
    throw new Error("DB connection pool full");
  };

  await assert.rejects(
    async () => {
      await runCrawlChunk({
        auditId,
        chunkNo: 1,
        jobId: "job-1",
        store,
        deps: {
          initialIntervalMs: 0,
          safeFetch: async (u: any) => mockRateLimit(u.toString(), "10"),
          lookup: async () => ["93.184.216.34"],
        },
      });
    },
    (err: any) => err instanceof AuditPhaseError && err.code === "db_error",
  );
});

test("crawlPhase: repeated 429s trigger rateLimited stop", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000005";
  store.seedAudit(makeAudit(auditId));
  await store.seedStart(auditId, "https://example.com/");

  const output = await runCrawlChunk({
    auditId,
    chunkNo: 1,
    jobId: "job-1",
    store,
    deps: {
      initialIntervalMs: 0,
      safeFetch: async (u: any) => mockRateLimit(u.toString(), "1"),
      lookup: async () => ["93.184.216.34"],
    },
  });

  assert.equal(output.rateLimited, true);
  assert.ok(output.throttleState.consecutiveRateLimits > 0);
});

test("crawlPhase: runCrawlPhase loop executes and stops on frontier exhaustion", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000006";
  const audit = makeAudit(auditId);
  store.seedAudit(audit);

  await store.seedStart(auditId, "https://example.com/");
  await store.seedSitemap(auditId, ["https://example.com/about"]);

  const executedSteps: string[] = [];
  const fakeCtx: any = {
    jobId: "job-test",
    step: {
      do: async (name: string, _opts: any, fn: () => Promise<any>) => {
        executedSteps.push(name);
        return fn();
      },
      sleep: async () => {},
    },
  };

  const outcome = await runCrawlPhase(fakeCtx, {
    audit,
    store,
    deps: {
      initialIntervalMs: 0,
      safeFetch: async (u: any) => mockHtml(u.toString()),
      lookup: async () => ["93.184.216.34"],
    },
  });

  assert.equal(outcome.crawlCompleted, true);
  assert.equal(outcome.rateLimited, false);
  assert.equal(outcome.cancelled, false);
  assert.ok(executedSteps.includes("crawl-chunk-1"));
});
