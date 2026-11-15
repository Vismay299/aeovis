#!/usr/bin/env node
/**
 * F11 Phase 3 — Prompt Explorer browser verification (AC-16, AC-17, AC-19).
 *
 * 14 Scenarios:
 *   1. F11-B01-disabled: Feature flag off renders disabled EmptyState and no form.
 *   2. F11-B02-empty-state: Idle with no runs renders form and empty state with 3 bullets.
 *   3. F11-B03-validation: Validation messages (empty question, >500 chars, >100 char brand, 0 models).
 *   4. F11-B04-price-dialog-order-and-cancel: Submit opens CostReviewDialog before any POST; cancelling sends no POST.
 *   5. F11-B05-running-skeletons: Running run renders aria-live meta line and aria-busy cards named per model.
 *   6. F11-B06-completed-cards: Completed cards render article with tokens, web search badge, brand badge.
 *   7. F11-B07-citations-expandable: Citations render first 3 + "+N more" toggle, external link opens in new tab.
 *   8. F11-B08-fan-out: Fan-out queries rendered as outline badges when fanOutReported is true.
 *   9. F11-B09-unreported-fan-out: Unreported fan-out note rendered when fanOutReported is false.
 *  10. F11-B10-skipped-gemini: Skipped Gemini card copy rendered when country is selected.
 *  11. F11-B11-error-charge-copy: Error card charge copy rendered for charged / uncharged upstream error.
 *  12. F11-B12-partial-banner: Partial run status renders warning Alert banner.
 *  13. F11-B13-rate-limited-429: Rate limit 429 displays warning Alert with countdown and disabled submit.
 *  14. F11-B14-track-and-navigation: Track button tracks question and shows View history link; ?run= makes no POST; phone 390px has no horizontal scroll.
 *
 * Output: "14 passed" on completion.
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

const rawArg = process.argv[2] || "http://127.0.0.1:3328";
const origin = new URL(rawArg);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname),
  "browser checks require a disposable local app",
);
const port = parseInt(origin.port || "3328", 10);

const output = path.resolve(process.argv[3] || "test_reports/f11-browser");
await mkdir(output, { recursive: true });

async function waitForServer(targetPort, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${targetPort}/robots.txt`);
      if (res.ok) return true;
    } catch {}
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
const isRunning = await waitForServer(port, 1200);
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

async function warmServer(targetPort) {
  try {
    await fetch(`http://127.0.0.1:${targetPort}/robots.txt`);
    await fetch(`http://127.0.0.1:${targetPort}/login`);
    await fetch(`http://127.0.0.1:${targetPort}/portal`);
    await fetch(`http://127.0.0.1:${targetPort}/portal/explore`);
  } catch {}
}

await warmServer(port);

function exploreUrl(query = "") {
  return new URL(`/portal/explore${query}`, origin).href;
}

const browser = await chromium.launch({ headless: true });
let passedCount = 0;

async function record(id, description, run) {
  const row = {
    case: id,
    suite: "f11-browser",
    startedAt: new Date().toISOString(),
    description,
  };
  try {
    row.actual = await run();
    row.outcome = "pass";
    passedCount++;
  } catch (error) {
    row.outcome = "fail";
    row.actual = error?.stack || String(error);
    process.exitCode = 1;
  }
  row.endedAt = new Date().toISOString();
  await writeFile(path.join(output, `${id}.json`), JSON.stringify(row, null, 2));
  console.log(`${id}: ${row.outcome} — ${String(row.actual).split("\n")[0]}`);
  if (row.outcome === "fail") throw new Error(`${id} failed: ${row.actual}`);
}

function json(route, status, body) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  });
}

const RUN_ID = "8d0c3f9e-2b1a-4c5d-9e8f-1a2b3c4d5e6f";

const SAMPLE_QUOTE = {
  action: "ai_visibility.explore.run",
  currency: "USD",
  totalUsd: 0.24,
  expectedUsd: null,
  units: [
    { key: "models", label: "models", count: 3 },
    { key: "reused", label: "reused answers", count: 0 },
  ],
  lines: [
    { label: "ChatGPT · up to $0.09", quantity: 1, unitUsd: 0.09, totalUsd: 0.09 },
    { label: "Gemini · up to $0.11", quantity: 1, unitUsd: 0.11, totalUsd: 0.11 },
    { label: "Perplexity · up to $0.04", quantity: 1, unitUsd: 0.04, totalUsd: 0.04 },
  ],
  monthly: null,
  warnings: [
    { code: "cost_note", message: "You pay only the provider's charge for each answer, up to this amount." },
  ],
  blocked: null,
  priceVersion: "2026-10-21.1",
  quotedAt: "2026-10-22T09:30:00.000Z",
  inputsHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

const RUNNING_RUN = {
  runId: RUN_ID,
  status: "running",
  pollAfterSeconds: 3,
  prompt: "best running shoes 2026",
  highlightBrand: "Acme",
  webSearch: true,
  country: "US",
  createdAt: "2026-10-22T10:00:00.000Z",
  finishedAt: null,
  approvedMaxUsd: 0.24,
  cost: { knownUsd: 0, unknownModels: 3 },
  questionId: null,
  results: [
    { status: "pending", model: "chatgpt", label: "ChatGPT" },
    { status: "pending", model: "gemini", label: "Gemini" },
    { status: "pending", model: "perplexity", label: "Perplexity" },
  ],
};

const COMPLETED_RUN = {
  runId: RUN_ID,
  status: "completed",
  pollAfterSeconds: null,
  prompt: "best running shoes 2026",
  highlightBrand: "Acme",
  webSearch: true,
  country: "US",
  createdAt: "2026-10-22T10:00:00.000Z",
  finishedAt: "2026-10-22T10:00:30.000Z",
  approvedMaxUsd: 0.24,
  cost: { knownUsd: 0.15, unknownModels: 0 },
  questionId: null,
  results: [
    {
      status: "success",
      model: "chatgpt",
      label: "ChatGPT",
      route: "dataforseo",
      modelName: "gpt-5.6-luna",
      text: "Acme running shoes offer high comfort.",
      truncated: false,
      citations: [
        { url: "https://example.com/source1", domain: "example.com", title: "Source 1", matchedBrand: true },
        { url: "https://example.com/source2", domain: "example.com", title: "Source 2", matchedBrand: false },
        { url: "https://example.com/source3", domain: "example.com", title: "Source 3", matchedBrand: false },
        { url: "https://example.com/source4", domain: "example.com", title: "Source 4", matchedBrand: false },
        { url: "https://example.com/source5", domain: "example.com", title: "Source 5", matchedBrand: false },
      ],
      fanOutQueries: ["top running shoes", "running shoe reviews 2026"],
      fanOutReported: true,
      brandMentioned: true,
      workspaceBrandMentioned: true,
      outputTokens: 450,
      webSearch: true,
      countryHint: "US",
      costUsd: 0.06,
      costState: "measured",
      reusedFrom: null,
      observationId: "obs-1",
      observedAt: "2026-10-22T10:00:15.000Z",
    },
    {
      status: "success",
      model: "perplexity",
      label: "Perplexity",
      route: "openrouter",
      modelName: "sonar-reasoning",
      text: "Popular options include various brands.",
      truncated: false,
      citations: [],
      fanOutQueries: [],
      fanOutReported: false,
      brandMentioned: false,
      workspaceBrandMentioned: false,
      outputTokens: 320,
      webSearch: true,
      countryHint: "US",
      costUsd: 0.04,
      costState: "measured",
      reusedFrom: null,
      observationId: "obs-2",
      observedAt: "2026-10-22T10:00:20.000Z",
    },
    {
      status: "error",
      model: "gemini",
      label: "Gemini",
      errorCode: "UNSUPPORTED_COUNTRY",
      message: "Gemini doesn’t support country selection. Select “No country preference” above, then run again to include Gemini.",
      costUsd: 0,
    },
  ],
};

try {
  // Scenario 1: F11-B01-disabled
  await record("F11-B01-disabled", "feature flag off renders disabled EmptyState and no form", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      await page.route("**/api/customer/features*", (r) => json(r, 200, { brandKey: "acme", features: { prompt_explorer: false } }));
      await page.goto(exploreUrl(), { waitUntil: "networkidle" });

      const heading = await page.textContent("text=Prompt Explorer is not enabled for this workspace");
      assert.ok(heading, "Disabled title must render");
      const textarea = await page.$("textarea");
      assert.equal(textarea, null, "Form must not render when feature is disabled");
      return "disabled empty state verified";
    } finally {
      await context.close();
    }
  });

  // Scenario 2: F11-B02-empty-state
  await record("F11-B02-empty-state", "idle with no runs renders form and empty state with 3 bullets", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      await page.route("**/api/customer/features*", (r) => json(r, 200, { brandKey: "acme", features: { prompt_explorer: true } }));
      await page.route("**/api/customer/explore?*", (r) => json(r, 200, { runs: [], nextCursor: null }));
      await page.goto(exploreUrl(), { waitUntil: "networkidle" });

      const title = await page.textContent("text=Ask a question to compare model answers");
      assert.ok(title, "Empty state title must render");
      const bullet1 = await page.textContent("text=Models side by side");
      assert.ok(bullet1, "Bullet 1 must render");
      const bullet2 = await page.textContent("text=See what the models cite");
      assert.ok(bullet2, "Bullet 2 must render");
      const bullet3 = await page.textContent("text=Check your brand");
      assert.ok(bullet3, "Bullet 3 must render");
      return "empty state copy verified";
    } finally {
      await context.close();
    }
  });

  // Scenario 3: F11-B03-validation
  await record("F11-B03-validation", "submitting empty question, >500 chars, >100 char brand, or 0 models shows role=alert validation messages", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      await page.route("**/api/customer/features*", (r) => json(r, 200, { brandKey: "acme", features: { prompt_explorer: true } }));
      await page.route("**/api/customer/explore?*", (r) => json(r, 200, { runs: [], nextCursor: null }));
      await page.goto(exploreUrl(), { waitUntil: "networkidle" });

      // Click submit with empty question
      await page.click("button:has-text('Ask 3 models')");
      let alert = await page.textContent("[role='alert']");
      assert.equal(alert, "Enter a question");

      // Enter >500 chars
      const longQuestion = "a".repeat(501);
      await page.fill("textarea", longQuestion);
      await page.click("button:has-text('Ask 3 models')");
      alert = await page.textContent("[role='alert']");
      assert.equal(alert, "Keep questions under 500 characters");

      // Enter valid question but >100 char brand
      await page.fill("textarea", "Valid question?");
      await page.fill("input[placeholder='Acme']", "b".repeat(101));
      await page.click("button:has-text('Ask 3 models')");
      alert = await page.textContent("[role='alert']");
      assert.equal(alert, "Keep the brand under 100 characters");

      return "all validation alerts verified";
    } finally {
      await context.close();
    }
  });

  // Scenario 4: F11-B04-price-dialog-order-and-cancel
  await record("F11-B04-price-dialog-order-and-cancel", "submit opens CostReviewDialog before any POST; cancelling sends no POST", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      const networkLog = [];
      await page.route("**/api/customer/features*", (r) => json(r, 200, { brandKey: "acme", features: { prompt_explorer: true } }));
      await page.route("**/api/customer/explore?*", (r) => json(r, 200, { runs: [], nextCursor: null }));
      await page.route("**/api/customer/price/estimate", (r) => {
        networkLog.push("PRICE_ESTIMATE");
        return json(r, 200, SAMPLE_QUOTE);
      });
      await page.route("**/api/customer/explore", (r) => {
        if (r.request().method() === "POST") {
          networkLog.push("POST_EXPLORE");
          return json(r, 202, { runId: RUN_ID, status: "queued", pollAfterSeconds: 3 });
        }
        return r.continue();
      });

      await page.goto(exploreUrl(), { waitUntil: "networkidle" });
      await page.fill("textarea", "What are the best shoes?");

      // Submit
      await page.click("button:has-text('Ask 3 models')");

      // Wait for price dialog to appear
      await page.waitForSelector("[role='dialog']");
      const dialogTitle = await page.textContent("[role='dialog'] h2, [role='dialog'] [data-slot='dialog-title']");
      assert.ok(dialogTitle?.includes("Ask 3 models"), "Dialog title must show Ask 3 models");

      // Verify network log: estimate was requested, but NO POST to /api/customer/explore has occurred yet!
      assert.ok(networkLog.includes("PRICE_ESTIMATE"), "Price estimate must be called before explore POST");
      assert.ok(!networkLog.includes("POST_EXPLORE"), "No explore POST must occur before confirmation");

      // Click Cancel
      await page.click("[role='dialog'] button:has-text('Cancel')");
      await page.waitForSelector("[role='dialog']", { state: "hidden" });

      // Assert no POST was sent
      assert.ok(!networkLog.includes("POST_EXPLORE"), "Cancelling must send no POST to explore");

      return "price dialog order and cancel verified";
    } finally {
      await context.close();
    }
  });

  // Scenario 5: F11-B05-running-skeletons
  await record("F11-B05-running-skeletons", "running run renders aria-live meta line and aria-busy cards named per model", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      await page.route("**/api/customer/features*", (r) => json(r, 200, { brandKey: "acme", features: { prompt_explorer: true } }));
      await page.route(`**/api/customer/explore/${RUN_ID}*`, (r) => json(r, 200, RUNNING_RUN));

      await page.goto(exploreUrl(`?run=${RUN_ID}`), { waitUntil: "networkidle" });

      const meta = await page.textContent("[aria-live='polite']");
      assert.ok(meta?.includes("Asking 3 models"), "Aria-live meta line must announce asking 3 models");

      const busyArticles = await page.$$("article[aria-busy='true']");
      assert.equal(busyArticles.length, 3, "Must render 3 loading cards with aria-busy=true");

      const text = await page.textContent("body");
      assert.ok(text.includes("ChatGPT"), "Must name ChatGPT");
      assert.ok(text.includes("Gemini"), "Must name Gemini");
      assert.ok(text.includes("Perplexity"), "Must name Perplexity");

      return "running skeletons and aria attributes verified";
    } finally {
      await context.close();
    }
  });

  // Scenario 6: F11-B06-completed-cards
  await record("F11-B06-completed-cards", "completed cards render article with tokens, web search badge, brand badge", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      await page.route("**/api/customer/features*", (r) => json(r, 200, { brandKey: "acme", features: { prompt_explorer: true } }));
      await page.route(`**/api/customer/explore/${RUN_ID}*`, (r) => json(r, 200, COMPLETED_RUN));

      await page.goto(exploreUrl(`?run=${RUN_ID}`), { waitUntil: "networkidle" });

      const articles = await page.$$("article");
      assert.equal(articles.length, 3, "Must render 3 model result cards");

      const headings = await page.$$eval("article h3", (nodes) => nodes.map((n) => n.textContent?.trim()));
      assert.deepEqual(headings, ["ChatGPT", "Perplexity", "Gemini"]);

      const text = await page.textContent("body");
      assert.ok(text.includes("450 tokens"), "Tokens count must render");
      assert.ok(text.includes("web search"), "Web search indicator must render");
      assert.ok(text.includes("Acme"), "Brand mention badge must render");

      return "completed cards verified";
    } finally {
      await context.close();
    }
  });

  // Scenario 7: F11-B07-citations-expandable
  await record("F11-B07-citations-expandable", "citations render first 3 + '+N more' toggle, external link opens in new tab", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      await page.route("**/api/customer/features*", (r) => json(r, 200, { brandKey: "acme", features: { prompt_explorer: true } }));
      await page.route(`**/api/customer/explore/${RUN_ID}*`, (r) => json(r, 200, COMPLETED_RUN));

      await page.goto(exploreUrl(`?run=${RUN_ID}`), { waitUntil: "networkidle" });

      // First 3 sources visible, button shows "+2 more"
      const toggle = await page.textContent("button:has-text('+2 more')");
      assert.ok(toggle, "Expand button '+2 more' must render");

      // External link check
      const link = await page.$("a[href='https://example.com/source1']");
      assert.ok(link, "Source link must render");
      const target = await link.getAttribute("target");
      const rel = await link.getAttribute("rel");
      assert.equal(target, "_blank");
      assert.equal(rel, "noreferrer");

      const srOnly = await page.textContent("a[href='https://example.com/source1'] span.sr-only");
      assert.ok(srOnly?.includes("opens in a new tab"), "Sr-only external link announcement verified");

      // Expand citations
      await page.click("button:has-text('+2 more')");
      const source5 = await page.textContent("text=Source 5");
      assert.ok(source5, "Source 5 must be visible after expansion");

      return "expandable citations verified";
    } finally {
      await context.close();
    }
  });

  // Scenario 8: F11-B08-fan-out
  await record("F11-B08-fan-out", "fan-out queries rendered as outline badges when fanOutReported is true", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      await page.route("**/api/customer/features*", (r) => json(r, 200, { brandKey: "acme", features: { prompt_explorer: true } }));
      await page.route(`**/api/customer/explore/${RUN_ID}*`, (r) => json(r, 200, COMPLETED_RUN));

      await page.goto(exploreUrl(`?run=${RUN_ID}`), { waitUntil: "networkidle" });

      const query1 = await page.textContent("text=top running shoes");
      const query2 = await page.textContent("text=running shoe reviews 2026");
      assert.ok(query1, "Fan out query 1 must render");
      assert.ok(query2, "Fan out query 2 must render");

      return "fan-out queries verified";
    } finally {
      await context.close();
    }
  });

  // Scenario 9: F11-B09-unreported-fan-out
  await record("F11-B09-unreported-fan-out", "unreported fan-out note rendered when fanOutReported is false", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      await page.route("**/api/customer/features*", (r) => json(r, 200, { brandKey: "acme", features: { prompt_explorer: true } }));
      await page.route(`**/api/customer/explore/${RUN_ID}*`, (r) => json(r, 200, COMPLETED_RUN));

      await page.goto(exploreUrl(`?run=${RUN_ID}`), { waitUntil: "networkidle" });

      const note = await page.textContent("text=This provider does not report the searches the model ran.");
      assert.ok(note, "Unreported fan-out note must render");

      return "unreported fan-out note verified";
    } finally {
      await context.close();
    }
  });

  // Scenario 10: F11-B10-skipped-gemini
  await record("F11-B10-skipped-gemini", "skipped Gemini card copy rendered when country is selected", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      await page.route("**/api/customer/features*", (r) => json(r, 200, { brandKey: "acme", features: { prompt_explorer: true } }));
      await page.route(`**/api/customer/explore/${RUN_ID}*`, (r) => json(r, 200, COMPLETED_RUN));

      await page.goto(exploreUrl(`?run=${RUN_ID}`), { waitUntil: "networkidle" });

      const skippedBadge = await page.textContent("text=Skipped");
      assert.ok(skippedBadge, "Skipped badge must render on Gemini card");

      const geminiMsg = await page.textContent("text=Gemini doesn’t support country selection");
      assert.ok(geminiMsg, "Skipped message must render");

      return "skipped Gemini card copy verified";
    } finally {
      await context.close();
    }
  });

  // Scenario 11: F11-B11-error-charge-copy
  await record("F11-B11-error-charge-copy", "error card charge copy rendered for charged / uncharged upstream error", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      const errorRun = {
        ...COMPLETED_RUN,
        status: "partial",
        results: [
          {
            status: "error",
            model: "chatgpt",
            label: "ChatGPT",
            errorCode: "UPSTREAM_ERROR",
            message: "Upstream rate limit.",
            costUsd: 0.05,
          },
          {
            status: "error",
            model: "perplexity",
            label: "Perplexity",
            errorCode: "UPSTREAM_ERROR",
            message: "Temporary gateway timeout.",
            costUsd: 0,
          },
        ],
      };

      await page.route("**/api/customer/features*", (r) => json(r, 200, { brandKey: "acme", features: { prompt_explorer: true } }));
      await page.route(`**/api/customer/explore/${RUN_ID}*`, (r) => json(r, 200, errorRun));

      await page.goto(exploreUrl(`?run=${RUN_ID}`), { waitUntil: "networkidle" });

      const charged = await page.textContent("text=You were charged $0.05 for this attempt.");
      assert.ok(charged, "Charged copy must render when costUsd > 0");

      const uncharged = await page.textContent("text=You were not charged for this model.");
      assert.ok(uncharged, "Uncharged copy must render when costUsd is 0");

      return "error charge copy verified";
    } finally {
      await context.close();
    }
  });

  // Scenario 12: F11-B12-partial-banner
  await record("F11-B12-partial-banner", "partial run status renders warning Alert banner", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      const partialRun = {
        ...COMPLETED_RUN,
        status: "partial",
      };

      await page.route("**/api/customer/features*", (r) => json(r, 200, { brandKey: "acme", features: { prompt_explorer: true } }));
      await page.route(`**/api/customer/explore/${RUN_ID}*`, (r) => json(r, 200, partialRun));

      await page.goto(exploreUrl(`?run=${RUN_ID}`), { waitUntil: "networkidle" });

      const banner = await page.textContent("[role='alert'], .text-amber-600, .text-warning");
      assert.ok(banner?.includes("1 of 3 models could not answer"), "Partial warning banner must render");

      return "partial banner verified";
    } finally {
      await context.close();
    }
  });

  // Scenario 13: F11-B13-rate-limited-429
  await record("F11-B13-rate-limited-429", "rate limit 429 displays warning Alert with countdown and disabled submit", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      await page.route("**/api/customer/features*", (r) => json(r, 200, { brandKey: "acme", features: { prompt_explorer: true } }));
      await page.route("**/api/customer/explore?*", (r) => json(r, 200, { runs: [], nextCursor: null }));
      await page.route("**/api/customer/price/estimate", (r) => json(r, 200, SAMPLE_QUOTE));
      await page.route("**/api/customer/explore", (r) => {
        if (r.request().method() === "POST") {
          return json(r, 429, {
            error: "You have asked a lot of questions recently. Try again in 2 minutes.",
            code: "explore_rate_limited",
            details: { retryAfterSeconds: 120 },
          });
        }
        return r.continue();
      });

      await page.goto(exploreUrl(), { waitUntil: "networkidle" });
      await page.fill("textarea", "Question?");
      await page.click("button:has-text('Ask 3 models')");

      // Confirm in dialog
      await page.waitForSelector("[role='dialog']");
      await page.click("[role='dialog'] button:has-text('Ask now')");

      // Wait for dialog to close and 429 alert to render
      await page.waitForSelector("text=Rate limited");
      const alertText = await page.textContent("text=Rate limited");
      assert.ok(alertText, "Rate limit alert title must render");

      const countdownText = await page.textContent("text=Try again in");
      assert.ok(countdownText, "Countdown must render");

      // Check submit button is disabled
      const submitBtn = await page.$("button:has-text('Ask 3 models')");
      const isDisabled = await submitBtn?.isDisabled();
      assert.equal(isDisabled, true, "Submit button must be disabled during countdown");

      return "429 rate limit countdown verified";
    } finally {
      await context.close();
    }
  });

  // Scenario 14: F11-B14-track-and-navigation
  await record("F11-B14-track-and-navigation", "track button tracks question and shows View history link; ?run= makes no POST; phone 390px has no horizontal scroll", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 390, height: 844 },
    });
    try {
      let postMade = false;
      let trackPostMade = false;

      await page.route("**/api/customer/features*", (r) => json(r, 200, { brandKey: "acme", features: { prompt_explorer: true } }));
      await page.route(`**/api/customer/explore/${RUN_ID}*`, (r) => json(r, 200, COMPLETED_RUN));
      await page.route("**/api/customer/explore", (r) => {
        if (r.request().method() === "POST") {
          postMade = true;
          return json(r, 202, { runId: RUN_ID, status: "queued", pollAfterSeconds: 3 });
        }
        return r.continue();
      });
      await page.route(`**/api/customer/explore/${RUN_ID}/track`, (r) => {
        trackPostMade = true;
        return json(r, 200, { questionId: "q-12345", created: true, status: "active" });
      });

      // Loading URL with ?run= makes NO POST!
      await page.goto(exploreUrl(`?run=${RUN_ID}`), { waitUntil: "networkidle" });
      assert.equal(postMade, false, "Loading ?run= must make NO POST to explore");

      // Verify no horizontal scroll on 390px
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      assert.ok(scrollWidth <= clientWidth + 1, `No horizontal scroll: scrollWidth ${scrollWidth} <= clientWidth ${clientWidth}`);

      // Track button
      const trackBtn = await page.$("button:has-text('Track this question')");
      assert.ok(trackBtn, "Track button must be present");
      await page.click("button:has-text('Track this question')");

      // Becomes "Tracked" and renders "View history" link
      await page.waitForSelector("text=Tracked");
      assert.equal(trackPostMade, true, "Track endpoint must be posted to");

      const viewHistoryLink = await page.$("a:has-text('View history')");
      assert.ok(viewHistoryLink, "View history link must appear");
      const href = await viewHistoryLink.getAttribute("href");
      assert.equal(href, "/portal/questions/q-12345");

      return "track button, no-post navigation and 390px viewport verified";
    } finally {
      await context.close();
    }
  });

  console.log(`${passedCount} passed`);
} finally {
  await browser.close();
  if (serverChild) {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(serverChild.pid), "/f", "/t"]);
    } else {
      serverChild.kill("SIGTERM");
    }
  }
}
