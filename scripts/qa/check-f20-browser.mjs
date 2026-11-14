#!/usr/bin/env node
/**
 * F20 Phase 5 browser verification (F20-AC-23, F20-AC-24).
 *
 * Scenarios (all fixture APIs, intercepted Connect, no live Google calls):
 *   B01 not configured -> "Google Analytics isn't set up on this deployment yet."
 *   B02 owner not connected -> "Connect" posts /connect and navigates to the returned URL (intercepted)
 *   B03 ?ga4_error=scope_not_granted copy
 *   B04 picker save -> connected state
 *   B05 connector left -> warning + Reconnect
 *   B06 overview metrics and change colours, "—" for null
 *   B07 limited-data notice
 *   B08 opportunities footer coverage and engagement-fallback note
 *   B09 Search Console not connected empty state
 *   B10 quota 429 copy without Retry
 *   B11 tab switch keeps URL ?tab=
 *   B12 375 px without horizontal page scroll on settings and analytics
 *
 * Output: "F20 browser: 12/12 passed" on pass.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { openPortal, SUPABASE_URL } from "./portalFixtureHarness.mjs";

let chromium;
try {
  ({ chromium } = await import("../../worker/node_modules/playwright/index.mjs"));
} catch {
  ({ chromium } = await import("playwright"));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, "../../tests/fixtures/f20/api");

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

const originArg =
  process.argv[2] && !process.argv[2].startsWith("--")
    ? process.argv[2]
    : "http://127.0.0.1:3328";
const origin = new URL(originArg);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname),
  "browser checks require a disposable local app",
);
const port = Number(origin.port || 3328);

const onlyFlag = process.argv.find((a) => a === "--only" || a.startsWith("--only="));
let requested = null;
if (onlyFlag) {
  if (onlyFlag.includes("=")) {
    requested = onlyFlag.split("=").slice(1).join("=").split(",").map((s) => s.trim());
  } else {
    const idx = process.argv.indexOf("--only");
    requested = (process.argv[idx + 1] || "").split(",").map((s) => s.trim());
  }
}
const selected = (id) => !requested || requested.includes(id);

async function waitForServer(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(new URL("/robots.txt", origin), { redirect: "manual" });
      if (response.status !== 404 && response.status !== 503) return true;
    } catch {
      // wait
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

let serverChild = null;
if (!(await waitForServer(1500))) {
  serverChild = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "-p", String(port)],
    {
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key",
      },
      stdio: "ignore",
    },
  );
  if (!(await waitForServer(90000))) {
    serverChild.kill("SIGTERM");
    throw new Error(`Next.js dev server failed to start on port ${port}`);
  }
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
process.on("uncaughtException", (error) => {
  killServerChild();
  console.error(error);
  process.exit(1);
});

const browser = await chromium.launch({ headless: true });

const ownerMemberships = [
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

const jsonResponse = (route, body, status = 200, headers = {}) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store", ...headers },
    body: JSON.stringify(body),
  });

const REPORT_FIXTURES = {
  landing_pages: "landing-pages.json",
  page_performance: "page-performance.json",
  key_events: "key-events.json",
  traffic_acquisition: "traffic-acquisition.json",
  ecommerce_performance: "ecommerce.json",
  site_search: "site-search.json",
  audience_breakdown: "audience.json",
};

/**
 * Stubs the portal's fixture APIs for one scenario. Later registrations win
 * over the harness catch-all, so these override the defaults.
 */
async function installGa4(page, options = {}) {
  const {
    status = "status-connected.json",
    overview = "overview.json",
    overviewStatus = 200,
    opportunities = "opportunities.json",
    opportunitiesStatus = 200,
    reports = REPORT_FIXTURES,
    health = "health.json",
  } = options;

  await page.route(
    (url) => url.pathname === "/api/customer/features",
    (route) => jsonResponse(route, { brandKey: "offcult.in", features: { ga4: true } }),
  );
  await page.route(
    (url) => url.pathname === "/api/customer/ga4",
    (route) => jsonResponse(route, readFixture(status)),
  );
  await page.route(
    (url) => url.pathname === "/api/customer/ga4/accounts",
    (route) => jsonResponse(route, { accounts: [] }),
  );
  await page.route(
    (url) => url.pathname === "/api/customer/ga4/overview",
    (route) => {
      if (overviewStatus !== 200) {
        return jsonResponse(
          route,
          readFixture(overview),
          overviewStatus,
          overviewStatus === 429 ? { "Retry-After": "120" } : {},
        );
      }
      return jsonResponse(route, readFixture(overview));
    },
  );
  await page.route(
    (url) => url.pathname === "/api/customer/ga4/opportunities",
    (route) => jsonResponse(route, readFixture(opportunities), opportunitiesStatus),
  );
  await page.route(
    (url) => url.pathname === "/api/customer/ga4/health",
    (route) => jsonResponse(route, readFixture(health)),
  );
  await page.route(
    (url) => url.pathname.startsWith("/api/customer/ga4/reports/"),
    (route) => {
      const kind = new URL(route.request().url()).pathname.split("/").pop();
      const name = reports[kind];
      if (!name) {
        return jsonResponse(
          route,
          { error: "Unknown report kind.", code: "invalid_request" },
          404,
        );
      }
      return jsonResponse(route, readFixture(name));
    },
  );
  await page.route(
    (url) => url.pathname === "/api/customer/ga4/properties",
    (route) => jsonResponse(route, readFixture("properties.json")),
  );
}

let passed = 0;
let failed = 0;

async function record(id, label, run) {
  if (!selected(id)) return;
  try {
    await run();
    passed += 1;
    console.log(`${id}: PASS — ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`${id}: FAIL — ${error?.stack || error}`);
  }
}

// B01: not configured.
await record("B01", "not configured", async () => {
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: ownerMemberships },
  });
  try {
    await installGa4(page, { status: "status-not-configured.json" });
    await page.goto(new URL("/portal/settings/integrations", origin).href, {
      waitUntil: "networkidle",
    });
    const text = page.getByText("Google Analytics isn't set up on this deployment yet.");
    await text.waitFor({ timeout: 30000 });
    assert.ok(await text.isVisible());
  } finally {
    await context.close();
  }
});

// B02: owner not connected -> Connect posts /connect and navigates to the returned URL.
await record("B02", "connect posts and navigates", async () => {
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: ownerMemberships },
  });
  try {
    await installGa4(page, { status: "status-disconnected-owner.json" });
    let connectBody = null;
    await page.route(
      (url) => url.pathname === "/api/customer/ga4/connect",
      async (route) => {
        assert.equal(route.request().method(), "POST");
        connectBody = JSON.parse(route.request().postData() || "{}");
        return jsonResponse(route, readFixture("connect.json"));
      },
    );
    await page.route("https://accounts.google.com/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<html><body>google consent mock</body></html>",
      }),
    );
    await page.goto(new URL("/portal/settings/integrations", origin).href, {
      waitUntil: "networkidle",
    });
    const connect = page.getByRole("button", { name: "Connect" });
    await connect.waitFor({ timeout: 30000 });
    await connect.click();
    await page.waitForURL(/accounts\.google\.com/, { timeout: 30000 });
    assert.equal(connectBody?.brand_key, "offcult.in");
    assert.equal(connectBody?.returnTo, "/portal/settings/integrations");
  } finally {
    await context.close();
  }
});

// B03: ?ga4_error=scope_not_granted copy.
await record("B03", "link error copy", async () => {
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: ownerMemberships },
  });
  try {
    await installGa4(page, { status: "status-disconnected-owner.json" });
    await page.goto(
      new URL("/portal/settings/integrations?ga4_error=scope_not_granted", origin).href,
      { waitUntil: "networkidle" },
    );
    const title = page.getByText("Google Analytics connection is missing a permission");
    await title.waitFor({ timeout: 30000 });
    assert.ok(await title.isVisible());
    const description = page.getByText(
      "Perceev didn't get access to your Analytics data because a box on Google's permission screen wasn't ticked. Try again and tick every box.",
    );
    assert.ok(await description.isVisible());
  } finally {
    await context.close();
  }
});

// B04: picker save -> connected state.
await record("B04", "picker save connects", async () => {
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: ownerMemberships },
  });
  try {
    let saved = false;
    await installGa4(page, { status: "status-grant-not-connected.json" });
    await page.route(
      (url) => url.pathname === "/api/customer/ga4",
      (route) => jsonResponse(route, readFixture(saved ? "status-connected.json" : "status-grant-not-connected.json")),
    );
    let saveBody = null;
    await page.route(
      (url) => url.pathname === "/api/customer/ga4/property",
      async (route) => {
        assert.equal(route.request().method(), "POST");
        saveBody = JSON.parse(route.request().postData() || "{}");
        saved = true;
        return jsonResponse(route, readFixture("status-connected.json"), 201);
      },
    );
    await page.goto(new URL("/portal/settings/integrations", origin).href, {
      waitUntil: "networkidle",
    });
    const choose = page.getByRole("button", { name: "Choose property" });
    await choose.waitFor({ timeout: 30000 });
    await choose.click();
    const property = page.getByRole("button", { name: /Offcult India/ });
    await property.first().waitFor({ timeout: 30000 });
    await property.first().click();
    const save = page.getByRole("button", { name: "Save property" });
    assert.ok(await save.isEnabled());
    await save.click();
    const connectedId = page.getByText("ID 123456789");
    await connectedId.waitFor({ timeout: 30000 });
    assert.ok(await connectedId.isVisible());
    assert.equal(saveBody?.propertyId, "properties/123456789");
  } finally {
    await context.close();
  }
});

// B05: connector left -> warning + Reconnect.
await record("B05", "connector left", async () => {
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: ownerMemberships },
  });
  try {
    await installGa4(page, { status: "status-connector-left.json" });
    await page.goto(new URL("/portal/settings/integrations", origin).href, {
      waitUntil: "networkidle",
    });
    const warning = page.getByText(
      "The person who connected Google Analytics is no longer in this workspace. Reconnect it to keep seeing data.",
    );
    await warning.waitFor({ timeout: 30000 });
    assert.ok(await warning.isVisible());
    const reconnect = page.getByRole("button", { name: "Reconnect" });
    assert.ok(await reconnect.first().isVisible());
  } finally {
    await context.close();
  }
});

// B06: overview metrics and change colours, "—" for null.
await record("B06", "overview metrics", async () => {
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: ownerMemberships },
  });
  try {
    await installGa4(page, {});
    await page.goto(new URL("/portal/analytics", origin).href, {
      waitUntil: "networkidle",
    });
    const heading = page.getByText("Organic search traffic");
    await heading.first().waitFor({ timeout: 30000 });
    const sessions = page.getByText("4,210");
    await sessions.first().waitFor({ timeout: 30000 });
    assert.ok(await sessions.first().isVisible());
    const increase = page.locator("span.text-emerald-600").first();
    assert.ok(await increase.isVisible());
    const changeText = await increase.textContent();
    assert.match(changeText || "", /\+[\d.]+%/);
    const nullCell = page.getByText("—", { exact: true }).first();
    assert.ok(await nullCell.isVisible());
    const sub = page.getByText(/Google Analytics · 2026-09-24 – 2026-10-21 vs the previous 28 days/);
    assert.ok(await sub.isVisible());
  } finally {
    await context.close();
  }
});

// B07: limited-data notice.
await record("B07", "limited data", async () => {
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: ownerMemberships },
  });
  try {
    await installGa4(page, { overview: "overview-limited.json" });
    await page.goto(new URL("/portal/analytics", origin).href, {
      waitUntil: "networkidle",
    });
    const notice = page.getByText(
      /Google Analytics limited this report \(sampling, thresholding or an “\(other\)” row\), so numbers may be lower than in Analytics\./,
    );
    await notice.first().waitFor({ timeout: 30000 });
    assert.ok(await notice.first().isVisible());
    const note = page.getByText("Days without data from Google Analytics are left blank.");
    assert.ok(await note.isVisible());
  } finally {
    await context.close();
  }
});

// B08: opportunities footer coverage and engagement-fallback note.
await record("B08", "opportunities footer", async () => {
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: ownerMemberships },
  });
  try {
    await installGa4(page, {});
    await page.goto(new URL("/portal/analytics", origin).href, {
      waitUntil: "networkidle",
    });
    const footer = page.getByText("1 of 2 pages ranking 4–20 matched an Analytics landing page.");
    await footer.waitFor({ timeout: 30000 });
    assert.ok(await footer.isVisible());
    const fallback = page.getByText(
      "None of these pages recorded key events, so business value uses engagement rate.",
    );
    assert.ok(await fallback.isVisible());
    const intro = page.getByText(
      /Pages ranking 4–20 on Google, scored by search demand \(50%\), business value \(30%\)/,
    );
    assert.ok(await intro.isVisible());
  } finally {
    await context.close();
  }
});

// B09: Search Console not connected empty state.
await record("B09", "gsc not connected", async () => {
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: ownerMemberships },
  });
  try {
    await installGa4(page, { opportunities: "opportunities-gsc-not-connected.json", opportunitiesStatus: 409 });
    await page.goto(new URL("/portal/analytics", origin).href, {
      waitUntil: "networkidle",
    });
    const empty = page.getByText("Connect Search Console to see search opportunities.");
    await empty.waitFor({ timeout: 30000 });
    assert.ok(await empty.isVisible());
    const link = page.getByRole("link", { name: "Open Search Console" });
    assert.equal(await link.getAttribute("href"), "/portal/search-console");
  } finally {
    await context.close();
  }
});

// B10: quota 429 copy without Retry.
await record("B10", "quota without retry", async () => {
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: ownerMemberships },
  });
  try {
    await installGa4(page, { overview: "quota-429.json", overviewStatus: 429 });
    await page.goto(new URL("/portal/analytics", origin).href, {
      waitUntil: "networkidle",
    });
    const quota = page.getByText(
      "Google Analytics' reporting quota for this property is used up. Try again in about 2 minutes.",
    );
    await quota.waitFor({ timeout: 30000 });
    assert.ok(await quota.isVisible());
    assert.equal(await page.getByRole("button", { name: "Retry" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0);
  } finally {
    await context.close();
  }
});

// B11: tab switch keeps URL ?tab=.
await record("B11", "tab url state", async () => {
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: ownerMemberships },
  });
  try {
    await installGa4(page, {});
    await page.goto(new URL("/portal/analytics", origin).href, {
      waitUntil: "networkidle",
    });
    const landing = page.getByRole("tab", { name: "Landing pages" });
    await landing.waitFor({ timeout: 30000 });
    await landing.click();
    await page.waitForURL(/tab=landing_pages/, { timeout: 15000 });
    assert.match(page.url(), /tab=landing_pages/);
    const keyEvents = page.getByRole("tab", { name: "Key events" });
    await keyEvents.click();
    await page.waitForURL(/tab=key_events/, { timeout: 15000 });
    assert.match(page.url(), /tab=key_events/);
  } finally {
    await context.close();
  }
});

// B12: 375 px without horizontal page scroll on settings and analytics.
await record("B12", "phone width", async () => {
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 375, height: 844 },
    fixtures: { memberships: ownerMemberships },
  });
  try {
    await installGa4(page, {});
    await page.goto(new URL("/portal/settings/integrations", origin).href, {
      waitUntil: "networkidle",
    });
    await page.getByText("Google Analytics").first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(500);
    let scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(scrollWidth <= 375, `settings scrollWidth ${scrollWidth} > 375`);

    await page.goto(new URL("/portal/analytics", origin).href, {
      waitUntil: "networkidle",
    });
    await page.getByText("Organic search traffic").first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(500);
    scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(scrollWidth <= 375, `analytics scrollWidth ${scrollWidth} > 375`);
  } finally {
    await context.close();
  }
});

await browser.close();
killServerChild();

const total = 12;
if (failed > 0) {
  console.error(`F20 browser: ${passed}/${total} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`F20 browser: ${total}/${total} passed`);
process.exit(0);
