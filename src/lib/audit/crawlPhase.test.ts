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
  const startUrl = patch?.start_url ?? "https://example.com/";
  return {
    id,
    brand_key: "qa-brand",
    job_id: "job-1",
    status: "running",
    current_phase: "crawling",
    requested_url: patch?.requested_url ?? startUrl,
    start_url: startUrl,
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

test("crawlPhase: render usage is summed in the chunk and persisted without re-billing on retry", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000030";
  store.seedAudit(
    makeAudit(auditId, {
      render_javascript: true,
      render_hold_id: "hold-1",
      render_approved_usd: 0.25,
      site_platform: null,
    }),
  );
  await store.seedStart(auditId, "https://example.com/");
  await store.seedSitemap(auditId, ["https://example.com/a"]);

  let renderCalls = 0;
  const output = await runCrawlChunk({
    auditId,
    chunkNo: 1,
    jobId: "job-1",
    store,
    deps: {
      initialIntervalMs: 0,
      safeFetch: async (u: any) => mockHtml(u.toString()),
      lookup: async () => ["93.184.216.34"],
      firecrawlApiKey: "test-key",
      renderPage: (async (_url: string, opts?: { usage?: { attempts: number; billed: number } }) => {
        renderCalls += 1;
        if (opts?.usage) {
          opts.usage.attempts += 1;
          opts.usage.billed += 1;
        }
        return { html: "<html><head><title>R</title></head><body><h1>R</h1></body></html>", status: 200 };
      }) as any,
    },
  });

  assert.ok(renderCalls > 0, "render is called when the hold is approved");
  assert.equal(output.renderUsage.attempts, renderCalls);
  assert.equal(output.renderUsage.billed, renderCalls);
  const fresh = await store.getAudit(auditId);
  assert.equal(fresh?.render_attempts, renderCalls);
  assert.equal(fresh?.render_billed, renderCalls);
});

test("crawlPhase: no render call without an approved hold", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000031";
  store.seedAudit(
    makeAudit(auditId, { render_javascript: true, render_hold_id: null }),
  );
  await store.seedStart(auditId, "https://example.com/");

  let renderCalls = 0;
  const output = await runCrawlChunk({
    auditId,
    chunkNo: 1,
    jobId: "job-1",
    store,
    deps: {
      initialIntervalMs: 0,
      safeFetch: async (u: any) => mockHtml(u.toString()),
      lookup: async () => ["93.184.216.34"],
      firecrawlApiKey: "test-key",
      renderPage: (async () => {
        renderCalls += 1;
        return { html: "<html></html>", status: 200 };
      }) as any,
    },
  });

  assert.equal(renderCalls, 0, "no render call without an approved hold");
  assert.deepEqual(output.renderUsage, { attempts: 0, billed: 0 });
  const pages = await store.listSlimPages(auditId, null, 10);
  assert.ok(pages.length > 0);
  const pagesMap = (store as any)._pages as Map<string, { rendered: boolean }> | undefined;
  const stored = pagesMap ? Array.from(pagesMap.values()) : [];
  assert.ok(stored.length > 0);
  assert.equal(stored[0].rendered, false);
});

test("crawlPhase: throttled Shopify pages are rendered instead of waiting", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000032";
  store.seedAudit(
    makeAudit(auditId, {
      render_javascript: true,
      render_hold_id: "hold-1",
      render_approved_usd: 0.25,
      site_platform: "shopify",
    }),
  );
  await store.seedStart(auditId, "https://example.com/");

  let renderCalls = 0;
  const startedAt = Date.now();
  const output = await runCrawlChunk({
    auditId,
    chunkNo: 1,
    jobId: "job-1",
    store,
    deps: {
      initialIntervalMs: 0,
      safeFetch: async (u: any) => mockRateLimit(u.toString(), "30"),
      lookup: async () => ["93.184.216.34"],
      firecrawlApiKey: "test-key",
      renderPage: (async (_url: string, opts?: { usage?: { attempts: number; billed: number } }) => {
        renderCalls += 1;
        if (opts?.usage) {
          opts.usage.attempts += 1;
          opts.usage.billed += 1;
        }
        return {
          html: "<!DOCTYPE html><html><head><title>Shop</title></head><body><h1>Shop</h1></body></html>",
          status: 200,
        };
      }) as any,
    },
  });

  assert.ok(renderCalls > 0, "throttled Shopify page is rendered");
  assert.ok(Date.now() - startedAt < 30_000, "rendered instead of waiting 30s");
  assert.equal(output.rateLimited, false);
  const pages = await store.listSlimPages(auditId, null, 10);
  assert.ok(pages.length > 0);
  assert.equal(pages[0].fetchClass, "ok");
});

test("crawlPhase: rendered chunks are billed with retries 0 (a retry never re-bills)", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000033";
  const audit = makeAudit(auditId, {
    render_javascript: true,
    render_hold_id: "hold-1",
    render_approved_usd: 0.25,
  });
  store.seedAudit(audit);
  await store.seedStart(auditId, "https://example.com/");

  const seenOpts: Array<{ name: string; opts: any }> = [];
  const fakeCtx: any = {
    jobId: "job-test",
    step: {
      do: async (name: string, opts: any, fn: () => Promise<any>) => {
        seenOpts.push({ name, opts });
        return fn();
      },
      sleep: async () => {},
    },
  };
  await runCrawlPhase(fakeCtx, {
    audit,
    store,
    admin: null,
    deps: {
      initialIntervalMs: 0,
      safeFetch: async (u: any) => mockHtml(u.toString()),
      lookup: async () => ["93.184.216.34"],
      firecrawlApiKey: "test-key",
      renderPage: (async (_url: string, opts?: { usage?: { attempts: number; billed: number } }) => {
        if (opts?.usage) {
          opts.usage.attempts += 1;
          opts.usage.billed += 1;
        }
        return {
          html: "<html><head><title>R</title></head><body><h1>R</h1></body></html>",
          status: 200,
        };
      }) as any,
    },
  });
  const chunkOpt = seenOpts.find((s) => s.name === "crawl-chunk-1")?.opts;
  assert.ok(chunkOpt, "chunk step ran");
  assert.equal(chunkOpt.billed, true);
  assert.equal(chunkOpt.retries, 0);

  // A free audit keeps the retryable chunk.
  const freeId = "00000000-0000-4000-8000-000000000034";
  const freeAudit = makeAudit(freeId, { render_javascript: false, render_hold_id: null });
  const freeStore = createMemoryAuditStore();
  freeStore.seedAudit(freeAudit);
  await freeStore.seedStart(freeId, "https://example.com/");
  const freeOpts: Array<{ name: string; opts: any }> = [];
  await runCrawlPhase(
    {
      jobId: "job-test",
      step: {
        do: async (name: string, opts: any, fn: () => Promise<any>) => {
          freeOpts.push({ name, opts });
          return fn();
        },
        sleep: async () => {},
      },
    } as any,
    {
      audit: freeAudit,
      store: freeStore,
      deps: {
        initialIntervalMs: 0,
        safeFetch: async (u: any) => mockHtml(u.toString()),
        lookup: async () => ["93.184.216.34"],
      },
    },
  );
  assert.equal(freeOpts.find((s) => s.name === "crawl-chunk-1")?.opts.retries, 1);
});
