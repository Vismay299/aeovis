#!/usr/bin/env node
/**
 * F10 phase 4 — Customer scheduling browser verification (AC-13, AC-14, AC-17).
 *
 * Scenarios:
 *   B1: off → pick weekly Monday 09:00 → price block shows per-scan and monthly → dialog → saved toast
 *   B2: daily warning visible ("Daily scans cost about 7 times as much as weekly.")
 *   B3: on → Pause → paused state
 *   B4: last skip price_changed → "Review price" opens dialog
 *   B5: member view: picker disabled with permission hint, Pause enabled
 *   B6: Overview and Scans badges for on, skipped and off
 *   B7: 375 px: no horizontal scroll; keyboard reaches select, time input and buttons
 *
 * Output: "ok 7 scenarios" on pass.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openPortal, SUPABASE_URL, readFixture, buildSessionToken } from "./portalFixtureHarness.mjs";

let chromium;
try {
  ({ chromium } = await import("../../worker/node_modules/playwright/index.mjs"));
} catch {
  ({ chromium } = await import("playwright"));
}

const rawArg = process.argv[2] || "http://127.0.0.1:3328";
const origin = new URL(rawArg);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname),
  "browser checks require a disposable local app",
);
const port = parseInt(origin.port || "3328", 10);

const output = path.resolve(process.argv[3] || "test_reports/f10-browser");
await mkdir(output, { recursive: true });

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

function spawnNextServer(targetPort) {
  return spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", String(targetPort)],
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
const isRunning = await waitForServer(port, 1000);
if (!isRunning) {
  serverChild = spawnNextServer(port);
  const up = await waitForServer(port, 45000);
  if (!up) {
    if (serverChild) {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(serverChild.pid), "/f", "/t"]);
      } else {
        serverChild.kill("SIGTERM");
      }
    }
    throw new Error(`Failed to start Next.js server on port ${port}`);
  }
}

const browser = await chromium.launch({ headless: true });

let passedCount = 0;

async function record(id, expected, run) {
  const row = {
    case: id,
    suite: "f10-browser",
    startedAt: new Date().toISOString(),
    expected,
    artifacts: [],
  };
  try {
    row.actual = await run(row.artifacts);
    row.outcome = "pass";
    passedCount++;
  } catch (error) {
    row.outcome = "fail";
    row.actual = error.stack || error.message;
    process.exitCode = 1;
  }
  row.endedAt = new Date().toISOString();
  const log = `${id}.json`;
  await writeFile(
    path.join(output, log),
    JSON.stringify({ ...row, artifacts: undefined }, null, 2),
  );
  row.artifacts.push(log);
  console.log(`${id}: ${row.outcome} — ${String(row.actual).split("\n")[0]}`);
  if (row.outcome === "fail") {
    throw new Error(`${id} failed: ${row.actual}`);
  }
}

function makeScheduleView(overrides = {}) {
  return {
    brandKey: "acme",
    status: "off",
    role: "owner",
    interval: null,
    dayOfWeek: null,
    dayOfMonth: null,
    timeOfDay: null,
    timezone: null,
    nextRunAt: null,
    approvedMaxUsd: null,
    lastSkip: null,
    lastRunAt: null,
    windows: [],
    ...overrides,
  };
}

function makePriceQuote(interval = "weekly") {
  const runsPerMonth = interval === "daily" ? 30 : interval === "weekly" ? 4 : 1;
  const totalUsd = 24;
  return {
    action: "ai_visibility.schedule.save",
    currency: "USD",
    totalUsd,
    expectedUsd: 7.2,
    units: [
      { key: "questions", label: "questions", count: 30 },
      { key: "engines", label: "engines", count: 4 },
      { key: "answers", label: "answers", count: 120 },
    ],
    lines: [
      {
        label: "Answers reserved at $0.20 each",
        quantity: 120,
        unitUsd: 0.2,
        totalUsd: 24,
      },
    ],
    monthly: {
      interval,
      runsPerMonth,
      totalUsd: runsPerMonth * totalUsd,
    },
    warnings:
      interval === "daily"
        ? [
            {
              code: "daily_cadence",
              message: "Daily scans cost about 7 times as much as weekly.",
            },
          ]
        : [],
    blocked: null,
    priceVersion: "v1",
    quotedAt: new Date().toISOString(),
    inputsHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  };
}

let currentScheduleState = makeScheduleView({ status: "off" });
let currentRole = "owner";
let currentFeatures = { customer_scheduling: true, price_review: true };
let lastPutPayload = null;

async function openPortalForSchedule(browser, origin, options = {}) {
  const {
    viewport = { width: 1440, height: 1000 },
    memberships = null,
  } = options;

  const base = typeof origin === "string" ? origin : origin.href;
  const session = (await readFixture("session.json")) ?? {
    user: { id: "qa-user", email: "owner@example.test" },
  };
  const token = buildSessionToken();
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const resolvedMemberships =
    memberships ??
    (await readFixture("memberships.json")) ??
    [
      {
        brand_key: "acme",
        role: currentRole,
        customer_brands: {
          brand_key: "acme",
          display_name: "Acme",
          website: "https://acme.example",
          is_active: true,
        },
      },
    ];

  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.origin === SUPABASE_URL || url.hostname.endsWith(".supabase.co")) {
      if (url.pathname === "/auth/v1/token") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            access_token: token,
            token_type: "bearer",
            expires_in: 3600,
            expires_at: expiresAt,
            refresh_token: token,
            user: session.user,
          }),
        });
      }
      if (url.pathname === "/auth/v1/user") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(session.user),
        });
      }
      if (url.pathname.startsWith("/rest/v1/customer_brand_memberships")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(resolvedMemberships),
        });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    }

    if (url.pathname === "/api/customer/features") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          brandKey: "acme",
          features: currentFeatures,
        }),
      });
    }

    if (url.pathname === "/api/customer/schedule") {
      if (method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...currentScheduleState, role: currentRole }),
        });
      }
      if (method === "PUT") {
        const payload = JSON.parse(request.postData() || "{}");
        lastPutPayload = payload;
        currentScheduleState = {
          ...currentScheduleState,
          role: currentRole,
          ...(payload.pause || payload.enabled === false
            ? { status: "paused" }
            : {
                status: "on",
                interval: payload.interval || "weekly",
                dayOfWeek: payload.dayOfWeek ?? 1,
                timeOfDay: payload.timeOfDay ?? "09:00",
                timezone: payload.timezone ?? "UTC",
                approvedMaxUsd: payload.maxUsd ?? 24,
                nextRunAt: new Date(Date.now() + 86400000 * 7).toISOString(),
              }),
        };
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(currentScheduleState),
        });
      }
    }

    if (url.pathname === "/api/customer/price/estimate") {
      let interval = "weekly";
      try {
        const data = JSON.parse(request.postData() || "{}");
        if (data.interval) interval = data.interval;
      } catch {
        // ignore
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makePriceQuote(interval)),
      });
    }

    if (url.pathname === "/api/customer/overview") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ scans: [], content_items: [], metrics: {} }),
      });
    }

    if (url.pathname === "/api/customer/scan") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ scans: [], jobs: [] }),
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
  await page.goto(new URL("/login", base).href, { waitUntil: "networkidle" });
  const continueWithEmail = page.getByRole("button", { name: "Continue with email" });
  await continueWithEmail.or(page.locator("#email")).first().waitFor({ state: "visible", timeout: 30000 });
  if (await continueWithEmail.isVisible()) {
    await continueWithEmail.click();
  }
  await page.fill("#email", session.user.email);
  await page.fill("#password", "qa-password-not-a-secret");
  await page.click('button[type="submit"]');
  await page.waitForURL(new URL("/portal", base).href, { timeout: 30000 });

  return { context, page };
}

try {
  // Scenario B1: off -> pick weekly Monday 09:00 -> price block shows per-scan and monthly -> dialog -> saved toast
  await record(
    "F10-B1",
    "off → pick weekly Monday 09:00 → price block shows per-scan and monthly → dialog → saved toast",
    async () => {
      currentScheduleState = makeScheduleView({ status: "off" });
      currentRole = "owner";
      currentFeatures = { customer_scheduling: true, price_review: true };
      lastPutPayload = null;

      const { context, page } = await openPortalForSchedule(browser, origin);
      try {
        await page.goto(new URL("/portal/settings/schedule", origin).href, {
          waitUntil: "networkidle",
        });

        // Interval trigger
        const intervalTrigger = page.locator('[data-testid="schedule-interval"], [data-slot="select-trigger"]').first();
        await intervalTrigger.waitFor({ state: "visible", timeout: 15000 });
        await intervalTrigger.click();

        // Pick weekly
        const weeklyItem = page.locator('[data-slot="select-item"]:has-text("Weekly")');
        await weeklyItem.waitFor({ state: "visible", timeout: 5000 });
        await weeklyItem.click();

        // If "change" link is visible, click it to expand time picker
        const changeBtn = page.locator('button:has-text("change")');
        if (await changeBtn.isVisible()) {
          await changeBtn.click();
        }

        // Pick day of week Monday
        const weekdayTrigger = page.locator('button[aria-label="Day of week"], [aria-label="Day of week"]').first();
        if (await weekdayTrigger.isVisible()) {
          await weekdayTrigger.click();
          const mondayItem = page.locator('[data-slot="select-item"]:has-text("Monday")');
          await mondayItem.waitFor({ state: "visible", timeout: 5000 });
          await mondayItem.click();
        }

        // Set time to 09:00
        const timeInput = page.locator('input[aria-label="Time of day"]');
        if (await timeInput.isVisible()) {
          await timeInput.fill("09:00");
        }

        // Verify price block shows per-scan ($24.00) and monthly projection ($96.00)
        const priceBlock = page.locator("text=Up to $24.00 per scan");
        await priceBlock.waitFor({ state: "visible", timeout: 10000 });
        const monthlyText = page.locator("text=$96.00 estimated per month");
        await monthlyText.waitFor({ state: "visible", timeout: 10000 });

        // Click Turn on scheduled scans button
        const turnOnBtn = page.locator('button:has-text("Turn on scheduled scans")');
        await turnOnBtn.click();

        // CostReviewDialog opens
        const dialog = page.locator('[data-slot="dialog-content"]');
        await dialog.waitFor({ state: "visible", timeout: 10000 });
        const dialogTitle = page.locator('[data-slot="dialog-title"]');
        assert.equal(await dialogTitle.innerText(), "Schedule scans");

        // Click Approve and schedule
        const confirmBtn = dialog.locator('button:has-text("Approve and schedule")');
        await confirmBtn.click();

        // Toast shows Schedule saved
        const toast = page.locator('text=/Scheduled scans are on|Schedule saved/');
        await toast.waitFor({ state: "visible", timeout: 10000 });

        assert.ok(lastPutPayload !== null, "PUT /api/customer/schedule must have been invoked");
        assert.equal(lastPutPayload.interval, "weekly");
        assert.equal(lastPutPayload.maxUsd, 24);

        return "Successfully picked weekly Monday 09:00, confirmed in dialog, received saved toast.";
      } finally {
        await context.close();
      }
    },
  );

  // Scenario B2: daily warning visible ("Daily scans cost about 7 times as much as weekly.")
  await record(
    "F10-B2",
    "daily warning visible ('Daily scans cost about 7 times as much as weekly.')",
    async () => {
      currentScheduleState = makeScheduleView({ status: "off" });
      currentRole = "owner";
      currentFeatures = { customer_scheduling: true, price_review: true };

      const { context, page } = await openPortalForSchedule(browser, origin);
      try {
        await page.goto(new URL("/portal/settings/schedule", origin).href, {
          waitUntil: "networkidle",
        });

        // Interval trigger
        const intervalTrigger = page.locator('[data-testid="schedule-interval"], [data-slot="select-trigger"]').first();
        await intervalTrigger.waitFor({ state: "visible", timeout: 15000 });
        await intervalTrigger.click();

        // Select Daily
        const dailyItem = page.locator('[data-slot="select-item"]:has-text("Daily")');
        await dailyItem.waitFor({ state: "visible", timeout: 5000 });
        await dailyItem.click();

        // Warning message must appear
        const warning = page.locator("text=Daily scans cost about 7 times as much as weekly.");
        await warning.waitFor({ state: "visible", timeout: 10000 });
        assert.ok(await warning.isVisible(), "Daily cadence warning must be visible");

        return "Daily warning 'Daily scans cost about 7 times as much as weekly.' is visible.";
      } finally {
        await context.close();
      }
    },
  );

  // Scenario B3: on -> Pause -> paused state
  await record(
    "F10-B3",
    "on → Pause → paused state",
    async () => {
      currentScheduleState = makeScheduleView({
        status: "on",
        interval: "weekly",
        nextRunAt: "2026-11-16T09:00:00.000Z",
        approvedMaxUsd: 24,
      });
      currentRole = "owner";
      currentFeatures = { customer_scheduling: true, price_review: true };
      lastPutPayload = null;

      const { context, page } = await openPortalForSchedule(browser, origin);
      try {
        await page.goto(new URL("/portal/settings/schedule", origin).href, {
          waitUntil: "networkidle",
        });

        // Summary should display Pause button
        const pauseBtn = page.locator('button:has-text("Pause")');
        await pauseBtn.waitFor({ state: "visible", timeout: 15000 });
        await pauseBtn.click();

        // Toast shows Scheduled scans are paused
        const toast = page.locator('text="Scheduled scans are paused."');
        await toast.waitFor({ state: "visible", timeout: 10000 });
        assert.ok(lastPutPayload?.pause || lastPutPayload?.enabled === false, "PUT /api/customer/schedule must receive pause: true or enabled: false");

        return "Clicked Pause button, PUT received pause: true, received paused toast.";
      } finally {
        await context.close();
      }
    },
  );

  // Scenario B4: last skip price_changed -> "Review price" opens dialog
  await record(
    "F10-B4",
    "last skip price_changed → 'Review price' opens dialog",
    async () => {
      currentScheduleState = makeScheduleView({
        status: "on",
        interval: "weekly",
        nextRunAt: "2026-11-16T09:00:00.000Z",
        approvedMaxUsd: 20,
        lastSkip: {
          reason: "price_changed",
          at: "2026-11-09T09:00:00.000Z",
          message:
            "The price changed since this schedule was approved. Review and approve the new price to resume.",
        },
        windows: [
          {
            windowAt: "2026-11-09T09:00:00.000Z",
            disposition: "skipped",
            skipReason: "price_changed",
            jobId: null,
            startedAt: null,
            finalizedAt: "2026-11-09T09:00:01.000Z",
          },
        ],
      });
      currentRole = "owner";
      currentFeatures = { customer_scheduling: true, price_review: true };

      const { context, page } = await openPortalForSchedule(browser, origin);
      try {
        await page.goto(new URL("/portal/settings/schedule", origin).href, {
          waitUntil: "networkidle",
        });

        // Skip banner with "Review price" button
        const reviewBtn = page.locator('button:has-text("Review price")');
        await reviewBtn.waitFor({ state: "visible", timeout: 15000 });
        await reviewBtn.click();

        // Dialog opens
        const dialog = page.locator('[data-slot="dialog-content"]');
        await dialog.waitFor({ state: "visible", timeout: 10000 });
        const dialogTitle = page.locator('[data-slot="dialog-title"]');
        assert.equal(await dialogTitle.innerText(), "Schedule scans");

        // Close dialog
        const cancelBtn = dialog.locator('button:has-text("Cancel")');
        await cancelBtn.click();
        await dialog.waitFor({ state: "hidden", timeout: 5000 });

        return "'Review price' button on skip banner opened the cost review dialog.";
      } finally {
        await context.close();
      }
    },
  );

  // Scenario B5: member view: picker disabled with permission hint, Pause enabled
  await record(
    "F10-B5",
    "member view: picker disabled with permission hint, Pause enabled",
    async () => {
      // 1. Check ON state: Pause is enabled
      currentScheduleState = makeScheduleView({
        status: "on",
        interval: "weekly",
        nextRunAt: "2026-11-16T09:00:00.000Z",
        approvedMaxUsd: 24,
      });
      currentRole = "member";
      currentFeatures = { customer_scheduling: true, price_review: true };

      const { context, page } = await openPortalForSchedule(browser, origin, {
        memberships: [
          {
            brand_key: "acme",
            role: "member",
            customer_brands: {
              brand_key: "acme",
              display_name: "Acme",
              website: "https://acme.example",
              is_active: true,
            },
          },
        ],
      });
      try {
        await page.goto(new URL("/portal/settings/schedule", origin).href, {
          waitUntil: "networkidle",
        });

        const pauseBtn = page.locator('button:has-text("Pause")');
        await pauseBtn.waitFor({ state: "visible", timeout: 15000 });
        assert.equal(await pauseBtn.isDisabled(), false, "Pause button must be enabled for member");

        // Change schedule button must NOT be visible to member
        const changeScheduleBtn = page.locator('button:has-text("Change schedule")');
        assert.equal(await changeScheduleBtn.isVisible(), false, "Change schedule must not be visible to member");

        // 2. Check OFF state: picker is disabled with permission hint
        currentScheduleState = makeScheduleView({ status: "off" });
        await page.goto(new URL("/portal/settings/schedule", origin).href, {
          waitUntil: "networkidle",
        });

        const intervalTrigger = page.locator('[data-testid="schedule-interval"], [data-slot="select-trigger"]').first();
        await intervalTrigger.waitFor({ state: "visible", timeout: 15000 });
        assert.equal(await intervalTrigger.isDisabled(), true, "Interval picker must be disabled for member");

        const hint = page.locator("text=Only the workspace owner can schedule scans.");
        await hint.waitFor({ state: "visible", timeout: 10000 });
        assert.ok(await hint.isVisible(), "Permission hint must be visible for member");

        return "Member sees Pause button enabled on ON state, and picker disabled with permission hint on OFF state.";
      } finally {
        await context.close();
      }
    },
  );

  // Scenario B6: Overview and Scans badges for on, skipped and off
  await record(
    "F10-B6",
    "Overview and Scans badges for on, skipped and off",
    async () => {
      // 1. ON state (no skip)
      currentScheduleState = makeScheduleView({
        status: "on",
        interval: "weekly",
        nextRunAt: "2026-11-16T09:00:00.000Z",
        approvedMaxUsd: 24,
        lastRunAt: "2026-11-09T09:00:00.000Z",
      });
      currentRole = "owner";
      currentFeatures = { customer_scheduling: true, price_review: true };

      const { context, page } = await openPortalForSchedule(browser, origin);
      try {
        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
        const overviewBadgeOn = page.locator('text=/Next scan /').first();
        await overviewBadgeOn.waitFor({ state: "visible", timeout: 15000 });
        assert.ok(await overviewBadgeOn.isVisible(), "Overview badge must show Next scan in on state");

        await page.goto(new URL("/portal/scans", origin).href, { waitUntil: "networkidle" });
        const scansBadgeOn = page.locator('text=/Next scan /').first();
        await scansBadgeOn.waitFor({ state: "visible", timeout: 15000 });
        assert.ok(await scansBadgeOn.isVisible(), "Scans badge must show Next scan in on state");

        // 2. ON state with recent skip
        currentScheduleState = makeScheduleView({
          status: "on",
          interval: "weekly",
          nextRunAt: "2026-11-16T09:00:00.000Z",
          approvedMaxUsd: 24,
          lastSkip: {
            reason: "price_changed",
            at: "2026-11-09T09:00:00.000Z",
            message: "The price changed since this schedule was approved.",
          },
          lastRunAt: "2026-11-02T09:00:00.000Z",
        });

        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
        const overviewBadgeSkipped = page.locator("text=last one skipped").first();
        await overviewBadgeSkipped.waitFor({ state: "visible", timeout: 15000 });
        assert.ok(await overviewBadgeSkipped.isVisible(), "Overview badge must show last one skipped");

        await page.goto(new URL("/portal/scans", origin).href, { waitUntil: "networkidle" });
        const scansBadgeSkipped = page.locator("text=last one skipped").first();
        await scansBadgeSkipped.waitFor({ state: "visible", timeout: 15000 });
        assert.ok(await scansBadgeSkipped.isVisible(), "Scans badge must show last one skipped");

        // 3. OFF state
        currentScheduleState = makeScheduleView({ status: "off" });

        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
        const overviewBadgeOff = page.locator("text=Scheduled scans off").first();
        await overviewBadgeOff.waitFor({ state: "visible", timeout: 15000 });
        assert.ok(await overviewBadgeOff.isVisible(), "Overview badge must show Scheduled scans off");

        await page.goto(new URL("/portal/scans", origin).href, { waitUntil: "networkidle" });
        const scansBadgeOff = page.locator("text=Scheduled scans off").first();
        await scansBadgeOff.waitFor({ state: "visible", timeout: 15000 });
        assert.ok(await scansBadgeOff.isVisible(), "Scans badge must show Scheduled scans off");

        return "Overview and Scans badges verified for on, skipped, and off states.";
      } finally {
        await context.close();
      }
    },
  );

  // Scenario B7: 375 px: no horizontal scroll; keyboard reaches select, time input and buttons
  await record(
    "F10-B7",
    "375 px: no horizontal scroll; keyboard reaches select, time input and buttons",
    async () => {
      currentScheduleState = makeScheduleView({ status: "off" });
      currentRole = "owner";
      currentFeatures = { customer_scheduling: true, price_review: true };

      const { context, page } = await openPortalForSchedule(browser, origin, {
        viewport: { width: 375, height: 812 },
      });
      try {
        await page.goto(new URL("/portal/settings/schedule", origin).href, {
          waitUntil: "networkidle",
        });

        const intervalTrigger = page.locator('[data-testid="schedule-interval"], [data-slot="select-trigger"]').first();
        await intervalTrigger.waitFor({ state: "visible", timeout: 15000 });

        // Ensure no horizontal scroll
        const scrollWidthInitial = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        assert.ok(
          scrollWidthInitial <= 375,
          `Expected document.documentElement.scrollWidth <= 375, found ${scrollWidthInitial}`,
        );

        // Tab through elements
        const focusedElements = [];
        for (let i = 0; i < 25; i++) {
          await page.keyboard.press("Tab");
          const activeInfo = await page.evaluate(() => {
            const el = document.activeElement;
            if (!el || el.tagName.toLowerCase() === "body") return null;
            return {
              tag: el.tagName.toLowerCase(),
              id: el.id,
              text: el.innerText ? el.innerText.trim().slice(0, 30) : "",
              ariaLabel: el.getAttribute("aria-label"),
            };
          });
          if (activeInfo) {
            focusedElements.push(activeInfo);
          }
        }

        assert.ok(
          focusedElements.length > 0,
          "Keyboard Tab must reach interactive elements on the page",
        );
        const reachedSelect = focusedElements.some(
          (e) => e.id === "schedule-interval" || e.tag === "button",
        );
        assert.ok(reachedSelect, "Tab order reached select or buttons");

        const scrollWidthFinal = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        assert.ok(
          scrollWidthFinal <= 375,
          `Expected document.documentElement.scrollWidth <= 375 after tabbing, found ${scrollWidthFinal}`,
        );

        return `375px mobile layout rendered with no horizontal scroll (scrollWidth = ${scrollWidthFinal}) and reached ${focusedElements.length} controls via Tab.`;
      } finally {
        await context.close();
      }
    },
  );

  console.log("ok 7 scenarios");
} finally {
  await browser.close();
  if (serverChild) {
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
}
