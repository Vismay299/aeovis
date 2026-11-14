#!/usr/bin/env node
/** F15 Phase 4: rank-tracking setup-wizard browser scenarios, fixtures only. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openPortal, SUPABASE_URL } from "./portalFixtureHarness.mjs";

let chromium;
try {
  ({ chromium } = await import("../../worker/node_modules/playwright/index.mjs"));
} catch {
  ({ chromium } = await import("playwright"));
}

const originArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "http://127.0.0.1:3341";
const origin = new URL(originArg);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "browser checks require a disposable local app");
const port = Number(origin.port || 3341);
async function waitForServer(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(new URL("/portal/rank-tracking", origin), { redirect: "manual" });
      if (response.status !== 404 && response.status !== 503) return true;
    } catch { /* wait */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}
let serverChild = null;
if (!(await waitForServer(1000))) {
  serverChild = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", String(port)], {
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key" },
    stdio: "ignore",
  });
  if (!(await waitForServer(90000))) {
    serverChild.kill("SIGTERM");
    throw new Error(`Next.js dev server failed to start on port ${port}`);
  }
}
const onlyIndex = process.argv.indexOf("--only");
const requested = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : "B1-B3";
const selectedScenarios = new Set();
for (const selection of requested.split(",")) {
  const range = selection.match(/^B(\d+)-B(\d+)$/);
  if (range) {
    for (let id = Number(range[1]); id <= Number(range[2]); id += 1) selectedScenarios.add(`B${id}`);
  } else {
    selectedScenarios.add(selection);
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_FIXTURES = path.resolve(HERE, "../../tests/fixtures/f15/api");
async function apiFixture(name) {
  return JSON.parse(await readFile(path.join(API_FIXTURES, name), "utf8"));
}
const emptyList = await apiFixture("trackers-empty.json");
const createdTracker = await apiFixture("tracker-created-weekly.json");
const quote1 = await apiFixture("config-save-quote-1.json");
const quote50 = await apiFixture("config-save-quote-50.json");
const suggestionsQuote = await apiFixture("suggestions-quote.json");
const suggestions25 = await apiFixture("suggestions-25.json");
const keywordsApprovalQuote = await apiFixture("keywords-approval-quote.json");
const checkQuote = await apiFixture("check-quote.json");

const browser = await chromium.launch({ headless: true });
let failures = 0;
let passed = 0;

async function record(id, expected, run) {
  if (!selectedScenarios.has(id)) return;
  try {
    const actual = await run();
    passed += 1;
    console.log(`${id}: PASS — ${actual}`);
  } catch (error) {
    failures += 1;
    console.error(`${id}: FAIL — ${error?.stack || error}`);
  }
}

async function makePage() {
  const { context, page } = await openPortal(browser, origin, {
    viewport: { width: 1280, height: 900 },
  });
  const suggestionsRequests = [];
  const keywordsRequests = [];
  const checkRequests = [];
  let keywordsCalls = 0;
  await page.route("**/api/customer/features*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ brandKey: "acme", features: { rank_tracking: true } }),
  }));
  await page.route("**/api/customer/rank-tracking/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/customer/rank-tracking/configs") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyList) });
    }
    if (request.method() === "POST" && url.pathname === "/api/customer/rank-tracking/configs") {
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(createdTracker) });
    }
    if (url.pathname.endsWith("/keywords")) {
      keywordsCalls += 1;
      const body = request.postDataJSON();
      keywordsRequests.push(body);
      if (keywordsCalls === 1) {
        assert.equal(body.maxUsd, undefined, "the first save must not carry an approval");
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Approve the price of scheduled checks to start them.",
            code: "approval_required",
            details: { quote: keywordsApprovalQuote },
          }),
        });
      }
      assert.equal(body.maxUsd, keywordsApprovalQuote.totalUsd, "the retry must approve the quoted maximum");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          added: body.keywords.length,
          addedIds: [],
          skipped: 0,
          metricsFromCache: 0,
          approval: { approvedMaxUsd: body.maxUsd, quote: keywordsApprovalQuote },
        }),
      });
    }
    if (url.pathname.endsWith("/check")) {
      const body = request.postDataJSON();
      checkRequests.push(body);
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ runId: "a1000000-0000-4000-8000-000000000000", jobId: "b2000000-0000-4000-8000-000000000000", status: "queued", pollAfterSeconds: 3 }),
      });
    }
    return route.continue();
  });
  await page.route("**/api/customer/rank-tracking/suggestions", (route) => {
    const body = route.request().postDataJSON();
    suggestionsRequests.push(body);
    if (body.cacheOnly) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ keywords: null }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(suggestions25) });
  });
  await page.route("**/api/customer/price/estimate*", (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "rank_tracking.suggestions.run") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...suggestionsQuote, action: body.action }) });
    }
    if (body.action === "rank_tracking.check.run") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...checkQuote, action: body.action }) });
    }
    const count = body.input?.draft?.keywordCount ?? 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(count >= 50 ? quote50 : quote1) });
  });
  return { context, page, suggestionsRequests, keywordsRequests, checkRequests };
}

async function openList(options) {
  const state = await makePage(options);
  await state.page.goto(new URL("/portal/rank-tracking", origin).href, { waitUntil: "networkidle" });
  return state;
}

function dialog(page) {
  return page.getByRole("dialog");
}

try {
  await record("B1", "empty list and Add Domain defaults with live cost text", async () => {
    const { context, page } = await openList();
    try {
      await page.getByText("No tracked domains yet").waitFor();
      await page.getByText("Add a domain to start monitoring keyword rankings over time.").waitFor();
      await page.getByRole("button", { name: "Add Domain" }).first().click();
      const dlg = dialog(page);
      await dlg.getByText("Add Domain", { exact: true }).first().waitFor();
      assert.equal(await dlg.getByLabel("Target Domain").inputValue(), "acme.example");
      assert.equal(await dlg.getByLabel("Target Domain").getAttribute("placeholder"), "example.com");
      await dlg.getByText("Mobile only", { exact: true }).first().waitFor();
      await dlg.getByText("4 pages (top 40 results)", { exact: true }).waitFor();
      await dlg.getByText("Weekly", { exact: true }).waitFor();
      await dlg.getByText("up to $0.0123").waitFor();
      await dlg.getByText("per keyword per check").waitFor();
      await dlg.getByText("$2.46/month").waitFor();
      await dlg.getByRole("button", { name: "Add Domain" }).last().waitFor();
      await dlg.getByRole("button", { name: "Cancel" }).waitFor();
      return "empty state, domain/country default and Mobile-only, 4-page, Weekly defaults with both cost lines";
    } finally { await context.close(); }
  });

  await record("B2", "daily and both-devices cost notes", async () => {
    const { context, page } = await openList();
    try {
      await page.getByText("No tracked domains yet").waitFor();
      await page.getByRole("button", { name: "Add Domain" }).first().click();
      const dlg = dialog(page);
      await dlg.getByText("Weekly", { exact: true }).waitFor();
      await dlg.getByText("Weekly", { exact: true }).click();
      await page.getByRole("option", { name: "Daily" }).click();
      await dlg.getByText("Daily checks cost about 7 times as much as weekly.").waitFor();
      await dlg.getByText("Mobile only", { exact: true }).first().click();
      await page.getByRole("option", { name: "Desktop + Mobile" }).click();
      await dlg.getByText("Tracking both devices doubles the cost of every check.").waitFor();
      await dlg.getByRole("button", { name: "Cancel" }).click();
      return "the 7x daily note and the doubling note each appeared on selection";
    } finally { await context.close(); }
  });

  await record("B3", "priced keyword step with top-20 preselect, approval and first check", async () => {
    const { context, page, suggestionsRequests, keywordsRequests, checkRequests } = await openList();
    try {
      await page.getByText("No tracked domains yet").waitFor();
      await page.getByRole("button", { name: "Add Domain" }).first().click();
      const dlg = dialog(page);
      await dlg.getByText("Add Domain", { exact: true }).first().waitFor();
      await dlg.getByRole("button", { name: "Add Domain" }).last().click();
      await dlg.getByText("Find the keywords acme.example already ranks for").waitFor();
      assert.ok(
        suggestionsRequests.length >= 1 && suggestionsRequests.every((request) => request.cacheOnly === true),
        `opening the step must read cacheOnly only, saw ${JSON.stringify(suggestionsRequests)}`,
      );
      assert.equal(
        suggestionsRequests.filter((request) => request.cacheOnly === false).length,
        0,
        "no paid suggestions request before the click",
      );
      await dlg.getByRole("button", { name: /Find ranking keywords/ }).click();
      await dlg.getByText("20 of 25 selected").waitFor();
      assert.equal(suggestionsRequests.filter((request) => request.cacheOnly === false).length, 1);
      await dlg.getByRole("button", { name: "Save Keywords" }).click();
      const approval = page.getByRole("dialog", { name: "Approve scheduled checks" });
      await approval.waitFor();
      await approval.getByText("20 keywords on Mobile, checked weekly").waitFor();
      await approval.getByRole("button", { name: "Approve and save" }).click();
      assert.equal(keywordsRequests.length, 2, `expected the save plus its approval retry, saw ${keywordsRequests.length}`);
      await page.getByText("Added 20 keywords for tracking").waitFor();
      await dlg.getByText("Check rankings now?").waitFor();
      await dlg.getByRole("button", { name: /Check 20 keywords now/ }).click();
      const review = page.getByRole("dialog", { name: "Check rankings now", exact: true });
      await review.waitFor();
      await review.getByRole("button", { name: "Run check" }).click();
      await page.getByText("Rank check started").waitFor();
      assert.equal(checkRequests.length, 1, "the first check must run once with its approval");
      return "cacheOnly-first fetch, 25 rows with 20 checked, approval retry, then the first check";
    } finally { await context.close(); }
  });
} finally {
  await browser.close();
  if (serverChild) serverChild.kill("SIGTERM");
}

if (failures) process.exitCode = 1;
else console.log(`ok ${passed} scenario${passed === 1 ? "" : "s"}`);
