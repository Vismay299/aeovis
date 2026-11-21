#!/usr/bin/env node
/**
 * F14 Phase 3/4 — Domain Overview browser verification (B1–B9).
 *
 * Scenarios:
 *   B1: Flag off: empty state and nav item hidden
 *   B2: Loading /portal/domain?domain=offcult.in sends cacheOnly: true & shows "Run lookup · up to $0.03"
 *   B3: Click "Run lookup" → overview + keywords render, cost hint visible, next page sends maxUsd
 *   B4: Filters apply, URL updates, reload restores last-used filters, over-budget saved filters show held-back alert
 *   B5: Save keywords with tags → POST /api/customer/keywords/saved without metrics; disabled after a
 *       location change; hidden when keyword_research is off
 *   B6: Competitors: CostReviewDialog → results → sort by average position (cache-only re-read)
 *   B7: Add as competitor → toast; absent when project_memory is off; a quick pick fills the input
 *       without a request
 *   B8: 375 px: no page overflow, and with one row selected every bulk-bar control is inside the viewport
 *   B9: Export CSV filename and headers
 *
 * Output: "ok 9 scenarios" on pass.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openPortal, SUPABASE_URL } from "./portalFixtureHarness.mjs";
import { slideToConfirm } from "./confirmGestures.mjs";

let chromium;
try {
  ({ chromium } = await import("../../worker/node_modules/playwright/index.mjs"));
} catch {
  ({ chromium } = await import("playwright"));
}

const args = process.argv.slice(2);
let originArg = "http://127.0.0.1:3328";
let onlyArg = null;
let outputDirArg = "test_reports/f14-browser";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--only" && args[i + 1]) {
    onlyArg = args[i + 1];
    i++;
  } else if (args[i].startsWith("--only=")) {
    onlyArg = args[i].slice("--only=".length);
  } else if (!args[i].startsWith("--")) {
    if (args[i].startsWith("http")) {
      originArg = args[i];
    } else {
      outputDirArg = args[i];
    }
  }
}

const origin = new URL(originArg);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname),
  "browser checks require a disposable local app",
);
const port = parseInt(origin.port || "3328", 10);
const output = path.resolve(outputDirArg);
await mkdir(output, { recursive: true });

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

import { createRequire } from "node:module";
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
const isRunning = await waitForServer(port, 1500);
if (!isRunning) {
  serverChild = spawnNextServer(port);
  const up = await waitForServer(port, 35000);
  if (!up) {
    if (serverChild) serverChild.kill("SIGTERM");
    throw new Error(`Failed to start Next.js server on port ${port}`);
  }
}

const browser = await chromium.launch({ headless: true });

// Parse scenarios filter
const requestedScenarios = new Set();
if (onlyArg) {
  for (const part of onlyArg.split(",")) {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      const [start, end] = trimmed.split("-");
      const startNum = parseInt(start.replace(/\D/g, ""), 10);
      const endNum = parseInt(end.replace(/\D/g, ""), 10);
      for (let n = startNum; n <= endNum; n++) {
        requestedScenarios.add(`B${n}`);
      }
    } else {
      requestedScenarios.add(trimmed);
    }
  }
}

let passedScenarios = 0;

async function record(id, description, run) {
  if ((id === "R1" || id === "R2") && !onlyArg) {
    return;
  }
  if (requestedScenarios.size > 0 && !requestedScenarios.has(id)) {
    return;
  }

  const row = {
    case: id,
    suite: "f14-browser",
    startedAt: new Date().toISOString(),
    description,
  };
  try {
    row.actual = await run();
    row.outcome = "pass";
    passedScenarios++;
  } catch (error) {
    row.outcome = "fail";
    row.actual = error.stack || error.message;
    process.exitCode = 1;
  }
  row.endedAt = new Date().toISOString();
  await writeFile(
    path.join(output, `${id}.json`),
    JSON.stringify(row, null, 2),
  );
  console.log(`${id}: ${row.outcome} — ${String(row.actual).split("\n")[0]}`);
  if (row.outcome === "fail") {
    throw new Error(`${id} failed: ${row.actual}`);
  }
}

function makePriceQuote(action, totalUsd) {
  return {
    action,
    currency: "USD",
    totalUsd,
    expectedUsd: totalUsd,
    units: [],
    lines: [
      {
        label: "Domain research line",
        quantity: 1,
        unitUsd: totalUsd,
        totalUsd,
      },
    ],
    monthly: null,
    warnings: [],
    blocked: null,
    priceVersion: "v1",
    quotedAt: new Date().toISOString(),
    inputsHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  };
}

function makeSampleKeywords() {
  const keywords = [];
  for (let i = 1; i <= 50; i++) {
    keywords.push({
      keyword: i === 1 ? "oversized t shirt" : i === 2 ? "anime t shirt" : `keyword ${i}`,
      position: i,
      searchVolume: 10000 - i * 100,
      traffic: 500 - i * 5,
      cpc: 0.45,
      url: "https://offcult.in/collections/oversized",
      relativeUrl: "/collections/oversized",
      keywordDifficulty: 35,
    });
  }
  return keywords;
}

function makeOverviewBody(overrides = {}) {
  return {
    status: "ok",
    domain: "offcult.in",
    displayTarget: "offcult.in",
    scope: "subdomains",
    organicTraffic: 1840,
    organicKeywords: 312,
    hasData: true,
    market: { locationCode: 2356, languageCode: "en", country: "India" },
    isOwnSite: false,
    isDeclaredCompetitor: false,
    cached: true,
    fetchedAt: new Date().toISOString(),
    provenance: { gateway: "dataforseo" },
    ...overrides,
  };
}

function makeKeywordsBody(keywords = makeSampleKeywords()) {
  return {
    status: "ok",
    domain: "offcult.in",
    page: 1,
    pageSize: 50,
    totalCount: keywords.length,
    hasMore: false,
    keywords,
    cached: true,
    fetchedAt: new Date().toISOString(),
    provenance: { gateway: "dataforseo" },
  };
}

function makeCompetitorRow(domain, { keywordsCount, avgPosition, visibility, etv }) {
  return {
    domain,
    keywordsCount,
    avgPosition,
    medianPosition: 3,
    visibility,
    etv,
    isOwnSite: false,
    isDeclaredCompetitor: false,
  };
}

try {
  // Scenario B1: Flag off
  await record("B1", "flag off: empty state and nav item hidden", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 1440, height: 1000 },
    });
    try {
      await page.route("**/api/customer/features*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            brandKey: "acme",
            features: { domain_research: false },
          }),
        });
      });

      await page.route("**/api/customer/domain/overview*", async (route) => {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            code: "feature_unavailable",
            error: "This page is not available for your workspace yet.",
          }),
        });
      });

      await page.evaluate(() => {
        window.__REACT_QUERY_CLIENT__?.clear();
      });

      await page.goto(new URL("/portal/domain", origin).href, { waitUntil: "networkidle" });

      // Verify sidebar does not link to /portal/domain
      const domainNavCount = await page.locator('nav a[href="/portal/domain"]').count();
      assert.equal(domainNavCount, 0, "nav link to /portal/domain is hidden when flag is off");

      // Verify EmptyState text
      const emptyTitle = page.getByText("This page is not available for your workspace yet.");
      await emptyTitle.waitFor({ state: "visible", timeout: 10000 });
      const emptyDesc = page.getByText("Ask Perceev support to turn on domain research.");
      await emptyDesc.waitFor({ state: "visible", timeout: 10000 });

      return "Flag off displays empty state and hides nav item";
    } finally {
      await context.close();
    }
  });

  // Scenario B2: Loading /portal/domain?domain=offcult.in sends cacheOnly: true & shows "Run lookup · up to $0.03"
  await record("B2", "loading /portal/domain?domain=offcult.in sends cacheOnly: true & shows Run lookup", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 1440, height: 1000 },
    });
    try {
      const overviewCalls = [];

      await page.route("**/api/customer/features*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            brandKey: "acme",
            features: { domain_research: true, keyword_research: true, project_memory: true },
          }),
        });
      });

      await page.route("**/api/customer/domain/overview*", async (route) => {
        const body = JSON.parse(route.request().postData() || "{}");
        overviewCalls.push(body);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "not_cached",
            domain: "offcult.in",
            displayTarget: "offcult.in",
            scope: "subdomains",
            market: { locationCode: 2356, languageCode: "en", country: "India" },
          }),
        });
      });

      await page.route("**/api/customer/price/estimate*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makePriceQuote("domain.lookup.run", 0.03012)),
        });
      });

      await page.route("**/api/customer/domain/competitors/declared*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            available: true,
            competitors: [],
            ownHost: "offcult.in",
          }),
        });
      });

      await page.goto(new URL("/portal/domain?domain=offcult.in", origin).href, {
        waitUntil: "networkidle",
      });

      // Verify request sent cacheOnly: true
      assert.ok(overviewCalls.length > 0, "overview query was called");
      assert.equal(overviewCalls[0].cacheOnly, true, "overview sent cacheOnly: true");

      // Verify not-loaded card text
      const heading = page.getByText("Results for offcult.in are not loaded.");
      await heading.waitFor({ state: "visible", timeout: 10000 });

      const countryText = page.getByText("Running this lookup buys fresh data for India.");
      await countryText.waitFor({ state: "visible", timeout: 10000 });

      // Verify button has price
      const runButton = page.getByRole("button", { name: /Run lookup · up to \$0\.03/i });
      await runButton.waitFor({ state: "visible", timeout: 10000 });

      return "cacheOnly: true sent and Run lookup button with price rendered";
    } finally {
      await context.close();
    }
  });

  // Scenario B3: Click "Run lookup" → overview + keywords render, cost hint visible, next page sends maxUsd
  await record("B3", "click Run lookup → renders overview + keywords, cost hint visible, next page sends maxUsd", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 1440, height: 1000 },
    });
    try {
      let isLive = false;
      const keywordRequests = [];

      await page.route("**/api/customer/features*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            brandKey: "acme",
            features: { domain_research: true, keyword_research: true, project_memory: true },
          }),
        });
      });

      await page.route("**/api/customer/domain/overview*", async (route) => {
        const body = JSON.parse(route.request().postData() || "{}");
        if (!isLive) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              status: "not_cached",
              domain: "offcult.in",
              displayTarget: "offcult.in",
              scope: "subdomains",
              market: { locationCode: 2356, languageCode: "en", country: "India" },
            }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "ok",
            domain: "offcult.in",
            displayTarget: "offcult.in",
            scope: "subdomains",
            organicTraffic: 1840,
            organicKeywords: 312,
            hasData: true,
            market: { locationCode: 2356, languageCode: "en", country: "India" },
            isOwnSite: true,
            isDeclaredCompetitor: false,
            cached: false,
            fetchedAt: new Date().toISOString(),
            provenance: { gateway: "dataforseo" },
          }),
        });
      });

      await page.route("**/api/customer/domain/keywords*", async (route) => {
        const body = JSON.parse(route.request().postData() || "{}");
        keywordRequests.push(body);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "ok",
            domain: "offcult.in",
            page: body.page ?? 1,
            pageSize: body.pageSize ?? 50,
            totalCount: 312,
            hasMore: true,
            keywords: makeSampleKeywords(),
            cached: false,
            fetchedAt: new Date().toISOString(),
            provenance: { gateway: "dataforseo" },
          }),
        });
      });

      await page.route("**/api/customer/price/estimate*", async (route) => {
        let action = "domain.lookup.run";
        try {
          const postData = JSON.parse(route.request().postData() || "{}");
          if (postData.action) action = postData.action;
        } catch {}
        const cost = action === "domain.lookup.run" ? 0.03012 : 0.018;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makePriceQuote(action, cost)),
        });
      });

      await page.route("**/api/customer/domain/competitors/declared*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            available: true,
            competitors: [],
            ownHost: "offcult.in",
          }),
        });
      });

      await page.goto(new URL("/portal/domain?domain=offcult.in", origin).href, {
        waitUntil: "networkidle",
      });

      // Prepare live mode return
      isLive = true;

      // Click "Run lookup"
      const runBtn = page.getByRole("button", { name: /Run lookup/i });
      await runBtn.click();

      // Verify overview card renders metrics
      // Scoped to the overview's metric rows: 312 also appears as the keyword
      // count ("312 keywords") and in the pager ("1–50 of 312") once the
      // keywords table loads, so a bare getByText("312") is ambiguous.
      await page
        .getByRole("row", { name: /Estimated organic traffic/ })
        .getByRole("cell", { name: "1,840", exact: true })
        .waitFor({ state: "visible", timeout: 15000 });
      await page
        .getByRole("row", { name: /Organic keywords/ })
        .getByRole("cell", { name: "312", exact: true })
        .waitFor({ state: "visible", timeout: 15000 });

      // Verify keywords table rendered
      await page.getByText("oversized t shirt").waitFor({ state: "visible", timeout: 15000 });

      // Verify cost hint in toolbar
      await page.getByText("Each new page, sort or filter costs up to $0.02. Pages are reused for 12 hours.").waitFor({ state: "visible", timeout: 10000 });

      // Click next page
      const nextBtn = page.getByRole("link", { name: "Next page" }).or(page.locator('[aria-label="Next page"]')).first();
      await nextBtn.waitFor({ state: "visible", timeout: 5000 });
      await nextBtn.click();

      await page.waitForFunction(() => {
        return window.location.search.includes("page=2");
      }, undefined, { timeout: 10000 });

      // Check keyword request for page 2 sent maxUsd
      const page2Req = keywordRequests.find((r) => r.page === 2);
      assert.ok(page2Req, "request for page 2 was made");
      assert.ok(page2Req.maxUsd > 0, "page 2 sent maxUsd");

      return "Overview and keywords rendered, toolbar cost hint visible, and page 2 sent maxUsd";
    } finally {
      await context.close();
    }
  });

  // Scenario B4: Filters apply, URL updates, reload restores last-used filters, over-budget saved filters show held-back alert
  await record("B4", "filters apply, URL updates, reload restores filters, over-budget shows alert", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 1440, height: 1000 },
    });
    try {
      await page.route("**/api/customer/features*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            brandKey: "acme",
            features: { domain_research: true, keyword_research: true, project_memory: true },
          }),
        });
      });

      await page.route("**/api/customer/domain/overview*", async (route) => {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "ok",
            domain: "offcult.in",
            displayTarget: "offcult.in",
            scope: "subdomains",
            organicTraffic: 1840,
            organicKeywords: 312,
            hasData: true,
            market: { locationCode: 2356, languageCode: "en", country: "India" },
            isOwnSite: true,
            isDeclaredCompetitor: false,
            cached: true,
            fetchedAt: new Date().toISOString(),
            provenance: { gateway: "dataforseo" },
          }),
        });
      });

      await page.route("**/api/customer/domain/keywords*", async (route) => {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "ok",
            domain: "offcult.in",
            page: 1,
            pageSize: 50,
            totalCount: 312,
            hasMore: true,
            keywords: makeSampleKeywords(),
            cached: true,
            fetchedAt: new Date().toISOString(),
            provenance: { gateway: "dataforseo" },
          }),
        });
      });

      await page.route("**/api/customer/domain/competitors/declared*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            available: true,
            competitors: [],
            ownHost: "offcult.in",
          }),
        });
      });

      await page.goto(new URL("/portal/domain?domain=offcult.in", origin).href, {
        waitUntil: "networkidle",
      });

      // Open filters panel
      const filterToggle = page.getByRole("button", { name: /Filters/i });
      await filterToggle.click();

      // Enter Include Terms
      const includeInput = page.getByLabel("Include Terms").or(page.locator('input[placeholder*="audit"]')).first();
      await includeInput.fill("t shirt");

      // Click "Apply filters"
      const applyBtn = page.getByRole("button", { name: "Apply filters" });
      await applyBtn.click();

      // Verify URL updated
      await page.waitForFunction(() => {
        return window.location.search.includes("include=t");
      }, undefined, { timeout: 10000 });

      // Test over-budget saved filters
      // For subdomains scope, max conditions is 8. Set 9 conditions in localStorage pref.
      await page.evaluate(() => {
        const overBudget = {
          include: "a,b,c,d,e,f,g,h,i",
        };
        window.localStorage.setItem(
          "perceev:pref:domain-filters:keywords:offcult.in:acme",
          JSON.stringify(overBudget),
        );
      });

      // Navigate to URL without filter param so it restores saved filters
      await page.goto(new URL("/portal/domain?domain=offcult.in", origin).href, {
        waitUntil: "networkidle",
      });

      // Held-back alert should be displayed
      const heldBackAlert = page.getByText(/Saved filters exceed this scope's 8-condition limit/i);
      await heldBackAlert.waitFor({ state: "visible", timeout: 15000 });

      await page.getByRole("button", { name: /Filters/i }).click();
      const overBudgetInput = page.getByLabel("Include Terms").or(page.locator('input[placeholder*="audit"]')).first();
      await overBudgetInput.fill("a,b,c,d,e,f,g,h,i");
      const exactOverBudgetCopy = page.getByText(
        "Too many filter conditions (9 of 8). Remove some to apply.",
        { exact: true },
      );
      await exactOverBudgetCopy.waitFor({ state: "visible", timeout: 10000 });

      return "Filters applied, held-back saved filters showed the alert, and the over-budget copy matched exactly";
    } finally {
      await context.close();
    }
  });

  // Scenario B5: Save keywords with tags → POST without metrics, disabled after a location change, hidden when keyword_research is off
  await record("B5", "save with tags → POST has no metrics, toast; disabled after changing the location; hidden when keyword_research off", async () => {
    const { context, page, blockedWrites } = await openPortal(browser, origin, {
      viewport: { width: 1440, height: 1000 },
    });
    try {
      let savedBody = null;

      await page.route("**/api/customer/features*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            brandKey: "acme",
            features: { domain_research: true, keyword_research: true, project_memory: true },
          }),
        });
      });

      await page.route("**/api/customer/domain/overview*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeOverviewBody()),
        });
      });

      await page.route("**/api/customer/domain/keywords*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeKeywordsBody()),
        });
      });

      await page.route("**/api/customer/price/estimate*", async (route) => {
        let action = "domain.lookup.run";
        try {
          action = JSON.parse(route.request().postData() || "{}").action || action;
        } catch {}
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makePriceQuote(action, 0.03012)),
        });
      });

      await page.route("**/api/customer/domain/competitors/declared*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ available: true, competitors: [], ownHost: "offcult.in" }),
        });
      });

      // The harness aborts every non-GET customer call, so this write is answered here.
      await page.route("**/api/customer/keywords/saved*", async (route) => {
        savedBody = JSON.parse(route.request().postData() || "{}");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ savedKeywordIds: ["saved-1", "saved-2"], created: 2 }),
        });
      });

      await page.goto(
        new URL("/portal/domain?domain=offcult.in&loc=2356", origin).href,
        {
          waitUntil: "networkidle",
        },
      );
      await page.getByText("oversized t shirt").waitFor({ state: "visible", timeout: 15000 });

      const rowCheckboxes = page.getByRole("checkbox", { name: "Select row" });
      await rowCheckboxes.nth(0).click();
      await rowCheckboxes.nth(1).click();

      await page.getByRole("button", { name: "Save keywords" }).click();
      const saveDialog = page.getByRole("dialog");
      await saveDialog.getByText("Save 2 keywords", { exact: true }).waitFor({
        state: "visible",
        timeout: 10000,
      });
      await saveDialog.getByLabel("Tags").fill("priority, blog");
      await saveDialog.getByRole("button", { name: "Save", exact: true }).click();

      await page.getByText("Saved 2 keywords", { exact: true }).waitFor({
        state: "visible",
        timeout: 15000,
      });
      await page.getByRole("button", { name: "Open saved keywords" }).waitFor({
        state: "visible",
        timeout: 10000,
      });

      assert.ok(savedBody, "the save posted to /api/customer/keywords/saved");
      assert.equal(
        Object.hasOwn(savedBody, "metrics"),
        false,
        "the save body carries no metrics key",
      );
      assert.deepEqual(savedBody.keywords, ["oversized t shirt", "anime t shirt"]);
      assert.deepEqual(savedBody.tags, ["priority", "blog"]);
      assert.equal(savedBody.locationCode, 2356, "the save used the shown market");
      assert.equal(savedBody.languageCode, "en");
      assert.equal(savedBody.tagMode, "append");
      assert.equal(blockedWrites.length, 0, "no customer write was aborted");

      // O6: a new sort means a different row set, so the selection (and its bulk
      // bar) must not survive it.
      await page.getByRole("button", { name: "Sort by Volume" }).click();
      await page.waitForFunction(
        () => !document.querySelector('[role="toolbar"][aria-label="Bulk actions"]'),
        undefined,
        { timeout: 10000 },
      );
      assert.equal(
        await page.getByRole("toolbar", { name: "Bulk actions" }).count(),
        0,
        "a sort change clears the keyword selection",
      );

      // The form's market no longer matches the shown one (the overview still answers India).
      await page.getByLabel("Country").click();
      await page.getByLabel("Country").fill("United States");
      await page
        .locator('[data-slot="combobox-item"]:has-text("United States")')
        .first()
        .click();
      await page.waitForFunction(
        () => {
          const input = document.querySelector('[aria-label="Country"]');
          return input instanceof HTMLInputElement && input.value === "United States";
        },
        undefined,
        { timeout: 10000 },
      );

      // A market change re-reads the overview; select a row again on the reloaded page.
      await page.getByText("oversized t shirt").waitFor({ state: "visible", timeout: 15000 });
      await page.getByRole("checkbox", { name: "Select row" }).nth(0).click();

      const disabledSave = page.getByRole("button", { name: "Save keywords" });
      await disabledSave.waitFor({ state: "visible", timeout: 10000 });
      assert.equal(
        await disabledSave.isDisabled(),
        true,
        "Save keywords is disabled after the location changed",
      );
      const disabledTitle = await disabledSave.evaluate(
        (element) => element.closest("[title]")?.getAttribute("title") ?? null,
      );
      assert.ok(
        disabledTitle?.startsWith("Change the location back to India"),
        `disabled title starts with the shown market: ${disabledTitle}`,
      );

      // Second pass: keyword_research off hides the action instead of disabling it.
      const second = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        await second.page.route("**/api/customer/features*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              brandKey: "acme",
              features: { domain_research: true, keyword_research: false, project_memory: true },
            }),
          });
        });

        await second.page.route("**/api/customer/domain/overview*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(makeOverviewBody()),
          });
        });

        await second.page.route("**/api/customer/domain/keywords*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(makeKeywordsBody()),
          });
        });

        await second.page.route("**/api/customer/domain/competitors/declared*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ available: true, competitors: [], ownHost: "offcult.in" }),
          });
        });

        await second.page.goto(new URL("/portal/domain?domain=offcult.in", origin).href, {
          waitUntil: "networkidle",
        });
        await second.page.getByText("oversized t shirt").waitFor({ state: "visible", timeout: 15000 });
        await second.page.getByRole("checkbox", { name: "Select row" }).nth(0).click();
        await second.page.getByRole("toolbar", { name: "Bulk actions" }).waitFor({
          state: "visible",
          timeout: 10000,
        });

        assert.equal(
          await second.page.getByRole("button", { name: "Save keywords" }).count(),
          0,
          "Save keywords is hidden when keyword_research is off",
        );
        await second.page.getByRole("button", { name: "Copy keywords" }).waitFor({
          state: "visible",
          timeout: 10000,
        });
      } finally {
        await second.context.close();
      }

      // Third pass: an overview with no data disables saving (O2). `loc=2356`
      // keeps the form on the shown market, so `hasData` is the only reason.
      const third = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        await third.page.route("**/api/customer/features*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              brandKey: "acme",
              features: { domain_research: true, keyword_research: true, project_memory: true },
            }),
          });
        });

        await third.page.route("**/api/customer/domain/overview*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(
              makeOverviewBody({ organicTraffic: 0, organicKeywords: 0, hasData: false }),
            ),
          });
        });

        await third.page.route("**/api/customer/domain/keywords*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(makeKeywordsBody()),
          });
        });

        await third.page.route("**/api/customer/domain/competitors/declared*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ available: true, competitors: [], ownHost: "offcult.in" }),
          });
        });

        await third.page.goto(
          new URL("/portal/domain?domain=offcult.in&loc=2356", origin).href,
          { waitUntil: "networkidle" },
        );
        await third.page.getByText("oversized t shirt").waitFor({ state: "visible", timeout: 15000 });
        await third.page.getByRole("checkbox", { name: "Select row" }).nth(0).click();

        const noDataSave = third.page.getByRole("button", { name: "Save keywords" });
        await noDataSave.waitFor({ state: "visible", timeout: 10000 });
        assert.equal(
          await noDataSave.isDisabled(),
          true,
          "Save keywords is disabled when the overview has no data",
        );
        const noDataTitle = await noDataSave.evaluate(
          (element) => element.closest("[title]")?.getAttribute("title") ?? null,
        );
        assert.ok(
          noDataTitle?.startsWith("Change the location back to India"),
          `the no-data disabled state keeps the §6.6 title: ${noDataTitle}`,
        );
      } finally {
        await third.context.close();
      }

      return "Saved 2 keywords without metrics, toasted with the saved-keywords action, disabled after a location change, disabled when the overview has no data, and hidden with keyword_research off";
    } finally {
      await context.close();
    }
  });

  // Scenario B6: Competitors — price approval, results, then a cache-only sort by average position
  await record("B6", "competitors: CostReviewDialog → results → sort by average position", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 1440, height: 1000 },
    });
    try {
      const competitorRequests = [];
      let liveCacheWarm = false;
      const twoKeywords = makeSampleKeywords().slice(0, 2);
      const byVisibility = [
        makeCompetitorRow("competitor-one.example", {
          keywordsCount: 2,
          avgPosition: 8.4,
          visibility: 0.41,
          etv: 12000,
        }),
        makeCompetitorRow("competitor-two.example", {
          keywordsCount: 2,
          avgPosition: 5.2,
          visibility: 0.3,
          etv: 8000,
        }),
        makeCompetitorRow("competitor-three.example", {
          keywordsCount: 2,
          avgPosition: 2.1,
          visibility: 0.2,
          etv: 4000,
        }),
      ];
      const byAvgPosition = [byVisibility[2], byVisibility[0], byVisibility[1]];

      await page.route("**/api/customer/features*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            brandKey: "acme",
            features: { domain_research: true, keyword_research: true, project_memory: true },
          }),
        });
      });

      await page.route("**/api/customer/domain/overview*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeOverviewBody()),
        });
      });

      await page.route("**/api/customer/domain/keywords*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeKeywordsBody(twoKeywords)),
        });
      });

      await page.route("**/api/customer/domain/competitors*", async (route) => {
        const body = JSON.parse(route.request().postData() || "{}");
        competitorRequests.push(body);
        if (body.cacheOnly && !liveCacheWarm) {
          // The 12-hour cache is empty until the approved run fills it.
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              status: "not_cached",
              keywordCount: twoKeywords.length,
              competitors: [],
            }),
          });
        }
        if (!body.cacheOnly) liveCacheWarm = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "ok",
            keywordCount: twoKeywords.length,
            competitors: body.sortBy === "avg_position" ? byAvgPosition : byVisibility,
            cached: body.cacheOnly,
            fetchedAt: new Date().toISOString(),
            provenance: { gateway: "dataforseo" },
          }),
        });
      });

      await page.route("**/api/customer/price/estimate*", async (route) => {
        let action = "domain.competitors.run";
        try {
          action = JSON.parse(route.request().postData() || "{}").action || action;
        } catch {}
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makePriceQuote(action, 0.018)),
        });
      });

      await page.route("**/api/customer/domain/competitors/declared*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ available: true, competitors: [], ownHost: "offcult.in" }),
        });
      });

      await page.goto(
        new URL("/portal/domain?domain=offcult.in&tab=competitors", origin).href,
        { waitUntil: "networkidle" },
      );

      await page
        .getByText("Find the domains that rank in Google for the same keywords as offcult.in.", {
          exact: true,
        })
        .waitFor({ state: "visible", timeout: 15000 });
      await page
        .getByText("Uses the 2 keywords on the current Top Keywords page.", { exact: true })
        .waitFor({ state: "visible", timeout: 15000 });

      assert.ok(competitorRequests.length > 0, "the idle state read the cache");
      assert.equal(competitorRequests[0].cacheOnly, true, "the idle read is cache-only");
      assert.deepEqual(competitorRequests[0].keywords, ["oversized t shirt", "anime t shirt"]);

      const findButton = page.getByRole("button", { name: /Find competitors · up to \$0\.018/ });
      await findButton.waitFor({ state: "visible", timeout: 15000 });
      await findButton.click();

      const costDialog = page.getByRole("dialog");
      await costDialog.getByText("Find SERP competitors", { exact: true }).waitFor({
        state: "visible",
        timeout: 10000,
      });
      // The final approval is a slide-to-confirm; Enter on its thumb confirms.
      const approvedUsd = await slideToConfirm(costDialog, "Find competitors");
      assert.equal(approvedUsd, 0.018, "the slider approves the quoted $0.018");

      await page.getByText("competitor-one.example").waitFor({ state: "visible", timeout: 15000 });
      await page.getByText("competitor-two.example").waitFor({ state: "visible", timeout: 10000 });
      await page.getByText("competitor-three.example").waitFor({ state: "visible", timeout: 10000 });
      await page.getByText("41.0%", { exact: true }).waitFor({ state: "visible", timeout: 10000 });

      const liveRequest = competitorRequests.find((request) => request.cacheOnly === false);
      assert.ok(liveRequest, "the approved click sent one live request");
      assert.ok(
        Math.abs(liveRequest.maxUsd - 0.018) < 1e-9,
        `the live request carried the approved maxUsd: ${liveRequest.maxUsd}`,
      );
      assert.equal(
        liveRequest.languageCode,
        "en",
        "the approved request carries the shown market's language",
      );

      // A sort change re-reads the 12-hour cache and never spends again.
      await page.getByRole("combobox", { name: "Sort competitors" }).click();
      await page.getByRole("option", { name: "Average position", exact: true }).click();
      await page.waitForFunction(
        () => {
          const tables = [...document.querySelectorAll("table")];
          const table = tables.find((candidate) =>
            candidate.textContent?.includes("Shared keywords"),
          );
          return table?.querySelector("tbody tr")?.textContent?.includes("competitor-three.example") === true;
        },
        undefined,
        { timeout: 15000 },
      );

      const sortRequest = competitorRequests[competitorRequests.length - 1];
      assert.equal(sortRequest.sortBy, "avg_position");
      assert.equal(sortRequest.cacheOnly, true, "a sort change reads the cache");

      const competitorsTable = page.locator("table").filter({ hasText: "Shared keywords" });
      const firstDomain = await competitorsTable
        .locator("tbody tr")
        .first()
        .locator("a")
        .first()
        .innerText();
      assert.equal(firstDomain, "competitor-three.example", "the server order is kept");

      // FE-2: sorting back to the mount-time sort must read the warm cache, not
      // replay the pre-run "not_cached" entry that the mount left behind.
      await page.getByRole("combobox", { name: "Sort competitors" }).click();
      await page.getByRole("option", { name: "Visibility", exact: true }).click();
      await page.getByText("competitor-one.example").waitFor({ state: "visible", timeout: 15000 });
      const backRequest = competitorRequests[competitorRequests.length - 1];
      assert.equal(backRequest.sortBy, "visibility", "sorting back asks for the mount sort");
      assert.equal(backRequest.cacheOnly, true, "sorting back is a free cache read");
      const backFirstDomain = await competitorsTable
        .locator("tbody tr")
        .first()
        .locator("a")
        .first()
        .innerText();
      assert.equal(backFirstDomain, "competitor-one.example", "the warm cache is shown, not the idle state");

      // Second pass: with no loaded Top Keywords page the action is disabled.
      const second = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        await second.page.route("**/api/customer/features*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              brandKey: "acme",
              features: { domain_research: true, keyword_research: true, project_memory: true },
            }),
          });
        });

        await second.page.route("**/api/customer/domain/overview*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(makeOverviewBody({ organicTraffic: 0, organicKeywords: 0, hasData: false })),
          });
        });

        // A cache-only miss: the Top Keywords page was never loaded.
        await second.page.route("**/api/customer/domain/keywords*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              status: "not_cached",
              domain: "offcult.in",
              page: 1,
              pageSize: 50,
              market: { locationCode: 2356, languageCode: "en", country: "India" },
            }),
          });
        });

        await second.page.route("**/api/customer/domain/competitors/declared*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ available: true, competitors: [], ownHost: "offcult.in" }),
          });
        });

        // O8: a quote is available, so an aborted price request cannot be what
        // disables the button — only the empty keyword guard can.
        await second.page.route("**/api/customer/price/estimate*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(makePriceQuote("domain.competitors.run", 0.018)),
          });
        });

        await second.page.goto(
          new URL("/portal/domain?domain=offcult.in&tab=competitors", origin).href,
          { waitUntil: "networkidle" },
        );

        const idleFind = second.page.getByRole("button", { name: "Find competitors" });
        await idleFind.waitFor({ state: "visible", timeout: 15000 });
        assert.equal(
          (await idleFind.innerText()).trim(),
          "Find competitors",
          "no price is quoted while the action is disabled (O8)",
        );
        assert.equal(
          await idleFind.isDisabled(),
          true,
          "Find competitors is disabled without a loaded Top Keywords page",
        );
        const idleTitle = await idleFind.evaluate(
          (element) => element.closest("[title]")?.getAttribute("title") ?? null,
        );
        assert.equal(
          idleTitle,
          "Load the Top Keywords tab first.",
          "the disabled state explains which tab to load first",
        );
      } finally {
        await second.context.close();
      }

      return "Idle copy priced, CostReviewDialog approved $0.018, three domains rendered, the average-position sort re-read the cache, and no keywords disables Find competitors";
    } finally {
      await context.close();
    }
  });

  // Scenario B7: Add as competitor, quick picks, and the project_memory-off state
  await record("B7", "add competitor → toast; absent when project_memory off; quick pick fills the input without a request", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 1440, height: 1000 },
    });
    try {
      let addedBody = null;
      const overviewCalls = [];

      await page.route("**/api/customer/features*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            brandKey: "acme",
            features: { domain_research: true, keyword_research: true, project_memory: true },
          }),
        });
      });

      await page.route("**/api/customer/domain/overview*", async (route) => {
        overviewCalls.push(JSON.parse(route.request().postData() || "{}"));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeOverviewBody()),
        });
      });

      await page.route("**/api/customer/domain/keywords*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeKeywordsBody()),
        });
      });

      await page.route("**/api/customer/domain/competitors/declared*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            available: true,
            competitors: [{ domain: "bewakoof.com", name: "Bewakoof" }],
            ownHost: "offcult.in",
          }),
        });
      });

      // The harness aborts every non-GET customer call, so this write is answered here.
      await page.route("**/api/customer/domain/competitors/add*", async (route) => {
        addedBody = JSON.parse(route.request().postData() || "{}");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            competitor: { domain: "offcult.in", name: null },
            added: true,
          }),
        });
      });

      await page.goto(new URL("/portal/domain?domain=offcult.in", origin).href, {
        waitUntil: "networkidle",
      });
      await page.getByText("oversized t shirt").waitFor({ state: "visible", timeout: 15000 });

      const addButton = page.getByRole("button", { name: "Add as competitor" });
      assert.equal(await addButton.count(), 1, "one add action on the keywords tab");
      const overviewCallsBeforeAdd = overviewCalls.length;
      await addButton.click();

      await page.getByText("Added offcult.in to your competitors.", { exact: true }).waitFor({
        state: "visible",
        timeout: 15000,
      });
      await page.getByRole("button", { name: "View context" }).waitFor({
        state: "visible",
        timeout: 10000,
      });
      assert.ok(addedBody, "the add posted to /api/customer/domain/competitors/add");
      assert.equal(addedBody.domain, "offcult.in");
      await page.waitForTimeout(400);
      assert.equal(
        overviewCalls.length,
        overviewCallsBeforeAdd,
        "adding a competitor made no overview request",
      );

      // A quick pick fills the input and scope only: no request follows.
      const overviewCallsBeforePick = overviewCalls.length;
      await page.getByRole("button", { name: "Bewakoof (bewakoof.com)" }).click();
      assert.equal(await page.getByLabel("Domain or URL").inputValue(), "bewakoof.com");
      await page.waitForTimeout(400);
      assert.equal(
        overviewCalls.length,
        overviewCallsBeforePick,
        "a quick pick made no request",
      );

      // Second pass: project_memory off removes the add action and the quick picks.
      const second = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        await second.page.route("**/api/customer/features*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              brandKey: "acme",
              features: { domain_research: true, keyword_research: true, project_memory: false },
            }),
          });
        });

        await second.page.route("**/api/customer/domain/overview*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(makeOverviewBody()),
          });
        });

        await second.page.route("**/api/customer/domain/keywords*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(makeKeywordsBody()),
          });
        });

        await second.page.route("**/api/customer/domain/competitors/declared*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ available: false, competitors: [] }),
          });
        });

        await second.page.goto(new URL("/portal/domain?domain=offcult.in", origin).href, {
          waitUntil: "networkidle",
        });
        await second.page.getByText("oversized t shirt").waitFor({ state: "visible", timeout: 15000 });

        assert.equal(
          await second.page.getByRole("button", { name: "Add as competitor" }).count(),
          0,
          "Add as competitor is absent when project_memory is off",
        );
        assert.equal(
          await second.page.getByText("Quick picks:", { exact: true }).count(),
          0,
          "quick picks are absent when project_memory is off",
        );
      } finally {
        await second.context.close();
      }

      // Third pass: a domain already declared is shown as a competitor, not added again.
      const third = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        await third.page.route("**/api/customer/features*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              brandKey: "acme",
              features: { domain_research: true, keyword_research: true, project_memory: true },
            }),
          });
        });

        await third.page.route("**/api/customer/domain/overview*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(makeOverviewBody({ isDeclaredCompetitor: true })),
          });
        });

        await third.page.route("**/api/customer/domain/keywords*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(makeKeywordsBody()),
          });
        });

        await third.page.route("**/api/customer/domain/competitors/declared*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              available: true,
              competitors: [{ domain: "offcult.in", name: null }],
              ownHost: "offcult.in",
            }),
          });
        });

        await third.page.goto(new URL("/portal/domain?domain=offcult.in", origin).href, {
          waitUntil: "networkidle",
        });
        await third.page.getByText("Competitor", { exact: true }).first().waitFor({
          state: "visible",
          timeout: 15000,
        });

        assert.equal(
          await third.page.getByRole("button", { name: "Add as competitor" }).count(),
          0,
          "Add as competitor is absent for an already declared domain",
        );
      } finally {
        await third.context.close();
      }

      // Fourth pass: adding from a competitors results row flips that row to the
      // `Competitor` badge instead of offering Add again (FE-3).
      const fourth = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        let rowAddedBody = null;

        await fourth.page.route("**/api/customer/features*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              brandKey: "acme",
              features: { domain_research: true, keyword_research: true, project_memory: true },
            }),
          });
        });

        await fourth.page.route("**/api/customer/domain/overview*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(makeOverviewBody()),
          });
        });

        await fourth.page.route("**/api/customer/domain/keywords*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(makeKeywordsBody(makeSampleKeywords().slice(0, 2))),
          });
        });

        // The warm cache already holds one undeclared competitor row: no click needed.
        await fourth.page.route("**/api/customer/domain/competitors*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              status: "ok",
              keywordCount: 2,
              competitors: [
                makeCompetitorRow("bewakoof.com", {
                  keywordsCount: 2,
                  avgPosition: 4.2,
                  visibility: 0.41,
                  etv: 12000,
                }),
              ],
              cached: true,
              fetchedAt: new Date().toISOString(),
              provenance: { gateway: "dataforseo" },
            }),
          });
        });

        await fourth.page.route("**/api/customer/domain/competitors/declared*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ available: true, competitors: [], ownHost: "offcult.in" }),
          });
        });

        // The harness aborts every non-GET customer call, so this write is answered here.
        await fourth.page.route("**/api/customer/domain/competitors/add*", async (route) => {
          rowAddedBody = JSON.parse(route.request().postData() || "{}");
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              competitor: { domain: "bewakoof.com", name: null },
              added: true,
            }),
          });
        });

        await fourth.page.goto(
          new URL("/portal/domain?domain=offcult.in&tab=competitors", origin).href,
          { waitUntil: "networkidle" },
        );

        const resultsTable = fourth.page
          .locator("table")
          .filter({ hasText: "Shared keywords" });
        await fourth.page.getByText("bewakoof.com", { exact: true }).first().waitFor({
          state: "visible",
          timeout: 15000,
        });
        const resultRow = resultsTable.locator("tbody tr").first();
        assert.equal(
          await resultRow.getByRole("button", { name: "Add as competitor" }).count(),
          1,
          "the results row offers Add as competitor",
        );
        await resultRow.getByRole("button", { name: "Add as competitor" }).click();

        await fourth.page
          .getByText("Added bewakoof.com to your competitors.", { exact: true })
          .waitFor({ state: "visible", timeout: 15000 });
        assert.ok(rowAddedBody, "the row add posted to /api/customer/domain/competitors/add");
        assert.equal(rowAddedBody.domain, "bewakoof.com");
        assert.equal(
          await resultRow.getByRole("button", { name: "Add as competitor" }).count(),
          0,
          "the row no longer offers Add as competitor",
        );
        await resultRow.getByText("Competitor", { exact: true }).first().waitFor({
          state: "visible",
          timeout: 10000,
        });
        assert.equal(
          await resultRow.getByText("Competitor", { exact: true }).count(),
          2,
          "the row shows the Competitor badge in the domain and action cells",
        );
      } finally {
        await fourth.context.close();
      }

      return "Added offcult.in with the toast and action, the quick pick filled the input with no request, project_memory off hid both, a declared domain showed the badge instead of the action, and a results row flipped to the badge after its own add";
    } finally {
      await context.close();
    }
  });

  // Regression R1: Enter uses the quoted Search action; failed paid overview calls do not retry.
  await record("R1", "keyboard Search uses quoted price and reviews overview price changes", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 1440, height: 1000 },
    });
    try {
      const liveOverviewRequests = [];

      await page.route("**/api/customer/features*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            brandKey: "acme",
            features: { domain_research: true, keyword_research: true, project_memory: true },
          }),
        });
      });

      await page.route("**/api/customer/domain/overview*", async (route) => {
        const body = JSON.parse(route.request().postData() || "{}");
        if (body.cacheOnly) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              status: "not_cached",
              domain: "offcult.in",
              displayTarget: "offcult.in",
              scope: "domain",
              market: { locationCode: 2356, languageCode: "en", country: "India" },
            }),
          });
        }

        liveOverviewRequests.push(body);
        if (liveOverviewRequests.length === 1) {
          return route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ code: "temporary_failure", error: "Temporary overview failure." }),
          });
        }
        if (liveOverviewRequests.length === 2) {
          return route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              code: "price_changed",
              error: "The price changed.",
              details: {
                approvedMaxUsd: body.maxUsd,
                quote: makePriceQuote("domain.lookup.run", 0.06012),
              },
            }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "ok",
            domain: "offcult.in",
            displayTarget: "offcult.in",
            scope: "domain",
            organicTraffic: 1840,
            organicKeywords: 312,
            hasData: true,
            market: { locationCode: 2356, languageCode: "en", country: "India" },
            isOwnSite: true,
            isDeclaredCompetitor: false,
            cached: false,
            fetchedAt: new Date().toISOString(),
            provenance: { gateway: "dataforseo" },
          }),
        });
      });

      await page.route("**/api/customer/price/estimate*", async (route) => {
        let action = "domain.lookup.run";
        try {
          action = JSON.parse(route.request().postData() || "{}").action || action;
        } catch {}
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makePriceQuote(action, 0.03012)),
        });
      });

      await page.route("**/api/customer/domain/competitors/declared*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ available: true, competitors: [], ownHost: "offcult.in" }),
        });
      });

      await page.goto(new URL("/portal/domain?domain=offcult.in", origin).href, {
        waitUntil: "networkidle",
      });
      await page.getByRole("button", { name: /Search · up to \$0\.03/i }).waitFor({
        state: "visible",
        timeout: 15000,
      });
      await page.waitForFunction(() => {
        const button = document.querySelector("button.domain-search-priced-action");
        return Boolean(button && !button.disabled);
      }, undefined, { timeout: 15000 });
      await page.getByLabel("Domain or URL").press("Enter");
      await page.getByRole("button", { name: "Try again" }).waitFor({
        state: "visible",
        timeout: 15000,
      });

      assert.equal(liveOverviewRequests.length, 1, "failed paid overview request is not retried automatically");
      assert.ok(
        Math.abs(liveOverviewRequests[0].maxUsd - 0.03012) < 1e-9,
        `Enter used the quote amount ${liveOverviewRequests[0].maxUsd}, not a fixed cap`,
      );

      await page.getByRole("button", { name: "Try again" }).click();
      const priceDialog = page.getByRole("dialog");
      await priceDialog.getByText("The price changed", { exact: true }).waitFor({
        state: "visible",
        timeout: 15000,
      });
      assert.equal(liveOverviewRequests.length, 2, "manual retry made one second request");
      // The shared cost dialog confirms non-scan quotes (its answers guard is
      // scan-only), so the reader can approve the new price here: the
      // slide-to-confirm must become enabled and name the new price.
      const approvedUsd = await slideToConfirm(priceDialog, "Search");
      // formatUsd shows four places under $1, so $0.06012 reads $0.0601.
      assert.equal(approvedUsd, 0.0601, `the slider names the new quote, saw ${approvedUsd}`);
      await page.getByText("1,840").waitFor({ state: "visible", timeout: 15000 });
      assert.equal(liveOverviewRequests.length, 3, "approving the new price made one request");
      assert.ok(
        Math.abs(liveOverviewRequests[2].maxUsd - 0.06012) < 1e-9,
        `the approved price changed the cap: ${liveOverviewRequests[2].maxUsd}`,
      );

      return "Enter used the quoted $0.03012 max; one failed request was followed only by manual retry; the price-change dialog approved the new $0.06012 quote";
    } finally {
      await context.close();
    }
  });

  // Regression R2: table failures render error/refusal states and do not retry automatically.
  await record("R2", "keywords and pages errors show price review or spend refusal without retries", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 1440, height: 1000 },
    });
    try {
      let keywordRequests = 0;
      let pageRequests = 0;

      await page.route("**/api/customer/features*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            brandKey: "acme",
            features: { domain_research: true, keyword_research: true, project_memory: true },
          }),
        });
      });

      await page.route("**/api/customer/domain/overview*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "ok",
            domain: "offcult.in",
            displayTarget: "offcult.in",
            scope: "domain",
            organicTraffic: 1840,
            organicKeywords: 312,
            hasData: true,
            market: { locationCode: 2356, languageCode: "en", country: "India" },
            isOwnSite: true,
            isDeclaredCompetitor: false,
            cached: true,
            fetchedAt: new Date().toISOString(),
            provenance: { gateway: "dataforseo" },
          }),
        });
      });

      await page.route("**/api/customer/domain/keywords*", async (route) => {
        keywordRequests++;
        if (keywordRequests === 1) {
          return route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ code: "temporary_failure", error: "Temporary keyword failure." }),
          });
        }
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            code: "price_changed",
            error: "The price changed.",
            details: {
              approvedMaxUsd: 0.05,
              quote: makePriceQuote("domain.keywords.page", 0.06),
            },
          }),
        });
      });

      await page.route("**/api/customer/domain/pages*", async (route) => {
        pageRequests++;
        if (pageRequests === 1) {
          return route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ code: "temporary_failure", error: "Temporary pages failure." }),
          });
        }
        return route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ code: "daily_cap", error: "Daily spend limit reached." }),
        });
      });

      await page.route("**/api/customer/price/estimate*", async (route) => {
        let action = "domain.lookup.run";
        try {
          action = JSON.parse(route.request().postData() || "{}").action || action;
        } catch {}
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makePriceQuote(action, 0.03)),
        });
      });

      await page.route("**/api/customer/domain/competitors/declared*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ available: true, competitors: [], ownHost: "offcult.in" }),
        });
      });

      await page.goto(new URL("/portal/domain?domain=offcult.in", origin).href, {
        waitUntil: "networkidle",
      });
      await page.getByRole("button", { name: "Try again" }).waitFor({
        state: "visible",
        timeout: 15000,
      });
      assert.equal(keywordRequests, 1, "failed keyword request is not retried automatically");
      await page.getByRole("button", { name: "Try again" }).click();
      await page.getByRole("dialog").getByText("The price changed", { exact: true }).waitFor({
        state: "visible",
        timeout: 15000,
      });
      assert.equal(keywordRequests, 2, "manual keyword retry made one request");
      await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

      await page.getByRole("tab", { name: "Top Pages" }).click();
      await page.getByRole("button", { name: "Try again" }).waitFor({
        state: "visible",
        timeout: 15000,
      });
      assert.equal(pageRequests, 1, "failed pages request is not retried automatically");
      await page.getByRole("button", { name: "Try again" }).click();
      await page.getByText("Daily spend limit reached", { exact: true }).waitFor({
        state: "visible",
        timeout: 15000,
      });
      assert.equal(pageRequests, 2, "manual pages retry made one spend-refusal request");

      return "Keyword failure and price-change states rendered; pages showed spend refusal after a manual retry and one request per attempt";
    } finally {
      await context.close();
    }
  });

  // Scenario B8: 375 px no horizontal scroll
  await record("B8", "375 px: no page scroll and the selected-row bulk bar fits the viewport", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 375, height: 812 },
    });
    try {
      await page.route("**/api/customer/features*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            brandKey: "acme",
            features: { domain_research: true, keyword_research: true, project_memory: true },
          }),
        });
      });

      await page.route("**/api/customer/domain/overview*", async (route) => {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "ok",
            domain: "offcult.in",
            displayTarget: "offcult.in",
            scope: "subdomains",
            organicTraffic: 1840,
            organicKeywords: 312,
            hasData: true,
            market: { locationCode: 2356, languageCode: "en", country: "India" },
            isOwnSite: true,
            isDeclaredCompetitor: false,
            cached: true,
            fetchedAt: new Date().toISOString(),
            provenance: { gateway: "dataforseo" },
          }),
        });
      });

      await page.route("**/api/customer/domain/keywords*", async (route) => {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "ok",
            domain: "offcult.in",
            page: 1,
            pageSize: 50,
            totalCount: 312,
            hasMore: true,
            keywords: makeSampleKeywords(),
            cached: true,
            fetchedAt: new Date().toISOString(),
            provenance: { gateway: "dataforseo" },
          }),
        });
      });

      await page.route("**/api/customer/domain/competitors/declared*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            available: true,
            competitors: [],
            ownHost: "offcult.in",
          }),
        });
      });

      await page.goto(new URL("/portal/domain?domain=offcult.in", origin).href, {
        waitUntil: "networkidle",
      });

      await page.waitForTimeout(500);

      // Select one row so the bulk action bar is on screen: it is the phone-width
      // control set that used to overflow.
      await page.getByRole("checkbox", { name: "Select row" }).first().click();
      const bulkBar = page.getByRole("toolbar", { name: "Bulk actions" });
      await bulkBar.waitFor({ state: "visible", timeout: 10000 });

      const metrics = await page.evaluate(() => {
        const root = document.documentElement;
        const toolbar = document.querySelector('[role="toolbar"][aria-label="Bulk actions"]');
        const barRect = toolbar.getBoundingClientRect();
        const round = (value) => Math.round(value * 10) / 10;
        const controls = [...toolbar.querySelectorAll("button")].map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            name: button.getAttribute("aria-label") || (button.textContent || "").trim(),
            left: round(rect.left),
            right: round(rect.right),
          };
        });
        return {
          scrollWidth: root.scrollWidth,
          clientWidth: root.clientWidth,
          innerWidth: window.innerWidth,
          bar: {
            left: round(barRect.left),
            right: round(barRect.right),
            width: round(barRect.width),
            height: round(barRect.height),
            scrollWidth: toolbar.scrollWidth,
            clientWidth: toolbar.clientWidth,
          },
          controls,
        };
      });

      assert.ok(
        metrics.scrollWidth <= metrics.clientWidth + 1,
        `Page overflowed horizontally: scrollWidth ${metrics.scrollWidth} > clientWidth ${metrics.clientWidth}`,
      );
      assert.ok(
        metrics.bar.left >= 0,
        `the bulk bar starts inside the viewport: left ${metrics.bar.left}`,
      );
      assert.ok(
        metrics.bar.right <= metrics.innerWidth,
        `the bulk bar ends inside the viewport: right ${metrics.bar.right} > ${metrics.innerWidth}`,
      );
      assert.ok(
        metrics.bar.scrollWidth <= metrics.bar.clientWidth + 1,
        `the bulk bar needs no internal scroll: ${metrics.bar.scrollWidth} > ${metrics.bar.clientWidth}`,
      );
      assert.ok(
        metrics.controls.length >= 4,
        `the bulk bar renders its controls: ${metrics.controls.length}`,
      );
      for (const control of metrics.controls) {
        assert.ok(
          control.left >= 0 && control.right <= metrics.innerWidth,
          `bulk control "${control.name}" is inside the viewport: ${control.left}..${control.right}`,
        );
      }
      assert.ok(
        metrics.controls.some((control) => control.name === "Clear selection"),
        "the clear affordance is on screen",
      );
      assert.ok(
        metrics.controls.some((control) => control.name === "Export"),
        "the export trigger is on screen",
      );

      return `375px: no page scroll (scrollWidth=${metrics.scrollWidth}); bulk bar ${metrics.bar.width}x${metrics.bar.height}px at ${metrics.bar.left}..${metrics.bar.right}, internal ${metrics.bar.scrollWidth}/${metrics.bar.clientWidth}, ${metrics.controls.length} controls all inside 0..${metrics.innerWidth}`;
    } finally {
      await context.close();
    }
  });

  // Scenario B9: Export CSV filename and headers
  await record("B9", "export CSV filename and headers", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 1440, height: 1000 },
    });
    try {
      await page.route("**/api/customer/features*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            brandKey: "acme",
            features: { domain_research: true, keyword_research: true, project_memory: true },
          }),
        });
      });

      await page.route("**/api/customer/domain/overview*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeOverviewBody()),
        });
      });

      await page.route("**/api/customer/domain/keywords*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeKeywordsBody()),
        });
      });

      await page.route("**/api/customer/domain/competitors/declared*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ available: true, competitors: [], ownHost: "offcult.in" }),
        });
      });

      await page.goto(new URL("/portal/domain?domain=offcult.in", origin).href, {
        waitUntil: "networkidle",
      });
      await page.getByText("oversized t shirt").waitFor({ state: "visible", timeout: 15000 });

      await page.getByRole("button", { name: "Export" }).first().click();
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 15000 }),
        page.getByRole("menuitem", { name: "Export CSV" }).click(),
      ]);

      assert.equal(download.suggestedFilename(), "offcult.in-keywords.csv");
      const downloadedPath = await download.path();
      const csv = await readFile(downloadedPath, "utf8");
      // Papa quotes every field; the header line is asserted without quotes.
      const headerLine = csv.split(/\r?\n/)[0].replace(/"/g, "");
      assert.equal(headerLine, "Keyword,Rank,Volume,Traffic,CPC,URL,Score");

      return "Export CSV downloaded offcult.in-keywords.csv with the keyword table headers";
    } finally {
      await context.close();
    }
  });

  console.log(`ok ${passedScenarios} scenarios`);
} finally {
  await browser.close();
  if (serverChild) {
    serverChild.kill("SIGTERM");
  }
}
