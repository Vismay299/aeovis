#!/usr/bin/env node
/**
 * F14 Phase 3 — Domain Overview browser verification (B1–B4, B8).
 *
 * Scenarios:
 *   B1: Flag off: empty state and nav item hidden
 *   B2: Loading /portal/domain?domain=offcult.in sends cacheOnly: true & shows "Run lookup · up to $0.03"
 *   B3: Click "Run lookup" → overview + keywords render, cost hint visible, next page sends maxUsd
 *   B4: Filters apply, URL updates, reload restores last-used filters, over-budget saved filters show held-back alert
 *   B8: 375 px viewport: document.documentElement.scrollWidth <= 375 (no horizontal scroll)
 *
 * Output: "ok 5 scenarios" on pass.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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
      await page.getByText("1,840").waitFor({ state: "visible", timeout: 15000 });
      await page.getByText("312").waitFor({ state: "visible", timeout: 15000 });

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
      const confirmButton = priceDialog.getByRole("button", { name: "Search", exact: true });
      assert.equal(await confirmButton.isDisabled(), true, "shared cost dialog currently disables non-answer quotes");

      return "Enter used the quoted $0.03012 max; one failed request was followed only by manual retry; price-change dialog rendered";
    } finally {
      await context.close();
    }
  });

  // Regression R2: table failures render error/refusal states and do not retry automatically.
  await record("R2", "keywords and pages errors show price review or spend refusal without retries", async () => {
    const { context, page, blockedWrites } = await openPortal(browser, origin, {
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
            isOwnSite: false,
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

      const addCompetitor = page.getByRole("button", { name: "Add as competitor" });
      await addCompetitor.click();
      assert.equal(
        blockedWrites.some((write) => write.includes("/api/customer/domain/competitors/add")),
        false,
        "Add as competitor is presentation-only in Phase 3",
      );

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
  await record("B8", "375 px: document.documentElement.scrollWidth <= 375", async () => {
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

      const metrics = await page.evaluate(() => {
        const root = document.documentElement;
        return {
          scrollWidth: root.scrollWidth,
          clientWidth: root.clientWidth,
          innerWidth: window.innerWidth,
        };
      });

      assert.ok(
        metrics.scrollWidth <= metrics.clientWidth + 1,
        `Page overflowed horizontally: scrollWidth ${metrics.scrollWidth} > clientWidth ${metrics.clientWidth}`,
      );

      return `375px viewport has no horizontal overflow: scrollWidth=${metrics.scrollWidth}, clientWidth=${metrics.clientWidth}`;
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
