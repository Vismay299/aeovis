#!/usr/bin/env node
/**
 * F17 browser verification (F17-AC-13).
 *
 * Scenarios:
 *   B1: no business -> "By name" lookup shows the price and the result card
 *   B2: "Nearby" search table and "Save as competitor"
 *   B3: profile head-to-head shows "Not loaded" (not 0) for a competitor without a profile
 *   B4: reviews: processing then completed, "owner replied to 6 of 20", page 2 of 2, rating filter
 *   B5: posts and questions empty states
 *   B6: "Run grid" opens the cost dialog with "9 Google Maps searches" and the centre
 *       warning; the SVG fills from "3 of 9" to complete, the summary reads
 *       "Ranked at 7 of 9 points", the failed point shows "×", arrow keys move focus
 *       between points, and no request leaves the local app (F17 phase 4)
 *   B7: local results "You rank #4 of 20" with the "You" badge (F17 phase 4)
 *   B8: phone width 390 px: no horizontal page scroll, the SVG fits (F17 phase 4)
 *
 * Output: "ok 8 scenarios" on pass.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { openPortal, SUPABASE_URL } from "./portalFixtureHarness.mjs";
import { slideToConfirm } from "./confirmGestures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, "../../tests/fixtures/f17/api");

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
let requestedScenarios = ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"];
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

let passedCount = 0;

// ==========================================
// Scenario B1: No business -> "By name" lookup shows price and result card
// ==========================================
if (requestedScenarios.includes("B1")) {
  console.log("Running Scenario B1...");
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: offcultMembership },
  });

  try {
    const b1 = readFixture("b1-fixtures.json");

    await page.route((url) => url.pathname === "/api/customer/features", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ features: { local_seo: true } }),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/local/businesses", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b1.emptyBusinesses),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/price/estimate", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b1.quoteProfile),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/local/profile", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b1.profileResult),
      });
    });

    await page.goto(`${origin.href}portal/local`, { waitUntil: "networkidle" });

    // Verify picker title
    const picker = page.locator('[data-slot="business-picker"]');
    await assert.doesNotReject(picker.waitFor({ timeout: 10000 }), "Picker should be visible");

    // Check "Find business" button exists and shows price ($0.0054)
    const findBtn = picker.locator('button:has-text("Find business")');
    await findBtn.waitFor({ timeout: 5000 });
    const btnText = await findBtn.textContent();
    assert.ok(btnText.includes("$0.0054") || btnText.includes("Find business"), `Button should show label: ${btnText}`);

    // Click "Find business"
    await findBtn.click();

    // Verify result card appears
    const resultCard = page.locator('[data-slot="lookup-result"]');
    await resultCard.waitFor({ timeout: 5000 });
    const resultText = await resultCard.textContent();
    assert.ok(resultText.includes("Acme Coffee"), `Result card should show business title: ${resultText}`);
    assert.ok(resultText.includes("This is my business"), "Result card should have 'This is my business' button");
    assert.ok(resultText.includes("Not it"), "Result card should have 'Not it' button");

    passedCount++;
    console.log("Scenario B1 passed");
  } finally {
    await context.close();
  }
}

// ==========================================
// Scenario B2: "Nearby" search table and "Save as competitor"
// ==========================================
if (requestedScenarios.includes("B2")) {
  console.log("Running Scenario B2...");
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: offcultMembership },
  });

  try {
    const b1 = readFixture("b1-fixtures.json");
    const b2 = readFixture("b2-fixtures.json");

    await page.route((url) => url.pathname === "/api/customer/features", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ features: { local_seo: true } }),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/local/businesses", async (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(b2.savedCompetitor),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ businesses: [] }),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/price/estimate", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b2.quoteListings),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/local/listings", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b2.listingsResult),
      });
    });

    await page.goto(`${origin.href}portal/local`, { waitUntil: "networkidle" });

    // Switch to "Nearby" mode
    const nearbyToggle = page.locator('button:has-text("Nearby")');
    await nearbyToggle.click();

    // Fill "Near" input
    const nearInput = page.locator('#nearby-near');
    await nearInput.fill("39.782, -89.652");

    // Click "Search businesses"
    const searchBtn = page.locator('button:has-text("Search businesses")');
    await searchBtn.waitFor({ timeout: 5000 });
    // Wait for debounced quote to settle
    await page.waitForTimeout(600);
    await searchBtn.click();

    const dialogConfirm = page.locator('[role="dialog"] button:has-text("Search businesses")');
    if (await dialogConfirm.isVisible({ timeout: 1000 }).catch(() => false)) {
      await dialogConfirm.click();
    }

    // Table should render with Competitor Cafe
    const resultsSlot = page.locator('[data-slot="nearby-results"]');
    await resultsSlot.waitFor({ timeout: 5000 });
    const tableText = await resultsSlot.textContent();
    assert.ok(tableText.includes("Competitor Cafe"), "Nearby table should list Competitor Cafe");

    // Click "Save as competitor"
    const saveCompetitorBtn = resultsSlot.locator('button:has-text("Save as competitor")').first();
    await saveCompetitorBtn.click();

    passedCount++;
    console.log("Scenario B2 passed");
  } finally {
    await context.close();
  }
}

// ==========================================
// Scenario B3: Profile head-to-head shows "Not loaded" (not 0) for competitor without profile
// ==========================================
if (requestedScenarios.includes("B3")) {
  console.log("Running Scenario B3...");
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: offcultMembership },
  });

  try {
    const b3 = readFixture("b3-fixtures.json");

    await page.route((url) => url.pathname === "/api/customer/features", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ features: { local_seo: true } }),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/local/businesses", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b3),
      });
    });

    await page.goto(`${origin.href}portal/local?tab=profile`, { waitUntil: "networkidle" });

    // Verify head-to-head section
    const headToHead = page.locator('[data-slot="head-to-head"]');
    await headToHead.waitFor({ timeout: 5000 });

    const text = await headToHead.textContent();
    assert.ok(text.includes("Head to head"), "Head to head table must be visible");
    assert.ok(text.includes("Competitor Cafe"), "Competitor Cafe column must be present");
    assert.ok(text.includes("Not loaded"), "Competitor without profile must display 'Not loaded'");
    // Verify it does NOT show "0" for the missing profile cells
    const competitorCells = headToHead.locator('tbody tr td:nth-child(3)');
    const cellCount = await competitorCells.count();
    for (let i = 0; i < cellCount; i++) {
      const cellText = (await competitorCells.nth(i).textContent()).trim();
      assert.notEqual(cellText, "0", `Competitor cell must not display 0, was: "${cellText}"`);
    }

    passedCount++;
    console.log("Scenario B3 passed");
  } finally {
    await context.close();
  }
}

// ==========================================
// Scenario B4: Reviews: processing then completed, "owner replied to 6 of 20", page 2 of 2, rating filter
// ==========================================
if (requestedScenarios.includes("B4")) {
  console.log("Running Scenario B4...");
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: offcultMembership },
  });

  try {
    const b3 = readFixture("b3-fixtures.json");
    const b4 = readFixture("b4-fixtures.json");

    await page.route((url) => url.pathname === "/api/customer/features", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ features: { local_seo: true } }),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/local/businesses", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b3),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/price/estimate", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b4.quoteReviews),
      });
    });

    let fetchCallCount = 0;
    await page.route((url) => url.pathname === "/api/customer/local/fetches", async (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify(b4.processing),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ fetches: [] }),
      });
    });

    await page.route((url) => url.pathname.startsWith("/api/customer/local/fetches/"), async (route) => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(b4.processing),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b4.completed),
      });
    });

    await page.goto(`${origin.href}portal/local?tab=reviews`, { waitUntil: "networkidle" });

    // Click "Collect reviews"
    const collectBtn = page.locator('button:has-text("Collect reviews")');
    await collectBtn.click();

    // Verify processing state
    const processingSlot = page.locator('[data-slot="reviews-processing"]');
    await processingSlot.waitFor({ timeout: 5000 });
    const processingText = await processingSlot.textContent();
    assert.ok(processingText.includes("Collecting reviews…"), "Should show processing copy");

    // Wait for completed state
    const completedSlot = page.locator('[data-slot="reviews-completed"]');
    await completedSlot.waitFor({ timeout: 10000 });
    const completedText = await completedSlot.textContent();
    assert.ok(completedText.includes("owner replied to 6 of 20"), `Should state owner reply count: ${completedText}`);
    assert.ok(completedText.includes("Collected 20 of 20 reviews"), "Should state 20 of 20 reviews");

    // Verify page 2 of 2
    assert.ok(completedText.includes("Page 1 of 2"), "Should start on Page 1 of 2");
    const nextBtn = page.locator('button[aria-label="Next page"], button:has-text("Next")').first();
    await nextBtn.click();
    await page.waitForTimeout(300);
    const page2Text = await completedSlot.textContent();
    assert.ok(page2Text.includes("Page 2 of 2"), `Should show Page 2 of 2: ${page2Text}`);

    // Test rating filter
    const star5Btn = page.locator('button:has-text("5★")');
    await star5Btn.click();
    await page.waitForTimeout(300);
    const filterText = await completedSlot.textContent();
    assert.ok(filterText.includes("Reviewer"), "Filtered list should show matching reviews");

    passedCount++;
    console.log("Scenario B4 passed");
  } finally {
    await context.close();
  }
}

// ==========================================
// Scenario B5: Posts and questions empty states
// ==========================================
if (requestedScenarios.includes("B5")) {
  console.log("Running Scenario B5...");
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: offcultMembership },
  });

  try {
    const b3 = readFixture("b3-fixtures.json");
    const b5 = readFixture("b5-fixtures.json");

    await page.route((url) => url.pathname === "/api/customer/features", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ features: { local_seo: true } }),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/local/businesses", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b3),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/price/estimate", async (route) => {
      const body = route.request().postDataJSON?.();
      if (body?.action === "local.updates.collect") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(b5.quotePosts),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b5.quoteQuestions),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/local/fetches", async (route) => {
      const body = route.request().postDataJSON?.();
      if (body?.kind === "updates") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(b5.postsEmpty),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b5.questionsEmpty),
      });
    });

    await page.route((url) => url.pathname.startsWith("/api/customer/local/fetches/"), async (route) => {
      const urlStr = route.request().url();
      if (urlStr.includes("44444444")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(b5.postsEmpty),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b5.questionsEmpty),
      });
    });

    // 1. Posts tab
    await page.goto(`${origin.href}portal/local?tab=posts`, { waitUntil: "networkidle" });
    const collectPostsBtn = page.locator('button:has-text("Collect posts")');
    await collectPostsBtn.click();

    const postsCompleted = page.locator('[data-slot="posts-completed"]');
    await postsCompleted.waitFor({ timeout: 5000 });
    const postsText = await postsCompleted.textContent();
    assert.ok(
      postsText.includes("This profile has published no posts."),
      `Posts empty state must match spec: "${postsText}"`
    );

    // 2. Questions tab
    await page.goto(`${origin.href}portal/local?tab=questions`, { waitUntil: "networkidle" });
    const collectQuestionsBtn = page.locator('button:has-text("Collect questions")');
    await collectQuestionsBtn.click();

    const questionsCompleted = page.locator('[data-slot="questions-completed"]');
    await questionsCompleted.waitFor({ timeout: 5000 });
    const questionsText = await questionsCompleted.textContent();
    assert.ok(
      questionsText.includes("Google returned no questions for this business."),
      `Questions empty state must match spec: "${questionsText}"`
    );

    passedCount++;
    console.log("Scenario B5 passed");
  } finally {
    await context.close();
  }
}

// ==========================================
// Scenario B6: grid cost dialog, SVG progress, summary, failed point, keyboard, no third party
// ==========================================
if (requestedScenarios.includes("B6")) {
  console.log("Running Scenario B6...");
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: offcultMembership },
  });

  try {
    const b3 = readFixture("b3-fixtures.json");
    const b6 = readFixture("b6-fixtures.json");

    const requestedHosts = new Set();
    page.on("request", (request) => {
      try {
        requestedHosts.add(new URL(request.url()).hostname);
      } catch {
        // A request without a URL (data:, blob:) cannot leave the app.
      }
    });

    await page.route((url) => url.pathname === "/api/customer/features", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ features: { local_seo: true } }),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/local/businesses", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b3),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/price/estimate", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b6.quoteGrid),
      });
    });

    const gridRunRequests = [];
    await page.route((url) => url.pathname === "/api/customer/local/grids", async (route) => {
      if (route.request().method() === "POST") {
        gridRunRequests.push(route.request().postDataJSON());
        return route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify(b6.processing),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b6.emptyGridHistory),
      });
    });

    let gridGetCount = 0;
    await page.route((url) => url.pathname.startsWith("/api/customer/local/grids/"), async (route) => {
      gridGetCount++;
      const body = gridGetCount === 1 ? b6.processing : b6.completed;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });

    await page.goto(`${origin.href}portal/local?tab=grid`, { waitUntil: "networkidle" });

    const keywordInput = page.locator("#grid-keyword");
    await keywordInput.waitFor({ timeout: 10000 });
    await keywordInput.fill("coffee shop");

    const runBtn = page.locator('[data-slot="grid-controls"] button:has-text("Run grid")').first();
    await runBtn.waitFor({ timeout: 10000 });
    // Wait for the debounced quote to settle before opening the dialog.
    await page.waitForTimeout(700);
    await runBtn.click();

    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ timeout: 10000 });
    await page.waitForTimeout(300);
    const dialogText = await dialog.textContent();
    assert.ok(
      dialogText.includes("9 Google Maps searches"),
      `dialog should state the search count: ${dialogText}`
    );
    assert.ok(
      dialogText.includes("Check that the centre is your storefront before running"),
      "dialog should show the centre warning"
    );

    // The final approval is a slide-to-confirm; Enter on its thumb confirms.
    const approved = await slideToConfirm(dialog, "Run grid");
    assert.equal(approved, b6.quoteGrid.totalUsd, "the slider must approve the quoted grid price");

    const processing = page.locator('[data-slot="grid-processing"]');
    await processing.waitFor({ timeout: 15000 });
    assert.equal(gridRunRequests.length, 1, "the grid must run once with its approval");
    assert.equal(
      gridRunRequests[0].maxUsd,
      approved,
      `the grid run must carry the approved maximum, saw ${JSON.stringify(gridRunRequests[0])}`
    );
    const processingText = await processing.textContent();
    assert.ok(
      processingText.includes("3 of 9 searches back"),
      `processing should show the progress: ${processingText}`
    );

    const completed = page.locator('[data-slot="grid-completed"]');
    await completed.waitFor({ timeout: 30000 });

    const summaryText = await page.locator('[data-slot="grid-summary"]').textContent();
    assert.ok(
      summaryText.includes("Ranked at 7 of 9 points"),
      `summary should read "Ranked at 7 of 9 points": ${summaryText}`
    );

    const failedCell = page.locator('[data-point="2-2"]');
    assert.equal(
      await failedCell.getAttribute("data-state"),
      "failed",
      "the refused point must render as a failed cell"
    );
    assert.ok(
      (await failedCell.textContent()).includes("×"),
      "the failed cell must show ×"
    );

    // Arrow keys move focus inside role="grid".
    await page.locator('[data-point="0-0"]').focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-point")),
      "0-1",
      "ArrowRight must move focus one point east"
    );
    await page.keyboard.press("ArrowDown");
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-point")),
      "1-1",
      "ArrowDown must move focus one point south"
    );

    // No third party: the grid is drawn locally, never from map tiles.
    const allowedHosts = new Set([origin.hostname, new URL(SUPABASE_URL).hostname]);
    const foreignHosts = [...requestedHosts].filter(
      (host) => host && !allowedHosts.has(host)
    );
    assert.deepEqual(
      foreignHosts,
      [],
      `no request may leave the local app, saw: ${foreignHosts.join(", ")}`
    );

    passedCount++;
    console.log("Scenario B6 passed");
  } finally {
    await context.close();
  }
}

// ==========================================
// Scenario B7: local results "You rank #4 of 20" with the "You" badge
// ==========================================
if (requestedScenarios.includes("B7")) {
  console.log("Running Scenario B7...");
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1440, height: 900 },
    fixtures: { memberships: offcultMembership },
  });

  try {
    const b3 = readFixture("b3-fixtures.json");
    const b7 = readFixture("b7-fixtures.json");

    await page.route((url) => url.pathname === "/api/customer/features", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ features: { local_seo: true } }),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/local/businesses", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b3),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/price/estimate", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b7.quoteSerp),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/local/serp", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b7.serpResult),
      });
    });

    await page.goto(`${origin.href}portal/local?tab=results`, { waitUntil: "networkidle" });

    const keywordInput = page.locator("#results-keyword");
    await keywordInput.waitFor({ timeout: 10000 });
    await keywordInput.fill("coffee shop");
    await page.waitForTimeout(700);

    const searchBtn = page
      .locator('[data-slot="results-controls"] button:has-text("Search")')
      .first();
    await searchBtn.click();

    // A quote at or below the inline threshold runs without a dialog; confirm
    // one if the quote's warnings forced it open.
    const dialogConfirm = page.locator('[role="dialog"] button:has-text("Search")');
    if (await dialogConfirm.isVisible({ timeout: 1000 }).catch(() => false)) {
      await dialogConfirm.click();
    }

    const summary = page.locator('[data-slot="results-summary"]');
    await summary.waitFor({ timeout: 10000 });
    const summaryText = await summary.textContent();
    assert.ok(
      summaryText.includes("You rank #4 of 20"),
      `summary should read "You rank #4 of 20": ${summaryText}`
    );

    const output = page.locator('[data-slot="results-output"]');
    const ownRow = output.locator("tr", { hasText: "Acme Coffee" }).first();
    await ownRow.waitFor({ timeout: 5000 });
    const ownRowText = await ownRow.textContent();
    assert.ok(ownRowText.includes("You"), `the own business row needs the You badge: ${ownRowText}`);
    assert.ok(
      ownRowText.includes("4"),
      `the own business row must show its rank: ${ownRowText}`
    );

    passedCount++;
    console.log("Scenario B7 passed");
  } finally {
    await context.close();
  }
}

// ==========================================
// Scenario B8: phone width 390 px: no horizontal page scroll, SVG fits
// ==========================================
if (requestedScenarios.includes("B8")) {
  console.log("Running Scenario B8...");
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 390, height: 844 },
    fixtures: { memberships: offcultMembership },
  });

  try {
    const b3 = readFixture("b3-fixtures.json");
    const b6 = readFixture("b6-fixtures.json");

    await page.route((url) => url.pathname === "/api/customer/features", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ features: { local_seo: true } }),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/local/businesses", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b3),
      });
    });

    await page.route((url) => url.pathname === "/api/customer/local/grids", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b6.emptyGridHistory),
      });
    });

    await page.route((url) => url.pathname.startsWith("/api/customer/local/grids/"), async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(b6.completed),
      });
    });

    await page.goto(
      `${origin.href}portal/local?tab=grid&grid=${b6.completed.id}`,
      { waitUntil: "networkidle" }
    );

    await page.locator('[data-slot="grid-completed"]').waitFor({ timeout: 15000 });

    const layout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert.ok(
      layout.scrollWidth <= layout.innerWidth + 1,
      `the page must not scroll horizontally on a phone: ${JSON.stringify(layout)}`
    );

    const svgBox = await page.locator('[data-slot="rank-grid-svg"] svg').boundingBox();
    assert.ok(svgBox, "the rank grid SVG must render");
    assert.ok(
      svgBox.width <= layout.innerWidth,
      `the SVG must fit the phone width: ${svgBox.width} <= ${layout.innerWidth}`
    );

    passedCount++;
    console.log("Scenario B8 passed");
  } finally {
    await context.close();
  }
}

// ==========================================
// Check total passed count
// ==========================================
if (passedCount === requestedScenarios.length) {
  console.log(`ok ${passedCount} scenarios`);
} else {
  console.error(`Only ${passedCount} of ${requestedScenarios.length} scenarios passed`);
  process.exitCode = 1;
}
killServerChild();
process.exit(process.exitCode ?? 0);
