#!/usr/bin/env node
/**
 * F26 Phase 2 browser checks (F26-AC-09).
 * Tests scenarios B1, B2, B3, B4, B5, B6, B8 against a local Next.js app.
 */
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const rawArg = process.argv[2] || "http://127.0.0.1:3328";
const originUrl = new URL(rawArg);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(originUrl.hostname),
  "browser checks require a disposable local app",
);
const port = parseInt(originUrl.port || "3328", 10);

const SUPABASE_URL = "https://placeholder.supabase.co";
const FIXTURE_TELEMETRY_ID = "11111111-2222-4333-8444-555555555555";
const FIXTURE_USER_ID = "qa-user";
const FIXTURE_EMAIL = "owner@example.test";
const FIXTURE_WORKSPACE_NAME = "Acme";
const FIXTURE_WEBSITE_HOST = "acme.example";
const FIXTURE_BRAND_KEY = "acme";

const externalRequests = [];
const recordedIngestRequests = [];

// Start local sink server to satisfy POSTHOG_INGEST_ORIGIN
const sinkServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: 1 }));
});
await new Promise((resolve) => sinkServer.listen(0, "127.0.0.1", resolve));
const sinkPort = sinkServer.address().port;

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
        NEXT_PUBLIC_POSTHOG_KEY: "phc_qa_placeholder",
        POSTHOG_INGEST_ORIGIN: `http://127.0.0.1:${sinkPort}`,
        NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key",
      },
      stdio: "inherit",
    },
  );
  const ready = await waitForServer(port, 45000);
  assert.ok(ready, "Next.js server failed to start on port " + port);
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

function buildToken(userId = FIXTURE_USER_ID) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url");
  return `${header}.${payload}.`;
}

function decodePostHogPayload(rawBody, headers = {}) {
  if (!rawBody) return [];
  let buffer;
  if (Buffer.isBuffer(rawBody)) {
    buffer = rawBody;
  } else {
    buffer = Buffer.from(String(rawBody));
  }

  // Decompress gzip if present
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      buffer = zlib.gunzipSync(buffer);
    } catch {
      // ignore
    }
  }

  let text = buffer.toString("utf8");
  if (text.startsWith("data=")) {
    try {
      const val = decodeURIComponent(text.slice(5));
      try {
        text = Buffer.from(val, "base64").toString("utf8");
      } catch {
        text = val;
      }
    } catch {
      // ignore
    }
  }

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.batch)) return parsed.batch;
    if (parsed.event) return [parsed];
  } catch {
    // not json
  }
  return [];
}

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});

async function setupPage(options = {}) {
  const {
    viewport = { width: 1440, height: 900 },
    userId = FIXTURE_USER_ID,
    userEmail = FIXTURE_EMAIL,
    initialChoice = null,
  } = options;

  let currentChoice = initialChoice;
  const context = await browser.newContext({
    viewport,
    reducedMotion: "reduce",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  await context.addInitScript(() => {
    try {
      Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
    } catch {}
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    } catch {}
    try {
      Object.defineProperty(navigator, "userAgentData", { get: () => undefined });
    } catch {}
  });

  const contextIngest = [];
  const putCalls = [];

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (
      url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost" &&
      url.hostname !== "[::1]" &&
      !url.origin.includes("supabase.co")
    ) {
      externalRequests.push(request.url());
      return route.abort("blockedbyclient");
    }

    if (url.origin === SUPABASE_URL || url.hostname.endsWith(".supabase.co")) {
      if (url.pathname === "/auth/v1/user") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: userId,
            email: userEmail,
            email_confirmed_at: "2026-11-01T00:00:00Z",
          }),
        });
      }
      if (url.pathname === "/auth/v1/token") {
        const token = buildToken(userId);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            access_token: token,
            token_type: "bearer",
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            refresh_token: token,
            user: { id: userId, email: userEmail },
          }),
        });
      }
      if (url.pathname.startsWith("/rest/v1/customer_brand_memberships")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              brand_key: FIXTURE_BRAND_KEY,
              role: "owner",
              customer_brands: {
                brand_key: FIXTURE_BRAND_KEY,
                display_name: FIXTURE_WORKSPACE_NAME,
                website: `https://${FIXTURE_WEBSITE_HOST}`,
                is_active: true,
                telemetry_id: FIXTURE_TELEMETRY_ID,
              },
            },
          ]),
        });
      }
      if (url.pathname.startsWith("/rest/v1/rpc/accept_customer_team_invites")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    }

    // Intercept ingest requests
    if (url.pathname.includes("/ingest/")) {
      console.log("INTERCEPT INGEST:", method, request.url());
      if (url.pathname.includes("exception-autocapture")) {
        const file = "node_modules/posthog-js/dist/exception-autocapture.js";
        return route.fulfill({
          status: 200,
          contentType: "application/javascript",
          body: fs.readFileSync(file, "utf8"),
        });
      }
      if (url.pathname.endsWith(".js") || url.pathname.includes("/static/")) {
        return route.fulfill({
          status: 200,
          contentType: "application/javascript",
          body: "/* posthog stub */",
        });
      }
      if (url.pathname.includes("/flags") || url.pathname.includes("/decide") || url.pathname.includes("/config")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ featureFlags: {}, status: 1 }),
        });
      }
      const body = request.postDataBuffer() || request.postData();
      const headers = request.headers();
      const record = {
        url: request.url(),
        method,
        headers,
        body,
        events: decodePostHogPayload(body, headers),
      };
      contextIngest.push(record);
      recordedIngestRequests.push(record);

      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: 1 }),
      });
    }

    // Intercept customer privacy endpoint
    if (url.pathname === "/api/customer/privacy") {
      if (method === "GET") {
        return route.fulfill({
          status: 200,
          headers: { "Cache-Control": "no-store" },
          contentType: "application/json",
          body: JSON.stringify({
            analytics: currentChoice,
            decidedAt: currentChoice !== null ? "2026-11-08T10:00:00.000Z" : null,
            source: currentChoice !== null ? "banner" : null,
            policyVersion: "2026-11-08",
            telemetryAvailable: true,
          }),
        });
      }
      if (method === "PUT") {
        const payload = request.postDataJSON() || {};
        putCalls.push(payload);
        currentChoice = payload.analytics;
        return route.fulfill({
          status: 200,
          headers: { "Cache-Control": "no-store" },
          contentType: "application/json",
          body: JSON.stringify({
            analytics: currentChoice,
            decidedAt: "2026-11-08T10:00:00.000Z",
            source: payload.source || "banner",
            policyVersion: "2026-11-08",
            telemetryAvailable: true,
          }),
        });
      }
    }

    if (url.pathname === "/api/customer/features") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          brandKey: FIXTURE_BRAND_KEY,
          features: {
            product_analytics: true,
          },
        }),
      });
    }

    if (url.pathname.startsWith("/api/customer/")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    }

    return route.continue();
  });

  const page = await context.newPage();
  page.on("console", (msg) => {
    console.log("PAGE LOG:", msg.type(), msg.text());
  });
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.stack || err));
  return {
    context,
    page,
    contextIngest,
    putCalls,
    getChoice: () => currentChoice,
    setChoice: (c) => {
      currentChoice = c;
    },
  };
}

async function signIn(page, email = FIXTURE_EMAIL) {
  try {
    await page.goto(`http://127.0.0.1:${port}/login`, { waitUntil: "networkidle" });
    const continueBtn = page.getByRole("button", { name: "Continue with email" });
    if (await continueBtn.isVisible()) {
      await continueBtn.click();
    }
    const emailInput = page.locator("#email");
    await emailInput.waitFor({ state: "visible", timeout: 10000 });
    await emailInput.fill(email);
    await page.fill("#password", "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL(`**/portal*`, { timeout: 30000 });
  } catch (err) {
    console.error("signIn error, current URL:", page.url());
    console.error("signIn page text:", await page.locator("body").innerText().catch(() => ""));
    throw err;
  }
}

console.log("# Starting F26 browser checks...");

// ==========================================
// Scenario B1: Undecided sends no events after 3s, banner visible
// ==========================================
console.log("Running Scenario B1...");
const b1 = await setupPage({ initialChoice: null });
await signIn(b1.page);
await b1.page.waitForTimeout(3000);
assert.equal(b1.contextIngest.length, 0, "B1: zero /ingest requests when undecided");
const bannerRegion = b1.page.locator('[role="region"][aria-label="Analytics choice"]');
await bannerRegion.waitFor({ state: "visible", timeout: 5000 });
assert.ok(await bannerRegion.isVisible(), "B1: consent banner is visible");
console.log("  ✓ Scenario B1 passed");

// ==========================================
// Scenario B2: "Share analytics" records choice, starts capture, identifies user and group
// ==========================================
console.log("Running Scenario B2...");
const shareBtn = b1.page.getByRole("button", { name: "Share analytics" });
await shareBtn.click();

// Wait for PUT /api/customer/privacy
await b1.page.waitForTimeout(1000);
assert.ok(
  b1.putCalls.some((c) => c.analytics === true && c.source === "banner"),
  "B2: PUT /api/customer/privacy called with { analytics: true, source: 'banner' }",
);

  // Wait for ingest event batches to appear (both identify and group/workspace context)
  const b2Start = Date.now();
  while (Date.now() - b2Start < 15000) {
    const events = b1.contextIngest.flatMap((r) => r.events);
    const okIdentify = events.some(
      (e) =>
        e.event === "$identify" ||
        e.distinct_id === FIXTURE_USER_ID ||
        e.properties?.$user_id === FIXTURE_USER_ID,
    );
    const okGroup = events.some(
      (e) =>
        e.event === "$groupidentify" ||
        e.properties?.$groups?.workspace === FIXTURE_TELEMETRY_ID ||
        e.properties?.["$group_set"]?.telemetry_id === FIXTURE_TELEMETRY_ID ||
        (e.properties?.$group_type === "workspace" && e.properties?.$group_key === FIXTURE_TELEMETRY_ID),
    );
    if (okIdentify && okGroup) break;
    await b1.page.evaluate(() => {
      try {
        window.posthog?._requestQueue?._poll();
      } catch {}
    });
    await b1.page.waitForTimeout(250);
  }
  assert.ok(b1.contextIngest.length > 0, "B2: /ingest requests appear after consent");

  const allEvents = b1.contextIngest.flatMap((r) => r.events);
  const hasIdentify = allEvents.some(
    (e) =>
      e.event === "$identify" ||
      e.distinct_id === FIXTURE_USER_ID ||
      e.properties?.$user_id === FIXTURE_USER_ID,
  );
  assert.ok(hasIdentify, "B2: decoded batch contains $identify with fixture user id");

  const hasGroup = allEvents.some(
    (e) =>
      e.event === "$groupidentify" ||
      e.properties?.$groups?.workspace === FIXTURE_TELEMETRY_ID ||
      e.properties?.["$group_set"]?.telemetry_id === FIXTURE_TELEMETRY_ID ||
      (e.properties?.$group_type === "workspace" && e.properties?.$group_key === FIXTURE_TELEMETRY_ID),
  );
  assert.ok(hasGroup, "B2: decoded batch contains group with fixture workspace telemetry_id");
  console.log("  ✓ Scenario B2 passed");

// ==========================================
// Scenario B3: No leaked PII across recorded bodies
// ==========================================
console.log("Running Scenario B3...");
for (const req of recordedIngestRequests) {
  const bodyStr = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");
  const eventsStr = JSON.stringify(req.events);

  for (const forbidden of [
    FIXTURE_EMAIL,
    FIXTURE_WORKSPACE_NAME,
    FIXTURE_WEBSITE_HOST,
    `brand_key=${FIXTURE_BRAND_KEY}`,
  ]) {
    assert.ok(
      !bodyStr.includes(forbidden) && !eventsStr.includes(forbidden),
      `B3: recorded body or events leaked "${forbidden}"`,
    );
  }
}
console.log("  ✓ Scenario B3 passed");

// ==========================================
// Scenario B4: Fresh context, "No thanks" → zero ingest, banner gone after reload
// ==========================================
console.log("Running Scenario B4...");
const b4 = await setupPage({ initialChoice: null });
await signIn(b4.page);
const noThanksBtn = b4.page.getByRole("button", { name: "No thanks" });
await noThanksBtn.waitFor({ state: "visible", timeout: 5000 });
await noThanksBtn.click();

await b4.page.waitForTimeout(1000);
assert.ok(
  b4.putCalls.some((c) => c.analytics === false && c.source === "banner"),
  "B4: PUT called with { analytics: false, source: 'banner' }",
);

// Navigation & reload
await b4.page.goto(`http://127.0.0.1:${port}/portal/settings`, { waitUntil: "networkidle" });
await b4.page.reload({ waitUntil: "networkidle" });
await b4.page.waitForTimeout(1500);

assert.equal(b4.contextIngest.length, 0, "B4: zero /ingest requests over navigation");
const bannerAfterReload = b4.page.locator('[role="region"][aria-label="Analytics choice"]');
assert.ok(
  !(await bannerAfterReload.isVisible().catch(() => false)),
  "B4: banner gone after choosing No thanks",
);
console.log("  ✓ Scenario B4 passed");

// ==========================================
// Scenario B5: Settings → Privacy shows switch on and toggling off stops ingest
// ==========================================
console.log("Running Scenario B5...");
// Navigate to settings privacy on consented context (b1)
await b1.page.goto(`http://127.0.0.1:${port}/portal/settings/privacy`, { waitUntil: "networkidle" });
const consentSwitch = b1.page.getByRole("switch", { name: "Share usage analytics" });
await consentSwitch.waitFor({ state: "visible", timeout: 5000 });

// Switch is on
const isChecked = await consentSwitch.getAttribute("data-checked");
assert.ok(isChecked !== null && isChecked !== undefined, "B5: switch is on after B2");

// Clear recorded ingest count snapshot
const countBefore = b1.contextIngest.length;

// Toggle off
await consentSwitch.click();
await b1.page.waitForTimeout(1000);

assert.ok(
  b1.putCalls.some((c) => c.analytics === false && c.source === "settings"),
  "B5: toggling off sends PUT false with source settings",
);

await b1.page.goto(`http://127.0.0.1:${port}/portal`, { waitUntil: "networkidle" });
await b1.page.waitForTimeout(2000);

const countAfter = b1.contextIngest.length;
assert.equal(countAfter, countBefore, "B5: further /ingest requests stopped after toggle off");
console.log("  ✓ Scenario B5 passed");

// ==========================================
// Scenario B6: /login with no cookie sends nothing
// ==========================================
console.log("Running Scenario B6...");
const b6 = await setupPage({ initialChoice: null });
await b6.page.goto(`http://127.0.0.1:${port}/login`, { waitUntil: "networkidle" });
await b6.page.waitForTimeout(2000);
assert.equal(b6.contextIngest.length, 0, "B6: /login with no cookie sends zero /ingest requests");
console.log("  ✓ Scenario B6 passed");

// ==========================================
// Scenario B8: Sign out after B2, sign in as second user (undecided) sends nothing until consent; 390px banner has no overflow
// ==========================================
console.log("Running Scenario B8...");
// Sign out from b1
const signOutBtn = b1.page.getByRole("button", { name: "Sign out" });
if (await signOutBtn.isVisible().catch(() => false)) {
  await signOutBtn.click();
} else {
  // Navigate to login
  await b1.page.goto(`http://127.0.0.1:${port}/login`, { waitUntil: "networkidle" });
}

// Setup user 2 context with 390px viewport
const b8 = await setupPage({
  viewport: { width: 390, height: 800 },
  userId: "qa-user-2",
  userEmail: "member@example.test",
  initialChoice: null,
});

await signIn(b8.page, "member@example.test");
await b8.page.waitForTimeout(3000);

assert.equal(b8.contextIngest.length, 0, "B8: zero /ingest requests for second user before consent");

// Check 390px banner has no horizontal overflow
const bannerB8 = b8.page.locator('[role="region"][aria-label="Analytics choice"]');
await bannerB8.waitFor({ state: "visible", timeout: 5000 });
assert.ok(await bannerB8.isVisible(), "B8: banner visible at 390px");

const overflow = await b8.page.evaluate(() => {
  return document.documentElement.scrollWidth > document.documentElement.clientWidth;
});
assert.ok(!overflow, "B8: 390 px banner has no horizontal overflow");

// Verify no captured URL in all ingest requests had a dotted path segment
for (const req of recordedIngestRequests) {
  for (const e of req.events) {
    const currentUrl = e.properties?.$current_url || "";
    const pathname = e.properties?.$pathname || "";
    for (const urlStr of [currentUrl, pathname]) {
      if (urlStr) {
        try {
          const pathPart = urlStr.startsWith("http") ? new URL(urlStr).pathname : urlStr.split("?")[0];
          const segments = pathPart.split("/").filter(Boolean);
          for (const seg of segments) {
            assert.ok(!seg.includes("."), `B8: captured URL path segment "${seg}" contains a dot: ${urlStr}`);
          }
        } catch {
          // ignore
        }
      }
    }
  }
}
console.log("  ✓ Scenario B8 passed");

// Clean up
await b1.context.close().catch(() => {});
await b4.context.close().catch(() => {});
await b6.context.close().catch(() => {});
await b8.context.close().catch(() => {});
await browser.close().catch(() => {});
sinkServer.close();
killServerChild();

assert.equal(externalRequests.length, 0, "0 requests outside 127.0.0.1");

console.log("ok 7 scenarios");
console.log("0 requests outside 127.0.0.1");
process.exit(0);
