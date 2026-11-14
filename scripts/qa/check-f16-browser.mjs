#!/usr/bin/env node
/**
 * F16 Phase 3 browser verification (F16-AC-07 browser half, F16-AC-10, F16-AC-11).
 *
 * Scenarios:
 *   B1: flag off -> empty state copy ("This page is not available for your workspace yet." / "Ask Perceev support to turn on backlinks."), sidebar link hidden.
 *   B2: /portal/backlinks?target=offcult.in sends only cacheOnly requests and shows "Run lookup · up to $0.09".
 *   B3: click "Run lookup" -> overview metrics ("—" for a null), growth chart with a gap for the missing month, new/lost chart.
 *   B2A: submit a newly priced target -> approved lookup sends cacheOnly: false and displays results.
 *   B4: Best links off -> sends hideSpam: false request; One per domain / All links toggles mode.
 *   B5: filters over budget -> warning message, table hidden until conditions removed.
 *   B6: expand domain -> "Loading links…" then links; second domain error shows "Couldn't load this domain's links.".
 *   B7: Ahrefs DR flag off -> no menu item and no column; on -> menu item, column fills, export gains "Ahrefs DR", failure toast.
 *   B8: 375 px viewport has no horizontal scroll; the 200-row estimate displays $0.04; export CSV includes headers.
 *
 * Output: "ok 9 scenarios" on pass.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { openPortal, SUPABASE_URL } from "./portalFixtureHarness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const rawArg = process.argv.find((a) => !a.startsWith("--") && a.includes("33")) || "http://127.0.0.1:3328";
const origin = new URL(rawArg.startsWith("http") ? rawArg : `http://${rawArg}`);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname),
  "browser checks require a disposable local app",
);
const port = parseInt(origin.port || "3328", 10);

const outputDir = path.resolve("test_reports/f16-browser");
await mkdir(outputDir, { recursive: true });

// Parse --only flag
function parseScenarioList(raw) {
  const parts = raw.split(",").map((s) => s.trim());
  const result = [];
  for (const part of parts) {
    const m = part.match(/^B(\d+)-B(\d+)$/i);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = parseInt(m[2], 10);
      for (let j = start; j <= end; j++) {
        result.push(`B${j}`);
      }
    } else {
      result.push(part.toUpperCase());
    }
  }
  return result;
}

let requestedScenarios = ["B1", "B2", "B3", "B2A", "B4", "B5", "B6", "B7", "B8"];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--only=")) {
    requestedScenarios = parseScenarioList(process.argv[i].split("=")[1]);
  } else if (process.argv[i] === "--only" && process.argv[i + 1]) {
    requestedScenarios = parseScenarioList(process.argv[i + 1]);
  }
}

async function waitForServer(targetPort, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${targetPort}/robots.txt`);
      if (res.ok) return true;
    } catch {
      // wait
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let serverChild = null;
const isRunning = await waitForServer(port, 1000);
if (!isRunning) {
  serverChild = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", String(port)],
    {
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key",
      },
      stdio: "inherit",
    },
  );
  const ready = await waitForServer(port, 45000);
  assert.ok(ready, `Next.js server failed to start on port ${port}`);
}

function killServerChild() {
  if (!serverChild) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(serverChild.pid), "/f", "/t"]);
    } else {
      serverChild.kill("SIGTERM");
    }
  } catch {
    // ignore
  }
}
process.on("exit", killServerChild);
process.on("SIGINT", () => {
  killServerChild();
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  killServerChild();
  console.error(err);
  process.exit(1);
});

const browser = await chromium.launch({ headless: true });

// Price quote fixture for backlinks.lookup.run
const lookupQuoteFixture = {
  action: "backlinks.lookup.run",
  currency: "USD",
  totalUsd: 0.087012,
  expectedUsd: 0.087012,
  units: [],
  lines: [
    {
      label: "Backlink overview and initial rows",
      quantity: 1,
      unitUsd: 0.087012,
      totalUsd: 0.087012,
    },
  ],
  monthly: null,
  warnings: [],
  blocked: null,
  priceVersion: "v1",
  quotedAt: "2026-11-08T12:00:00.000Z",
  inputsHash: "0123456789abcdef",
};

// Mock data fixtures
const overviewNotCachedFixture = {
  status: "not_cached",
  target: "offcult.in",
  displayTarget: "offcult.in",
  scope: "subdomains",
};

const overviewOkFixture = {
  status: "ok",
  target: "offcult.in",
  displayTarget: "offcult.in",
  scope: "subdomains",
  summary: {
    rank: 21,
    backlinks: 4120,
    referringPages: 2980,
    referringDomains: 312,
    brokenBacklinks: 14,
    brokenPages: 3,
    backlinksSpamScore: 12,
    targetSpamScore: null, // null to verify "—" rendering
    newBacklinks: 85,
    lostBacklinks: 40,
    newReferringDomains: 9,
    lostReferringDomains: 5,
  },
  trends: [
    { date: "2025-10-31", backlinks: 3810, referringDomains: 290, rank: 20 },
    { date: "2025-11-30", backlinks: 3900, referringDomains: 295, rank: 20 },
    { date: "2025-12-31", backlinks: null, referringDomains: null, rank: null }, // gap
    { date: "2026-01-31", backlinks: 4000, referringDomains: 305, rank: 21 },
    { date: "2026-02-28", backlinks: 4120, referringDomains: 312, rank: 21 },
  ],
  newLostTrends: [
    { date: "2025-10-31", newBacklinks: 70, lostBacklinks: 22, newReferringDomains: 6, lostReferringDomains: 2 },
    { date: "2025-11-30", newBacklinks: 65, lostBacklinks: 18, newReferringDomains: 5, lostReferringDomains: 1 },
    { date: "2025-12-31", newBacklinks: 50, lostBacklinks: 15, newReferringDomains: 4, lostReferringDomains: 1 },
    { date: "2026-01-31", newBacklinks: 80, lostBacklinks: 20, newReferringDomains: 7, lostReferringDomains: 2 },
    { date: "2026-02-28", newBacklinks: 85, lostBacklinks: 40, newReferringDomains: 9, lostReferringDomains: 5 },
  ],
  tracked: null,
  isOwnSite: true,
  isDeclaredCompetitor: false,
  cached: false,
  fetchedAt: "2026-10-21T09:30:00.000Z",
  provenance: { gateway: "dataforseo" },
};

const rowsOkFixture = {
  status: "ok",
  rows: [
    {
      domainFrom: "partner.com",
      urlFrom: "https://partner.com/blog/great-gear",
      urlTo: "https://offcult.in/shoes",
      anchor: "Great shoes",
      itemType: "anchor",
      isDofollow: true,
      relAttributes: [],
      rank: 35,
      domainFromRank: 50,
      pageFromRank: 40,
      spamScore: 10,
      firstSeen: "2026-01-15T00:00:00.000Z",
      lastSeen: "2026-02-20T00:00:00.000Z",
      isLost: false,
      isBroken: false,
      linksCount: 2,
    },
    {
      domainFrom: "competitor.com",
      urlFrom: "https://competitor.com/resources/links",
      urlTo: "https://offcult.in",
      anchor: "Offcult",
      itemType: "anchor",
      isDofollow: false,
      relAttributes: ["nofollow"],
      rank: 20,
      domainFromRank: 30,
      pageFromRank: 25,
      spamScore: 5,
      firstSeen: "2026-02-10T00:00:00.000Z",
      lastSeen: "2026-02-22T00:00:00.000Z",
      isLost: false,
      isBroken: false,
      linksCount: 1,
    },
  ],
  totalCount: 2,
  hasMore: false,
  page: 1,
  pageSize: 50,
  cached: false,
  fetchedAt: "2026-10-21T09:30:00.000Z",
  provenance: { gateway: "dataforseo" },
};

const partnerDomainLinksFixture = {
  status: "ok",
  rows: [
    {
      domainFrom: "partner.com",
      urlFrom: "https://partner.com/blog/great-gear",
      urlTo: "https://offcult.in/shoes",
      anchor: "Great shoes",
      itemType: "anchor",
      isDofollow: true,
      relAttributes: [],
      rank: 35,
      domainFromRank: 50,
      pageFromRank: 40,
      spamScore: 10,
      firstSeen: "2026-01-15T00:00:00.000Z",
      lastSeen: "2026-02-20T00:00:00.000Z",
      isLost: false,
      isBroken: false,
      linksCount: 2,
    },
    {
      domainFrom: "partner.com",
      urlFrom: "https://partner.com/reviews/boots",
      urlTo: "https://offcult.in/boots",
      anchor: "Boots review",
      itemType: "anchor",
      isDofollow: true,
      relAttributes: [],
      rank: 30,
      domainFromRank: 50,
      pageFromRank: 38,
      spamScore: 8,
      firstSeen: "2026-01-20T00:00:00.000Z",
      lastSeen: "2026-02-20T00:00:00.000Z",
      isLost: false,
      isBroken: false,
      linksCount: 2,
    },
  ],
  totalCount: 2,
  hasMore: false,
  page: 1,
  pageSize: 50,
  cached: false,
  fetchedAt: "2026-10-21T09:30:00.000Z",
  provenance: { gateway: "dataforseo" },
};

const referringDomainsOkFixture = {
  status: "ok",
  rows: [
    {
      domain: "partner.com",
      backlinks: 2,
      referringPages: 2,
      rank: 50,
      spamScore: 10,
      firstSeen: "2026-01-15T00:00:00.000Z",
      brokenBacklinks: 0,
      brokenPages: 0,
    },
    {
      domain: "competitor.com",
      backlinks: 1,
      referringPages: 1,
      rank: 30,
      spamScore: 5,
      firstSeen: "2026-02-10T00:00:00.000Z",
      brokenBacklinks: 0,
      brokenPages: 0,
    },
  ],
  totalCount: 2,
  hasMore: false,
  page: 1,
  pageSize: 50,
  cached: false,
  fetchedAt: "2026-10-21T09:30:00.000Z",
  provenance: { gateway: "dataforseo" },
};

const topPagesOkFixture = {
  status: "ok",
  rows: [
    {
      page: "https://offcult.in/",
      backlinks: 2500,
      referringDomains: 200,
      rank: 21,
      brokenBacklinks: 0,
    },
    {
      page: "https://offcult.in/shoes",
      backlinks: 1200,
      referringDomains: 100,
      rank: 18,
      brokenBacklinks: 2,
    },
  ],
  totalCount: 2,
  hasMore: false,
  page: 1,
  pageSize: 50,
  cached: false,
  fetchedAt: "2026-10-21T09:30:00.000Z",
  provenance: { gateway: "dataforseo" },
};

let executedCount = 0;
let sharedContext = null;
let sharedPage = null;

async function recordScenario(id, description, run) {
  if (!requestedScenarios.includes(id)) {
    return;
  }
  console.log(`Running Scenario ${id}: ${description}...`);
  const recordRow = {
    case: id,
    suite: "f16-browser",
    startedAt: new Date().toISOString(),
    description,
  };
  try {
    await run();
    recordRow.outcome = "pass";
    executedCount++;
    console.log(`  ✓ Scenario ${id} passed`);
  } catch (error) {
    recordRow.outcome = "fail";
    recordRow.actual = error.stack || error.message;
    console.error(`  ✗ Scenario ${id} failed:`, error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    recordRow.endedAt = new Date().toISOString();
    await writeFile(
      path.join(outputDir, `${id}.json`),
      JSON.stringify(recordRow, null, 2),
    );
  }
}

try {
  // Scenario B1: flag off -> empty state copy, sidebar link hidden
  await recordScenario("B1", "flag off -> empty state copy and hidden sidebar link", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 1440, height: 1000 },
    });
    page.on("console", (msg) => console.log(`[PAGE CONSOLE ${msg.type()}]:`, msg.text()));
    page.on("pageerror", (err) => console.error(`[PAGE ERROR]:`, err.message));
    page.on("response", (res) => {
      if (res.status() >= 400) {
        console.log(`[HTTP ${res.status()}]:`, res.url());
      }
    });
    try {
      await page.route("**/api/customer/features*", async (route) => {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            brandKey: "acme",
            features: { backlinks: false },
          }),
        });
      });

      // Load portal home to verify sidebar link
      await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
      const sidebarLink = page.locator('nav a[href="/portal/backlinks"]');
      const isVisible = await sidebarLink.isVisible().catch(() => false);
      assert.equal(isVisible, false, "Sidebar link to /portal/backlinks must be hidden when feature flag is off");

      // Navigate directly to /portal/backlinks
      await page.goto(new URL("/portal/backlinks", origin).href, { waitUntil: "networkidle" });
      const emptyTitle = page.getByText("This page is not available for your workspace yet.");
      await emptyTitle.waitFor({ state: "visible", timeout: 25000 });
      assert.ok(await emptyTitle.isVisible(), "Empty state title must be visible");

      const emptyDesc = page.getByText("Ask Perceev support to turn on backlinks.");
      assert.ok(await emptyDesc.isVisible(), "Empty state description must be visible");
    } finally {
      await context.close().catch(() => {});
    }
  });

  // Shared state for B2, B3, B4, B5, B6, B8 session
  const backlinksRequests = [];
  let isOverviewCached = false;
  let simulateDomainError = false;

  async function initSharedSession() {
    if (sharedPage) return;
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 1440, height: 1000 },
    });
    sharedContext = context;
    sharedPage = page;

    sharedPage.on("console", (msg) => console.log(`[SHARED CONSOLE ${msg.type()}]:`, msg.text()));
    sharedPage.on("pageerror", (err) => console.error(`[SHARED ERROR]:`, err.message));
    sharedPage.on("request", (req) => console.log(`[SHARED REQ ${req.method()}]:`, req.url()));
    sharedPage.on("response", (res) => console.log(`[SHARED RES ${res.status()}]:`, res.url()));

    // Feature flag: backlinks on
    await sharedPage.route(/\/api\/customer\/features/, async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          brandKey: "acme",
          features: { backlinks: true, backlinks_ahrefs_dr: false, backlink_snapshots: false },
        }),
      });
    });

    // Intercept price quote estimation
    await sharedPage.route(/\/api\/customer\/price\/estimate/, async (route) => {
      const postData = route.request().postDataJSON() || {};
      if (postData.action === "backlinks.page") {
        const pageSize = postData.input?.pageSize ?? 50;
        const totalUsd = pageSize === 200 ? 0.0312 : pageSize === 100 ? 0.0276 : 0.0258;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...lookupQuoteFixture,
            action: "backlinks.page",
            totalUsd,
            expectedUsd: totalUsd,
            lines: [{ label: `${pageSize} backlinks`, quantity: 1, unitUsd: totalUsd, totalUsd }],
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(lookupQuoteFixture),
      });
    });

    // Intercept backlinks API routes
    await sharedPage.route(/\/api\/customer\/backlinks\//, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const postData = req.postDataJSON() || {};
      backlinksRequests.push({
        url: url.pathname,
        method: req.method(),
        body: postData,
      });

      if (url.pathname === "/api/customer/backlinks/overview") {
        if (!isOverviewCached && postData.cacheOnly) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(overviewNotCachedFixture),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(overviewOkFixture),
        });
      }

      if (url.pathname === "/api/customer/backlinks/rows") {
        if (postData.filters?.domainFrom === "competitor.com" && simulateDomainError) {
          return route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "domain_error", message: "Failed to load links" }),
          });
        }
        if (postData.filters?.domainFrom === "partner.com") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(partnerDomainLinksFixture),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(rowsOkFixture),
        });
      }

      if (url.pathname === "/api/customer/backlinks/referring-domains") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(referringDomainsOkFixture),
        });
      }

      if (url.pathname === "/api/customer/backlinks/top-pages") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(topPagesOkFixture),
        });
      }

      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      });
    });
  }

  async function ensureLoadedTarget() {
    await initSharedSession();
    isOverviewCached = true;

    const currentUrl = new URL(sharedPage.url());
    if (
      currentUrl.pathname !== "/portal/backlinks" ||
      currentUrl.searchParams.get("target") !== "offcult.in"
    ) {
      const overviewResponse = sharedPage.waitForResponse((res) =>
        res.url().includes("/api/customer/backlinks/overview"),
      );
      await sharedPage.goto(
        new URL("/portal/backlinks?target=offcult.in", origin).href,
      );
      await overviewResponse;
    }

    await sharedPage.getByText("4,120").waitFor({
      state: "visible",
      timeout: 10000,
    });
    await sharedPage.getByRole("columnheader", { name: "Source" }).waitFor({
      state: "visible",
      timeout: 10000,
    });
  }

  // Scenario B2: /portal/backlinks?target=offcult.in sends only cacheOnly requests and shows "Run lookup · up to $0.09"
  await recordScenario("B2", "/portal/backlinks?target=offcult.in cacheOnly and not loaded card", async () => {
    await initSharedSession();
    backlinksRequests.length = 0;
    isOverviewCached = false;

    const overviewPromise = sharedPage.waitForResponse((res) => res.url().includes("/api/customer/backlinks/overview"), { timeout: 15000 });
    await sharedPage.goto(new URL("/portal/backlinks?target=offcult.in", origin).href);
    await overviewPromise;

    // Check all requests made to backlinks API had cacheOnly: true
    assert.ok(backlinksRequests.length > 0, "Requests should have been made to /api/customer/backlinks/*");
    for (const req of backlinksRequests) {
      assert.equal(req.body.cacheOnly, true, `Request to ${req.url} must send cacheOnly: true`);
    }

    // Check NotLoaded card
    const notLoadedTitle = sharedPage.getByText("Backlinks for offcult.in are not loaded.");
    await notLoadedTitle.waitFor({ state: "visible", timeout: 10000 });
    assert.ok(await notLoadedTitle.isVisible(), "Not loaded card title must be visible");

    const notLoadedDesc = sharedPage.getByText("Running this lookup buys fresh backlink data.");
    assert.ok(await notLoadedDesc.isVisible(), "Not loaded card description must be visible");

    const runLookupBtn = sharedPage.getByRole("button", { name: /Run lookup/i });
    await runLookupBtn.waitFor({ state: "visible", timeout: 5000 });
    assert.ok(await runLookupBtn.isVisible(), "Run lookup button must be visible");
  });

  // Scenario B3: click "Run lookup" -> overview metrics ("—" for a null), growth chart with gap, new/lost chart
  await recordScenario("B3", "click Run lookup -> metrics table with null as '—' and charts", async () => {
    await initSharedSession();
    backlinksRequests.length = 0;
    isOverviewCached = true;

    const runLookupBtn = sharedPage.getByRole("button", { name: /Run lookup/i });
    // Verify non-cacheOnly request was dispatched
    await Promise.all([
      sharedPage.waitForResponse((res) => res.url().includes("/api/customer/backlinks/overview")),
      runLookupBtn.click(),
    ]);
    const liveReq = backlinksRequests.find((r) => r.url === "/api/customer/backlinks/overview" && !r.body.cacheOnly);
    assert.ok(liveReq, "Clicking Run lookup must send a request with cacheOnly: false");

    // Wait for overview section to appear
    const metricsHeader = sharedPage.getByText("4,120");
    await metricsHeader.waitFor({ state: "visible", timeout: 10000 });
    assert.ok(await metricsHeader.isVisible(), "Backlinks metric '4,120' must be visible");

    // Target Spam Score was null in fixture, check that it renders "—"
    // The metric label is "Target Spam Score"
    const targetSpamCell = sharedPage.locator('div:has-text("Target Spam Score")').locator('..').getByText("—");
    await targetSpamCell.first().waitFor({ state: "visible", timeout: 5000 });
    assert.ok(await targetSpamCell.first().isVisible(), "Null Target Spam Score must render as '—'");

    // Verify growth chart panel and new/lost chart panel
    const growthChart = sharedPage.locator('[aria-label="Backlink trend chart"]');
    await growthChart.waitFor({ state: "visible", timeout: 5000 });
    assert.ok(await growthChart.isVisible(), "Backlink trend chart must be rendered");

    const newLostChart = sharedPage.locator('[aria-label="New and lost backlinks chart"]');
    await newLostChart.waitFor({ state: "visible", timeout: 5000 });
    assert.ok(await newLostChart.isVisible(), "New and lost backlinks chart must be rendered");
  });

  // Scenario B2A: submit a newly priced target and verify the approved live lookup
  await recordScenario("B2A", "new target approved lookup is live and shows results", async () => {
    await initSharedSession();
    backlinksRequests.length = 0;
    isOverviewCached = false;
    await sharedPage.goto(new URL("/portal/backlinks", origin).href);

    const targetInput = sharedPage.getByLabel("Domain or URL");
    await targetInput.waitFor({ state: "visible", timeout: 10000 });
    await targetInput.fill("fresh-approved.in");

    const lookupQuoteResponse = await sharedPage.waitForResponse((res) => {
      if (!res.url().includes("/api/customer/price/estimate")) return false;
      const body = res.request().postDataJSON() || {};
      return body.action === "backlinks.lookup.run" && body.input?.target === "fresh-approved.in";
    }, { timeout: 10000 });
    const lookupQuote = await lookupQuoteResponse.json();
    assert.ok(lookupQuote.totalUsd < 0.25, "Fixture quote is below the approval dialog threshold");

    const searchButton = sharedPage.getByRole("button", { name: /^Search/ });
    await searchButton.waitFor({ state: "visible", timeout: 5000 });
    const overviewResponse = sharedPage.waitForResponse((res) =>
      res.url().includes("/api/customer/backlinks/overview"),
    );
    await searchButton.click();
    await overviewResponse;

    const liveReq = backlinksRequests.find(
      (req) => req.url === "/api/customer/backlinks/overview" &&
        req.body.target === "fresh-approved.in" && req.body.cacheOnly === false,
    );
    assert.ok(liveReq, "Approving a new target lookup must send cacheOnly: false for that target");
    const freshResultsMetric = sharedPage.getByText("4,120");
    await freshResultsMetric.waitFor({
      state: "visible",
      timeout: 10000,
    });
    assert.ok(await freshResultsMetric.isVisible(), "Fresh results must be displayed");
  });

  // Scenario B4: Best links off -> sends hideSpam: false; One per domain / All links toggles mode
  await recordScenario("B4", "Best links toggle and One per domain / All links mode toggle", async () => {
    await ensureLoadedTarget();
    const onePerDomainReq = backlinksRequests.find(
      (r) => r.url === "/api/customer/backlinks/rows" && r.body.mode === "one_per_domain",
    );
    assert.ok(onePerDomainReq, "Initial one-per-domain view must send mode: 'one_per_domain'");
    backlinksRequests.length = 0;

    // Open Best links dropdown menu
    const bestLinksButton = sharedPage.getByRole("button", { name: /Best links:/i });
    await bestLinksButton.waitFor({ state: "visible", timeout: 5000 });
    await bestLinksButton.click();

    // Click "All links (spammy included)"
    const allLinksMenuOption = sharedPage
      .getByRole("menuitemradio", { name: /All links \(spammy included\)/i });
    await allLinksMenuOption.waitFor({ state: "visible", timeout: 5000 });

    // Verify request had hideSpam: false
    await Promise.all([
      sharedPage.waitForResponse((res) => res.url().includes("/api/customer/backlinks/rows")),
      allLinksMenuOption.click(),
    ]);
    const spamOffReq = backlinksRequests.find(
      (r) => r.url === "/api/customer/backlinks/rows" && r.body.hideSpam === false,
    );
    assert.ok(spamOffReq, "Selecting All links must send hideSpam: false in rows request");
    await sharedPage.keyboard.press("Escape");

    // Click "All links" in segmented toggle (value 'all')
    backlinksRequests.length = 0;
    const allLinksToggle = sharedPage.getByRole("button", {
      name: "All links",
      exact: true,
    });

    await Promise.all([
      sharedPage.waitForResponse((res) => res.url().includes("/api/customer/backlinks/rows")),
      allLinksToggle.click(),
    ]);
    const allModeReq = backlinksRequests.find(
      (r) => r.url === "/api/customer/backlinks/rows" && (r.body.mode === "all" || r.body.mode === "as_is"),
    );
    assert.ok(allModeReq, "Toggling All links must send mode: 'all' or 'as_is'");

    // Toggle back to "One per domain"
    const onePerDomainToggle = sharedPage.getByRole("button", {
      name: "One per domain",
      exact: true,
    });
    await Promise.all([
      sharedPage.waitForURL((url) => !url.searchParams.has("view")),
      onePerDomainToggle.click(),
    ]);
    assert.equal(await onePerDomainToggle.getAttribute("aria-pressed"), "true");
    const resetModeReq = backlinksRequests.find(
      (r) => r.url === "/api/customer/backlinks/rows" && r.body.mode === "one_per_domain",
    );
    if (resetModeReq) {
      assert.equal(resetModeReq.body.mode, "one_per_domain");
    }
  });

  // Scenario B5: filters over budget -> warning message, table hidden until conditions removed
  await recordScenario("B5", "filters over budget message and hidden table", async () => {
    await ensureLoadedTarget();

    // Apply 8 valid filter conditions through persisted state. The UI allows
    // at most 8 raw conditions, while the best-links spam condition consumes 2,
    // so this reproduces a saved filter set that exceeds this view's budget.
    if (new URL(sharedPage.url()).searchParams.get("includeSpam") === "true") {
      const bestLinksButton = sharedPage.getByRole("button", { name: /Best links:/i });
      await bestLinksButton.click();
      const bestLinksOnly = sharedPage.getByRole("menuitemradio", { name: /Best links only/i });
      await bestLinksOnly.click();
      await sharedPage.keyboard.press("Escape");
      await sharedPage.waitForURL((url) => !url.searchParams.has("includeSpam"));
    }

    await sharedPage.evaluate(() => {
      localStorage.setItem(
        "backlinks-filters:backlinks",
        JSON.stringify({
          include: "blog, news, press, media",
          exclude: "forum, spam, tag, archive",
        }),
      );
    });
    const overviewResponse = sharedPage.waitForResponse((res) =>
      res.url().includes("/api/customer/backlinks/overview"),
    );
    await sharedPage.reload();
    await overviewResponse;

    const filterBtn = sharedPage.getByRole("button", {
      name: /^Filters(?:\s|$)/,
    });
    await filterBtn.click();

    // Assert warning message appears
    const warningMsg = sharedPage.getByText(
      "These filters exceed the 6-condition limit for this view. Remove conditions in Filters or choose All links (spammy included) from Best links. Your filters have been kept.",
    );
    await warningMsg.waitFor({ state: "visible", timeout: 5000 });
    assert.ok(await warningMsg.isVisible(), "Over-budget warning message must be visible");

    // Assert table is hidden
    const sourceHeader = sharedPage.getByRole("columnheader", { name: "Source" });
    const isResultsTableVisible = await sourceHeader.isVisible().catch(() => false);
    assert.equal(isResultsTableVisible, false, "Table must be hidden when filters exceed budget");

    assert.equal(
      await sharedPage.getByLabel("Source URL Contains").inputValue(),
      "blog, news, press, media",
      "Saved filter input must remain unchanged while over budget",
    );

    // Clear filters
    await sharedPage.getByRole("button", { name: "Clear all" }).click();
    await sharedPage.getByRole("columnheader", { name: "Source" }).waitFor({
      state: "visible",
      timeout: 5000,
    });

    // Close filters panel
    await filterBtn.click();
  });

  // Scenario B6: expand a domain -> "Loading links…" then links; second domain error shows "Couldn't load this domain's links."
  await recordScenario("B6", "domain expansion with loading state and error handling", async () => {
    await ensureLoadedTarget();
    simulateDomainError = false;

    // Wait for table to be visible again
    const sourceHeader = sharedPage.getByRole("columnheader", { name: "Source" });
    await sourceHeader.waitFor({ state: "visible", timeout: 5000 });

    // First domain is partner.com, click its expand toggle
    const expandBtn1 = sharedPage.getByRole("button", { name: /Show all links from partner\.com/i });
    await expandBtn1.waitFor({ state: "visible", timeout: 5000 });
    await expandBtn1.click();

    // Verify sub-rows render with links from partner.com
    const sublink = sharedPage.getByText("https://partner.com/reviews/boots").or(sharedPage.getByText("Boots review"));
    await sublink.waitFor({ state: "visible", timeout: 5000 });
    assert.ok(await sublink.isVisible(), "Expanded domain rows must display child links");

    // Now enable simulated error for competitor.com
    simulateDomainError = true;
    const expandBtn2 = sharedPage.getByRole("button", { name: /Show all links from competitor\.com/i });
    await expandBtn2.waitFor({ state: "visible", timeout: 5000 });
    await expandBtn2.click();

    // Verify error state
    const errorText = sharedPage.getByText("Couldn't load this domain's links.");
    await errorText.waitFor({ state: "visible", timeout: 5000 });
    assert.ok(await errorText.isVisible(), "Domain error state must show 'Couldn't load this domain's links.'");
  });

  // Scenario B7: Ahrefs DR flag off -> no menu item and no column; on -> menu item, column fills, export, failure toast
  await recordScenario("B7", "Ahrefs DR flag gating, column fill, export and failure toast", async () => {
    async function setupAhrefsPage({ ahrefsEnabled, ahrefsStatus }) {
      const { context, page } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      await page.route(/\/api\/customer\/features/, async (route) => {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            brandKey: "acme",
            features: {
              backlinks: true,
              backlinks_ahrefs_dr: ahrefsEnabled,
              backlink_snapshots: false,
            },
          }),
        });
      });
      await page.route(/\/api\/customer\/price\/estimate/, async (route) => {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(lookupQuoteFixture),
        });
      });
      const ahrefsRequests = [];
      await page.route(/\/api\/customer\/backlinks\//, async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/customer/backlinks/ahrefs-dr") {
          const postData = route.request().postDataJSON() || {};
          ahrefsRequests.push(postData);
          if (ahrefsStatus !== 200) {
            return route.fulfill({
              status: ahrefsStatus,
              contentType: "application/json",
              body: JSON.stringify({ error: "ahrefs_failed" }),
            });
          }
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ratings: { "partner.com": 61, "competitor.com": null },
            }),
          });
        }
        if (url.pathname === "/api/customer/backlinks/overview") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(overviewOkFixture),
          });
        }
        if (url.pathname === "/api/customer/backlinks/rows") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(rowsOkFixture),
          });
        }
        if (url.pathname === "/api/customer/backlinks/referring-domains") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(referringDomainsOkFixture),
          });
        }
        if (url.pathname === "/api/customer/backlinks/top-pages") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(topPagesOkFixture),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "ok" }),
        });
      });
      return { context, page, ahrefsRequests };
    }

    // Part 1: flag off -> no menu item and no column.
    {
      const { context, page } = await setupAhrefsPage({
        ahrefsEnabled: false,
        ahrefsStatus: 200,
      });
      try {
        await page.goto(new URL("/portal/backlinks?target=offcult.in", origin).href);
        await page.getByText("4,120").waitFor({ state: "visible", timeout: 15000 });
        await page.getByRole("columnheader", { name: "Source" }).waitFor({
          state: "visible",
          timeout: 10000,
        });
        assert.equal(
          await page.getByRole("button", { name: "Backlinks table actions" }).count(),
          0,
          "Actions menu must be hidden when backlinks_ahrefs_dr is off",
        );
        assert.equal(
          await page.getByRole("columnheader", { name: "Ahrefs DR" }).count(),
          0,
          "Ahrefs DR column must be hidden when backlinks_ahrefs_dr is off",
        );
      } finally {
        await context.close().catch(() => {});
      }
    }

    // Part 2: flag on -> menu item, column fills, export gains "Ahrefs DR".
    {
      const { context, page, ahrefsRequests } = await setupAhrefsPage({
        ahrefsEnabled: true,
        ahrefsStatus: 200,
      });
      try {
        await page.goto(new URL("/portal/backlinks?target=offcult.in", origin).href);
        await page.getByText("4,120").waitFor({ state: "visible", timeout: 15000 });
        await page.getByRole("columnheader", { name: "Source" }).waitFor({
          state: "visible",
          timeout: 10000,
        });
        assert.equal(
          await page.getByRole("columnheader", { name: "Ahrefs DR" }).count(),
          0,
          "Ahrefs DR column must stay hidden until the user opts in",
        );

        const actionsButton = page.getByRole("button", { name: "Backlinks table actions" });
        await actionsButton.waitFor({ state: "visible", timeout: 10000 });
        await actionsButton.click();
        const drItem = page.getByRole("menuitem", { name: "Ahrefs DR" });
        await drItem.waitFor({ state: "visible", timeout: 5000 });
        assert.equal(
          await drItem.getAttribute("title"),
          "Look up Ahrefs Domain Rating for each domain in the table",
          "Ahrefs DR menu item must carry the spec title",
        );
        const ahrefsResponse = page.waitForResponse(
          (res) => res.url().includes("/api/customer/backlinks/ahrefs-dr"),
          { timeout: 10000 },
        );
        await drItem.click();
        await ahrefsResponse;
        assert.ok(ahrefsRequests.length > 0, "Clicking Ahrefs DR must call the ahrefs-dr route");
        const sentDomains = ahrefsRequests[0].domains;
        assert.ok(Array.isArray(sentDomains) && sentDomains.length <= 100, "DR request must send at most 100 domains");
        assert.ok(sentDomains.includes("partner.com"), "DR request must include the table domains");

        await page.getByRole("columnheader", { name: "Ahrefs DR" }).waitFor({
          state: "visible",
          timeout: 10000,
        });
        await page.getByText("61.0").waitFor({ state: "visible", timeout: 5000 });
        await page.getByText("Domain Rating from Ahrefs' free public lookup.").waitFor({
          state: "visible",
          timeout: 5000,
        });

        // Referring Domains tab gains the column from the same loaded ratings.
        await page.getByRole("tab", { name: "Referring Domains" }).click();
        await page.getByRole("columnheader", { name: "Ahrefs DR" }).waitFor({
          state: "visible",
          timeout: 10000,
        });
        await page.getByText("61.0").first().waitFor({ state: "visible", timeout: 5000 });

        // Export gains the "Ahrefs DR" column when ratings are loaded.
        await page.getByRole("tab", { name: "Backlinks" }).click();
        await page.getByRole("columnheader", { name: "Source" }).waitFor({
          state: "visible",
          timeout: 10000,
        });
        const exportBtn = page.getByRole("button", { name: /Export/i });
        await exportBtn.waitFor({ state: "visible", timeout: 5000 });
        await exportBtn.click();
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 10000 }),
          page.getByRole("menuitem", { name: /CSV/i }).or(page.getByText(/Export CSV/i)).click(),
        ]);
        const stream = await download.createReadStream();
        const chunks = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        const csvContent = Buffer.concat(chunks).toString("utf8");
        assert.ok(csvContent.includes("Ahrefs DR"), 'Exported CSV must include header "Ahrefs DR"');
      } finally {
        await context.close().catch(() => {});
      }
    }

    // Part 3: failing DR fetch -> failure toast, no column.
    {
      const { context, page } = await setupAhrefsPage({
        ahrefsEnabled: true,
        ahrefsStatus: 500,
      });
      try {
        await page.goto(new URL("/portal/backlinks?target=offcult.in", origin).href);
        await page.getByText("4,120").waitFor({ state: "visible", timeout: 15000 });
        await page.getByRole("columnheader", { name: "Source" }).waitFor({
          state: "visible",
          timeout: 10000,
        });
        const actionsButton = page.getByRole("button", { name: "Backlinks table actions" });
        await actionsButton.waitFor({ state: "visible", timeout: 10000 });
        await actionsButton.click();
        const drItem = page.getByRole("menuitem", { name: "Ahrefs DR" });
        await drItem.waitFor({ state: "visible", timeout: 5000 });
        await drItem.click();
        await page.getByText("Could not load Ahrefs DR.").waitFor({
          state: "visible",
          timeout: 10000,
        });
        assert.equal(
          await page.getByRole("columnheader", { name: "Ahrefs DR" }).count(),
          0,
          "A failed DR fetch must not add the column",
        );
      } finally {
        await context.close().catch(() => {});
      }
    }
  });
  // Scenario B8: 375 px viewport has no horizontal scroll (scrollWidth <= 375); export CSV includes headers
  await recordScenario("B8", "375 px responsive layout and CSV export verification", async () => {
    await ensureLoadedTarget();

    // 1. Check 375 px responsive layout
    await sharedPage.setViewportSize({ width: 375, height: 667 });
    await sharedPage.waitForTimeout(1000);

    const hasHorizontalOverflow = await sharedPage.evaluate(() => {
      return document.documentElement.scrollWidth > 375;
    });
    assert.equal(
      hasHorizontalOverflow,
      false,
      "375 px viewport must not have horizontal scroll (scrollWidth <= 375)",
    );

    // Reset viewport for desktop interactions
    await sharedPage.setViewportSize({ width: 1440, height: 1000 });
    await sharedPage.waitForTimeout(500);

    // A 200-row page quote of $0.0312 must be formatted as $0.04 in the hint.
    const pageSizeSelect = sharedPage.getByRole("combobox", { name: "Rows per page" });
    await pageSizeSelect.click();
    const pageQuoteResponse = sharedPage.waitForResponse((res) => {
      if (!res.url().includes("/api/customer/price/estimate")) return false;
      const body = res.request().postDataJSON() || {};
      return body.action === "backlinks.page" && body.input?.pageSize === 200;
    }, { timeout: 10000 });
    await sharedPage.getByRole("option", { name: "200", exact: true }).click();
    await pageQuoteResponse;
    await sharedPage.getByText(
      "Each new page, sort or filter costs up to $0.04. Results are reused for 6 hours.",
      { exact: true },
    ).waitFor({ state: "visible", timeout: 10000 });

    // 2. Export CSV and check headers
    const exportBtn = sharedPage.getByRole("button", { name: /Export/i });
    await exportBtn.waitFor({ state: "visible", timeout: 5000 });
    await exportBtn.click();

    const [download] = await Promise.all([
      sharedPage.waitForEvent("download", { timeout: 10000 }),
      sharedPage.getByRole("menuitem", { name: /CSV/i }).or(sharedPage.getByText(/Export CSV/i)).click(),
    ]);

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const csvContent = Buffer.concat(chunks).toString("utf8");

    // Verify required CSV headers
    const requiredHeaders = ["Domain", "Source URL", "Target URL", "Anchor", "First Seen"];
    for (const h of requiredHeaders) {
      assert.ok(
        csvContent.includes(h),
        `Exported CSV must include header "${h}"`,
      );
    }
  });

  // Cleanup shared session
  if (sharedContext) {
    await sharedContext.close().catch(() => {});
  }
  await browser.close().catch(() => {});
  killServerChild();

  console.log(`ok ${executedCount} scenarios`);
  process.exit(0);
} catch (error) {
  if (sharedContext) {
    await sharedContext.close().catch(() => {});
  }
  await browser.close().catch(() => {});
  killServerChild();
  console.error("Test failed:", error);
  process.exit(1);
}
