// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/siteAuditWorkflowPhases.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runLighthousePhase, LIGHTHOUSE_WAVE_STEP } from "./phases.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";

// F03 price: kept local so the audit import guard stays green.
const LIGHTHOUSE_LIVE_USD = 0.005;

function makeAudit(overrides: Record<string, unknown> = {}) {
  return {
    id: "audit-1",
    brand_key: "brand-1",
    run_lighthouse: true,
    start_url: "https://example.com/",
    lighthouse_approved_usd: 10,
    ...overrides,
  };
}

function makeStore(pages: Array<{ id: string; url: string }>, hooks: Record<string, any> = {}) {
  const updates: any[] = [];
  const inserted: any[] = [];
  let persistCalls = 0;
  return {
    updates,
    inserted,
    async lighthouseCandidates() {
      return pages.map((p) => ({ id: p.id, url: p.url, statusCode: 200, fetchClass: "ok" as const }));
    },
    async updateAudit(_id: string, _job: string, patch: any) {
      updates.push(patch);
      if (hooks.updateAudit) await hooks.updateAudit(patch, updates.length);
    },
    async insertLighthouse(_audit: any, rows: any[]) {
      persistCalls += 1;
      if (hooks.insertLighthouse) await hooks.insertLighthouse(rows, persistCalls);
      inserted.push(...rows);
    },
    get persistCalls() {
      return persistCalls;
    },
  };
}

function makeCtx(capture: Record<string, any>, behavior?: (name: string, opts: any, fn: () => Promise<any>) => Promise<any>) {
  const cache = new Map<string, any>();
  return {
    jobId: "job-1",
    brandKey: "brand-1",
    step: {
      async do(name: string, opts: any, fn: () => Promise<any>) {
        capture[name] = opts;
        if (behavior) return behavior(name, opts, fn);
        if (name.startsWith("lighthouse-wave-") && cache.has(name)) return cache.get(name);
        let attempts = 0;
        const maxAttempts = 1 + (opts?.retries ?? 0);
        for (;;) {
          try {
            const out = await fn();
            if (name.startsWith("lighthouse-wave-")) cache.set(name, out);
            return out;
          } catch (err) {
            attempts += 1;
            if (attempts >= maxAttempts) throw err;
          }
        }
      },
      async sleep() {},
    },
  };
}

function okFetch(page: { id: string; url: string }, strategy: "mobile" | "desktop") {
  return {
    result: {
      url: page.url,
      pageId: page.id,
      strategy,
      performanceScore: 90,
      accessibilityScore: 91,
      bestPracticesScore: 92,
      seoScore: 93,
      lcpMs: 1000,
      cls: 0.01,
      inpMs: 100,
      ttfbMs: 200,
      errorMessage: null,
    },
    payloadJson: JSON.stringify({ ok: true, strategy }),
  };
}

test("persistence retry does not replay paid calls", async () => {
  let fetchCalls = 0;
  const store = makeStore([{ id: "p1", url: "https://example.com/" }], {
    async insertLighthouse(_rows: any[], call: number) {
      if (call === 1) throw new Error("progress unavailable");
    },
  });
  const capture: Record<string, any> = {};
  const ctx = makeCtx(capture);
  const meteredCalls: string[] = [];
  const out = await runLighthousePhase(ctx as never, {
    audit: makeAudit(),
    store: store as never,
    jobId: "job-1",
    deps: {
      fetchLighthouse: async (page: any, strategy: any) => {
        fetchCalls += 1;
        return okFetch(page, strategy);
      },
      uploadPayload: async () => {},
      metered: (async (i: any, call: any) => {
        meteredCalls.push(i.idempotencyKey);
        return (await call()).value;
      }) as never,
    },
  });
  assert.equal(fetchCalls, 2);
  assert.equal(meteredCalls.length, 2);
  assert.equal(store.inserted.length, 2);
  assert.deepEqual(capture["lighthouse-wave-1"], { ...LIGHTHOUSE_WAVE_STEP });
  assert.deepEqual(out.pages, [{ id: "p1", url: "https://example.com/" }]);
});

test("persists sibling results when one fetch fails", async () => {
  const store = makeStore(
    [
      { id: "p1", url: "https://example.com/" },
      { id: "p2", url: "https://example.com/about" },
    ],
  );
  const capture: Record<string, any> = {};
  const ctx = makeCtx(capture);
  await runLighthousePhase(ctx as never, {
    audit: makeAudit(),
    store: store as never,
    jobId: "job-1",
    deps: {
      fetchLighthouse: async (page: any, strategy: any) => {
        if (page.id === "p2" && strategy === "mobile") throw new Error("step timed out");
        return okFetch(page, strategy);
      },
      uploadPayload: async () => {},
      metered: (async (_i: any, call: any) => (await call()).value) as never,
    },
  });
  assert.equal(store.inserted.length, 4);
  const failed = store.inserted.filter((r: any) => r.errorMessage);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].errorMessage, "step timed out");
});

test("budget guard skips a wave without paid calls", async () => {
  const pages = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, url: `https://example.com/s${i}` }));
  let fetchCalls = 0;
  const store = makeStore(pages);
  const capture: Record<string, any> = {};
  const ctx = makeCtx(capture);
  // 6 pages = 12 checks; approve only the first wave (5 pages = 10 checks).
  await runLighthousePhase(ctx as never, {
    audit: makeAudit({ lighthouse_approved_usd: 10 * LIGHTHOUSE_LIVE_USD }),
    store: store as never,
    jobId: "job-1",
    deps: {
      fetchLighthouse: async (page: any, strategy: any) => {
        fetchCalls += 1;
        return okFetch(page, strategy);
      },
      uploadPayload: async () => {},
      metered: (async (_i: any, call: any) => (await call()).value) as never,
    },
  });
  assert.equal(fetchCalls, 10);
  assert.equal(store.inserted.length, 12);
  const budgetRows = store.inserted.filter((r: any) => r.errorMessage === "Lighthouse budget reached");
  assert.equal(budgetRows.length, 2);
});

test("storage failure keeps scores with the error message", async () => {
  const store = makeStore([{ id: "p1", url: "https://example.com/" }]);
  const capture: Record<string, any> = {};
  const ctx = makeCtx(capture);
  await runLighthousePhase(ctx as never, {
    audit: makeAudit(),
    store: store as never,
    jobId: "job-1",
    deps: {
      fetchLighthouse: async (page: any, strategy: any) => okFetch(page, strategy),
      uploadPayload: async () => {
        throw new Error("bucket down");
      },
      metered: (async (_i: any, call: any) => (await call()).value) as never,
    },
  });
  assert.equal(store.inserted.length, 2);
  for (const row of store.inserted) {
    assert.equal(row.performanceScore, 90);
    assert.equal(row.errorMessage, "Report details could not be stored.");
  }
});

test("step definitions are billed once with no retries", async () => {
  const store = makeStore([{ id: "p1", url: "https://example.com/" }]);
  const capture: Record<string, any> = {};
  const ctx = makeCtx(capture);
  await runLighthousePhase(ctx as never, {
    audit: makeAudit(),
    store: store as never,
    jobId: "job-1",
    deps: {
      fetchLighthouse: async (page: any, strategy: any) => okFetch(page, strategy),
      uploadPayload: async () => {},
      metered: (async (_i: any, call: any) => (await call()).value) as never,
    },
  });
  assert.deepEqual(capture["lighthouse-select"], DB_STEP);
  assert.deepEqual(capture["lighthouse-wave-1"], { timeoutMs: 140_000, retries: 0, billed: true });
  assert.deepEqual(capture["lighthouse-persist-1"], DB_STEP);
});

test("refusal happens before any provider call when the budget is zero", async () => {
  let fetchCalls = 0;
  const store = makeStore([{ id: "p1", url: "https://example.com/" }]);
  const ctx = makeCtx({});
  await runLighthousePhase(ctx as never, {
    audit: makeAudit({ lighthouse_approved_usd: 0 }),
    store: store as never,
    jobId: "job-1",
    deps: {
      fetchLighthouse: async (page: any, strategy: any) => {
        fetchCalls += 1;
        return okFetch(page, strategy);
      },
      uploadPayload: async () => {},
      metered: (async (_i: any, call: any) => (await call()).value) as never,
    },
  });
  assert.equal(fetchCalls, 0);
  assert.ok(store.inserted.every((r: any) => r.errorMessage === "Lighthouse budget reached"));
});
