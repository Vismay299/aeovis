#!/usr/bin/env node
/**
 * F03 Phase 4 — cost UI browser verification (F03-AC-11, F03-AC-14, F03-AC-15).
 *
 * Scenarios, every assertion on the §6.6 copy verbatim:
 *
 *   U1–U7  /portal/usage: loading, empty, error, partial, populated, range
 *          change updates ?range=7d, 390 px has no horizontal overflow.
 *   R1–R4  the scan report cost card: final, running, unavailable, unknown
 *          attempts (em dash per answer, "Unknown" per-answer cost).
 *   O1–O4  /ops/costs: the 401 copy, resolve-dialog validation (including the
 *          probe row's disabled "Not billed"), bulk-accept validation and the
 *          controls confirmation field.
 *
 * The customer pages run through `portalFixtureHarness.openPortal`, which
 * substitutes the Supabase session and the customer read APIs. Each case then
 * registers its OWN page-level route for `/api/customer/usage` or
 * `/api/customer/scan/report/*`: Playwright checks a page route before the
 * context route, so the shared harness file is untouched.
 *
 * `/ops/costs` needs no session (the operator token is a cookie the /api
 * perimeter checks), so it opens in a fresh context with the `/api/ops/*`
 * answers defined below.
 *
 * NOTHING LEAVES THE MACHINE. Every non-loopback request is aborted and
 * counted, and the count is asserted to be zero. The ops cases also assert no
 * request names rollout or probe dispatch: this page may never change dispatch
 * rollout.
 *
 * Usage: node scripts/qa/check-f03-browser.mjs [origin] [--only=U1,R2]
 *
 * The app must be BUILT with the placeholder Supabase variables CI uses
 * (`NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co`,
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key`): `NEXT_PUBLIC_*` is
 * inlined by `next build`, and without it the login page cannot create a
 * client, so every portal case times out on the sign-in redirect.
 *
 * Output: "ok N scenarios" on success; a JSON row per case in
 * `test_reports/f03-browser/`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openPortal, SUPABASE_URL } from "./portalFixtureHarness.mjs";

let chromium;
try {
  ({ chromium } = await import("../../worker/node_modules/playwright/index.mjs"));
} catch {
  ({ chromium } = await import("playwright"));
}

const args = process.argv.slice(2);
let originArg = "http://127.0.0.1:3328";
let onlyArg = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--only" && args[i + 1]) {
    onlyArg = args[i + 1];
    i++;
  } else if (args[i].startsWith("--only=")) {
    onlyArg = args[i].slice("--only=".length);
  } else if (!args[i].startsWith("--") && args[i].startsWith("http")) {
    originArg = args[i];
  }
}

const origin = new URL(originArg);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
assert.ok(
  LOOPBACK.has(origin.hostname),
  "browser checks require a disposable local app",
);
const port = parseInt(origin.port || "3328", 10);

const output = path.resolve("test_reports/f03-browser");
await mkdir(output, { recursive: true });

const SUPABASE_HOST = new URL(SUPABASE_URL).hostname;

// ---------------------------------------------------------------------------
// The local app
// ---------------------------------------------------------------------------

async function waitForServer(targetPort, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${targetPort}/robots.txt`);
      if (res.ok) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

function spawnNextServer(targetPort) {
  return spawn(
    process.execPath,
    [nextBin, "start", "-p", String(targetPort)],
    {
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key",
      },
      stdio: "ignore",
    },
  );
}

let serverChild = null;
if (!(await waitForServer(port, 1500))) {
  serverChild = spawnNextServer(port);
  const up = await waitForServer(port, 35000);
  if (!up) {
    if (serverChild) serverChild.kill("SIGTERM");
    throw new Error(`Failed to start Next.js server on port ${port}`);
  }
}

// ---------------------------------------------------------------------------
// Request watches
// ---------------------------------------------------------------------------

/**
 * Every request the page makes that is not loopback and not the placeholder
 * Supabase the fixture harness answers itself. Nothing here may ever be
 * non-empty: the harness aborts these, and so does the ops context.
 */
function watchForeign(page) {
  const foreign = [];
  page.on("request", (request) => {
    const url = safeUrl(request.url());
    if (!url || url.protocol === "data:" || url.protocol === "blob:") return;
    if (LOOPBACK.has(url.hostname)) return;
    if (url.hostname === SUPABASE_HOST) return;
    foreign.push(request.url());
  });
  return foreign;
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function jsonRoute(status, body) {
  return async (route) => {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  };
}

function localDay(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Usage fixtures (GET /api/customer/usage)
// ---------------------------------------------------------------------------

function usageDays(count) {
  const days = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const last = i === 0;
    days.push({
      date: localDay(date),
      usd: last ? 3.6 : 0.3,
      knownUsd: last ? 3.2 : 0.3,
      unknownUsd: last ? 0.4 : 0,
    });
  }
  return days;
}

function usageFor(range) {
  const count = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  return {
    range,
    timeZone: "UTC",
    from: new Date(Date.now() - (count - 1) * 24 * 60 * 60 * 1000).toISOString(),
    to: new Date().toISOString(),
    totals: {
      accountedUsd: 12.5,
      knownUsd: 12.1,
      unknownUsd: 0.4,
      calls: 122,
      unknownCalls: 3,
    },
    days: usageDays(count),
    features: [
      {
        feature: "ai_visibility.scan",
        label: "AI visibility scans",
        usd: 12.5,
        unknownUsd: 0.4,
        calls: 122,
      },
    ],
    recent: [
      {
        occurredAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        feature: "ai_visibility.scan",
        label: "AI visibility scans",
        provider: "openrouter",
        endpoint: "probe:chatgpt",
        usd: 0.0612,
        costSource: "provider_reported",
        notBilled: false,
      },
      {
        occurredAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
        feature: "ai_visibility.scan",
        label: "AI visibility scans",
        provider: "dataforseo",
        endpoint: "serp:google",
        usd: 0.002,
        costSource: "price_table",
        notBilled: false,
      },
      {
        occurredAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        feature: "ai_visibility.scan",
        label: "AI visibility scans",
        provider: "openrouter",
        endpoint: "probe:gemini",
        usd: 0.2,
        costSource: "reservation",
        notBilled: false,
      },
      {
        occurredAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
        feature: "platform.selftest",
        label: "Platform check",
        provider: "openrouter",
        endpoint: "selftest",
        usd: 0,
        costSource: "none",
        notBilled: true,
      },
    ],
    position: {
      todayUsd: 3.6,
      monthUsd: 12.5,
      dailyCapUsd: 10,
      monthlyCapUsd: 50,
      openHoldsUsd: 0,
      openHolds: 0,
      dayStartsAt: `${localDay(new Date())}T00:00:00.000Z`,
      monthStartsAt: `${localDay(new Date()).slice(0, 8)}01T00:00:00.000Z`,
    },
    generatedAt: new Date().toISOString(),
  };
}

function emptyUsage() {
  const days = usageDays(30).map((day) => ({
    date: day.date,
    usd: 0,
    knownUsd: 0,
    unknownUsd: 0,
  }));
  return {
    ...usageFor("30d"),
    totals: { accountedUsd: 0, knownUsd: 0, unknownUsd: 0, calls: 0, unknownCalls: 0 },
    days,
    features: [],
    recent: [],
    position: {
      ...usageFor("30d").position,
      todayUsd: 0,
      monthUsd: 0,
      dailyCapUsd: null,
      monthlyCapUsd: null,
    },
  };
}

/** Partial: seven unknown calls, but only one of them is inside `recent`. */
function partialUsage() {
  const base = usageFor("30d");
  return {
    ...base,
    totals: {
      accountedUsd: 12.5,
      knownUsd: 12.1,
      unknownUsd: 0.4,
      calls: 122,
      unknownCalls: 7,
    },
    recent: base.recent.filter((row) => row.costSource === "reservation"),
  };
}

const PARTIAL_COPY =
  "7 calls did not report a cost, so they are counted at the amount reserved before they ran. Reported costs replace them when available.";

// ---------------------------------------------------------------------------
// Scan report fixtures (GET /api/customer/scan/report/[scan_id])
// ---------------------------------------------------------------------------

function reportScan(cost) {
  return {
    id: "scan-1",
    brand: "Acme",
    url: "https://acme.example",
    scanned_at: "2026-11-01T09:00:00.000Z",
    created_at: "2026-11-01T09:00:00.000Z",
    visibility_pct: 42,
    summary_stats: null,
    prompts_tracked: 30,
    prompts_mentioned: 9,
    platform: ["chatgpt"],
    engines: null,
    planned_questions: null,
    engine_scores: null,
    competitors: [],
    share_of_voice_pct: null,
    win_rate_pct: null,
    brand_citation_share_pct: null,
    cost,
  };
}

function finalReport() {
  return {
    scan: reportScan({
      state: "final",
      jobId: "job-1",
      answers: 116,
      attempts: 116,
      knownUsd: 29,
      unknownAttempts: 0,
      reservedUnknownUsd: 0,
      totalAccountedUsd: 29,
      perAnswerUsd: 0.25,
      byEngine: [
        {
          engine: "chatgpt",
          label: "ChatGPT",
          answers: 58,
          attempts: 58,
          knownUsd: 14.5,
          unknownAttempts: 0,
          perAnswerUsd: 0.25,
        },
        {
          engine: "gemini",
          label: "Gemini",
          answers: 58,
          attempts: 58,
          knownUsd: 14.5,
          unknownAttempts: 0,
          perAnswerUsd: 0.25,
        },
      ],
      heldUsd: null,
    }),
    results: [
      {
        id: "result-1",
        query: "best running shoes",
        engine: "chatgpt",
        answer_text: "An answer.",
        answered: true,
        mentioned: true,
        brand_cited: false,
        position: 1,
        sentiment: "positive",
        raw: { observation_id: "obs-1" },
        created_at: "2026-11-01T09:00:00.000Z",
        cost: { usd: 0.25, attempts: 1, unknownAttempts: 0 },
      },
    ],
  };
}

function runningReport() {
  const report = finalReport();
  report.scan.cost = {
    ...report.scan.cost,
    state: "running",
    knownUsd: 6.3,
    totalAccountedUsd: 7.5,
    perAnswerUsd: null,
    heldUsd: 1.2,
    byEngine: [
      {
        engine: "chatgpt",
        label: "ChatGPT",
        answers: 58,
        attempts: 58,
        knownUsd: 6.3,
        unknownAttempts: 0,
        perAnswerUsd: null,
      },
    ],
  };
  return report;
}

function unavailableReport() {
  const report = finalReport();
  report.scan.cost = {
    state: "unavailable",
    jobId: null,
    answers: 0,
    attempts: 0,
    knownUsd: 0,
    unknownAttempts: 0,
    reservedUnknownUsd: 0,
    totalAccountedUsd: 0,
    perAnswerUsd: null,
    byEngine: [],
    heldUsd: null,
  };
  return report;
}

function unknownReport() {
  const report = finalReport();
  report.scan.cost = {
    ...report.scan.cost,
    knownUsd: 12.1,
    unknownAttempts: 2,
    reservedUnknownUsd: 0.4,
    totalAccountedUsd: 12.5,
    perAnswerUsd: null,
    byEngine: [
      {
        engine: "chatgpt",
        label: "ChatGPT",
        answers: 58,
        attempts: 60,
        knownUsd: 12.1,
        unknownAttempts: 2,
        perAnswerUsd: null,
      },
    ],
  };
  report.results = [
    {
      id: "result-1",
      query: "best running shoes",
      engine: "chatgpt",
      answer_text: "An answer.",
      answered: true,
      mentioned: true,
      brand_cited: false,
      position: 1,
      sentiment: "positive",
      raw: { observation_id: "obs-1" },
      created_at: "2026-11-01T09:00:00.000Z",
      cost: { usd: null, attempts: 1, unknownAttempts: 1 },
    },
    {
      id: "result-2",
      query: "which shoes are best for flat feet",
      engine: "gemini",
      answer_text: "An answer.",
      answered: true,
      mentioned: false,
      brand_cited: false,
      position: null,
      sentiment: "neutral",
      raw: { observation_id: "obs-2" },
      created_at: "2026-11-01T09:00:00.000Z",
      cost: { usd: 0.24, attempts: 1, unknownAttempts: 0 },
    },
  ];
  return report;
}

// ---------------------------------------------------------------------------
// Operator fixtures (GET /api/ops/costs, /api/ops/spend/*)
// ---------------------------------------------------------------------------

function operatorCosts() {
  return {
    byWorkspace: [
      {
        brandKey: "acme",
        feature: "ai_visibility.scan",
        accountedUsd: 12.5,
        knownUsd: 12.1,
        unknownUsd: 0.4,
        calls: 122,
        openReconciliations: 3,
      },
      {
        brandKey: "beta",
        feature: "platform.selftest",
        accountedUsd: 0.03,
        knownUsd: 0.03,
        unknownUsd: 0,
        calls: 2,
        openReconciliations: 0,
      },
    ],
    byEndpoint: [
      {
        provider: "openrouter",
        endpoint: "probe:chatgpt",
        calls: 60,
        estimateUsd: 12,
        actualUsd: 12.1,
        unknownCalls: 2,
        undershoots: 2,
        maxRatio: 1.4,
      },
      {
        provider: "dataforseo",
        endpoint: "serp:google",
        calls: 62,
        estimateUsd: 0.13,
        actualUsd: 0.12,
        unknownCalls: 0,
        undershoots: 0,
        maxRatio: 0.94,
      },
    ],
    openHolds: [
      {
        holdId: "hold-old",
        brandKey: "acme",
        feature: "ai_visibility.scan",
        estimateUsd: 1,
        createdAt: "2026-11-10T08:00:00.000Z",
        expiresAt: "2026-11-11T08:00:00.000Z",
        subjectKind: "scan_job",
        subjectId: "job-old",
      },
      {
        holdId: "hold-new",
        brandKey: "acme",
        feature: "ai_visibility.scan",
        estimateUsd: 1.2,
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString(),
        subjectKind: "scan_job",
        subjectId: "job-new",
      },
    ],
    reconciliations: [
      {
        id: "rec-undershoot",
        brandKey: "acme",
        feature: "ai_visibility.scan",
        provider: "openrouter",
        endpoint: "probe:chatgpt",
        kind: "undershoot",
        estimateUsd: 0.2,
        actualUsd: 0.28,
        priceVersion: "2026-10-21.1",
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        isProbe: false,
      },
      {
        id: "rec-unknown-old",
        brandKey: "acme",
        feature: "ai_visibility.scan",
        provider: "openrouter",
        endpoint: "probe:gemini",
        kind: "unknown_cost",
        estimateUsd: 0.2,
        actualUsd: null,
        priceVersion: "2026-10-21.1",
        createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        isProbe: true,
      },
      {
        id: "rec-unknown-new",
        brandKey: "acme",
        feature: "ai_visibility.scan",
        provider: "openrouter",
        endpoint: "probe:perplexity",
        kind: "unknown_cost",
        estimateUsd: 0.2,
        actualUsd: null,
        priceVersion: "2026-10-21.1",
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        isProbe: true,
      },
    ],
    engineStats: [
      { engine: "chatgpt", samples: 24, medianUsd: 0.24, p90Usd: 0.31 },
      { engine: "gemini", samples: 22, medianUsd: 0.23, p90Usd: 0.3 },
    ],
    priceVersion: "2026-10-21.1",
  };
}

function operatorControls() {
  return {
    controls: [
      {
        feature: "ai_visibility.scan",
        enabled: true,
        mode: "all",
        brandAllowlist: [],
        dailyCapUsd: 10,
        maxCallUsd: 0.5,
        note: "Scan answers.",
        updatedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      },
      {
        feature: "platform.selftest",
        enabled: false,
        mode: "allowlist",
        brandAllowlist: ["acme"],
        dailyCapUsd: null,
        maxCallUsd: null,
        note: null,
        updatedAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
      },
    ],
  };
}

function operatorLimits() {
  return {
    limits: [
      {
        brandKey: "acme",
        dailyCapUsd: 10,
        monthlyCapUsd: 50,
        updatedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const requested = new Set();
if (onlyArg) {
  for (const part of onlyArg.split(",")) requested.add(part.trim());
}
const shouldRun = (id) => requested.size === 0 || requested.has(id);

let passed = 0;
let failed = 0;

async function record(id, description, run) {
  if (!shouldRun(id)) return;
  const row = {
    case: id,
    suite: "f03-browser",
    description,
    startedAt: new Date().toISOString(),
  };
  try {
    row.actual = await run();
    row.outcome = "pass";
    passed++;
  } catch (error) {
    row.outcome = "fail";
    row.actual = error.stack || error.message;
    failed++;
    process.exitCode = 1;
  }
  row.endedAt = new Date().toISOString();
  await writeFile(path.join(output, `${id}.json`), JSON.stringify(row, null, 2));
  console.log(`${id}: ${row.outcome} — ${String(row.actual).split("\n")[0]}`);
}

/** Opens /portal/usage with the usage route answered by `answer`. */
async function openUsage(browser, answer, options = {}) {
  const { context, page } = await openPortal(browser, origin, {
    viewport: options.viewport ?? { width: 1440, height: 1000 },
  });
  const foreign = watchForeign(page);
  const requests = [];
  await page.route("**/api/customer/usage*", async (route) => {
    requests.push(safeUrl(route.request().url())?.searchParams.get("range") ?? "");
    await answer(route);
  });
  await page.goto(new URL(options.path ?? "/portal/usage", origin).href, {
    waitUntil: options.waitUntil ?? "networkidle",
  });
  return { context, page, foreign, requests };
}

async function openReport(browser, body) {
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 1000 },
  });
  const foreign = watchForeign(page);
  await page.route("**/api/customer/scan/report/*", jsonRoute(200, body));
  await page.goto(new URL("/portal/scans/scan-1", origin).href, {
    waitUntil: "networkidle",
  });
  return { context, page, foreign };
}

const browser = await chromium.launch({ headless: true });

try {
  // -------------------------------------------------------------------------
  // /portal/usage
  // -------------------------------------------------------------------------

  await record("U1", "usage loading shows the skeleton", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { context, page, foreign } = await openUsage(
      browser,
      async (route) => {
        await gate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(usageFor("30d")),
        });
      },
      { waitUntil: "domcontentloaded" },
    );
    try {
      await page
        .locator('[data-slot="usage-skeleton"]')
        .waitFor({ state: "visible", timeout: 20000 });
      release();
      await page
        .getByText("Limits reset at 00:00 UTC.", { exact: true })
        .waitFor({ state: "visible", timeout: 20000 });
      assert.deepEqual(foreign, [], "no request may leave the local origin");
      return "the usage page paints its skeleton before the response, then the loaded page";
    } finally {
      await context.close();
    }
  });

  await record("U2", "usage empty state", async () => {
    const { context, page, foreign } = await openUsage(browser, jsonRoute(200, emptyUsage()));
    try {
      await page
        .getByText("No usage recorded yet", { exact: true })
        .first()
        .waitFor({ state: "visible", timeout: 20000 });
      await page
        .getByText("No paid calls yet.", { exact: true })
        .waitFor({ state: "visible", timeout: 20000 });
      assert.equal(
        await page.getByText("No usage recorded yet", { exact: true }).count(),
        2,
        "the chart and the feature list each say the range has no usage",
      );
      assert.deepEqual(foreign, [], "no request may leave the local origin");
      return 'empty usage shows "No usage recorded yet" twice and "No paid calls yet."';
    } finally {
      await context.close();
    }
  });

  await record("U3", "usage error state", async () => {
    const { context, page, foreign } = await openUsage(
      browser,
      jsonRoute(503, {
        code: "usage_unavailable",
        error: "Usage could not be loaded. Please retry.",
      }),
    );
    try {
      await page
        .getByText("Usage could not be loaded.", { exact: true })
        .waitFor({ state: "visible", timeout: 20000 });
      await page
        .getByRole("button", { name: "Retry", exact: true })
        .waitFor({ state: "visible", timeout: 20000 });
      assert.deepEqual(foreign, [], "no request may leave the local origin");
      return 'a 503 answers "Usage could not be loaded." with a "Retry" button';
    } finally {
      await context.close();
    }
  });

  await record("U4", "usage partial alert uses totals.unknownCalls", async () => {
    const { context, page, foreign } = await openUsage(browser, jsonRoute(200, partialUsage()));
    try {
      await page
        .getByText("Some costs are estimates", { exact: true })
        .waitFor({ state: "visible", timeout: 20000 });
      await page
        .getByText(PARTIAL_COPY, { exact: true })
        .waitFor({ state: "visible", timeout: 20000 });
      assert.deepEqual(foreign, [], "no request may leave the local origin");
      return "the partial alert counts the 7 unknown calls the API reported, not the one row in `recent`";
    } finally {
      await context.close();
    }
  });

  await record("U5", "usage populated state", async () => {
    const { context, page, foreign } = await openUsage(browser, jsonRoute(200, usageFor("30d")));
    try {
      await page.getByText("Today", { exact: true }).waitFor({ state: "visible", timeout: 20000 });
      await page.getByText("This month", { exact: true }).waitFor({ state: "visible", timeout: 20000 });
      await page.getByText("$3.60", { exact: true }).first().waitFor({ state: "visible", timeout: 20000 });
      await page.getByText("of $10.00 daily limit", { exact: true }).waitFor({ state: "visible", timeout: 20000 });
      await page.getByText("of $50.00 monthly limit", { exact: true }).waitFor({ state: "visible", timeout: 20000 });
      await page.getByText("Limits reset at 00:00 UTC.", { exact: true }).waitFor({ state: "visible", timeout: 20000 });
      await page.getByText("Priced or reported", { exact: true }).first().waitFor({ state: "visible", timeout: 20000 });
      await page
        .getByText("Estimated (cost not reported)", { exact: true })
        .first()
        .waitFor({ state: "visible", timeout: 20000 });
      for (const source of ["Reported", "Priced", "Estimated", "Not billed"]) {
        await page
          .getByText(source, { exact: true })
          .first()
          .waitFor({ state: "visible", timeout: 20000 });
      }
      await page
        .locator('[aria-label="Daily spend, 30d"]')
        .first()
        .waitFor({ state: "attached", timeout: 20000 });
      assert.deepEqual(foreign, [], "no request may leave the local origin");
      return "limit cards, the reset footnote, the chart legend, the total and all four source badges render";
    } finally {
      await context.close();
    }
  });

  await record("U6", "range change updates ?range=7d", async () => {
    const { context, page, foreign, requests } = await openUsage(
      browser,
      async (route) => {
        const range = safeUrl(route.request().url())?.searchParams.get("range") || "30d";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(usageFor(range === "7d" ? "7d" : "30d")),
        });
      },
    );
    try {
      await page
        .getByText("Limits reset at 00:00 UTC.", { exact: true })
        .waitFor({ state: "visible", timeout: 20000 });
      await page.getByRole("combobox", { name: "Date range" }).click();
      await page
        .locator('[data-slot="select-item"]:has-text("Last 7 days")')
        .click();
      await page.waitForFunction(
        () => window.location.search.includes("range=7d"),
        undefined,
        { timeout: 15000 },
      );
      await page.waitForFunction(
        () => document.body.innerText.includes("Last 7 days"),
        undefined,
        { timeout: 15000 },
      );
      assert.ok(requests.includes("7d"), "the page asked the API for the 7-day range");
      assert.deepEqual(foreign, [], "no request may leave the local origin");
      return "choosing Last 7 days writes ?range=7d and refetches with range=7d";
    } finally {
      await context.close();
    }
  });

  await record("U7", "usage at 390 px has no horizontal overflow", async () => {
    const { context, page, foreign } = await openUsage(
      browser,
      jsonRoute(200, usageFor("30d")),
      { viewport: { width: 390, height: 844 } },
    );
    try {
      await page
        .getByText("Limits reset at 00:00 UTC.", { exact: true })
        .waitFor({ state: "visible", timeout: 20000 });
      await page.waitForTimeout(400);
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      assert.ok(
        metrics.scrollWidth <= 390,
        `the 390 px page overflowed: scrollWidth ${metrics.scrollWidth}`,
      );
      assert.deepEqual(foreign, [], "no request may leave the local origin");
      return `390 px has no horizontal overflow: scrollWidth=${metrics.scrollWidth}`;
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------
  // Scan report cost card
  // -------------------------------------------------------------------------

  await record("R1", "report cost card — final", async () => {
    const { context, page, foreign } = await openReport(browser, finalReport());
    try {
      await page.getByText("Cost", { exact: true }).first().waitFor({ state: "visible", timeout: 20000 });
      await page.getByText("$29.00", { exact: true }).waitFor({ state: "visible", timeout: 20000 });
      await page
        .getByText("116 answers · about $0.25 per answer", { exact: true })
        .waitFor({ state: "visible", timeout: 20000 });
      await page
        .locator('[data-slot="scan-cost-card"]')
        .waitFor({ state: "visible", timeout: 20000 });
      assert.deepEqual(foreign, [], "no request may leave the local origin");
      return 'final cost renders $29.00 and "116 answers · about $0.25 per answer"';
    } finally {
      await context.close();
    }
  });

  await record("R2", "report cost card — running", async () => {
    const { context, page, foreign } = await openReport(browser, runningReport());
    try {
      await page
        .getByText("Cost so far", { exact: true })
        .waitFor({ state: "visible", timeout: 20000 });
      await page
        .getByText("This scan is still running. $1.20 is reserved for it.", {
          exact: true,
        })
        .waitFor({ state: "visible", timeout: 20000 });
      assert.deepEqual(foreign, [], "no request may leave the local origin");
      return 'a running scan is titled "Cost so far" and names the reserved amount';
    } finally {
      await context.close();
    }
  });

  await record("R3", "report cost card — unavailable", async () => {
    const { context, page, foreign } = await openReport(browser, unavailableReport());
    try {
      await page
        .getByText("Cost details are not available for this scan.", { exact: true })
        .waitFor({ state: "visible", timeout: 20000 });
      assert.equal(
        await page.locator('[data-slot="scan-cost-card"]').count(),
        0,
        "an unavailable cost renders no numbers",
      );
      assert.deepEqual(foreign, [], "no request may leave the local origin");
      return "an unavailable cost says so and draws no numbers";
    } finally {
      await context.close();
    }
  });

  await record("R4", "report cost card — unknown attempts", async () => {
    const { context, page, foreign } = await openReport(browser, unknownReport());
    try {
      await page
        .getByText(
          "2 attempts did not report a cost. Each is counted at its $0.20 reservation, so the total may be lower.",
          { exact: true },
        )
        .waitFor({ state: "visible", timeout: 20000 });
      await page
        .getByText(
          "116 answers · per-answer cost not available while some costs are unknown",
          { exact: true },
        )
        .waitFor({ state: "visible", timeout: 20000 });
      await page
        .getByLabel("Not available while a cost is unknown")
        .waitFor({ state: "visible", timeout: 20000 });
      await page.getByRole("button", { name: "Show cost per answer" }).click();
      await page
        .getByRole("columnheader", { name: "Question", exact: true })
        .waitFor({ state: "visible", timeout: 20000 });
      await page
        .getByText("Unknown", { exact: true })
        .first()
        .waitFor({ state: "visible", timeout: 20000 });
      assert.deepEqual(foreign, [], "no request may leave the local origin");
      return "unknown attempts warn, the per-answer cell is an em dash, and a null answer cost reads Unknown";
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------
  // /ops/costs
  // -------------------------------------------------------------------------

  /** A fresh operator context: no session, `/api/ops/*` answered from here. */
  async function openOps({ unauthorized = false } = {}) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1200 },
      reducedMotion: "reduce",
    });
    const foreign = [];
    const requests = [];

    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push(`${request.method()} ${url.pathname}`);

      if (!LOOPBACK.has(url.hostname)) {
        foreign.push(request.url());
        return route.abort("blockedbyclient");
      }

      if (url.pathname.startsWith("/api/ops/")) {
        if (unauthorized) {
          return route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({ code: "unauthenticated", error: "Operator token required." }),
          });
        }
        if (url.pathname === "/api/ops/costs") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(operatorCosts()),
          });
        }
        if (url.pathname === "/api/ops/spend/controls") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(operatorControls()),
          });
        }
        if (url.pathname === "/api/ops/spend/limits") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(operatorLimits()),
          });
        }
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      }

      return route.continue();
    });

    const page = await context.newPage();
    await page.goto(new URL("/ops/costs", origin).href, { waitUntil: "networkidle" });
    return { context, page, foreign, requests };
  }

  function assertNoRollout(requests) {
    const forbidden = requests.filter((entry) =>
      /rollout|probe_dispatch|dispatch_control|set_probe_rollout/i.test(entry),
    );
    assert.deepEqual(
      forbidden,
      [],
      `the cost console must never touch dispatch rollout: ${forbidden.join(", ")}`,
    );
    const writes = requests.filter(
      (entry) =>
        entry.startsWith("POST ") ||
        entry.startsWith("PUT ") ||
        entry.startsWith("DELETE "),
    );
    assert.deepEqual(writes, [], "opening dialogs must not write anything");
  }

  await record("O1", "ops costs 401 copy", async () => {
    const { context, page, foreign, requests } = await openOps({ unauthorized: true });
    try {
      await page
        .getByText("Operator sign-in required. Set the operator token and reload.", {
          exact: true,
        })
        .waitFor({ state: "visible", timeout: 20000 });
      assert.equal(
        await page.getByText("Spend by workspace", { exact: true }).count(),
        0,
        "a 401 renders no sections",
      );
      assertNoRollout(requests);
      assert.deepEqual(foreign, [], "no request may leave the local origin");
      return "a 401 answers the operator sign-in copy and renders no numbers";
    } finally {
      await context.close();
    }
  });

  await record("O2", "resolve dialog validation and the probe row", async () => {
    const { context, page, foreign, requests } = await openOps();
    try {
      await page
        .getByText("Reconciliation queue", { exact: true })
        .waitFor({ state: "visible", timeout: 20000 });
      await page.getByText("3 open · 2 unknown cost", { exact: true }).waitFor({
        state: "visible",
        timeout: 20000,
      });

      await page.getByRole("button", { name: "Resolve probe:chatgpt" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText("Resolve reconciliation", { exact: true }).waitFor({
        state: "visible",
        timeout: 20000,
      });
      const submit = dialog.getByRole("button", { name: "Resolve", exact: true });
      assert.equal(await submit.isDisabled(), true, "an empty note cannot be submitted");
      await dialog.getByLabel("Note").fill("too short");
      assert.equal(
        await submit.isDisabled(),
        true,
        "a note under 10 characters cannot be submitted",
      );
      await dialog
        .getByText("Add a note of at least 10 characters.", { exact: true })
        .waitFor({ state: "visible", timeout: 10000 });
      await dialog.getByLabel("Note").fill("Accepted after reviewing the receipt.");
      assert.equal(await submit.isDisabled(), false, "a valid note can be submitted");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page
        .locator('[data-slot="dialog-content"]')
        .waitFor({ state: "detached", timeout: 10000 });

      await page.getByRole("button", { name: "Resolve probe:gemini" }).click();
      const probeDialog = page.getByRole("dialog");
      await probeDialog
        .getByText("Resolve reconciliation", { exact: true })
        .waitFor({ state: "visible", timeout: 20000 });
      assert.equal(
        await probeDialog.getByRole("radio", { name: "Not billed", exact: true }).isDisabled(),
        true,
        "a probe row cannot be marked not billed here",
      );
      await probeDialog
        .getByText("Use Measurement operations for answer attempts", { exact: true })
        .waitFor({ state: "visible", timeout: 10000 });
      await probeDialog.getByRole("button", { name: "Cancel", exact: true }).click();

      assertNoRollout(requests);
      assert.deepEqual(foreign, [], "no request may leave the local origin");
      return "Resolve is blocked under 10 characters, and the probe row disables Not billed with its hint";
    } finally {
      await context.close();
    }
  });

  await record("O3", "bulk accept dialog validation", async () => {
    const { context, page, foreign, requests } = await openOps();
    try {
      await page
        .getByRole("button", { name: "Accept unknown costs older than…" })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByText("Accept unknown costs older than…", { exact: true })
        .waitFor({ state: "visible", timeout: 20000 });
      const accept = dialog.getByRole("button", { name: "Accept", exact: true });
      assert.equal(await accept.isDisabled(), true, "an empty note cannot be submitted");
      await dialog.getByLabel("Days").fill("7");
      await dialog.getByLabel("Note").fill("too short");
      assert.equal(
        await accept.isDisabled(),
        true,
        "a note under 10 characters cannot be submitted",
      );
      await dialog
        .getByText("Add a note of at least 10 characters.", { exact: true })
        .waitFor({ state: "visible", timeout: 10000 });
      await dialog
        .getByText(/open unknown-cost row/)
        .first()
        .waitFor({ state: "visible", timeout: 10000 });
      await dialog.getByLabel("Note").fill("Accepting the unknown-cost backlog.");
      assert.equal(await accept.isDisabled(), false, "a valid bulk note can be submitted");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

      assertNoRollout(requests);
      assert.deepEqual(foreign, [], "no request may leave the local origin");
      return "the bulk dialog reports the cutoff, disables Accept under 10 characters, and can only accept";
    } finally {
      await context.close();
    }
  });

  await record("O4", "controls edit dialog needs the typed feature", async () => {
    const { context, page, foreign, requests } = await openOps();
    try {
      await page
        .getByRole("button", { name: "Edit ai_visibility.scan" })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByText("Type ai_visibility.scan to confirm", { exact: true })
        .waitFor({ state: "visible", timeout: 20000 });
      const save = dialog.getByRole("button", { name: "Save", exact: true });
      assert.equal(await save.isDisabled(), true, "Save needs the typed feature name");
      await dialog.getByLabel("Type ai_visibility.scan to confirm").fill("ai_visibility");
      assert.equal(await save.isDisabled(), true, "a partial feature name is refused");
      await dialog
        .getByLabel("Type ai_visibility.scan to confirm")
        .fill("ai_visibility.scan");
      assert.equal(await save.isDisabled(), false, "the exact feature name unlocks Save");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

      assertNoRollout(requests);
      assert.deepEqual(foreign, [], "no request may leave the local origin");
      return "the controls dialog requires the exact feature name before Save";
    } finally {
      await context.close();
    }
  });

  if (failed === 0) console.log(`ok ${passed} scenarios`);
  else console.log(`${failed} of ${passed + failed} scenarios failed`);
} finally {
  await browser.close();
  if (serverChild) serverChild.kill("SIGTERM");
}
