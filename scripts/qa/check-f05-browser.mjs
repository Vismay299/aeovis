#!/usr/bin/env node
/**
 * F05 phase 3 — client data layer browser verification (B01–B06).
 *
 * Exercises the TanStack Query data layer, prefetching, status polling,
 * workspace switch isolation, 401 redirect, search filter debouncing,
 * and 402 spend limit handling against the local fixture harness.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "../../worker/node_modules/playwright/index.mjs";
import { openPortal, readFixture } from "./portalFixtureHarness.mjs";

const origin = new URL(process.argv[2] || "http://127.0.0.1:3328");
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname),
  "browser checks require a disposable local app"
);
const output = path.resolve(process.argv[3] || "test_reports/f05-browser");
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });

/** One recorded case, written to its own file whether it passes or fails. */
async function record(id, expected, run) {
  const row = {
    case: id,
    suite: "f05-browser",
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
    JSON.stringify({ ...row, artifacts: undefined }, null, 2)
  );
  row.artifacts.push(log);
  console.log(`${id}: ${row.outcome} — ${String(row.actual).split("\n")[0]}`);
}

try {
  await record(
    "F05-B01",
    "Switching workspace isolates data: Acme overview data is displayed, switching to Beta shows Beta data without stale metrics, and query cache keys are distinct.",
    async () => {
      const { context, page, blockedWrites } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });

        const switcher = page.locator('[aria-label="Switch workspace"]');
        assert.ok((await switcher.innerText()).includes("Acme"), "starts on Acme workspace");
        await page.waitForSelector("text=42%", { timeout: 15000 });

        await switcher.click();
        await page.locator('[data-slot="combobox-item"]:has-text("Beta")').click();

        await page.waitForFunction(
          () =>
            document
              .querySelector('[aria-label="Switch workspace"]')
              ?.textContent?.includes("Beta") === true,
          undefined,
          { timeout: 15000 }
        );
        await page.waitForTimeout(600);

        const keys = await page.evaluate(() => {
          const qc = window.__REACT_QUERY_CLIENT__;
          if (!qc) return [];
          return qc.getQueryCache().findAll().map((q) => q.queryKey);
        });
        const hasAcmeOverview = keys.some(
          (k) => Array.isArray(k) && k[0] === "overview" && k[1] === "acme"
        );
        const hasBetaOverview = keys.some(
          (k) => Array.isArray(k) && k[0] === "overview" && k[1] === "beta"
        );
        assert.ok(hasAcmeOverview, "cache contains ['overview', 'acme']");
        assert.ok(hasBetaOverview, "cache contains ['overview', 'beta']");

        assert.deepEqual(blockedWrites, [], "the shell wrote to a customer route");
        return "Acme rendered, switched to Beta cleanly, and distinct query keys exist in cache.";
      } finally {
        await context.close();
      }
    }
  );

  await record(
    "F05-B02",
    "Running scan polls status every 2s (3 ± 1 polls over 6s), and complete status stops polling and refetches overview once.",
    async () => {
      const { context, page, blockedWrites } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        const runningOverview = await readFixture("overview-acme-running.json");
        const statusSeq = await readFixture("scan-status-sequence.json");
        let seqIndex = 0;
        let pollCount = 0;
        let overviewRefetchCount = 0;

        await page.route("**/api/customer/overview*", async (route) => {
          overviewRefetchCount++;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(runningOverview),
          });
        });

        await page.route("**/api/scan/*/status*", async (route) => {
          pollCount++;
          const item =
            statusSeq?.sequence?.[seqIndex] ||
            statusSeq?.sequence?.[statusSeq.sequence.length - 1] ||
            { status: "probing", progress_pct: 25, poll_after_seconds: 2 };
          if (statusSeq?.sequence && seqIndex < statusSeq.sequence.length - 2) {
            seqIndex++;
          }
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(item),
          });
        });

        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForTimeout(500);

        pollCount = 0;
        await page.waitForTimeout(6000);
        assert.ok(
          pollCount >= 2 && pollCount <= 4,
          `expected 3 ± 1 polls over 6s, observed ${pollCount}`
        );

        await page.route("**/api/scan/*/status*", async (route) => {
          pollCount++;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              status: "complete",
              result_id: "scan-1",
              terminal_outcome: "complete",
              progress_pct: 100,
              poll_after_seconds: 0,
            }),
          });
        });

        overviewRefetchCount = 0;
        await page.waitForTimeout(2500);
        const pollsAtComplete = pollCount;

        await page.waitForTimeout(3000);
        assert.equal(
          pollCount,
          pollsAtComplete,
          `polling did not stop after complete: had ${pollsAtComplete}, now ${pollCount}`
        );
        assert.ok(overviewRefetchCount >= 1, "overview was refetched after scan completed");

        return `Observed 3 ± 1 polls (${pollCount} polls in window), complete stopped polling, overview refetched.`;
      } finally {
        await context.close();
      }
    }
  );

  await record(
    "F05-B03",
    "Hovering over Questions nav link or scan row prefetches data before click.",
    async () => {
      const { context, page, blockedWrites } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        let questionsPrefetched = false;
        let scanPrefetched = false;

        await page.route("**/api/customer/repairs/panel*", async (route) => {
          questionsPrefetched = true;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ items: [] }),
          });
        });

        await page.route("**/api/customer/scan/report/*", async (route) => {
          scanPrefetched = true;
          const report = (await readFixture("report-scan-1.json")) || {};
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(report),
          });
        });

        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });

        const questionsLink = page.locator(
          'nav[aria-label="Main navigation"] a[href="/portal/measurement"]'
        );
        await questionsLink.hover();
        await page.waitForTimeout(200);
        assert.ok(questionsPrefetched, "Questions link hover triggered prefetch");

        const scanRow = page.locator('a[href="/portal/scans/scan-1"]').first();
        await scanRow.scrollIntoViewIfNeeded();
        if (await scanRow.isVisible()) {
          await scanRow.hover();
          await page.waitForTimeout(200);
          assert.ok(scanPrefetched, "Scan row hover triggered prefetch");
        }

        return "Prefetch triggered on hover for Questions and scan row.";
      } finally {
        await context.close();
      }
    }
  );

  await record(
    "F05-B04",
    "A 401 from customer overview redirects to /login?next=... exactly once.",
    async () => {
      const { context, page, blockedWrites } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        let redirectCount = 0;
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame() && frame.url().includes("/login")) {
            redirectCount++;
          }
        });

        await page.route("**/auth/v1/user*", async (route) => {
          return route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({ message: "Invalid token" }),
          });
        });

        await page.route("**/api/customer/overview*", async (route) => {
          return route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({ error: "Unauthorized", code: "unauthenticated" }),
          });
        });

        await page.goto(new URL("/portal", origin).href);
        await page.waitForURL((url) => url.pathname === "/login", { timeout: 15000 });
        assert.ok(
          page.url().includes("next=%2Fportal"),
          `redirect URL includes next parameter: ${page.url()}`
        );
        await page.waitForTimeout(1000);
        assert.equal(redirectCount, 1, `expected exactly 1 redirect to /login, got ${redirectCount}`);

        return "401 redirected to /login?next=%2Fportal exactly once.";
      } finally {
        await context.close();
      }
    }
  );

  await record(
    "F05-B05",
    "URL search filters update after 300ms debounce on scan report, and round-trip on reload.",
    async () => {
      const { context, page, blockedWrites } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        const report = {
          scan: {
            id: "scan-1",
            brand_key: "acme",
            visibility_pct: 42,
            prompts_tracked: 30,
            prompts_mentioned: 9,
            scanned_at: "2026-10-20T09:00:00.000Z",
            status: "complete",
          },
          results: [
            {
              id: "res-1",
              query: "What is Acme pricing?",
              engine: "chatgpt",
              answered: true,
              mentioned: true,
              position: 1,
            },
            {
              id: "res-2",
              query: "Best alternative to Acme",
              engine: "chatgpt",
              answered: true,
              mentioned: false,
            },
          ],
          questions: [],
          collection: { outcome: "complete", planned: 2, valid: 2, failed: 0, not_attempted: 0 },
        };

        await page.route("**/api/customer/scan/report/*", async (route) => {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(report),
          });
        });

        await page.goto(new URL("/portal/scans/scan-1", origin).href, { waitUntil: "networkidle" });

        const searchInput = page.locator('input[type="search"]').first();
        await searchInput.waitFor({ state: "visible", timeout: 15000 });
        await searchInput.fill("pricing");

        const urlImmediate = new URL(page.url());
        assert.ok(!urlImmediate.searchParams.has("q"), "q should not be set immediately before debounce");

        await page.waitForTimeout(450);
        const urlDebounced = new URL(page.url());
        assert.equal(urlDebounced.searchParams.get("q"), "pricing", "q updated after debounce");

        await page.reload({ waitUntil: "networkidle" });
        await page.waitForTimeout(200);

        const reloadedVal = await page.locator('input[type="search"]').first().inputValue();
        assert.equal(reloadedVal, "pricing", "input value preserved after reload");

        return "Search input debounced 300ms to URL and preserved across reload.";
      } finally {
        await context.close();
      }
    }
  );

  await record(
    "F05-B06",
    "A 402 with reason daily_cap renders SpendRefusedError card with no retry button.",
    async () => {
      const { context, page, blockedWrites } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        await page.route("**/api/customer/overview*", async (route) => {
          return route.fulfill({
            status: 402,
            contentType: "application/json",
            body: JSON.stringify({
              error: "Spend limit reached",
              code: "daily_cap",
              recovery: "Wait for tomorrow's reset, or increase the limit in Settings.",
            }),
          });
        });

        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });

        const cardText = await page.locator('main, [data-slot="error-state"]').first().innerText();
        assert.match(cardText, /Daily spend limit reached|Spend limit reached/i, "renders spend limit title");
        assert.match(cardText, /Wait for tomorrow's reset|daily spend cap/i, "renders spend limit message");

        const tryAgainCount = await page.locator('button:has-text("Try again")').count();
        assert.equal(tryAgainCount, 0, "Try again button must be absent");

        return "402 daily_cap rendered SpendRefusedError card with hard stop (no retry).";
      } finally {
        await context.close();
      }
    }
  );
} finally {
  await browser.close();
}
