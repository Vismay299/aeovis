#!/usr/bin/env node
/**
 * F12 Phase 3 — Question detail and answer history browser verification.
 *
 * Scenarios B01–B16 per spec:
 *  B01 loading skeletons
 *  B02 404 state
 *  B03 no answers
 *  B04 no answers in range + "Show all available history"
 *  B05 custom range validation (no request sent)
 *  B06 brand table "x of y", "(n unknown)", "Show 2 more"
 *  B07 engine switch keeps scan
 *  B08 date select
 *  B09 Answer/Citations/Brands on 390 px
 *  B10 citations badges "Your site"/"Competitor: …"
 *  B11 excerpts with <mark>
 *  B12 evidence footer stored/expired/withdrawn copy
 *  B13 executions tags Scheduled/Explorer/Legacy and statuses
 *  B14 wording notices
 *  B15 URL restores on reload and back
 *  B16 data-ph-mask present and scan report "History" link navigates with "Back to scan report"
 *
 * Output: "16 passed" on pass.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "../../worker/node_modules/playwright/index.mjs";
import { openPortal, SUPABASE_URL } from "./portalFixtureHarness.mjs";

const origin = new URL(process.argv[2] || "http://127.0.0.1:3328");
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname),
  "browser checks require a disposable local app",
);
const port = parseInt(origin.port || "3328", 10);
const output = path.resolve(process.argv[3] || "test_reports/f12-browser");
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

let serverChild = null;
if (!(await waitForServer(port, 1200))) {
  serverChild = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key" },
    stdio: "ignore",
  });
  const up = await waitForServer(port, 45000);
  if (!up) {
    try { serverChild?.kill("SIGTERM"); } catch {}
    throw new Error(`Failed to start Next.js server on port ${port}`);
  }
}

const browser = await chromium.launch({ headless: true });
let passed = 0;

async function record(id, description, run) {
  const row = { case: id, suite: "f12-browser", startedAt: new Date().toISOString(), description };
  try {
    row.actual = await run();
    row.outcome = "pass";
    passed++;
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

const QUESTION_ID = "0b9c2d4e-6f70-4a81-9b2c-3d4e5f607182";
const SCAN_ID = "scan-1";

function makeHistory(overrides = {}) {
  return {
    question: {
      id: QUESTION_ID,
      text: "best oversized t-shirt brands in india",
      topic: "Fashion",
      status: "active",
      branded: false,
      origin: "manual",
      replacedBy: null,
      replaces: [],
    },
    range: { from: null, to: null },
    executions: [
      {
        answerId: "ans-1",
        source: "scan",
        engine: "chatgpt",
        engineLabel: "ChatGPT",
        collectedAt: "2026-10-20T10:00:00.000Z",
        trigger: "scheduled",
        status: "answered",
        ownMentioned: true,
        ownCited: true,
        askedText: "best oversized t-shirt brands in india",
        scanId: SCAN_ID,
        exploreRunId: null,
        method: "model_api",
        quality: "measured",
      },
    ],
    summary: [
      {
        name: "Acme",
        isSelf: true,
        answers: 1,
        mentions: 1,
        citations: 1,
        unknown: 0,
      },
    ],
    coverage: {
      total: 1,
      answered: 1,
      noAnswer: 0,
      failed: 0,
      explore: 0,
      legacy: 0,
    },
    truncated: false,
    latestScanId: SCAN_ID,
    ...overrides,
  };
}

function makeAnswer(overrides = {}) {
  return {
    execution: {
      answerId: "ans-1",
      source: "scan",
      engine: "chatgpt",
      engineLabel: "ChatGPT",
      collectedAt: "2026-10-20T10:00:00.000Z",
      trigger: "scheduled",
      status: "answered",
      ownMentioned: true,
      ownCited: true,
      askedText: "best oversized t-shirt brands in india",
      scanId: SCAN_ID,
      exploreRunId: null,
      method: "model_api",
      quality: "measured",
    },
    text: "Discover our stylish Acme shirts. Popular brands include Acme and Offcult.",
    markdown: null,
    truncated: false,
    citations: [
      {
        url: "https://acme.example/tees",
        domain: "acme.example",
        title: "Acme Tees",
        owned: true,
        competitor: null,
      },
      {
        url: "https://offcult.in/tees",
        domain: "offcult.in",
        title: "Offcult Tees",
        owned: false,
        competitor: "Offcult",
      },
    ],
    brands: [
      {
        name: "Acme",
        isSelf: true,
        mentioned: true,
        cited: true,
        position: 1,
        relationship: "featured",
        sentiment: "positive",
        sentimentLabel: "positive",
        spans: [{ start: 21, end: 25 }],
      },
      {
        name: "Offcult",
        isSelf: false,
        mentioned: true,
        cited: true,
        position: 2,
        relationship: "competitor",
        sentiment: "neutral",
        sentimentLabel: "neutral",
        spans: [{ start: 63, end: 70 }],
      },
    ],
    provenance: {
      method: "model_api",
      methodLabel: "Model API",
      gateway: "openrouter",
      requestedModel: "gpt-4o",
      returnedModel: "gpt-4o-2024-08-06",
      requestedLocation: "in",
      searchUsed: "unknown",
    },
    evidence: {
      state: "stored",
      captures: [
        {
          index: 0,
          state: "stored",
          href: "/api/customer/measurement/evidence?brand_key=acme&observation=obs-1&attempt=att-1&index=0",
          expiresAt: "2027-01-18T10:12:04.000Z",
        },
      ],
    },
    error: null,
    ...overrides,
  };
}

try {
  // B01: loading skeletons
  await record("B01", "loading skeletons displayed while history query is pending", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      await page.route(`**/api/customer/questions/${QUESTION_ID}/history*`, async (route) => {
        await new Promise((r) => setTimeout(r, 600));
        return json(route, 200, makeHistory());
      });
      await page.route(`**/api/customer/questions/${QUESTION_ID}/answers/*`, (route) =>
        json(route, 200, makeAnswer()),
      );

      const navigation = page.goto(
        new URL(`/portal/questions/${QUESTION_ID}`, origin).href,
      );
      await page.waitForSelector('[data-slot="skeleton"], .animate-pulse', { timeout: 10000 });
      const skeletons = await page.locator('[data-slot="skeleton"], .animate-pulse').count();
      assert.ok(skeletons > 0, "skeleton elements visible during load");
      await navigation;
      return "Skeletons visible during loading state.";
    } finally {
      await context.close();
    }
  });

  // B02: 404 state
  await record("B02", "404 state rendered with empty state and All questions button", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      await page.route(`**/api/customer/questions/${QUESTION_ID}/history*`, (route) =>
        json(route, 404, { code: "question_not_found", message: "Question not found" }),
      );

      await page.goto(new URL(`/portal/questions/${QUESTION_ID}`, origin).href, {
        waitUntil: "networkidle",
      });

      const notFoundText = page.getByRole("heading", { name: "Question not found" });
      await notFoundText.waitFor({ timeout: 10000 });
      const allQuestionsBtn = page.getByRole("link", { name: "All questions" }).first();
      await allQuestionsBtn.waitFor({ state: "visible" });
      return "404 state displayed cleanly with All questions button.";
    } finally {
      await context.close();
    }
  });

  // B03: no answers
  await record("B03", "no answers ever renders empty state with Go to Questions action", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      await page.route(`**/api/customer/questions/${QUESTION_ID}/history*`, (route) =>
        json(
          route,
          200,
          makeHistory({
            coverage: { total: 0, answered: 0, noAnswer: 0, failed: 0, explore: 0, legacy: 0 },
            executions: [],
            summary: [],
          }),
        ),
      );

      await page.goto(new URL(`/portal/questions/${QUESTION_ID}`, origin).href, {
        waitUntil: "networkidle",
      });

      await page.getByText("No answers yet").waitFor({ timeout: 10000 });
      await page.getByText("This question is asked in your next scan after it is in an approved panel.").waitFor({ timeout: 10000 });
      const goToQuestions = page.getByRole("button", { name: "Go to Questions" }).or(page.getByRole("link", { name: "Go to Questions" })).or(page.locator('a[href="/portal/measurement"], button:has-text("Go to Questions")')).first();
      await goToQuestions.waitFor({ state: "visible" });
      return "Empty state 'No answers yet' rendered with 'Go to Questions' button.";
    } finally {
      await context.close();
    }
  });

  // B04: no answers in range + "Show all available history"
  await record("B04", "no answers in range renders empty state and Show all available history button resets range", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      let requestedRange = "";
      await page.route(`**/api/customer/questions/${QUESTION_ID}/history*`, (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("from") || url.searchParams.get("to")) {
          // within 28 days -> 0 executions
          return json(
            route,
            200,
            makeHistory({
              coverage: { total: 5, answered: 5, noAnswer: 0, failed: 0, explore: 0, legacy: 0 },
              executions: [],
              summary: [],
            }),
          );
        }
        // all range -> executions returned
        requestedRange = "all";
        return json(route, 200, makeHistory());
      });
      await page.route(`**/api/customer/questions/${QUESTION_ID}/answers/*`, (route) =>
        json(route, 200, makeAnswer()),
      );

      await page.goto(
        new URL(`/portal/questions/${QUESTION_ID}?range=last_28_days`, origin).href,
        { waitUntil: "networkidle" },
      );

      await page.getByText("No answers in this period").waitFor({ timeout: 10000 });
      const showAllBtn = page.getByRole("button", { name: "Show all available history" });
      await showAllBtn.waitFor({ state: "visible" });
      await showAllBtn.click();

      // Should change range to all and reload answers
      await page.waitForURL(/range=all/, { timeout: 10000 });
      await page.getByRole("heading", { name: "Brand comparison" }).waitFor({ timeout: 10000 });
      assert.equal(requestedRange, "all", "history requested with all range");
      return "Show all available history button reset range to all and rendered history.";
    } finally {
      await context.close();
    }
  });

  // B05: custom range validation (no request sent)
  await record("B05", "custom range validation prevents request when start is after end", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      let customRequests = 0;
      await page.route(`**/api/customer/questions/${QUESTION_ID}/history*`, (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("from") === "2026-11-20T00:00:00.000Z") {
          customRequests++;
        }
        return json(route, 200, makeHistory());
      });
      await page.route(`**/api/customer/questions/${QUESTION_ID}/answers/*`, (route) =>
        json(route, 200, makeAnswer()),
      );

      await page.goto(new URL(`/portal/questions/${QUESTION_ID}`, origin).href, {
        waitUntil: "networkidle",
      });

      // Open date range select
      const rangeSelect = page.getByRole("combobox", { name: "Analysis date range" }).or(page.getByLabel("Analysis date range")).first();
      await rangeSelect.click();

      // Click Custom option
      await page.getByRole("option", { name: /Custom/i }).click();

      // Fill Start date: 2026-11-20, End date: 2026-11-10
      const startInput = page.getByLabel("Period start date");
      const endInput = page.getByLabel("Period end date");
      await startInput.fill("2026-11-20");
      await endInput.fill("2026-11-10");

      // Check error text
      await page.getByText("Choose a start date on or before the end date.").waitFor({ timeout: 10000 });

      await page.waitForTimeout(500);
      assert.equal(customRequests, 0, "no network request was sent for invalid custom range");
      return "Custom range validation displayed error and prevented network request.";
    } finally {
      await context.close();
    }
  });

  // B06: brand table "x of y", "(n unknown)", "Show 2 more"
  await record("B06", "brand table displays x of y, unknown count, and expands with Show 2 more", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      const summary = [
        { name: "Acme", isSelf: true, answers: 10, mentions: 8, citations: 5, unknown: 1 },
        { name: "Brand B", isSelf: false, answers: 10, mentions: 7, citations: 4, unknown: 0 },
        { name: "Brand C", isSelf: false, answers: 10, mentions: 6, citations: 3, unknown: 0 },
        { name: "Brand D", isSelf: false, answers: 10, mentions: 5, citations: 2, unknown: 0 },
        { name: "Brand E", isSelf: false, answers: 10, mentions: 4, citations: 1, unknown: 0 },
        { name: "Brand F", isSelf: false, answers: 10, mentions: 3, citations: 1, unknown: 0 },
      ];

      await page.route(`**/api/customer/questions/${QUESTION_ID}/history*`, (route) =>
        json(route, 200, makeHistory({ summary })),
      );
      await page.route(`**/api/customer/questions/${QUESTION_ID}/answers/*`, (route) =>
        json(route, 200, makeAnswer()),
      );

      await page.goto(new URL(`/portal/questions/${QUESTION_ID}`, origin).href, {
        waitUntil: "networkidle",
      });

      // Verify "8 of 10" and "(1 unknown)"
      await page.getByText("8 of 10 (1 unknown)").waitFor({ timeout: 10000 });

      // Verify "Show 2 more" button
      const showMoreBtn = page.getByRole("button", { name: "Show 2 more" });
      await showMoreBtn.waitFor({ state: "visible" });

      // Initially only 4 brands are in the table
      assert.equal(await page.locator("table tbody tr").count(), 4, "initially 4 rows visible");

      // Click Show 2 more
      await showMoreBtn.click();
      assert.equal(await page.locator("table tbody tr").count(), 6, "after expand 6 rows visible");
      assert.equal(await showMoreBtn.count(), 0, "Show 2 more button is gone");
      return "Brand table displayed '8 of 10 (1 unknown)' and expanded from 4 to 6 rows.";
    } finally {
      await context.close();
    }
  });

  // B07: engine switch keeps scan
  await record("B07", "engine switch keeps same scan when available for next engine", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      const executions = [
        {
          answerId: "ans-chatgpt-scan1",
          source: "scan",
          engine: "chatgpt",
          engineLabel: "ChatGPT",
          collectedAt: "2026-10-20T10:00:00.000Z",
          trigger: "scheduled",
          status: "answered",
          ownMentioned: true,
          ownCited: true,
          askedText: "best oversized t-shirt brands in india",
          scanId: "scan-1",
          exploreRunId: null,
          method: "model_api",
          quality: "measured",
        },
        {
          answerId: "ans-claude-scan1",
          source: "scan",
          engine: "claude",
          engineLabel: "Claude",
          collectedAt: "2026-10-20T10:00:00.000Z",
          trigger: "scheduled",
          status: "answered",
          ownMentioned: false,
          ownCited: false,
          askedText: "best oversized t-shirt brands in india",
          scanId: "scan-1",
          exploreRunId: null,
          method: "model_api",
          quality: "measured",
        },
        {
          answerId: "ans-claude-scan2",
          source: "scan",
          engine: "claude",
          engineLabel: "Claude",
          collectedAt: "2026-10-21T10:00:00.000Z",
          trigger: "scheduled",
          status: "answered",
          ownMentioned: false,
          ownCited: false,
          askedText: "best oversized t-shirt brands in india",
          scanId: "scan-2",
          exploreRunId: null,
          method: "model_api",
          quality: "measured",
        },
      ];

      await page.route(`**/api/customer/questions/${QUESTION_ID}/history*`, (route) =>
        json(route, 200, makeHistory({ executions })),
      );
      await page.route(`**/api/customer/questions/${QUESTION_ID}/answers/*`, (route) => {
        const id = route.request().url().split("/answers/")[1].split("?")[0];
        const match = executions.find((e) => e.answerId === id) || executions[0];
        return json(route, 200, makeAnswer({ execution: match }));
      });

      await page.goto(
        new URL(`/portal/questions/${QUESTION_ID}?engine=chatgpt&answer=ans-chatgpt-scan1`, origin).href,
        { waitUntil: "networkidle" },
      );

      // Change Engine Select to Claude
      const engineSelect = page.getByRole("combobox", { name: "Engine" });
      await engineSelect.click();
      await page.getByRole("option", { name: "Claude" }).click();

      // Upstream rule: same scan was scan-1, so ans-claude-scan1 should be chosen (not ans-claude-scan2)
      await page.waitForURL(/answer=ans-claude-scan1/, { timeout: 10000 });
      return "Engine switch preserved scan-1 and selected ans-claude-scan1.";
    } finally {
      await context.close();
    }
  });

  // B08: date select
  await record("B08", "date select switches active answer execution", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      const executions = [
        {
          answerId: "ans-date-1",
          source: "scan",
          engine: "chatgpt",
          engineLabel: "ChatGPT",
          collectedAt: "2026-10-20T10:00:00.000Z",
          trigger: "scheduled",
          status: "answered",
          ownMentioned: true,
          ownCited: true,
          askedText: "best oversized t-shirt brands in india",
          scanId: "scan-1",
          exploreRunId: null,
          method: "model_api",
          quality: "measured",
        },
        {
          answerId: "ans-date-2",
          source: "scan",
          engine: "chatgpt",
          engineLabel: "ChatGPT",
          collectedAt: "2026-10-21T10:00:00.000Z",
          trigger: "scheduled",
          status: "answered",
          ownMentioned: true,
          ownCited: true,
          askedText: "best oversized t-shirt brands in india",
          scanId: "scan-2",
          exploreRunId: null,
          method: "model_api",
          quality: "measured",
        },
      ];

      await page.route(`**/api/customer/questions/${QUESTION_ID}/history*`, (route) =>
        json(route, 200, makeHistory({ executions })),
      );
      await page.route(`**/api/customer/questions/${QUESTION_ID}/answers/*`, (route) => {
        const id = route.request().url().split("/answers/")[1].split("?")[0];
        const match = executions.find((e) => e.answerId === id) || executions[0];
        return json(route, 200, makeAnswer({ execution: match, text: `Answer content for ${id}` }));
      });

      await page.goto(
        new URL(`/portal/questions/${QUESTION_ID}?engine=chatgpt&answer=ans-date-1`, origin).href,
        { waitUntil: "networkidle" },
      );

      await page.getByText("Answer content for ans-date-1").waitFor({ timeout: 10000 });

      // Change Date Select to the second execution
      const dateSelect = page.getByRole("combobox", { name: "Answer date" });
      await dateSelect.click();
      await page.getByRole("option").nth(1).click();

      await page.waitForURL(/answer=ans-date-2/, { timeout: 10000 });
      await page.getByText("Answer content for ans-date-2").waitFor({ timeout: 10000 });
      return "Date select switched answer and rendered updated answer content.";
    } finally {
      await context.close();
    }
  });

  // B09: Answer/Citations/Brands on 390 px
  await record("B09", "390px mobile viewport renders Answer, Citations, Brands tabs without horizontal overflow", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 390, height: 844 },
    });
    try {
      await page.route(`**/api/customer/questions/${QUESTION_ID}/history*`, (route) =>
        json(route, 200, makeHistory()),
      );
      await page.route(`**/api/customer/questions/${QUESTION_ID}/answers/*`, (route) =>
        json(route, 200, makeAnswer()),
      );

      await page.goto(new URL(`/portal/questions/${QUESTION_ID}`, origin).href, {
        waitUntil: "networkidle",
      });

      // Verify no horizontal overflow
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(scrollWidth <= 390, `expected scrollWidth <= 390, got ${scrollWidth}`);

      // Verify mobile buttons
      const answerBtn = page.getByRole("button", { name: "Answer", exact: true });
      const citationsBtn = page.getByRole("button", { name: /Citations \(\d+\)/ });
      const brandsBtn = page.getByRole("button", { name: "Brands", exact: true });

      await answerBtn.waitFor({ state: "visible" });
      await citationsBtn.waitFor({ state: "visible" });
      await brandsBtn.waitFor({ state: "visible" });

      // Switch to Citations
      await citationsBtn.click();
      await page.getByText("acme.example").waitFor({ timeout: 10000 });

      // Switch to Brands
      await brandsBtn.click();
      await page.getByText("Mentions appear in the answer text").waitFor({ timeout: 10000 });

      // Switch back to Answer
      await answerBtn.click();
      await page.getByText("Discover our stylish Acme shirts").waitFor({ timeout: 10000 });

      return `No horizontal overflow at 390px (scrollWidth=${scrollWidth}) and all 3 view buttons switched panels.`;
    } finally {
      await context.close();
    }
  });

  // B10: citations badges "Your site"/"Competitor: …"
  await record("B10", "citations render Your site and Competitor badges", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      await page.route(`**/api/customer/questions/${QUESTION_ID}/history*`, (route) =>
        json(route, 200, makeHistory()),
      );
      await page.route(`**/api/customer/questions/${QUESTION_ID}/answers/*`, (route) =>
        json(route, 200, makeAnswer()),
      );

      await page.goto(new URL(`/portal/questions/${QUESTION_ID}`, origin).href, {
        waitUntil: "networkidle",
      });

      // Assert "Your site" badge
      const yourSiteBadge = page.getByText("Your site");
      await yourSiteBadge.waitFor({ state: "visible", timeout: 10000 });

      // Assert "Competitor: Offcult" badge
      const competitorBadge = page.getByText("Competitor: Offcult");
      await competitorBadge.waitFor({ state: "visible", timeout: 10000 });

      return "Found 'Your site' and 'Competitor: Offcult' citation badges.";
    } finally {
      await context.close();
    }
  });

  // B11: excerpts with <mark>
  await record("B11", "mention excerpts expand and highlight matched brand in mark tag", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      await page.route(`**/api/customer/questions/${QUESTION_ID}/history*`, (route) =>
        json(route, 200, makeHistory()),
      );
      await page.route(`**/api/customer/questions/${QUESTION_ID}/answers/*`, (route) =>
        json(route, 200, makeAnswer()),
      );

      await page.goto(new URL(`/portal/questions/${QUESTION_ID}`, origin).href, {
        waitUntil: "networkidle",
      });

      // Switch aside to Brands tab on desktop
      const brandsTab = page.getByRole("tab", { name: "Brands" });
      await brandsTab.click();

      // Open Mention excerpts accordion
      const excerptTrigger = page.getByRole("button", { name: /Mention excerpts/i }).first();
      await excerptTrigger.waitFor({ state: "visible", timeout: 10000 });
      await excerptTrigger.click();

      // Look for mark tag
      const markTag = page.locator("mark").first();
      await markTag.waitFor({ state: "visible", timeout: 10000 });
      const markedText = await markTag.innerText();
      assert.equal(markedText, "Acme", "mark element contains matched brand name");

      return `Mention excerpts expanded and found <mark>${markedText}</mark>.`;
    } finally {
      await context.close();
    }
  });

  // B12: evidence footer stored/expired/withdrawn copy
  await record("B12", "evidence footer renders correct copy for stored, expired, and withdrawn states", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      let stateToTest = "stored";
      await page.route(`**/api/customer/questions/${QUESTION_ID}/history*`, (route) =>
        json(route, 200, makeHistory()),
      );
      await page.route(`**/api/customer/questions/${QUESTION_ID}/answers/*`, (route) => {
        if (stateToTest === "stored") {
          return json(route, 200, makeAnswer({ evidence: { state: "stored", captures: [{ index: 0, state: "stored", href: "#capture", expiresAt: "2027-01-01T00:00:00.000Z" }] } }));
        }
        if (stateToTest === "expired") {
          return json(route, 200, makeAnswer({ evidence: { state: "expired", captures: [] } }));
        }
        return json(route, 200, makeAnswer({ evidence: { state: "withdrawn", captures: [] } }));
      });

      // 1. Stored state
      await page.goto(new URL(`/portal/questions/${QUESTION_ID}`, origin).href, { waitUntil: "networkidle" });
      await page.getByText("Raw capture: Open").waitFor({ timeout: 10000 });

      // 2. Expired state
      stateToTest = "expired";
      await page.reload({ waitUntil: "networkidle" });
      await page.getByText("Raw capture expired under the retention policy. The measurement is retained.").waitFor({ timeout: 10000 });

      // 3. Withdrawn state
      stateToTest = "withdrawn";
      await page.reload({ waitUntil: "networkidle" });
      await page.getByText("This capture was withdrawn because its redaction could not be verified. The measurement is retained.").waitFor({ timeout: 10000 });

      return "Evidence footer verified stored, expired, and withdrawn copy.";
    } finally {
      await context.close();
    }
  });

  // B13: executions tags Scheduled/Explorer/Legacy and statuses
  await record("B13", "executions list renders Scheduled, Explorer, Legacy tags and status labels", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      const executions = [
        {
          answerId: "ans-scheduled",
          source: "scan",
          engine: "chatgpt",
          engineLabel: "ChatGPT",
          collectedAt: "2026-10-20T10:00:00.000Z",
          trigger: "scheduled",
          status: "answered",
          ownMentioned: true,
          ownCited: true,
          askedText: "q",
          scanId: "scan-1",
          exploreRunId: null,
          method: "model_api",
          quality: "measured",
        },
        {
          answerId: "ans-explore",
          source: "explore",
          engine: "chatgpt",
          engineLabel: "ChatGPT",
          collectedAt: "2026-10-20T09:00:00.000Z",
          trigger: "explore",
          status: "answered",
          ownMentioned: true,
          ownCited: false,
          askedText: "q",
          scanId: null,
          exploreRunId: "exp-1",
          method: "model_api",
          quality: "measured",
        },
        {
          answerId: "ans-legacy",
          source: "scan",
          engine: "chatgpt",
          engineLabel: "ChatGPT",
          collectedAt: "2026-10-19T10:00:00.000Z",
          trigger: "legacy",
          status: "answered",
          ownMentioned: false,
          ownCited: false,
          askedText: "q",
          scanId: "scan-0",
          exploreRunId: null,
          method: "model_api",
          quality: "legacy_unknown",
        },
        {
          answerId: "ans-no-answer",
          source: "scan",
          engine: "chatgpt",
          engineLabel: "ChatGPT",
          collectedAt: "2026-10-18T10:00:00.000Z",
          trigger: "scheduled",
          status: "no_answer",
          ownMentioned: null,
          ownCited: null,
          askedText: "q",
          scanId: "scan-legacy",
          exploreRunId: null,
          method: "model_api",
          quality: "measured",
        },
        {
          answerId: "ans-failed",
          source: "scan",
          engine: "chatgpt",
          engineLabel: "ChatGPT",
          collectedAt: "2026-10-17T10:00:00.000Z",
          trigger: "scheduled",
          status: "failed",
          ownMentioned: null,
          ownCited: null,
          askedText: "q",
          scanId: "scan-fail",
          exploreRunId: null,
          method: "model_api",
          quality: "measured",
        },
      ];

      await page.route(`**/api/customer/questions/${QUESTION_ID}/history*`, (route) =>
        json(route, 200, makeHistory({ executions })),
      );
      await page.route(`**/api/customer/questions/${QUESTION_ID}/answers/*`, (route) =>
        json(route, 200, makeAnswer({ execution: executions[0] })),
      );

      await page.goto(new URL(`/portal/questions/${QUESTION_ID}`, origin).href, {
        waitUntil: "networkidle",
      });

      // Check tags
      await page.getByText("Scheduled", { exact: true }).first().waitFor({ state: "visible", timeout: 10000 });
      await page.getByText("Explorer", { exact: true }).first().waitFor({ state: "visible", timeout: 10000 });
      await page.getByText("Legacy", { exact: true }).first().waitFor({ state: "visible", timeout: 10000 });

      // Check status labels
      await page.getByText("No substantive answer").waitFor({ state: "visible", timeout: 10000 });
      await page.getByText("Collection failed").waitFor({ state: "visible", timeout: 10000 });

      return "Executions listed Scheduled, Explorer, Legacy tags and unearned status labels.";
    } finally {
      await context.close();
    }
  });

  // B14: wording notices
  await record("B14", "wording notices appear when question has replaces or replacedBy history", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      await page.route(`**/api/customer/questions/${QUESTION_ID}/history*`, (route) =>
        json(
          route,
          200,
          makeHistory({
            question: {
              id: QUESTION_ID,
              text: "best oversized t-shirt brands in india",
              topic: "Fashion",
              status: "active",
              branded: false,
              origin: "manual",
              replaces: [{ id: "q-earlier", text: "what are best oversized tees" }],
              replacedBy: { id: "q-newer", text: "top oversized tee brands india" },
            },
          }),
        ),
      );
      await page.route(`**/api/customer/questions/${QUESTION_ID}/answers/*`, (route) =>
        json(route, 200, makeAnswer()),
      );

      await page.goto(new URL(`/portal/questions/${QUESTION_ID}`, origin).href, {
        waitUntil: "networkidle",
      });

      // Check both wording notices
      await page.getByText("This question replaced an earlier wording: “what are best oversized tees”.").waitFor({ timeout: 10000 });
      await page.getByText("A newer wording replaced this question: “top oversized tee brands india”.").waitFor({ timeout: 10000 });

      return "Both earlier and newer wording notices displayed with links to history.";
    } finally {
      await context.close();
    }
  });

  // B15: URL restores on reload and back
  await record("B15", "URL query parameters update and restore across reload and browser back", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      const executions = [
        {
          answerId: "ans-initial",
          source: "scan",
          engine: "chatgpt",
          engineLabel: "ChatGPT",
          collectedAt: "2026-10-20T10:00:00.000Z",
          trigger: "scheduled",
          status: "answered",
          ownMentioned: true,
          ownCited: true,
          askedText: "q",
          scanId: "scan-1",
          exploreRunId: null,
          method: "model_api",
          quality: "measured",
        },
        {
          answerId: "ans-secondary",
          source: "scan",
          engine: "claude",
          engineLabel: "Claude",
          collectedAt: "2026-10-21T10:00:00.000Z",
          trigger: "scheduled",
          status: "answered",
          ownMentioned: false,
          ownCited: false,
          askedText: "q",
          scanId: "scan-2",
          exploreRunId: null,
          method: "model_api",
          quality: "measured",
        },
      ];

      await page.route(`**/api/customer/questions/${QUESTION_ID}/history*`, (route) =>
        json(route, 200, makeHistory({ executions })),
      );
      await page.route(`**/api/customer/questions/${QUESTION_ID}/answers/*`, (route) => {
        const id = route.request().url().split("/answers/")[1].split("?")[0];
        const match = executions.find((e) => e.answerId === id) || executions[0];
        return json(route, 200, makeAnswer({ execution: match, text: `Detail of ${id}` }));
      });

      await page.goto(
        new URL(`/portal/questions/${QUESTION_ID}?engine=chatgpt&answer=ans-initial`, origin).href,
        { waitUntil: "networkidle" },
      );

      // Select secondary execution from executions list
      await page.getByRole("button", { name: /Claude/i }).click();
      await page.waitForURL(/answer=ans-secondary/, { timeout: 10000 });
      await page.getByText("Detail of ans-secondary").waitFor({ timeout: 10000 });

      // Reload page — URL params must persist
      await page.reload({ waitUntil: "networkidle" });
      assert.ok(page.url().includes("answer=ans-secondary"), "reload preserved answer parameter");
      await page.getByText("Detail of ans-secondary").waitFor({ timeout: 10000 });

      // Go back
      await page.goBack({ waitUntil: "networkidle" });
      assert.ok(page.url().includes("answer=ans-initial"), "back restored initial answer parameter");
      await page.getByText("Detail of ans-initial").waitFor({ timeout: 10000 });

      return "URL parameters updated, persisted across reload, and restored on browser back.";
    } finally {
      await context.close();
    }
  });

  // B16: data-ph-mask present and scan report "History" link navigates with "Back to scan report"
  await record("B16", "data-ph-mask present and scan report History link navigates with Back to scan report", async () => {
    const { context, page } = await openPortal(browser, origin);
    try {
      const questionText = "best oversized t-shirt brands in india";
      const reportFixture = {
        scan: {
          id: SCAN_ID,
          brand_key: "acme",
          visibility_pct: 42,
          prompts_tracked: 1,
          prompts_mentioned: 1,
          scanned_at: "2026-10-20T09:00:00.000Z",
          created_at: "2026-10-20T09:00:00.000Z",
          status: "complete",
          engines: ["chatgpt"],
          planned_questions: [{ text: questionText }],
        },
        results: [
          {
            query: questionText,
            engine: "chatgpt",
            mentioned: true,
            cited: true,
          },
        ],
        questionIdByQuery: {
          [questionText]: QUESTION_ID,
        },
        collection: { outcome: "complete", planned: 1, valid: 1, failed: 0, not_attempted: 0 },
      };

      await page.route(`**/api/customer/scan/report/${SCAN_ID}*`, (route) =>
        json(route, 200, reportFixture),
      );
      await page.route(`**/api/customer/questions/${QUESTION_ID}/history*`, (route) =>
        json(route, 200, makeHistory({ latestScanId: SCAN_ID })),
      );
      await page.route(`**/api/customer/questions/${QUESTION_ID}/answers/*`, (route) =>
        json(route, 200, makeAnswer()),
      );

      // Start at scan report page
      await page.goto(new URL(`/portal/scans/${SCAN_ID}`, origin).href, {
        waitUntil: "networkidle",
      });

      // Expand question row
      const questionToggle = page.locator(".pv-scans-q__toggle").first();
      await questionToggle.waitFor({ state: "visible", timeout: 10000 });
      await questionToggle.click();

      // Find and click the "History" link button in question row
      const historyLink = page
        .getByRole("button", { name: "Question history" })
        .or(page.getByRole("link", { name: "Question history" }))
        .or(page.locator('a[aria-label="Question history"], button[aria-label="Question history"]'))
        .first();
      await historyLink.waitFor({ state: "visible", timeout: 10000 });
      await historyLink.click();

      // Verify navigation to Question History page with from_scan query param
      await page.waitForURL(new RegExp(`/portal/questions/${QUESTION_ID}\\?from_scan=${SCAN_ID}`), {
        timeout: 10000,
      });

      // Verify data-ph-mask attribute is present on title and article
      await page.locator("article[data-ph-mask]").waitFor({ state: "visible", timeout: 10000 });
      const maskedCount = await page.locator("[data-ph-mask]").count();
      assert.ok(maskedCount >= 2, `expected at least 2 data-ph-mask elements, found ${maskedCount}`);

      // Verify "Back to scan report" link is present
      const backLink = page.getByRole("link", { name: "Back to scan report" });
      await backLink.waitFor({ state: "visible", timeout: 10000 });

      // Click "Back to scan report" and verify navigation back
      await backLink.click();
      await page.waitForURL(new RegExp(`/portal/scans/${SCAN_ID}`), { timeout: 10000 });

      return `data-ph-mask present (${maskedCount} elements) and History link round-tripped with Back to scan report.`;
    } finally {
      await context.close();
    }
  });

} finally {
  await browser.close();
  if (serverChild) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(serverChild.pid), "/f", "/t"]);
      } else {
        serverChild.kill("SIGTERM");
      }
    } catch {}
  }
}

console.log(`${passed} passed`);
process.exit(process.exitCode || 0);
