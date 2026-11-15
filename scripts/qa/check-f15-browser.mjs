#!/usr/bin/env node
/** F15 Phase 4: rank-tracking setup-wizard browser scenarios, fixtures only. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openPortal, SUPABASE_URL } from "./portalFixtureHarness.mjs";

let chromium;
try {
  ({ chromium } = await import("../../worker/node_modules/playwright/index.mjs"));
} catch {
  ({ chromium } = await import("playwright"));
}

const originArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "http://127.0.0.1:3341";
const origin = new URL(originArg);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "browser checks require a disposable local app");
const port = Number(origin.port || 3341);
async function waitForServer(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(new URL("/portal/rank-tracking", origin), { redirect: "manual" });
      if (response.status !== 404 && response.status !== 503) return true;
    } catch { /* wait */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}
let serverChild = null;
if (!(await waitForServer(1000))) {
  serverChild = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", String(port)], {
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key" },
    stdio: "ignore",
  });
  if (!(await waitForServer(90000))) {
    serverChild.kill("SIGTERM");
    throw new Error(`Next.js dev server failed to start on port ${port}`);
  }
}
const onlyIndex = process.argv.indexOf("--only");
const requested = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : "B1-B8";
const selectedScenarios = new Set();
for (const selection of requested.split(",")) {
  const range = selection.match(/^B(\d+)-B(\d+)$/);
  if (range) {
    for (let id = Number(range[1]); id <= Number(range[2]); id += 1) selectedScenarios.add(`B${id}`);
  } else {
    selectedScenarios.add(selection);
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_FIXTURES = path.resolve(HERE, "../../tests/fixtures/f15/api");
async function apiFixture(name) {
  return JSON.parse(await readFile(path.join(API_FIXTURES, name), "utf8"));
}
const emptyList = await apiFixture("trackers-empty.json");
const createdTracker = await apiFixture("tracker-created-weekly.json");
const quote1 = await apiFixture("config-save-quote-1.json");
const quote50 = await apiFixture("config-save-quote-50.json");
const suggestionsQuote = await apiFixture("suggestions-quote.json");
const suggestions25 = await apiFixture("suggestions-25.json");
const keywordsApprovalQuote = await apiFixture("keywords-approval-quote.json");
const checkQuote = await apiFixture("check-quote.json");
const trackerDetail = await apiFixture("tracker-detail.json");
const results19 = await apiFixture("results-19.json");
const trendPoints = await apiFixture("trend-points.json");
const matrixCells = await apiFixture("matrix-cells.json");
const keywordHistory = await apiFixture("keyword-history.json");

const browser = await chromium.launch({ headless: true });
let failures = 0;
let passed = 0;

async function record(id, expected, run) {
  if (!selectedScenarios.has(id)) return;
  try {
    const actual = await run();
    passed += 1;
    console.log(`${id}: PASS — ${actual}`);
  } catch (error) {
    failures += 1;
    console.error(`${id}: FAIL — ${error?.stack || error}`);
  }
}

async function makePage() {
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1280, height: 900 },
  });
  const suggestionsRequests = [];
  const keywordsRequests = [];
  const checkRequests = [];
  let keywordsCalls = 0;
  await page.route("**/api/customer/features*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ brandKey: "acme", features: { rank_tracking: true } }),
  }));
  await page.route("**/api/customer/rank-tracking/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/customer/rank-tracking/configs") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyList) });
    }
    if (request.method() === "POST" && url.pathname === "/api/customer/rank-tracking/configs") {
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(createdTracker) });
    }
    if (url.pathname.endsWith("/keywords")) {
      keywordsCalls += 1;
      const body = request.postDataJSON();
      keywordsRequests.push(body);
      if (keywordsCalls === 1) {
        assert.equal(body.maxUsd, undefined, "the first save must not carry an approval");
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Approve the price of scheduled checks to start them.",
            code: "approval_required",
            details: { quote: keywordsApprovalQuote },
          }),
        });
      }
      assert.equal(body.maxUsd, keywordsApprovalQuote.totalUsd, "the retry must approve the quoted maximum");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          added: body.keywords.length,
          addedIds: [],
          skipped: 0,
          metricsFromCache: 0,
          approval: { approvedMaxUsd: body.maxUsd, quote: keywordsApprovalQuote },
        }),
      });
    }
    if (url.pathname.endsWith("/check")) {
      const body = request.postDataJSON();
      checkRequests.push(body);
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ runId: "a1000000-0000-4000-8000-000000000000", jobId: "b2000000-0000-4000-8000-000000000000", status: "queued", pollAfterSeconds: 3 }),
      });
    }
    return route.continue();
  });
  await page.route("**/api/customer/rank-tracking/suggestions", (route) => {
    const body = route.request().postDataJSON();
    suggestionsRequests.push(body);
    if (body.cacheOnly) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ keywords: null }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(suggestions25) });
  });
  await page.route("**/api/customer/price/estimate*", (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "rank_tracking.suggestions.run") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...suggestionsQuote, action: body.action }) });
    }
    if (body.action === "rank_tracking.check.run") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...checkQuote, action: body.action }) });
    }
    const count = body.input?.draft?.keywordCount ?? 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(count >= 50 ? quote50 : quote1) });
  });
  return { context, page, suggestionsRequests, keywordsRequests, checkRequests };
}

async function openList(options) {
  const state = await makePage(options);
  await state.page.goto(new URL("/portal/rank-tracking", origin).href, { waitUntil: "networkidle" });
  return state;
}

function dialog(page) {
  return page.getByRole("dialog");
}

try {
  await record("B1", "empty list and Add Domain defaults with live cost text", async () => {
    const { context, page } = await openList();
    try {
      await page.getByText("No tracked domains yet").waitFor();
      await page.getByText("Add a domain to start monitoring keyword rankings over time.").waitFor();
      await page.getByRole("button", { name: "Add Domain" }).first().click();
      const dlg = dialog(page);
      await dlg.getByText("Add Domain", { exact: true }).first().waitFor();
      assert.equal(await dlg.getByLabel("Target Domain").inputValue(), "acme.example");
      assert.equal(await dlg.getByLabel("Target Domain").getAttribute("placeholder"), "example.com");
      await dlg.getByText("Mobile only", { exact: true }).first().waitFor();
      await dlg.getByText("4 pages (top 40 results)", { exact: true }).waitFor();
      await dlg.getByText("Weekly", { exact: true }).waitFor();
      await dlg.getByText("up to $0.0123").waitFor();
      await dlg.getByText("per keyword per check").waitFor();
      await dlg.getByText("$2.46/month").waitFor();
      await dlg.getByRole("button", { name: "Add Domain" }).last().waitFor();
      await dlg.getByRole("button", { name: "Cancel" }).waitFor();
      return "empty state, domain/country default and Mobile-only, 4-page, Weekly defaults with both cost lines";
    } finally { await context.close(); }
  });

  await record("B2", "daily and both-devices cost notes", async () => {
    const { context, page } = await openList();
    try {
      await page.getByText("No tracked domains yet").waitFor();
      await page.getByRole("button", { name: "Add Domain" }).first().click();
      const dlg = dialog(page);
      await dlg.getByText("Weekly", { exact: true }).waitFor();
      await dlg.getByText("Weekly", { exact: true }).click();
      await page.getByRole("option", { name: "Daily" }).click();
      await dlg.getByText("Daily checks cost about 7 times as much as weekly.").waitFor();
      await dlg.getByText("Mobile only", { exact: true }).first().click();
      await page.getByRole("option", { name: "Desktop + Mobile" }).click();
      await dlg.getByText("Tracking both devices doubles the cost of every check.").waitFor();
      await dlg.getByRole("button", { name: "Cancel" }).click();
      return "the 7x daily note and the doubling note each appeared on selection";
    } finally { await context.close(); }
  });

  await record("B3", "priced keyword step with top-20 preselect, approval and first check", async () => {
    const { context, page, suggestionsRequests, keywordsRequests, checkRequests } = await openList();
    try {
      await page.getByText("No tracked domains yet").waitFor();
      await page.getByRole("button", { name: "Add Domain" }).first().click();
      const dlg = dialog(page);
      await dlg.getByText("Add Domain", { exact: true }).first().waitFor();
      await dlg.getByRole("button", { name: "Add Domain" }).last().click();
      await dlg.getByText("Find the keywords acme.example already ranks for").waitFor();
      assert.ok(
        suggestionsRequests.length >= 1 && suggestionsRequests.every((request) => request.cacheOnly === true),
        `opening the step must read cacheOnly only, saw ${JSON.stringify(suggestionsRequests)}`,
      );
      assert.equal(
        suggestionsRequests.filter((request) => request.cacheOnly === false).length,
        0,
        "no paid suggestions request before the click",
      );
      await dlg.getByRole("button", { name: /Find ranking keywords/ }).click();
      await dlg.getByText("20 of 25 selected").waitFor();
      assert.equal(suggestionsRequests.filter((request) => request.cacheOnly === false).length, 1);
      await dlg.getByRole("button", { name: "Save Keywords" }).click();
      const approval = page.getByRole("dialog", { name: "Approve scheduled checks" });
      await approval.waitFor();
      await approval.getByText("20 keywords on Mobile, checked weekly").waitFor();
      await approval.getByRole("button", { name: "Approve and save" }).click();
      assert.equal(keywordsRequests.length, 2, `expected the save plus its approval retry, saw ${keywordsRequests.length}`);
      await page.getByText("Added 20 keywords for tracking").waitFor();
      await dlg.getByText("Check rankings now?").waitFor();
      await dlg.getByRole("button", { name: /Check 20 keywords now/ }).click();
      const review = page.getByRole("dialog", { name: "Check rankings now", exact: true });
      await review.waitFor();
      await review.getByRole("button", { name: "Run check" }).click();
      await page.getByText("Rank check started").waitFor();
      assert.equal(checkRequests.length, 1, "the first check must run once with its approval");
      return "cacheOnly-first fetch, 25 rows with 20 checked, approval retry, then the first check";
    } finally { await context.close(); }
  });

  async function openDetail(options = {}) {
    const { context, page } = await openPortal(browser, origin, {
      viewport: options.viewport ?? { width: 1280, height: 900 },
    });
    let currentRun = options.initialRun !== undefined ? options.initialRun : results19.run;
    let resultsData = JSON.parse(JSON.stringify(results19));
    let resultsFetchCount = 0;
    const pinRequests = [];
    const checkRequests = [];

    await page.route("**/api/customer/features*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ brandKey: "acme", features: { rank_tracking: true } }),
    }));

    await page.route("**/api/customer/rank-tracking/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());

      if (request.method() === "GET" && url.pathname.endsWith("/runs/latest")) {
        const runToReturn = typeof options.getRun === "function" ? options.getRun() : currentRun;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: runToReturn }) });
      }
      if (request.method() === "GET" && url.pathname.includes("/results")) {
        resultsFetchCount += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(resultsData) });
      }
      if (request.method() === "GET" && url.pathname.includes("/trend")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(trendPoints) });
      }
      if (request.method() === "GET" && url.pathname.includes("/matrix")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(matrixCells) });
      }
      if (request.method() === "GET" && url.pathname.includes("/history")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(keywordHistory) });
      }
      if (request.method() === "GET" && url.pathname.endsWith(`/configs/${trackerDetail.tracker.id}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(trackerDetail) });
      }
      if (request.method() === "POST" && url.pathname.endsWith("/check")) {
        checkRequests.push(request.postDataJSON());
        if (options.onCheck) options.onCheck();
        return route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            runId: "run-22222222-0000-4000-8000-000000000000",
            jobId: "job-22222222-0000-4000-8000-000000000000",
            status: "queued",
            pollAfterSeconds: 3,
          }),
        });
      }
      if (request.method() === "POST" && url.pathname.endsWith("/pin")) {
        const body = request.postDataJSON();
        pinRequests.push(body);
        if (options.pinFail) {
          return route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "Failed to update pin", code: "pin_failed" }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ updated: 1, updatedIds: body.keywordIds }),
        });
      }
      return route.continue();
    });

    await page.route("**/api/customer/price/estimate*", (route) => {
      const body = route.request().postDataJSON();
      if (body.action === "rank_tracking.check.run") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...checkQuote, action: body.action }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quote1) });
    });

    const detailUrl = new URL(`/portal/rank-tracking/${trackerDetail.tracker.id}`, origin);
    if (options.urlParams) {
      for (const [k, v] of Object.entries(options.urlParams)) {
        detailUrl.searchParams.set(k, v);
      }
    }
    await page.goto(detailUrl.href, { waitUntil: "networkidle" });

    return {
      context,
      page,
      pinRequests,
      checkRequests,
      getResultsFetchCount: () => resultsFetchCount,
      setRun: (r) => { currentRun = r; },
      resultsData,
    };
  }

  await record("B4", "detail renders chart legend, strip 'AI Overview seen for 6 of 19 checked keywords', 'AI' tags", async () => {
    const { context, page } = await openDetail();
    try {
      await page.getByText("AI Overview seen for 6 of 19 checked keywords on mobile (latest check).").waitFor();
      await page.getByText("Top 3", { exact: true }).first().waitFor();
      await page.getByText("4–10", { exact: true }).first().waitFor();
      await page.getByText("11–20", { exact: true }).first().waitFor();
      await page.getByText("Not in top 20", { exact: true }).first().waitFor();
      await page.getByText("Not checked", { exact: true }).first().waitFor();
      const aiTags = page.getByText("AI", { exact: true });
      assert.ok((await aiTags.count()) >= 6, "expected at least 6 AI tags rendered");
      return "chart legend, strip 'AI Overview seen for 6 of 19 checked keywords', 'AI' tags";
    } finally { await context.close(); }
  });

  await record("B5", "'Check rankings' opens cost dialog, confirm -> progress '10/20', polling stops at completed and table refreshes once", async () => {
    let runState = { ...results19.run, status: "completed" };
    const { context, page, checkRequests, getResultsFetchCount } = await openDetail({
      getRun: () => runState,
    });
    try {
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByText("Check rankings", { exact: true }).click();
      const costDlg = page.getByRole("dialog", { name: /Check 19 keywords/ });
      await costDlg.waitFor();
      await costDlg.getByText("19 keywords × 1 device = 19 searches").waitFor();

      const fetchCountBefore = getResultsFetchCount();

      runState = {
        ...results19.run,
        id: "run-22222222-0000-4000-8000-000000000000",
        status: "running",
        keywordsTotal: 20,
        keywordsChecked: 10,
        phase: "checking",
        pollAfterSeconds: 3,
      };
      await costDlg.getByRole("button", { name: "Run check" }).click();

      await page.getByLabel("Rank check progress").waitFor();
      await page.getByText("10/20").waitFor();
      assert.equal(checkRequests.length, 1);

      runState = {
        ...runState,
        status: "completed",
        keywordsChecked: 20,
        completedAt: new Date().toISOString(),
        pollAfterSeconds: null,
      };

      await page.waitForTimeout(4000);
      const fetchCountAfter = getResultsFetchCount();
      assert.ok(fetchCountAfter > fetchCountBefore, "table results should refresh after run finishes");

      return "Check rankings opens CostReviewDialog, progress 10/20 shown, polling stops at completed and table refreshed";
    } finally { await context.close(); }
  });

  await record("B6", "pin moves row before request resolves and reverts on a 500", async () => {
    const { context, page } = await openDetail({
      pinFail: true,
    });
    try {
      await page.getByText("best espresso blend").waitFor();
      const rows = page.locator("table").last().locator("tbody tr");
      const firstRowBefore = await rows.nth(0).innerText();
      assert.ok(firstRowBefore.includes("acme coffee beans"));

      const pinBtn = rows.nth(1).getByRole("button", { name: "Pin keyword to top" });
      await pinBtn.click();

      const firstRowOptimistic = await rows.nth(0).innerText();
      assert.ok(firstRowOptimistic.includes("best espresso blend"), "row must move to top optimistically");

      await page.waitForTimeout(600);
      const firstRowReverted = await rows.nth(0).innerText();
      assert.ok(firstRowReverted.includes("acme coffee beans"), "row must revert after 500 failure");

      return "pin moved row optimistically to top and reverted on 500";
    } finally { await context.close(); }
  });

  await record("B7", "History toggle and trend modal (axis label 'Google position (1 = best)')", async () => {
    const { context, page } = await openDetail();
    try {
      const historyBtn = page.getByRole("button", { name: "History", exact: true });
      await historyBtn.waitFor();
      await historyBtn.click();

      await page.getByText("Nov 6", { exact: false }).waitFor();
      await page.getByText("Nov 13", { exact: false }).waitFor();

      await page.getByRole("button", { name: "Latest", exact: true }).click();
      await page.getByText("acme coffee beans").waitFor();

      await page.getByRole("button", { name: "acme coffee beans" }).click();
      const modal = page.getByRole("dialog");
      await modal.waitFor();
      await modal.getByText("Google position (1 = best)").waitFor();
      await modal.getByText("Better ↑").waitFor();

      return "History toggle renders matrix cells, and trend modal opens with inverted axis label";
    } finally { await context.close(); }
  });

  await record("B8", "filters aio=shown and export CSV contains numeric change and the 'AI Overview' column; phone width 390 px has no horizontal page scroll", async () => {
    const { context, page } = await openDetail();
    try {
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      await page.getByRole("combobox", { name: "AI Overview" }).click();
      await page.getByRole("option", { name: "Shown" }).click();

      await page.waitForURL((url) => url.searchParams.get("aio") === "shown");
      assert.ok(page.url().includes("aio=shown"), "URL should contain aio=shown");

      const rows = page.locator("table").last().locator("tbody tr");
      assert.equal(await rows.count(), 6, "only 6 rows with AI Overview should be shown");

      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export", exact: false }).first().click();
      await page.getByRole("menuitem", { name: "Export CSV" }).click();
      const download = await downloadPromise;
      const downloadPath = await download.path();
      const csvContent = await readFile(downloadPath, "utf8");

      assert.ok(csvContent.includes("AI Overview"), "CSV must include AI Overview column");
      assert.ok(/[\+\-]?\d+/.test(csvContent), "CSV must include numeric change");

      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(500);

      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      assert.ok(!hasHorizontalScroll, "phone width 390px must have no horizontal page scroll");

      return "aio=shown filter isolates 6 rows, CSV export has AI Overview and numeric change, 390px has no horizontal scroll";
    } finally { await context.close(); }
  });
} finally {
  await browser.close();
  if (serverChild) serverChild.kill("SIGTERM");
}

if (failures) process.exitCode = 1;
else console.log(`ok ${passed} scenario${passed === 1 ? "" : "s"}`);
