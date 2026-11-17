// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/siteAuditWorkflowCrawl.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { runCrawlChunk, runCrawlPhase } from "./crawlPhase.ts";
import { createMemoryAuditStore } from "./memoryStore.ts";
import { AuditPhaseError } from "./errors.ts";
import { finalizeAudit } from "./phases.ts";
import { StepFailedError } from "../jobs/runner.ts";
import {
  crawlerAccessAad,
  encryptCrawlerField,
} from "./crawlerAccessCrypto.ts";
import { renderPage } from "./renderedPage.ts";
import type { AuditRow } from "./store.ts";
import type { SafeFetchResult } from "../../shared/http/safeFetch.ts";

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

test("crawlPhase: renders billed in a chunk that fails still reach render_billed", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000034";
  store.seedAudit(
    makeAudit(auditId, {
      render_javascript: true,
      render_hold_id: "hold-1",
      render_approved_usd: 0.25,
      site_platform: null,
    }),
  );
  await store.seedStart(auditId, "https://example.com/");
  await store.seedSitemap(auditId, ["https://example.com/a", "https://example.com/b"]);

  let renderCalls = 0;
  await assert.rejects(
    runCrawlChunk({
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
          // A billed scrape whose HTML is unusable: Firecrawl charged, the page fails.
          if (renderCalls === 2) throw new Error("Rendered page is not usable");
          return { html: "<html><head><title>R</title></head><body><h1>R</h1></body></html>", status: 200 };
        }) as any,
      },
    }),
    /not usable/,
  );

  assert.ok(renderCalls >= 2, "the failing render ran");
  const fresh = await store.getAudit(auditId);
  assert.equal(fresh?.render_billed, renderCalls, "every billed render is recorded for settlement");
  assert.equal(fresh?.render_attempts, renderCalls);
});

test("crawlPhase: a failed rendered chunk is abandoned and the audit finishes partial", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000035";
  const audit = makeAudit(auditId, {
    render_javascript: true,
    render_hold_id: "hold-1",
    render_approved_usd: 0.25,
    site_platform: null,
  });
  store.seedAudit(audit);
  await store.seedStart(auditId, "https://example.com/");
  await store.seedSitemap(auditId, ["https://example.com/a"]);

  // The runner surfaces a step whose retries are spent as StepFailedError.
  const ctx: any = {
    jobId: "job-1",
    step: {
      do: async (_name: string, opts: any, fn: () => Promise<any>) => {
        try {
          return await fn();
        } catch (err) {
          if (opts?.retries === 0) throw new StepFailedError("step_failed", (err as Error).message);
          throw err;
        }
      },
      sleep: async () => {},
    },
  };
  let renderCalls = 0;
  const outcome = await runCrawlPhase(ctx, {
    audit,
    store,
    admin: null,
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
        throw new Error("Rendered page is not usable");
      }) as any,
    },
  });

  // Two pages were leased; each renders at most once (no step retry re-renders).
  assert.ok(renderCalls >= 1 && renderCalls <= 2, `renders: ${renderCalls}`);
  const fresh = await store.getAudit(auditId);
  assert.ok((fresh?.pages_abandoned ?? 0) > 0, "the chunk's pages are abandoned");
  assert.equal(fresh?.render_billed, renderCalls, "every billed render is still recorded");
  const final = await finalizeAudit(fresh!, outcome, store, "job-1");
  assert.equal(final.status, "partial");
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

// ---------------------------------------------------------------------------
// Shopify crawler access (F18 phase 9)
// ---------------------------------------------------------------------------

const CRAWLER_SIGNATURE_INPUT = 'sig1=("@authority" "signature-agent");keyid="test-key"';
const CRAWLER_SIGNATURE = "sig1=:EXAMPLE-NOT-A-REAL-SIGNATURE:";

function crawlerEnv(): Record<string, string | undefined> {
  return { CRAWLER_ACCESS_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex") };
}

function sealedCredential(
  env: Record<string, string | undefined>,
  brandKey = "qa-brand",
  host = "example.com",
) {
  return {
    brandKey,
    host,
    signatureInput: encryptCrawlerField(
      CRAWLER_SIGNATURE_INPUT,
      crawlerAccessAad(brandKey, host, "signature_input"),
      env,
    ),
    signature: encryptCrawlerField(
      CRAWLER_SIGNATURE,
      crawlerAccessAad(brandKey, host, "signature"),
      env,
    ),
    expiresAt: null,
  };
}

test("crawler access: page GETs carry the replay headers only for the credential host", async () => {
  const env = crawlerEnv();
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-0000000000a1";
  store.seedAudit(makeAudit(auditId, { crawler_credential_id: "cred-1" }));
  await store.seedStart(auditId, "https://example.com/");
  await store.seedSitemap(auditId, ["https://example.com/p1"]);

  const seen: Array<{ url: string; headers: Headers }> = [];
  const output = await runCrawlChunk({
    auditId,
    chunkNo: 1,
    jobId: "job-1",
    store,
    deps: {
      initialIntervalMs: 0,
      safeFetch: async (u: any, init: any) => {
        seen.push({ url: u.toString(), headers: new Headers(init?.headers ?? {}) });
        return mockHtml(u.toString());
      },
      lookup: async () => ["93.184.216.34"],
      env,
      resolveCrawlerAccess: async () => ({ id: "cred-1", sealed: sealedCredential(env) }),
    },
  });

  assert.ok(seen.length >= 2);
  for (const call of seen) {
    assert.equal(call.headers.get("signature-input"), CRAWLER_SIGNATURE_INPUT, call.url);
    assert.equal(call.headers.get("signature"), CRAWLER_SIGNATURE, call.url);
    assert.equal(call.headers.get("signature-agent"), '"https://shopify.com"', call.url);
  }
  assert.ok(!JSON.stringify(output).includes(CRAWLER_SIGNATURE));
});

test("crawler access: a decrypt failure logs one host-only line and crawls unsigned", async () => {
  const env = crawlerEnv();
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-0000000000a2";
  store.seedAudit(makeAudit(auditId, { crawler_credential_id: "cred-1" }));
  await store.seedStart(auditId, "https://example.com/");

  const warnings: string[] = [];
  const seen: Headers[] = [];
  await runCrawlChunk({
    auditId,
    chunkNo: 1,
    jobId: "job-1",
    store,
    deps: {
      initialIntervalMs: 0,
      safeFetch: async (u: any, init: any) => {
        seen.push(new Headers(init?.headers ?? {}));
        return mockHtml(u.toString());
      },
      lookup: async () => ["93.184.216.34"],
      env,
      warn: (message: string) => warnings.push(message),
      resolveCrawlerAccess: async () => ({
        id: "cred-1",
        sealed: {
          brandKey: "qa-brand",
          host: "example.com",
          signatureInput: "corrupt",
          signature: "corrupt",
          expiresAt: null,
        },
      }),
    },
  });

  assert.ok(seen.length > 0);
  for (const headers of seen) assert.equal(headers.get("signature"), null);
  assert.deepEqual(warnings, ["[audit] crawler access unreadable host=example.com"]);
  assert.ok(!warnings.join("\n").includes("corrupt"));
});

test("crawler access: a live credential with no key fails the chunk", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-0000000000a3";
  store.seedAudit(makeAudit(auditId, { crawler_credential_id: "cred-1" }));
  await store.seedStart(auditId, "https://example.com/");

  await assert.rejects(
    runCrawlChunk({
      auditId,
      chunkNo: 1,
      jobId: "job-1",
      store,
      deps: {
        initialIntervalMs: 0,
        safeFetch: async (u: any) => mockHtml(u.toString()),
        lookup: async () => ["93.184.216.34"],
        env: {},
        resolveCrawlerAccess: async () => ({
          id: "cred-1",
          sealed: {
            brandKey: "qa-brand",
            host: "example.com",
            signatureInput: "sealed",
            signature: "sealed",
            expiresAt: null,
          },
        }),
      },
    }),
    (err: unknown) =>
      err instanceof AuditPhaseError && err.code === "unknown" && err.phase === "crawling",
  );
});

test("secrets: Firecrawl render requests and render options carry no signature", async () => {
  const env = crawlerEnv();
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-0000000000a4";
  store.seedAudit(
    makeAudit(auditId, {
      crawler_credential_id: "cred-1",
      render_javascript: true,
      render_hold_id: "hold-1",
      site_platform: "shopify",
    }),
  );
  await store.seedStart(auditId, "https://example.com/");

  const firecrawlCalls: Array<{ url: string; init: any }> = [];
  const renderCalls: Array<{ url: string; options: any }> = [];

  await runCrawlChunk({
    auditId,
    chunkNo: 1,
    jobId: "job-1",
    store,
    deps: {
      initialIntervalMs: 0,
      safeFetch: async (u: any) => mockRateLimit(u.toString()),
      lookup: async () => ["93.184.216.34"],
      env,
      resolveCrawlerAccess: async () => ({ id: "cred-1", sealed: sealedCredential(env) }),
      firecrawlApiKey: "test-firecrawl-key",
      renderPage: async (url: string, options: any) => {
        renderCalls.push({ url, options });
        return renderPage(url, options);
      },
      firecrawlFetchImpl: (async (url: string, init: any) => {
        firecrawlCalls.push({ url, init });
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              rawHtml:
                "<!DOCTYPE html><html><head><title>Rendered</title></head><body><h1>Rendered</h1></body></html>",
              metadata: { statusCode: 200, url },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as any,
    },
  });

  assert.ok(renderCalls.length > 0, "a throttled Shopify page still renders");
  assert.ok(firecrawlCalls.length > 0);
  for (const call of renderCalls) {
    assert.deepEqual(Object.keys(call.options).sort(), ["apiKey", "auditId", "fetchImpl", "usage"]);
  }
  for (const call of firecrawlCalls) {
    const body = String(call.init?.body ?? "");
    assert.ok(!/signature/i.test(body), "the Firecrawl request body carries no signature");
    const headerNames = [...new Headers(call.init?.headers ?? {}).keys()];
    assert.ok(headerNames.every((name) => !/^signature/i.test(name)));
  }
});
