#!/usr/bin/env node
/**
 * F18 Phase 4 browser verification (F18-AC-27, F18-AC-28).
 *
 * Runs the real portal against recorded API responses under
 * `tests/fixtures/site-audit/api/`; no audit is crawled and no provider is
 * reached.
 *
 * Scenarios:
 *   B01 launch form defaults and the empty-URL validation
 *   B02 the > 500-page confirmation copy
 *   B03 Lighthouse on -> cost dialog "Up to $0.10" and a POST carrying maxUsd
 *   B04 running audit: phase badge, "23 / 50 pages", feed, Cancel -> cancelled
 *   B05 failed with pages: "This audit stopped early after 12 page(s)."
 *   B06 issues grouped Critical/Warning/Info, sorted by pages, "How to fix:"
 *   B07 pages filters -> filtered empty state -> Clear filters
 *   B08 AI access shows "Blocked" for OAI-SearchBot
 *   B09 an injected registry tab and page action render; flag-off entries hide
 *   B10 375 px viewport has no horizontal page scroll
 *   B11 lighthouse detail renders scores and filters by category
 *
 * Output: "F18 browser: 11/11 passed" on pass.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { openPortal, SUPABASE_URL } from "./portalFixtureHarness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, "../../tests/fixtures/site-audit/api");

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

const AUDIT_ID = "6f1d2c3b-0a4e-4b8f-9c1d-2e3f4a5b6c7d";
const JOB_ID = "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90";
const COMPLETED_ID = "7a2e3d4c-1b5f-4c9a-8d2e-3f4a5b6c7d8e";
const FAILED_ID = "8b3f4e5d-2c6a-4d1b-9e3f-4a5b6c7d8e9f";

const FEATURES = {
  site_audit: true,
  site_audit_lighthouse: true,
  site_audit_render: true,
};

const rawArg =
  process.argv.find((arg) => !arg.startsWith("--") && arg.includes("33")) ||
  "http://127.0.0.1:3328";
const origin = new URL(rawArg.startsWith("http") ? rawArg : `http://${rawArg}`);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname),
  "browser checks require a disposable local app",
);
const port = parseInt(origin.port || "3328", 10);
const base = origin.href.replace(/\/$/, "");

let requested = ["B01", "B02", "B03", "B04", "B05", "B06", "B07", "B08", "B09", "B10", "B11"];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--only=")) {
    requested = process.argv[i].split("=")[1].split(",").map((s) => s.trim());
  } else if (process.argv[i] === "--only" && process.argv[i + 1]) {
    requested = process.argv[i + 1].split(",").map((s) => s.trim());
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
    await new Promise((resolve) => setTimeout(resolve, 250));
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

const jsonResponse = (route, body, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  });

/**
 * Answers every audit route from the recorded fixtures, then clears the query
 * cache so the feature flags (served by this harness) are read again.
 */
async function installAuditApi(page, options = {}) {
  const {
    list = fixture("audit-list.json"),
    status = fixture("audit-status-completed.json"),
    feed = fixture("audit-feed.json"),
    summary = fixture("audit-summary-completed.json"),
    issues = fixture("audit-issues-missing-title.json"),
    pages = fixture("audit-pages.json"),
    performance = fixture("audit-performance.json"),
    price = fixture("price-quote.json"),
    start,
    cancel,
    features = FEATURES,
  } = options;

  const value = (candidate, url) =>
    typeof candidate === "function" ? candidate(url) : candidate;

  await page.route(
    (url) => url.pathname === "/api/customer/features",
    (route) =>
      jsonResponse(route, { brandKey: "acme", features }),
  );

  await page.route(
    (url) => url.pathname === "/api/customer/audit",
    (route) => {
      if (route.request().method() === "POST") {
        start?.onPost?.(JSON.parse(route.request().postData() || "{}"));
        return jsonResponse(
          route,
          start?.response ?? {
            auditId: AUDIT_ID,
            jobId: JOB_ID,
            status: "queued",
            pollAfterSeconds: 3,
            approvedMaxUsd: null,
          },
          202,
        );
      }
      return jsonResponse(route, list);
    },
  );

  await page.route(
    (url) => /^\/api\/customer\/audit\/[0-9a-f-]{36}$/.test(url.pathname),
    (route) => jsonResponse(route, value(status)),
  );
  await page.route(
    (url) => url.pathname.endsWith("/feed"),
    (route) => jsonResponse(route, value(feed)),
  );
  await page.route(
    (url) => url.pathname.endsWith("/summary"),
    (route) => jsonResponse(route, value(summary)),
  );
  await page.route(
    (url) => url.pathname.endsWith("/issues"),
    (route) =>
      jsonResponse(route, value(issues, new URL(route.request().url()))),
  );
  await page.route(
    (url) => url.pathname.endsWith("/pages"),
    (route) =>
      jsonResponse(route, value(pages, new URL(route.request().url()))),
  );
  await page.route(
    (url) => url.pathname.endsWith("/performance"),
    (route) => jsonResponse(route, value(performance)),
  );
  await page.route(
    (url) => /\/lighthouse\/[^/]+\/export/.test(url.pathname),
    (route) =>
      jsonResponse(route, {
        filename: "lighthouse-mobile-issues.json",
        content: JSON.stringify({ resultId: "x", category: "all", issues: [] }),
      }),
  );
  await page.route(
    (url) => /\/lighthouse\/[^/]+$/.test(url.pathname),
    (route) => jsonResponse(route, value(options.lighthouseDetail ?? fixture("lighthouse-detail.json"))),
  );
  await page.route(
    (url) => url.pathname.endsWith("/cancel"),
    (route) => jsonResponse(route, cancel ? cancel() : { status: "cancelling" }),
  );
  await page.route(
    (url) => url.pathname === "/api/customer/price/estimate",
    (route) => jsonResponse(route, price),
  );

  // The shell read the harness's feature flags during sign-in; clear the cache
  // so the audit harness's flags are read instead.
  await page.evaluate(() => {
    window.__REACT_QUERY_CLIENT__?.clear();
  });
}

const scenarios = [];
function scenario(id, run) {
  scenarios.push({ id, run });
}

let startPosts = [];

async function gotoLaunch(page) {
  await page.goto(`${base}/portal/audit`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Site URL").waitFor({ timeout: 20000 });
}

async function gotoDetail(page, auditId) {
  await page.goto(`${base}/portal/audit/${auditId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("link", { name: "All audits" }).waitFor({
    timeout: 20000,
  });
}


scenario("B01", async (page) => {
  await gotoLaunch(page);
  await page.getByRole("link", { name: "Site Audit" }).first().waitFor();
  assert.equal(
    await page.getByLabel("Site URL").inputValue(),
    "https://offcult.in/",
  );
  assert.equal(await page.getByLabel("Max pages").inputValue(), "50");
  await page
    .getByText(
      "Crawl your website for technical SEO problems and see what AI crawlers can read.",
    )
    .waitFor();
  await page.getByLabel("Site URL").fill("");
  await page.getByRole("button", { name: "Start audit" }).click();
  await page.getByText("Please enter a URL.").waitFor();
});

scenario("B02", async (page) => {
  await gotoLaunch(page);
  await page.getByLabel("Max pages").fill("600");
  await page.getByLabel("Max pages").press("Tab");
  await page.getByRole("button", { name: "Start audit" }).click();
  await page.getByText("Start a large audit?").waitFor();
  await page.getByText(/about 10 minutes/).waitFor();
  await page.getByRole("button", { name: "Continue" }).waitFor();
});

scenario("B03", async (page) => {
  await gotoLaunch(page);
  await page.getByRole("switch", { name: "Include Lighthouse" }).click();
  await page.getByRole("button", { name: "Start audit" }).click();
  await page.getByText("Up to $0.10").waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Start audit" })
    .click();
  await page.waitForURL(new RegExp(`/portal/audit/${AUDIT_ID}$`), {
    timeout: 15000,
  });
  assert.equal(startPosts.length, 1);
  assert.equal(startPosts[0].lighthouse, true);
  assert.equal(startPosts[0].maxUsd, 0.1);
});

scenario("B04", async (page) => {
  await gotoDetail(page, AUDIT_ID);
  await page.getByText("Crawling", { exact: true }).first().waitFor();
  await page.getByText("23 / 50 pages").waitFor();
  await page
    .getByText("Boots that last the winter")
    .waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Cancel audit" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Cancel audit" })
    .click();
  await page.getByText("Cancelling…").waitFor({ timeout: 6000 });
  await page
    .getByText("You cancelled this audit before it crawled any pages.")
    .waitFor({ timeout: 15000 });
});

scenario("B05", async (page) => {
  await gotoDetail(page, FAILED_ID);
  await page
    .getByText("This audit stopped early after 12 page(s).")
    .waitFor({ timeout: 10000 });
});

scenario("B06", async (page) => {
  await gotoDetail(page, COMPLETED_ID);
  await page.getByText("Issues (7)").waitFor({ timeout: 10000 });
  await page.getByText("Critical (3)").waitFor();
  await page.getByText("Warning (3)").waitFor();
  await page.getByText("Info (1)").waitFor();

  const warning = page.locator("section", { hasText: "Warning (3)" }).last();
  const warningText = await warning.innerText();
  assert.ok(
    warningText.indexOf("Page returns an error (4xx)") <
      warningText.indexOf("Duplicate title"),
    "warning groups are sorted by pages affected",
  );

  await page.getByRole("button", { name: /Missing title tag/ }).click();
  await page.getByText("How to fix:").waitFor({ timeout: 10000 });
  await page
    .locator('a[href="https://offcult.in/blog/boots"]')
    .first()
    .waitFor({ timeout: 10000 });
});

scenario("B07", async (page) => {
  await gotoDetail(page, COMPLETED_ID);
  await page.getByRole("tab", { name: /Pages \(48\)/ }).click();
  await page
    .getByText("Boots that last the winter")
    .waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: /Filters/ }).click();
  await page.getByRole("combobox", { name: "Status" }).first().click();
  await page.getByRole("option", { name: "Error (4xx+)" }).click();
  await page
    .getByText("No pages match these filters.")
    .waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page
    .getByText("Boots that last the winter")
    .waitFor({ timeout: 10000 });

  // AC-26 client half: the visible rows export through F06's exportRows.
  const downloadPromise = page.waitForEvent("download", { timeout: 10000 });
  await page.getByRole("button", { name: /^Export/ }).click();
  await page.getByRole("menuitem", { name: "Export CSV" }).click();
  const download = await downloadPromise;
  assert.ok(
    download.suggestedFilename().endsWith(".csv"),
    "CSV export downloads the loaded page rows",
  );
});

scenario("B08", async (page) => {
  await gotoDetail(page, COMPLETED_ID);
  await page.getByRole("tab", { name: "AI access" }).click();
  const row = page.getByRole("row", { name: /OAI-SearchBot/ });
  await row.waitFor({ timeout: 10000 });
  const text = await row.innerText();
  assert.ok(text.includes("Blocked"), "OAI-SearchBot is blocked");
});

scenario("B09", async (page) => {
  await page.addInitScript(() => {
    window.__PERCEEV_AUDIT_TABS__ = [
      { id: "test-visible", label: "Test tab" },
      { id: "test-flag-off", label: "Hidden tab", flag: "indexnow" },
    ];
    window.__PERCEEV_AUDIT_PAGE_ACTIONS__ = [
      { id: "test-action", label: "Test action" },
      { id: "test-action-off", label: "Hidden action", flag: "indexnow" },
    ];
  });

  await gotoLaunch(page);
  await page.getByRole("tab", { name: "Test tab" }).waitFor({
    timeout: 10000,
  });
  assert.equal(
    await page.getByRole("tab", { name: "Hidden tab" }).count(),
    0,
    "a flag-off tab is hidden",
  );
  await page.getByRole("tab", { name: "Test tab" }).click();
  await page.getByTestId("injected-tab-panel-test-visible").waitFor();

  await gotoDetail(page, COMPLETED_ID);
  await page.getByRole("tab", { name: /Pages \(48\)/ }).click();
  await page
    .getByText("Boots that last the winter")
    .waitFor({ timeout: 10000 });
  await page
    .getByRole("row", { name: /Boots that last the winter/ })
    .getByRole("checkbox")
    .click();
  await page.getByRole("button", { name: "Test action" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Hidden action" }).count(),
    0,
    "a flag-off page action is hidden",
  );
  await page.getByRole("button", { name: "Test action" }).click();
  await page.getByTestId("injected-action-dialog-test-action").waitFor();
});

scenario("B11", async (page) => {
  const resultId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await page.goto(`${base}/portal/audit/${COMPLETED_ID}/lighthouse/${resultId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Back to audit" }).waitFor({ timeout: 20000 });
  await page.getByText("Reduce unused JavaScript").waitFor({ timeout: 10000 });
  await page.getByRole("tab", { name: /Performance/ }).click();
  await page.waitForURL(/category=performance/, { timeout: 10000 });
  await page.getByText("Reduce unused JavaScript").waitFor({ timeout: 10000 });
  assert.equal(await page.getByText("Background and foreground colors do not have a sufficient contrast ratio.").count(), 0);
});

scenario("B10", async (page) => {
  const noHorizontalScroll = () =>
    page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    );

  await gotoLaunch(page);
  assert.ok(await noHorizontalScroll(), "launch has no horizontal scroll");

  await gotoDetail(page, COMPLETED_ID);
  await page.getByText("Issues (7)").waitFor({ timeout: 10000 });
  assert.ok(await noHorizontalScroll(), "detail has no horizontal scroll");

  await page.getByRole("tab", { name: /Pages \(48\)/ }).click();
  await page
    .getByText("Boots that last the winter")
    .waitFor({ timeout: 10000 });
  assert.ok(await noHorizontalScroll(), "pages has no horizontal scroll");
});

const passed = [];
const failed = [];

for (const { id, run } of scenarios) {
  if (!requested.includes(id)) continue;
  console.log(`Running ${id}…`);
  const { page, context } = await openPortal(browser, origin, {
    viewport:
      id === "B10" ? { width: 375, height: 800 } : { width: 1440, height: 1000 },
  });

  const auditOptions = {};
  if (id === "B04") {
    let cancelled = false;
    let cancelRequested = false;
    auditOptions.status = () =>
      cancelled
        ? fixture("audit-status-cancelled.json")
        : cancelRequested
          ? { ...fixture("audit-status-running.json"), cancelRequested: true }
          : fixture("audit-status-running.json");
    auditOptions.summary = fixture("audit-summary-empty.json");
    auditOptions.cancel = () => {
      cancelRequested = true;
      setTimeout(() => {
        cancelled = true;
      }, 700);
      return { status: "cancelling" };
    };
  }
  if (id === "B05") {
    auditOptions.status = fixture("audit-status-failed.json");
    auditOptions.summary = fixture("audit-summary-empty.json");
  }
  if (id === "B06" || id === "B07" || id === "B08" || id === "B09" || id === "B10") {
    auditOptions.status = fixture("audit-status-completed.json");
    auditOptions.summary = fixture("audit-summary-completed.json");
  }
  if (id === "B03") {
    startPosts = [];
    auditOptions.start = {
      response: {
        auditId: AUDIT_ID,
        jobId: JOB_ID,
        status: "queued",
        pollAfterSeconds: 3,
        approvedMaxUsd: 0.1,
      },
      onPost: (body) => startPosts.push(body),
    };
  }
  if (id === "B07" || id === "B09" || id === "B10") {
    auditOptions.pages = (url) =>
      url.searchParams.get("status") === "error"
        ? fixture("audit-pages-empty.json")
        : fixture("audit-pages.json");
  }

  await installAuditApi(page, auditOptions);

  try {
    await run(page);
    passed.push(id);
    console.log(`ok ${id}`);
  } catch (error) {
    failed.push({ id, error });
    let body = "";
    try {
      body = (await page.locator("body").innerText()).slice(0, 1200);
    } catch {
      // ignore
    }
    console.error(`FAIL ${id}: ${error.message}`);
    if (body) console.error(`--- ${id} body ---\n${body}\n---`);
  } finally {
    await context.close();
  }
}

await browser.close();
killServerChild();

if (failed.length > 0) {
  for (const { id, error } of failed) {
    console.error(`${id}: ${error.stack ?? error.message}`);
  }
  console.error(`F18 browser: ${passed.length}/${passed.length + failed.length} passed`);
  process.exit(1);
}

console.log(`F18 browser: ${passed.length}/${passed.length} passed`);
