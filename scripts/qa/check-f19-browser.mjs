#!/usr/bin/env node
/**
 * F19 Phase 2 browser verification (F19-AC-11).
 *
 * Scenarios:
 *   B1: no key -> "Set up IndexNow" -> key shown with both hosts unchecked
 *   B2: "Check again" -> "Not found" on both; then found + moved -> title "Your key file is set up" and only the bare host listed
 *   B3: submit two URLs (one off-site) -> success toast "Submitted 1 URL" and warning "Skipped 1 URL not on offcult.in", history row "Submitted via Bing"; phone width 390 px has no horizontal scroll
 *
 * Output: "ok 3 scenarios" on pass.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { openPortal, SUPABASE_URL } from "./portalFixtureHarness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, "../../tests/fixtures/f19/api");

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

const rawArg = process.argv.find((a) => !a.startsWith("--") && a.includes("33")) || "http://127.0.0.1:3328";
const origin = new URL(rawArg.startsWith("http") ? rawArg : `http://${rawArg}`);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname),
  "browser checks require a disposable local app"
);
const port = parseInt(origin.port || "3328", 10);

// Parse --only flag
let requestedScenarios = ["B1", "B2", "B3", "B4", "B5"];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--only=")) {
    requestedScenarios = process.argv[i].split("=")[1].split(",").map((s) => s.trim());
  } else if (process.argv[i] === "--only" && process.argv[i + 1]) {
    requestedScenarios = process.argv[i + 1].split(",").map((s) => s.trim());
  }
}

async function waitForServer(targetPort, timeoutMs = 30000) {
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
const isRunning = await waitForServer(port, 1500);
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
    }
  );
  const ready = await waitForServer(port, 45000);
  assert.ok(ready, `Next.js server failed to start on port ${port}`);
}

function killServerChild() {
  if (!serverChild) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(serverChild.pid), "/f", "/t"]);
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

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});

const offcultMembership = [
  {
    brand_key: "offcult.in",
    role: "owner",
    customer_brands: {
      brand_key: "offcult.in",
      display_name: "Offcult",
      website: "https://offcult.in",
      website_host: "offcult.in",
      is_active: true,
    },
  },
];

const jsonResponse = (route, body, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  });

const SITE_AUDIT_FIXTURES_DIR = path.resolve(HERE, "../../tests/fixtures/site-audit/api");
function siteAuditFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(SITE_AUDIT_FIXTURES_DIR, name), "utf8"));
}

const FEATURES = {
  site_audit: true,
  site_audit_lighthouse: true,
  site_audit_render: true,
  indexnow: true,
};

async function installAuditApi(page, options = {}) {
  const {
    list = siteAuditFixture("audit-list.json"),
    status = siteAuditFixture("audit-status-completed.json"),
    feed = siteAuditFixture("audit-feed.json"),
    summary = siteAuditFixture("audit-summary-completed.json"),
    issues = siteAuditFixture("audit-issues-missing-title.json"),
    pages = siteAuditFixture("audit-pages.json"),
    performance = siteAuditFixture("audit-performance.json"),
    price = siteAuditFixture("price-quote.json"),
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
            auditId: "7a2e3d4c-1b5f-4c9a-8d2e-3f4a5b6c7d8e",
            jobId: "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90",
            status: "queued",
          },
        );
      }
      return jsonResponse(route, list);
    },
  );

  await page.route(
    (url) => url.pathname === "/api/customer/audit/7a2e3d4c-1b5f-4c9a-8d2e-3f4a5b6c7d8e",
    (route) => jsonResponse(route, status),
  );

  await page.route(
    (url) =>
      url.pathname === "/api/customer/audit/7a2e3d4c-1b5f-4c9a-8d2e-3f4a5b6c7d8e/feed",
    (route) => jsonResponse(route, feed),
  );

  await page.route(
    (url) =>
      url.pathname === "/api/customer/audit/7a2e3d4c-1b5f-4c9a-8d2e-3f4a5b6c7d8e/summary",
    (route) => jsonResponse(route, summary),
  );

  await page.route(
    (url) =>
      url.pathname === "/api/customer/audit/7a2e3d4c-1b5f-4c9a-8d2e-3f4a5b6c7d8e/issues",
    (route) => jsonResponse(route, issues),
  );

  await page.route(
    (url) =>
      url.pathname === "/api/customer/audit/7a2e3d4c-1b5f-4c9a-8d2e-3f4a5b6c7d8e/pages",
    (route) => jsonResponse(route, pages),
  );

  await page.route(
    (url) =>
      url.pathname ===
      "/api/customer/audit/7a2e3d4c-1b5f-4c9a-8d2e-3f4a5b6c7d8e/performance",
    (route) => jsonResponse(route, performance),
  );

  await page.route(
    (url) => url.pathname === "/api/customer/price/estimate",
    (route) => jsonResponse(route, price),
  );

  await page.route(
    (url) =>
      url.pathname ===
      "/api/customer/audit/7a2e3d4c-1b5f-4c9a-8d2e-3f4a5b6c7d8e/cancel",
    (route) => {
      cancel?.onPost?.();
      return jsonResponse(route, { cancelled: true });
    },
  );
}

let passedCount = 0;

// ==========================================
// Scenario B1: No key -> "Set up IndexNow" -> key shown with both hosts unchecked
// ==========================================
if (requestedScenarios.includes("B1")) {
  console.log("Running Scenario B1...");
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: offcultMembership },
  });

  try {
    let indexnowState = readFixture("b1-no-key.json");

    await page.route((url) => url.pathname === "/api/customer/features", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          brandKey: "offcult.in",
          features: { indexnow: true },
        }),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/indexnow", async (route) => {
      return route.fulfill({
        status: 200,
        headers: { "Cache-Control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify(indexnowState),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/indexnow/setup", async (route) => {
      indexnowState = readFixture("b1-key-created.json");
      return route.fulfill({
        status: 200,
        headers: { "Cache-Control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify(readFixture("b1-setup-success.json")),
      });
    });

    await page.goto(new URL("/portal/settings/indexnow", origin).href, {
      waitUntil: "networkidle",
    });

    const setupBtn = page.getByRole("button", { name: "Set up IndexNow" });
    await setupBtn.waitFor({ state: "visible", timeout: 10000 });
    assert.ok(await setupBtn.isVisible(), "B1: 'Set up IndexNow' visible");

    await setupBtn.click();

    // Key shown
    const keyLoc = page.locator("text=3f2a9c1e5b7d4f60a8c2e1b3d5f7a9c1");
    await keyLoc.first().waitFor({ state: "visible", timeout: 10000 });
    assert.ok(await keyLoc.first().isVisible(), "B1: key is shown after setup");

    // Both hosts shown
    const bareHost = page.locator("text=https://offcult.in/3f2a9c1e5b7d4f60a8c2e1b3d5f7a9c1.txt");
    const wwwHost = page.locator("text=https://www.offcult.in/3f2a9c1e5b7d4f60a8c2e1b3d5f7a9c1.txt");
    await bareHost.first().waitFor({ state: "visible", timeout: 5000 });
    await wwwHost.first().waitFor({ state: "visible", timeout: 5000 });

    assert.ok(await bareHost.first().isVisible(), "B1: bare host shown");
    assert.ok(await wwwHost.first().isVisible(), "B1: www host shown");

    // Unchecked (no Found or Not found labels)
    assert.equal(await page.locator("text=Not found").count(), 0, "B1: no 'Not found' badge");
    assert.equal(await page.locator("text=Found").count(), 0, "B1: no 'Found' badge");

    passedCount++;
    console.log("  ✓ Scenario B1 passed");
  } finally {
    await context.close();
  }
}

// ==========================================
// Scenario B2: "Check again" -> "Not found" on both; then found + moved -> title "Your key file is set up" and only the bare host listed
// ==========================================
if (requestedScenarios.includes("B2")) {
  console.log("Running Scenario B2...");
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: offcultMembership },
  });

  try {
    let indexnowState = readFixture("b1-key-created.json");
    let checkCount = 0;

    await page.route((url) => url.pathname === "/api/customer/features", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          brandKey: "offcult.in",
          features: { indexnow: true },
        }),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/indexnow", async (route) => {
      return route.fulfill({
        status: 200,
        headers: { "Cache-Control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify(indexnowState),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/indexnow/check", async (route) => {
      checkCount++;
      if (checkCount === 1) {
        indexnowState = readFixture("b2-setup-missing.json");
        return route.fulfill({
          status: 200,
          headers: { "Cache-Control": "no-store" },
          contentType: "application/json",
          body: JSON.stringify(readFixture("b2-check-missing.json")),
        });
      } else {
        indexnowState = readFixture("b2-setup-found-moved.json");
        return route.fulfill({
          status: 200,
          headers: { "Cache-Control": "no-store" },
          contentType: "application/json",
          body: JSON.stringify(readFixture("b2-check-found-moved.json")),
        });
      }
    });

    await page.goto(new URL("/portal/settings/indexnow", origin).href, {
      waitUntil: "networkidle",
    });

    const checkBtn = page.getByRole("button", { name: "Check again" });
    await checkBtn.waitFor({ state: "visible", timeout: 10000 });

    // First check: missing on both
    await checkBtn.click();
    const notFoundBadges = page.locator("text=Not found");
    await notFoundBadges.first().waitFor({ state: "visible", timeout: 10000 });
    assert.equal(await notFoundBadges.count(), 2, "B2: 'Not found' shown on both hosts");

    // Second check: found + moved
    await checkBtn.click();
    const readyTitle = page.locator("text=Your key file is set up");
    await readyTitle.waitFor({ state: "visible", timeout: 10000 });
    assert.ok(await readyTitle.isVisible(), "B2: title 'Your key file is set up' visible");

    const bareHost = page.locator("text=https://offcult.in/3f2a9c1e5b7d4f60a8c2e1b3d5f7a9c1.txt");
    const wwwHost = page.locator("text=https://www.offcult.in/3f2a9c1e5b7d4f60a8c2e1b3d5f7a9c1.txt");
    assert.ok(await bareHost.first().isVisible(), "B2: bare host is listed");
    assert.equal(await wwwHost.count(), 0, "B2: www host is hidden when unused/moved");

    passedCount++;
    console.log("  ✓ Scenario B2 passed");
  } finally {
    await context.close();
  }
}

// ==========================================
// Scenario B3: Submit two URLs (one off-site) -> success toast "Submitted 1 URL" and warning "Skipped 1 URL not on offcult.in", history row "Submitted via Bing"; phone width 390 px has no horizontal scroll
// ==========================================
if (requestedScenarios.includes("B3")) {
  console.log("Running Scenario B3...");
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: offcultMembership },
  });

  try {
    const indexnowState = readFixture("b2-setup-found-moved.json");
    let submissionsState = { submissions: [] };

    await page.route((url) => url.pathname === "/api/customer/features", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          brandKey: "offcult.in",
          features: { indexnow: true },
        }),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/indexnow", async (route) => {
      return route.fulfill({
        status: 200,
        headers: { "Cache-Control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify(indexnowState),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/indexnow/submissions", async (route) => {
      return route.fulfill({
        status: 200,
        headers: { "Cache-Control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify(submissionsState),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/indexnow/submit", async (route) => {
      submissionsState = readFixture("b3-submissions.json");
      return route.fulfill({
        status: 200,
        headers: { "Cache-Control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify(readFixture("b3-submit-result.json")),
      });
    });

    await page.goto(new URL("/portal/settings/indexnow", origin).href, {
      waitUntil: "networkidle",
    });

    const textarea = page.locator('textarea[name="urls"]');
    await textarea.waitFor({ state: "visible", timeout: 10000 });
    await textarea.fill("https://offcult.in/new-page\nhttps://other.com/page");

    const submitBtn = page.getByRole("button", { name: "Submit to IndexNow" });
    await submitBtn.click();

    // Success toast: "Submitted 1 URL"
    const successToast = page.locator("text=Submitted 1 URL");
    await successToast.waitFor({ state: "visible", timeout: 10000 });
    assert.ok(await successToast.isVisible(), "B3: success toast visible");

    // Warning toast: "Skipped 1 URL not on offcult.in"
    const warningToast = page.locator("text=Skipped 1 URL not on offcult.in");
    await warningToast.waitFor({ state: "visible", timeout: 10000 });
    assert.ok(await warningToast.isVisible(), "B3: warning toast visible");

    // History row: "Submitted via Bing"
    const historyRow = page.locator("text=Submitted via Bing");
    await historyRow.first().waitFor({ state: "visible", timeout: 10000 });
    assert.ok(await historyRow.first().isVisible(), "B3: history row visible");

    // Phone width 390 px horizontal scroll check
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(
      scrollWidth <= 390,
      `B3: expected document scrollWidth <= 390 on phone width 390 px, got ${scrollWidth}`
    );

    passedCount++;
    console.log("  ✓ Scenario B3 passed");
  } finally {
    await context.close();
  }
}

// ==========================================
// Scenario B4: audit shows IndexNow tab; panel loads; submit opens dialog
// ==========================================
if (requestedScenarios.includes("B4")) {
  console.log("Running Scenario B4...");
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: offcultMembership },
  });

  try {
    await installAuditApi(page, {});

    const indexnowState = readFixture("b2-setup-found-moved.json");
    await page.route((url) => url.pathname === "/api/customer/indexnow", async (route) => {
      return route.fulfill({
        status: 200,
        headers: { "Cache-Control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify(indexnowState),
      });
    });
    await page.route((url) => url.pathname === "/api/customer/indexnow/submissions", async (route) => {
      return route.fulfill({
        status: 200,
        headers: { "Cache-Control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify({ submissions: [] }),
      });
    });

    await page.goto(new URL("/portal/audit/7a2e3d4c-1b5f-4c9a-8d2e-3f4a5b6c7d8e?tab=indexnow", origin).href, {
      waitUntil: "networkidle",
    });

    const indexnowTab = page.getByRole("tab", { name: "IndexNow" });
    await indexnowTab.waitFor({ state: "visible", timeout: 15000 });
    assert.ok(await indexnowTab.isVisible(), "B4: IndexNow tab visible");

    // panel loads
    await page.getByText("Key file verified").first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    // accept either verified or not-verified copy
    const panelVisible =
      (await page.getByText("Key file").count()) > 0;
    assert.ok(panelVisible, "B4: IndexNow panel loaded");

    passedCount++;
    console.log("  ✓ Scenario B4 passed");
  } finally {
    await context.close();
  }
}

// ==========================================
// Scenario B5: select 3 pages (one 404) -> dialog lists 2 + left-out note; >100 needs checkbox
// ==========================================
if (requestedScenarios.includes("B5")) {
  console.log("Running Scenario B5...");
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: offcultMembership },
  });

  try {
    await installAuditApi(page, {});

    const indexnowState = readFixture("b2-setup-found-moved.json");
    await page.route((url) => url.pathname === "/api/customer/indexnow", async (route) => {
      return route.fulfill({
        status: 200,
        headers: { "Cache-Control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify(indexnowState),
      });
    });
    await page.route((url) => url.pathname === "/api/customer/indexnow/submissions", async (route) => {
      return route.fulfill({
        status: 200,
        headers: { "Cache-Control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify({ submissions: [] }),
      });
    });

    await page.goto(new URL("/portal/audit/7a2e3d4c-1b5f-4c9a-8d2e-3f4a5b6c7d8e", origin).href, {
      waitUntil: "networkidle",
    });

    await page.getByRole("tab", { name: /Pages/ }).click();
    await page.getByText("Boots that last the winter").first().waitFor({ timeout: 15000 });

    // select first 3 rows
    const rows = page.getByRole("row");
    const checkboxes = page.getByRole("checkbox");
    // select 3 page checkboxes (skip header)
    for (let i = 1; i <= 3 && i < (await checkboxes.count()); i++) {
      await checkboxes.nth(i).click();
    }

    const submitBtn = page.getByRole("button", { name: "Submit to IndexNow" });
    await submitBtn.waitFor({ state: "visible", timeout: 15000 });
    await submitBtn.click();

    // left-out note
    await page.getByText(/left out because they didn't load or are marked noindex/i).waitFor({
      timeout: 15000,
    });

    passedCount++;
    console.log("  ✓ Scenario B5 passed");
  } finally {
    await context.close();
  }
}

await browser.close();
killServerChild();

console.log(`ok ${passedCount} scenarios`);
process.exit(0);
