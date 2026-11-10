#!/usr/bin/env node
/**
 * F02 Phase 3 browser verification (F02-AC-30).
 * Tests that customer report renders:
 * 1. "Consumer app" badge for consumer_capture measurement method with tooltip.
 * 2. "Model API" badge for model_api measurement method.
 *
 * Output: "2 passed" on success.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { openPortal, readFixture, SUPABASE_URL } from "./portalFixtureHarness.mjs";

const rawArg = process.argv[2] || "http://127.0.0.1:3328";
const origin = new URL(rawArg);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname),
  "browser checks require a disposable local app",
);
const port = parseInt(origin.port || "3328", 10);

async function waitForServer(targetPort, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${targetPort}/robots.txt`);
      if (res.ok) return true;
    } catch {
      // waiting
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let serverChild = null;
const isRunning = await waitForServer(port, 1000);
if (!isRunning) {
  // This harness injects disposable Supabase placeholders at server startup.
  // A production build bakes NEXT_PUBLIC_* values into its client bundle, so
  // always use dev mode here to ensure the browser sees those fixture values.
  const nextCmd = "dev";
  serverChild = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", nextCmd, "-p", String(port)],
    {
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key",
      },
      stdio: "ignore",
    },
  );
  const up = await waitForServer(port, 60000);
  if (!up) {
    if (serverChild) serverChild.kill("SIGTERM");
    throw new Error(`Next.js server failed to start on port ${port}`);
  }
}

const browser = await chromium.launch({ headless: true });

try {
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 1000 },
  });

  try {
    const baseFixture = (await readFixture("report-scan-1.json")) || {};
    const reportData = {
      ...baseFixture,
      scan: {
        ...baseFixture.scan,
        planned_questions: {
          prompts: ["Best anvil for roadrunners?"],
          engines: ["chatgpt", "gemini"],
        },
      },
      results: [
        {
          id: "res-model-1",
          query: "Best anvil for roadrunners?",
          engine: "chatgpt",
          answered: true,
          answer_text: "Acme model API answer text.",
          mentioned: true,
          position: 1,
          raw: {
            measurement_method: "model_api",
          },
        },
        {
          id: "res-consumer-1",
          query: "Best anvil for roadrunners?",
          engine: "gemini",
          answered: true,
          answer_text: "Acme consumer capture answer text.",
          mentioned: true,
          position: 2,
          raw: {
            measurement_method: "consumer_capture",
          },
        },
      ],
    };

    await page.route("**/api/customer/scan/report/*", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(reportData),
      });
    });

    await page.goto(new URL("/portal/scans/scan-1", origin).href, { waitUntil: "networkidle" });

    // Expand the question row to show the answers
    const toggle = page.locator(".pv-scans-q__toggle").first();
    await toggle.waitFor({ state: "visible", timeout: 15000 });
    await toggle.click();

    // Check 1: Consumer app badge
    const consumerBadge = page.locator('.pv-scans-answer').locator('text="Consumer app"').first();
    await consumerBadge.waitFor({ state: "visible", timeout: 10000 });
    const consumerTitle = await consumerBadge.getAttribute("title");
    assert.equal(
      consumerTitle,
      "Captured from the consumer app through DataForSEO.",
      "Consumer app badge must have explanatory tooltip title",
    );
    console.log("ok 1 Consumer app badge rendered");

    // Check 2: Model API badge
    const modelBadge = page.locator('.pv-scans-answer').locator('text="Model API"').first();
    await modelBadge.waitFor({ state: "visible", timeout: 10000 });
    console.log("ok 2 Model API badge rendered");

    console.log("2 passed");
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
  if (serverChild) {
    serverChild.kill("SIGTERM");
  }
}
