#!/usr/bin/env node
/**
 * F09 phase 3 — cost review dialog browser verification (AC-14, AC-15).
 *
 * Exercises the generic cost review dialog, quote loading/refreshing states,
 * blocked quotes (panel_not_approved), confirmation with approved maximum,
 * the 409 price_changed flow, Escape protection during start, and phone layout
 * against the local app with route interception.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { openPortal, readFixture } from "./portalFixtureHarness.mjs";

let chromium;
try {
  ({ chromium } = await import("../../worker/node_modules/playwright/index.mjs"));
} catch {
  ({ chromium } = await import("playwright"));
}

const origin = new URL(process.argv[2] || "http://127.0.0.1:3328");
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname),
  "browser checks require a disposable local app",
);
const output = path.resolve(process.argv[3] || "test_reports/f09-browser");
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });

async function record(id, expected, run) {
  const row = {
    case: id,
    suite: "f09-browser",
    startedAt: new Date().toISOString(),
    expected,
    artifacts: [],
  };
  try {
    row.actual = await run(row.artifacts);
    row.outcome = "pass";
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
}

const validQuote = {
  action: "ai_visibility.scan.run",
  currency: "USD",
  totalUsd: 24,
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
    interval: "weekly",
    runsPerMonth: 4,
    totalUsd: 96,
  },
  warnings: [
    {
      code: "retry_note",
      message:
        "Each question is asked once per engine. A failed answer may be retried within this amount.",
    },
    {
      code: "typical_cost",
      message: "Typical cost for this scan is about $7.20, based on recent answers.",
    },
  ],
  blocked: null,
  priceVersion: "v1",
  quotedAt: "2026-11-08T12:00:00.000Z",
  inputsHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

const blockedQuote = {
  action: "ai_visibility.scan.run",
  currency: "USD",
  totalUsd: 0,
  expectedUsd: null,
  units: [],
  lines: [],
  monthly: null,
  warnings: [],
  blocked: {
    code: "panel_not_approved",
    message:
      "Scans ask the questions in your approved question panel. Review and approve it first.",
    recovery: "Open Questions & evidence to approve the panel.",
  },
  priceVersion: "v1",
  quotedAt: "2026-11-08T12:00:00.000Z",
  inputsHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

const priceChangedQuote = {
  action: "ai_visibility.scan.run",
  currency: "USD",
  totalUsd: 28.5,
  expectedUsd: 8.0,
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
      totalUsd: 28.5,
    },
  ],
  monthly: null,
  warnings: [],
  blocked: null,
  priceVersion: "v1",
  quotedAt: "2026-11-08T12:05:00.000Z",
  inputsHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

async function setupPage(page, { quoteData = validQuote, flagOn = true } = {}) {
  await page.route("**/api/customer/features*", async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        brandKey: "acme",
        features: { price_review: flagOn },
      }),
    });
  });

  await page.route("**/api/customer/price/estimate*", async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(quoteData),
    });
  });
}

try {
  await record(
    "F09-B01",
    "Clicking Run scan from entry points opens the cost review dialog with title 'Run scan'.",
    async () => {
      const { context, page } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        await setupPage(page);

        // 1. Overview header action
        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
        const overviewBtn = page.locator('button:has-text("Run scan")').first();
        await overviewBtn.click();
        const dialog = page.locator('[data-slot="dialog-content"]');
        await dialog.waitFor({ state: "visible", timeout: 10000 });
        const title = page.locator('[data-slot="dialog-title"]');
        assert.equal(await title.innerText(), "Run scan");
        await page.locator('button:has-text("Cancel")').click();
        await dialog.waitFor({ state: "hidden", timeout: 5000 });

        // 2. Scans page header action
        await page.goto(new URL("/portal/scans", origin).href, { waitUntil: "networkidle" });
        const scansBtn = page.locator('button:has-text("Run scan")').first();
        await scansBtn.click();
        await dialog.waitFor({ state: "visible", timeout: 10000 });
        assert.equal(await title.innerText(), "Run scan");
        await page.locator('button:has-text("Cancel")').click();
        await dialog.waitFor({ state: "hidden", timeout: 5000 });

        // 3. Measurement page button
        await page.goto(new URL("/portal/measurement", origin).href, { waitUntil: "networkidle" });
        const measurementBtn = page.locator('button:has-text("Run scan")').first();
        if (await measurementBtn.isVisible()) {
          await measurementBtn.click();
          await dialog.waitFor({ state: "visible", timeout: 10000 });
          assert.equal(await title.innerText(), "Run scan");
          await page.locator('button:has-text("Cancel")').click();
          await dialog.waitFor({ state: "hidden", timeout: 5000 });
        }

        return "Run scan entry points successfully opened the CostReviewDialog.";
      } finally {
        await context.close();
      }
    },
  );

  await record(
    "F09-B02",
    "Dialog shows loading skeleton while quote resolves, then shows Cost, amount, answer counts, line label, warnings and footer.",
    async () => {
      const { context, page } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        let resolveEstimate;
        const estimatePromise = new Promise((resolve) => {
          resolveEstimate = resolve;
        });

        await page.route("**/api/customer/features*", async (route) => {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              brandKey: "acme",
              features: { price_review: true },
            }),
          });
        });

        await page.route("**/api/customer/price/estimate*", async (route) => {
          await estimatePromise;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(validQuote),
          });
        });

        await page.goto(new URL("/portal", origin).href);
        const runBtn = page.locator('button:has-text("Run scan")').first();
        await runBtn.waitFor({ state: "visible", timeout: 15000 });
        await runBtn.click();

        const dialog = page.locator('[data-slot="dialog-content"]');
        await dialog.waitFor({ state: "visible", timeout: 10000 });

        // While pending, skeleton is visible and Run scan is disabled
        const skeleton = dialog.locator('[aria-busy="true"]');
        assert.ok(await skeleton.isVisible(), "loading skeleton is displayed");
        const confirmBtn = dialog.locator('button:has-text("Run scan")');
        assert.ok(await confirmBtn.isDisabled(), "Run scan is disabled while loading");

        // Fulfill quote
        resolveEstimate();

        // Amount and details
        await dialog.locator("text=Up to $24.00").waitFor({ state: "visible", timeout: 10000 });
        assert.ok(
          await dialog.getByText("Cost", { exact: true }).isVisible(),
          "Cost label present",
        );
        assert.ok(
          await dialog.locator("text=120 answers (30 questions × 4 engines)").isVisible(),
          "subline present",
        );
        assert.ok(
          await dialog.locator("text=Answers reserved at $0.20 each").isVisible(),
          "reservation line label present",
        );
        assert.ok(
          await dialog
            .locator("text=You are only charged the provider cost of answers collected")
            .isVisible(),
          "footer note present",
        );
        assert.ok(
          await dialog.locator("text=Each question is asked once per engine").isVisible(),
          "bullet warning present",
        );
        assert.ok(
          await dialog.locator("text=Typical cost for this scan is about $7.20").isVisible(),
          "typical cost warning present",
        );
        assert.ok(!(await confirmBtn.isDisabled()), "Run scan button is enabled");

        return "Loading skeleton transitioned cleanly to ready copy with all details and enabled button.";
      } finally {
        await context.close();
      }
    },
  );

  await record(
    "F09-B03",
    "Blocked quote (panel_not_approved) displays destructive Alert and Review questions link, with confirm disabled.",
    async () => {
      const { context, page } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        await setupPage(page, { quoteData: blockedQuote });

        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
        await page.locator('button:has-text("Run scan")').first().click();

        const dialog = page.locator('[data-slot="dialog-content"]');
        await dialog.waitFor({ state: "visible", timeout: 10000 });

        const alert = dialog.locator('[data-slot="alert"]');
        assert.ok(await alert.isVisible(), "destructive alert is visible");
        assert.ok(
          (await alert.innerText()).includes(
            "Scans ask the questions in your approved question panel",
          ),
        );

        const reviewLink = dialog.locator('a:has-text("Review questions")');
        assert.ok(await reviewLink.isVisible(), "Review questions link is visible");
        assert.equal(await reviewLink.getAttribute("href"), "/portal/measurement");

        const confirmBtn = dialog.locator('button:has-text("Run scan")');
        assert.ok(await confirmBtn.isDisabled(), "confirm button is disabled when blocked");

        return "Blocked panel displayed error message, Review questions link, and disabled confirm button.";
      } finally {
        await context.close();
      }
    },
  );

  await record(
    "F09-B04",
    "Confirming sends maxUsd equal to displayed totalUsd and closes on success (AC-14).",
    async () => {
      const { context, page } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        let postedMaxUsd;
        await setupPage(page, { quoteData: validQuote });

        await page.route("**/api/customer/scan", async (route) => {
          const req = route.request();
          if (req.method() === "POST") {
            const body = JSON.parse(req.postData() || "{}");
            postedMaxUsd = body.maxUsd;
            return route.fulfill({
              status: 201,
              contentType: "application/json",
              body: JSON.stringify({
                job_id: "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90",
                brand: "acme",
                status: "pending",
                approvedMaxUsd: body.maxUsd,
                quotedUsd: 24,
              }),
            });
          }
          return route.continue();
        });

        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
        await page.locator('button:has-text("Run scan")').first().click();

        const dialog = page.locator('[data-slot="dialog-content"]');
        await dialog.waitFor({ state: "visible", timeout: 10000 });
        await dialog.locator("text=Up to $24.00").waitFor({ state: "visible", timeout: 10000 });

        const confirmBtn = dialog.locator('button:has-text("Run scan")');
        await confirmBtn.click();

        assert.equal(postedMaxUsd, 24, "POST /api/customer/scan sent maxUsd: 24");
        await dialog.waitFor({ state: "hidden", timeout: 5000 });

        return "Confirming sent maxUsd: 24 matching quote and closed dialog on 201.";
      } finally {
        await context.close();
      }
    },
  );

  await record(
    "F09-B05",
    "409 price_changed flow: dialog stays open, shows warning with old/new amounts, and re-approves at new amount (AC-15).",
    async () => {
      const { context, page } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        await setupPage(page, { quoteData: validQuote });

        let scanAttempts = 0;
        const recordedAmounts = [];

        await page.route("**/api/customer/scan", async (route) => {
          const req = route.request();
          if (req.method() === "POST") {
            scanAttempts++;
            const body = JSON.parse(req.postData() || "{}");
            recordedAmounts.push(body.maxUsd);
            if (scanAttempts === 1) {
              return route.fulfill({
                status: 409,
                contentType: "application/json",
                body: JSON.stringify({
                  error:
                    "This now costs up to $28.50, more than the $24.00 you approved. Review the new price.",
                  code: "price_changed",
                  details: {
                    approvedMaxUsd: 24,
                    quote: priceChangedQuote,
                  },
                }),
              });
            }
            return route.fulfill({
              status: 201,
              contentType: "application/json",
              body: JSON.stringify({
                job_id: "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90",
                brand: "acme",
                status: "pending",
                approvedMaxUsd: 28.5,
                quotedUsd: 28.5,
              }),
            });
          }
          return route.continue();
        });

        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
        await page.locator('button:has-text("Run scan")').first().click();

        const dialog = page.locator('[data-slot="dialog-content"]');
        await dialog.waitFor({ state: "visible", timeout: 10000 });
        await dialog.locator("text=Up to $24.00").waitFor({ state: "visible", timeout: 10000 });

        // First click approves $24
        const confirmBtn = dialog.locator('button:has-text("Run scan")');
        await confirmBtn.click();

        // Verify dialog stays open and displays the price changed warning
        await dialog.locator("text=The price changed").waitFor({ state: "visible", timeout: 5000 });
        const warningBody = await dialog.locator('[data-slot="alert-description"]').innerText();
        assert.ok(
          warningBody.includes(
            "This scan now costs up to $28.50. You approved $24.00. Review the new price and run again.",
          ),
          `warning copy matched: ${warningBody}`,
        );

        // Updated amount displayed
        assert.ok(
          await dialog.locator('.tabular-nums:has-text("Up to $28.50")').isVisible(),
          "amount shows new quote",
        );

        // Second click approves $28.50
        await confirmBtn.click();
        await dialog.waitFor({ state: "hidden", timeout: 5000 });

        assert.deepEqual(
          recordedAmounts,
          [24, 28.5],
          "first request approved 24, second request approved 28.5",
        );

        return "409 price_changed kept dialog open, displayed new price with warning, and re-approved with $28.50.";
      } finally {
        await context.close();
      }
    },
  );

  await record(
    "F09-B06",
    "Escape key and overlay are ignored while starting, and buttons show pending state.",
    async () => {
      const { context, page } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        let resolveScan;
        const scanPromise = new Promise((resolve) => {
          resolveScan = resolve;
        });

        await setupPage(page, { quoteData: validQuote });

        await page.route("**/api/customer/scan", async (route) => {
          await scanPromise;
          return route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({
              job_id: "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90",
              brand: "acme",
              status: "pending",
              approvedMaxUsd: 24,
              quotedUsd: 24,
            }),
          });
        });

        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
        await page.locator('button:has-text("Run scan")').first().click();

        const dialog = page.locator('[data-slot="dialog-content"]');
        await dialog.waitFor({ state: "visible", timeout: 10000 });
        await dialog.locator("text=Up to $24.00").waitFor({ state: "visible", timeout: 10000 });

        const confirmBtn = dialog.locator('button:has-text("Run scan")');
        await confirmBtn.click();

        // While pending: "Starting…" with spinner, Cancel disabled
        await dialog.locator("text=Starting…").waitFor({ state: "visible", timeout: 5000 });
        assert.ok(
          await dialog.locator('button:has-text("Cancel")').isDisabled(),
          "Cancel is disabled",
        );

        // Press Escape key
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        assert.ok(await dialog.isVisible(), "dialog remains open on Escape while starting");

        // Fulfill scan request
        resolveScan();
        await dialog.waitFor({ state: "hidden", timeout: 5000 });

        return "Escape was ignored during start; buttons were disabled with Starting… label.";
      } finally {
        await context.close();
      }
    },
  );

  await record(
    "F09-B07",
    "Phone layout at 390px renders fullscreen dialog with stacked buttons, primary first.",
    async () => {
      const { context, page } = await openPortal(browser, origin, {
        viewport: { width: 390, height: 844 },
      });
      try {
        await setupPage(page, { quoteData: validQuote });

        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
        await page.locator('button:has-text("Run scan")').first().click();

        const dialog = page.locator('[data-slot="dialog-content"]');
        await dialog.waitFor({ state: "visible", timeout: 10000 });
        // The dialog springs in from scale 0.92 (motion-modal), so a box read
        // mid-transition measures 0.92 × 390 = 358.8px. Wait for it to settle.
        await dialog.evaluate(async (el) => {
          while (el.hasAttribute("data-starting-style")) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
          await Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => {})));
        });

        const box = await dialog.boundingBox();
        assert.ok(box.width >= 380, `dialog fills mobile width (${box.width}px)`);

        // Check button stacking: primary button appears higher in Y coordinate than cancel
        const confirmBtn = dialog.locator('button:has-text("Run scan")');
        const cancelBtn = dialog.locator('button:has-text("Cancel")');
        const confirmBox = await confirmBtn.boundingBox();
        const cancelBox = await cancelBtn.boundingBox();
        assert.ok(
          confirmBox.y < cancelBox.y,
          `primary button (y=${confirmBox.y}) is stacked above cancel (y=${cancelBox.y})`,
        );

        await cancelBtn.click();
        await dialog.waitFor({ state: "hidden", timeout: 5000 });

        return "390px mobile layout rendered full-screen with primary button stacked first.";
      } finally {
        await context.close();
      }
    },
  );
} finally {
  await browser.close();
}
