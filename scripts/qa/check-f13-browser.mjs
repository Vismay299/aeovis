#!/usr/bin/env node
/** F13 Phase 4: research-page browser scenarios, using local fixtures only. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { openPortal } from "./portalFixtureHarness.mjs";
import { SUPABASE_URL } from "./portalFixtureHarness.mjs";

let chromium;
try {
  ({ chromium } = await import("../../worker/node_modules/playwright/index.mjs"));
} catch {
  ({ chromium } = await import("playwright"));
}

const originArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "http://127.0.0.1:3328";
const origin = new URL(originArg);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "browser checks require a disposable local app");
const port = Number(origin.port || 3328);
async function waitForServer(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(new URL("/portal/keywords", origin), { redirect: "manual" });
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
  if (!(await waitForServer(60000))) {
    serverChild.kill("SIGTERM");
    throw new Error(`Next.js dev server failed to start on port ${port}`);
  }
}
const onlyIndex = process.argv.indexOf("--only");
const requested = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : "B1-B18";
const selectedScenarios = new Set();
for (const selection of requested.split(",")) {
  const range = selection.match(/^B(\d+)-B(\d+)$/);
  if (range) {
    for (let id = Number(range[1]); id <= Number(range[2]); id++) selectedScenarios.add(`B${id}`);
  } else {
    selectedScenarios.add(selection);
  }
}

const quote = {
  action: "keywords.research.run", currency: "USD", totalUsd: 0.0755, expectedUsd: 0.05,
  units: [{ key: "keywords", label: "keywords", count: 150 }],
  lines: [
    { label: "Keyword ideas", quantity: 1, unitUsd: 0.06, totalUsd: 0.06 },
    { label: "SERP analysis", quantity: 1, unitUsd: 0.0155, totalUsd: 0.0155 },
  ], monthly: null, warnings: [], blocked: null, priceVersion: "v1",
  quotedAt: "2026-11-10T12:00:00.000Z",
  inputsHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};
const rows = [
  { keyword: "oversized t shirt", searchVolume: 74000, trend: [{ year: 2026, month: 9, searchVolume: 74000 }], cpc: 0.41, competition: 0.72, keywordDifficulty: 38, intent: "transactional" },
  { keyword: "oversized shirt for men", searchVolume: 12000, trend: [{ year: 2026, month: 9, searchVolume: 12000 }], cpc: 0.34, competition: 0.5, keywordDifficulty: 24, intent: "commercial" },
  { keyword: "oversized tee outfit", searchVolume: 4800, trend: [{ year: 2026, month: 9, searchVolume: 4800 }], cpc: null, competition: null, keywordDifficulty: null, intent: "informational" },
];
const familyRows = [
  ...Array.from({ length: 49 }, (_, index) => ({
    keyword: `volume filler ${index + 1}`,
    searchVolume: 30000 - index * 100,
    trend: [{ year: 2026, month: 9, searchVolume: 30000 - index * 100 }],
    cpc: 0.1 + index / 100,
    competition: 0.2,
    keywordDifficulty: 20,
    intent: "commercial",
  })),
  { keyword: "family alpha", searchVolume: 10000, trend: [{ year: 2026, month: 8, searchVolume: 10000 }, { year: 2026, month: 9, searchVolume: 8000 }], cpc: 0.55, competition: 0.5, keywordDifficulty: 30, intent: "commercial" },
  { keyword: "family beta", searchVolume: 10000, trend: [{ year: 2026, month: 8, searchVolume: 10000 }, { year: 2026, month: 9, searchVolume: 8000 }], cpc: 0.55, competition: 0.5, keywordDifficulty: 32, intent: "commercial" },
];
const serpItems = [{ rank: 1, title: "Oversized T-Shirts", url: "https://example.test/oversized", domain: "example.test", description: "A fixture search result.", etv: 10, estimatedPaidTrafficCost: null, referringDomains: 1, backlinks: 2, isNew: false, rankChange: null }];
const browser = await chromium.launch({ headless: true });
let failures = 0;
let passed = 0;

async function record(id, expected, run) {
  if (selectedScenarios && !selectedScenarios.has(id)) return;
  try {
    const actual = await run();
    passed += 1;
    console.log(`${id}: PASS — ${actual}`);
  } catch (error) {
    failures += 1;
    console.error(`${id}: FAIL — ${error?.stack || error}`);
  }
}

async function makePage({ flag = true, cacheMiss = true, serpCacheMiss = false, serpItemCount = 1, serpDepth100Error = false, priceChanged = false, viewport = { width: 1280, height: 900 }, fixtureRows = rows, researchErrorCode = null, delayedQuoteKeyword = null } = {}) {
  const { context, page } = await openPortal(browser, origin, { viewport });
  const researchRequests = [];
  const serpRequests = [];
  await page.route("**/api/customer/features*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ brandKey: "acme", features: { keyword_research: flag, price_review: true } }) }));
  await page.route("**/api/customer/price/estimate*", async (route) => {
    const body = route.request().postDataJSON();
    if (delayedQuoteKeyword && body.input?.keyword === delayedQuoteKeyword) await new Promise((resolve) => setTimeout(resolve, 900));
    if (body.action === "keywords.serp.run") {
      const totalUsd = body.input?.depth === 100 ? 0.0155 : 0.0035;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...quote, action: body.action, totalUsd, expectedUsd: totalUsd, lines: [{ label: `Top ${body.input?.depth ?? 20} Google results`, quantity: 1, unitUsd: totalUsd, totalUsd }] }) });
    }
    if (body.input?.locationName) {
      const local = { label: `Local volume for ${body.input.locationName}`, quantity: 1, unitUsd: 0.09, totalUsd: 0.09 };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...quote, action: body.action, totalUsd: quote.totalUsd + 0.09, expectedUsd: quote.expectedUsd + 0.09, lines: [...quote.lines, local] }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...quote, action: body.action }) });
  });
  const locationRequests = [];
  await page.route("**/api/customer/keywords/locations*", (route) => {
    const url = new URL(route.request().url());
    locationRequests.push(Object.fromEntries(url.searchParams));
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const registry = [
      { locationName: "Mumbai,Maharashtra,India", displayLabel: "Mumbai, Maharashtra, India", locationType: "City" },
      { locationName: "Navi Mumbai,Maharashtra,India", displayLabel: "Navi Mumbai, Maharashtra, India", locationType: "City" },
      { locationName: "Pune,Maharashtra,India", displayLabel: "Pune, Maharashtra, India", locationType: "City" },
    ];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ locations: registry.filter((row) => row.locationName.toLowerCase().includes(q)) }) });
  });
  await page.route("**/api/customer/keywords/research", (route) => {
    const body = route.request().postDataJSON();
    researchRequests.push(body);
    if (priceChanged && !body.cacheOnly) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "The price changed", code: "price_changed" }) });
    if (researchErrorCode) return route.fulfill({ status: researchErrorCode === "research_invalid" ? 422 : 400, contentType: "application/json", body: JSON.stringify({ error: "This keyword cannot be used.", code: researchErrorCode }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body.cacheOnly && cacheMiss ? { notCached: true, cached: false } : { rows: fixtureRows, source: "blended", cached: false, fetchedAt: "2026-11-10T12:00:00.000Z" }) });
  });
  await page.route("**/api/customer/keywords/serp", (route) => {
    const body = route.request().postDataJSON();
    serpRequests.push(body);
    if (body.depth === 100 && serpDepth100Error) return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Deep crawl unavailable.", code: "serp_unavailable" }) });
    if (body.cacheOnly && serpCacheMiss) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notCached: true, cached: false, depth: body.depth }) });
    const count = body.depth === 100 ? 100 : serpItemCount;
    const items = Array.from({ length: count }, (_, index) => ({ ...serpItems[0], rank: index + 1, title: `Search result ${index + 1}` }));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requestedKeyword: body.keyword, depth: body.depth, items, cached: body.cacheOnly }) });
  });
  await page.route("**/api/customer/keywords/saved", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ created: route.request().postDataJSON().keywords.length, savedKeywordIds: [] }) }));
  return { context, page, researchRequests, serpRequests, locationRequests };
}

async function openResearch(options, url = "/portal/keywords") {
  const state = await makePage(options);
  await state.page.goto(new URL(url, origin).href, { waitUntil: "networkidle" });
  return state;
}

try {
  await record("B1", "feature-off navigation and unavailable copy", async () => {
    const { context, page } = await openResearch({ flag: false });
    try {
      const body = await page.locator("body").innerText();
      assert.ok(body.includes("This page is not available for your workspace yet."), `Unexpected page copy: ${body}`);
      assert.ok(body.includes("Ask Perceev support to turn on keyword research."), `Unexpected page copy: ${body}`);
      assert.equal(await page.getByRole("link", { name: "Keywords" }).count(), 0);
      return "flag-off page is unavailable and Keywords navigation is hidden";
    } finally { await context.close(); }
  });

  await record("B2", "URL opens with only cacheOnly research and a priced cache-miss card", async () => {
    const { context, page, researchRequests } = await openResearch({}, "/portal/keywords?q=oversized+t+shirt");
    try {
      await page.waitForTimeout(750);
      const body = await page.locator("body").innerText();
      assert.ok(body.includes("Results for “oversized t shirt” are not loaded"), `Cache miss card was absent. Requests: ${researchRequests.length}; body: ${body}`);
      assert.match(await page.locator("button").filter({ hasText: "Run search" }).first().innerText(), /Run search · up to \$0\.08/);
      assert.ok(researchRequests.length >= 1 && researchRequests.every((request) => request.cacheOnly === true));
      return "initial URL lookup was cache-only and showed the priced miss";
    } finally { await context.close(); }
  });

  await record("B3", "priced run carries maxUsd and requestId, results load, seed SERP runs once", async () => {
    const { context, page, researchRequests, serpRequests } = await openResearch({}, "/portal/keywords?q=oversized+t+shirt");
    try {
      await page.getByRole("button", { name: /Run search · up to \$0\.08/ }).click();
      await page.getByRole("button", { name: "oversized shirt for men" }).waitFor();
      const run = researchRequests.find((request) => request.cacheOnly === false);
      assert.equal(run.maxUsd, 0.0755); assert.ok(run.requestId);
      await page.waitForFunction(() => document.body.innerText.includes("SERP Analysis: oversized t shirt"));
      assert.equal(serpRequests.filter((request) => request.keyword === "oversized t shirt").length, 1);
      return "paid search and seed SERP each ran once with the approved ceiling";
    } finally { await context.close(); }
  });

  await record("B4", "row click updates the selected overview and SERP", async () => {
    const { context, page, serpRequests } = await openResearch({ cacheMiss: false }, "/portal/keywords?q=oversized+t+shirt");
    try {
      const overview = page.getByTestId("keyword-overview").first();
      await overview.waitFor({ state: "visible" });
      assert.match(await overview.innerText(), /oversized t shirt/);
      await page.getByRole("button", { name: "oversized shirt for men" }).click();
      await page.waitForFunction(() => document.body.innerText.includes("SERP Analysis: oversized shirt for men"));
      await page.waitForFunction(() => document.querySelector('[data-testid="keyword-overview"]')?.innerText.includes("oversized shirt for men"));
      assert.match(await overview.innerText(), /oversized shirt for men/);
      assert.ok(serpRequests.some((request) => request.keyword === "oversized shirt for men"));
      return "selected keyword updated the overview and SERP card";
    } finally { await context.close(); }
  });

  await record("B5", "approximate-match notice, filter-empty state, and clear action", async () => {
    const { context, page } = await openResearch({ cacheMiss: false }, "/portal/keywords?q=oversized+t+shirt&mode=ideas");
    try {
      await page.getByText(/No exact match for .* Showing closest related keywords instead\./).waitFor();
      await page.getByRole("button", { name: "Filters" }).click();
      await page.getByLabel("Search Volume minimum").fill("10000");
      await page.getByLabel("Search Volume maximum").fill("20000");
      await page.getByLabel("CPC (USD) minimum").fill("0.33");
      await page.getByLabel("CPC (USD) maximum").fill("0.35");
      await page.getByLabel("Difficulty minimum").fill("20");
      await page.getByLabel("Difficulty maximum").fill("25");
      await page.getByRole("button", { name: "oversized shirt for men" }).waitFor({ state: "visible" });
      await page.getByRole("button", { name: "oversized t shirt" }).waitFor({ state: "hidden" });
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Filters" }).click();
      assert.equal(await page.getByLabel("Search Volume minimum").inputValue(), "10000");
      assert.equal(await page.getByLabel("Search Volume maximum").inputValue(), "20000");
      assert.equal(await page.getByLabel("CPC (USD) minimum").inputValue(), "0.33");
      assert.equal(await page.getByLabel("CPC (USD) maximum").inputValue(), "0.35");
      assert.equal(await page.getByLabel("Difficulty minimum").inputValue(), "20");
      assert.equal(await page.getByLabel("Difficulty maximum").inputValue(), "25");
      await page.getByRole("button", { name: "Clear filters" }).first().click();
      await page.getByLabel("Include Terms").fill("no-such-keyword");
      await page.getByText("No results match these filters").waitFor();
      await page.getByRole("button", { name: "Clear filters" }).last().click();
      await page.getByRole("button", { name: "oversized shirt for men" }).waitFor();
      return "filters, approximate notice, empty result and clear action work";
    } finally { await context.close(); }
  });

  await record("B6", "selected keywords save and show the success toast", async () => {
    const { context, page } = await openResearch({ cacheMiss: false }, "/portal/keywords?q=oversized+t+shirt");
    try {
      for (const keyword of rows.map((row) => row.keyword)) await page.getByRole("checkbox", { name: `Select ${keyword}` }).check();
      await page.getByRole("button", { name: "Save Keywords" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
      await page.getByText("Saved 3 keywords").waitFor();
      return "three selected rows were saved";
    } finally { await context.close(); }
  });

  await record("B7", "price_changed opens the F09 review state", async () => {
    const { context, page } = await openResearch({ priceChanged: true }, "/portal/keywords?q=oversized+t+shirt");
    try {
      await page.getByRole("button", { name: /Run search/ }).click();
      await page.getByRole("dialog").getByText("The price changed").first().waitFor();
      return "price change is surfaced in the review dialog";
    } finally { await context.close(); }
  });

  await record("B8", "375px layout fits viewport and mobile tabs switch panels", async () => {
    const { context, page } = await openResearch({ cacheMiss: false, viewport: { width: 375, height: 812 } }, "/portal/keywords?q=oversized+t+shirt");
    try {
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(width <= 375, `document width ${width} exceeded 375px`);
      await page.getByRole("tab", { name: "SERP Analysis" }).click();
      assert.equal(await page.getByText("Search Trends").isVisible().catch(() => false), false);
      const overviewCards = page.getByTestId("keyword-overview");
      assert.ok(await overviewCards.count() > 0, "overview stats should remain in the responsive layout");
      for (const card of await overviewCards.all()) assert.equal(await card.isVisible(), false, "overview stats must be hidden below md");
      await page.getByRole("tab", { name: /Keywords/ }).click();
      await page.getByRole("button", { name: "oversized shirt for men" }).waitFor();
      return "375px fits and both mobile panels are reachable";
    } finally { await context.close(); }
  });

  await record("B9", "multi-line submit creates one tab per keyword and searches the first", async () => {
    const { context, page, researchRequests } = await openResearch({}, "/portal/keywords");
    try {
      await page.getByLabel("Keywords").fill("keyboard stand\nusb microphone\nmonitor arm");
      const search = page.locator("#keyword-research-submit");
      await page.waitForFunction(() => {
        const button = document.querySelector("#keyword-research-submit");
        return Boolean(button && !button.disabled);
      });
      await search.click();
      await page.getByRole("button", { name: "oversized shirt for men" }).waitFor();
      const run = researchRequests.find((request) => request.cacheOnly === false);
      assert.equal(run.keyword, "keyboard stand");
      assert.ok(run.requestId);
      assert.equal(researchRequests.filter((request) => request.cacheOnly === false).length, 1);
      for (const keyword of ["keyboard stand", "usb microphone", "monitor arm"]) {
        const tab = page.getByRole("button", { name: keyword, exact: true });
        await tab.waitFor();
        assert.equal(await tab.count(), 1, `expected one tab for ${keyword}`);
      }
      return "three lines created three tabs; the priced request searched line one";
    } finally { await context.close(); }
  });

  await record("B10", "shared-volume families stay together when pagination reaches a boundary", async () => {
    const { context, page } = await openResearch({ cacheMiss: false, fixtureRows: familyRows }, "/portal/keywords?q=family+alpha&grp=true");
    try {
      await page.getByRole("button", { name: "family beta" }).waitFor();
      const childRow = page.locator("tr").filter({ hasText: "family beta" });
      assert.equal(await childRow.getAttribute("title"), "family beta: matching reported volume with family alpha. Shared volumes may overlap.");
      assert.equal(await page.getByText("1-51 of 51").count(), 1, "the parent and child family must stay together on the 51-row research page");
      assert.equal(await page.getByRole("button", { name: "Next page" }).isDisabled(), true, "the complete shared-volume family should fit on page one");
      return "parent and child share a page and the child explains its shared volume";
    } finally { await context.close(); }
  });

  await record("B11", "invalid keyword errors suppress retry for both specified codes", async () => {
    for (const code of ["unknown_location", "research_invalid"]) {
      const { context, page } = await openResearch({ researchErrorCode: code }, "/portal/keywords?q=invalid+keyword");
      try {
        await page.getByText("This keyword cannot be used.").waitFor();
        assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0, `${code} must not show Retry`);
      } finally { await context.close(); }
    }
    return "unknown_location and research_invalid display no Retry button";
  });

  await record("B12", "stale quote disables paid search until the current estimate is ready", async () => {
    const { context, page } = await openResearch({ cacheMiss: false, delayedQuoteKeyword: "new phrase" }, "/portal/keywords?q=oversized+t+shirt");
    try {
      const search = page.locator("#keyword-research-submit");
      await page.waitForFunction(() => {
        const button = document.querySelector("#keyword-research-submit");
        return Boolean(button && !button.disabled);
      });
      assert.equal(await search.isDisabled(), false);
      await page.getByRole("textbox", { name: "Keywords" }).fill("new phrase");
      assert.equal(await search.isDisabled(), true, "old quote must be blocked immediately after the input changes");
      await page.waitForTimeout(500);
      assert.equal(await search.isDisabled(), true, "placeholder data must stay blocked while the new quote is loading");
      await page.waitForTimeout(850);
      assert.equal(await search.isDisabled(), false, "the button should enable with the fresh quote");
      return "stale and loading quote states could not start a paid search";
    } finally { await context.close(); }
  });

  await record("B13", "SERP approval sends one priced SERP request without enabling paid research", async () => {
    const { context, page, researchRequests, serpRequests } = await openResearch({ cacheMiss: false, serpCacheMiss: true }, "/portal/keywords?q=oversized+t+shirt");
    try {
      await page.getByRole("button", { name: /Load results.*up to \$0\.01/ }).click();
      await page.waitForFunction(() => document.body.innerText.includes("1 organic results"));
      const paidSerp = serpRequests.find((request) => request.cacheOnly === false);
      assert.equal(paidSerp?.depth, 20);
      assert.equal(paidSerp?.maxUsd, 0.0035);
      assert.ok(researchRequests.length > 0 && researchRequests.every((request) => request.cacheOnly === true), "SERP authorization must not start a paid research request");
      return "the approved SERP ceiling was sent only to SERP; research stayed cache-only";
    } finally { await context.close(); }
  });

  await record("B14", "SERP paginates ten rows and prices the top-100 extension", async () => {
    const { context, page, serpRequests } = await openResearch({ cacheMiss: false, serpItemCount: 20 }, "/portal/keywords?q=oversized+t+shirt");
    try {
      await page.getByText("Page 1 of 2").waitFor();
      await page.getByRole("link", { name: /^1\. example\.test Search result 1/ }).waitFor();
      await page.getByRole("button", { name: "Next SERP page" }).click();
      await page.getByRole("link", { name: /^11\. example\.test Search result 11/ }).waitFor();
      await page.getByRole("button", { name: /Load top 100.*up to \$0\.02/ }).click();
      await page.waitForFunction(() => document.body.innerText.includes("100 organic results"));
      const deep = serpRequests.find((request) => request.depth === 100);
      assert.equal(deep?.cacheOnly, false);
      assert.equal(deep?.maxUsd, 0.0155);
      await page.getByText("Page 1 of 10").waitFor();
      return "SERP pages contain ten rows and top-100 ran with its displayed quote";
    } finally { await context.close(); }
  });

  await record("B15", "failed deep crawl restores the loaded top-20 results", async () => {
    const { context, page } = await openResearch({ cacheMiss: false, serpItemCount: 20, serpDepth100Error: true }, "/portal/keywords?q=oversized+t+shirt");
    try {
      await page.getByText("Page 1 of 2").waitFor();
      await page.getByRole("button", { name: "Next SERP page" }).click();
      await page.getByRole("button", { name: /Load top 100/ }).click();
      await page.getByRole("alert").getByText("Deep crawl unavailable.").waitFor();
      await page.getByRole("button", { name: "Show top 20" }).click();
      await page.getByText("Page 1 of 2").waitFor();
      await page.getByRole("link", { name: /^1\. example\.test Search result 1/ }).waitFor();
      return "deep-crawl failure offered Show top 20 and restored the prior results";
    } finally { await context.close(); }
  });

  await record("B16", "intent filters retain rows matching either selected intent", async () => {
    const { context, page } = await openResearch({ cacheMiss: false }, "/portal/keywords?q=oversized+t+shirt");
    try {
      await page.getByRole("button", { name: "Filters" }).click();
      await page.getByRole("checkbox", { name: "Intent informational" }).check();
      await page.getByRole("checkbox", { name: "Intent transactional" }).check();
      await page.getByRole("button", { name: "oversized tee outfit" }).waitFor();
      await page.getByRole("button", { name: "oversized t shirt" }).waitFor();
      await page.getByRole("button", { name: "oversized shirt for men" }).waitFor({ state: "hidden" });
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Filters" }).click();
      assert.equal(await page.getByRole("checkbox", { name: "Intent informational" }).isChecked(), true);
      assert.equal(await page.getByRole("checkbox", { name: "Intent transactional" }).isChecked(), true);
      return "both selected intents matched and persisted in the workspace filter";
    } finally { await context.close(); }
  });

  await record("B17", "URL sort drives row order and accessible column state", async () => {
    const { context, page } = await openResearch({ cacheMiss: false }, "/portal/keywords?q=oversized+t+shirt&sort=cpc&order=asc");
    try {
      const cpcHeader = page.locator("th").filter({ has: page.getByRole("button", { name: "Sort by CPC" }) });
      assert.equal(await cpcHeader.getAttribute("aria-sort"), "ascending");
      const volumeHeader = page.locator("th").filter({ has: page.getByRole("button", { name: "Sort by volume" }) });
      await page.getByRole("button", { name: "Sort by volume" }).click();
      await page.waitForFunction(() => {
        const params = new URL(location.href).searchParams;
        return (params.get("order") === "desc" || params.get("order") === null) && (params.get("sort") === "searchVolume" || params.get("sort") === null);
      });
      assert.equal(await volumeHeader.getAttribute("aria-sort"), "descending");
      assert.match(await page.locator("tbody tr").first().innerText(), /oversized t shirt/);
      await page.getByRole("button", { name: "Sort by volume" }).click();
      await page.waitForFunction(() => new URL(location.href).searchParams.get("order") === "asc");
      assert.equal(await volumeHeader.getAttribute("aria-sort"), "ascending");
      assert.match(await page.locator("tbody tr").first().innerText(), /oversized tee outfit/);
      return "sort/order URL state controls ordering and aria-sort";
    } finally { await context.close(); }
  });
  await record("B18", "city picker lists Mumbai, prices local volume, sends locationName, and notes national-only saves", async () => {
    const { context, page, researchRequests, locationRequests } = await openResearch({ cacheMiss: false }, "/portal/keywords");
    try {
      await page.getByLabel("Keywords").fill("plumber");
      await page.getByRole("combobox", { name: "City (optional)" }).fill("mum");
      const option = page.getByRole("option", { name: /^Mumbai, Maharashtra, India/ });
      await option.waitFor();
      assert.ok(locationRequests.some((request) => /^[a-z]{2}$/.test(request.country) && request.q === "mum"), `location lookups: ${JSON.stringify(locationRequests)}`);
      await option.click();
      await page.getByText("Local volume adds up to $0.09 per search.").waitFor();
      await page.locator("#keyword-research-submit:not([disabled])").filter({ hasText: /up to \$0\.17/ }).click();
      await page.getByRole("button", { name: "oversized shirt for men" }).waitFor();
      const run = researchRequests.find((request) => request.cacheOnly === false);
      assert.equal(run?.locationName, "Mumbai,Maharashtra,India");
      assert.equal(new URL(page.url()).searchParams.get("locName"), "Mumbai,Maharashtra,India");
      await page.getByRole("checkbox", { name: "Select oversized t shirt" }).check();
      await page.getByRole("button", { name: "Save Keywords" }).click();
      await page.getByRole("dialog").getByText("Saved keywords show national metrics. The local volume for Mumbai, Maharashtra, India is not saved.").waitFor();
      return "typing \"mum\" listed Mumbai; selecting it priced and sent local volume; save dialog noted national metrics";
    } finally { await context.close(); }
  });
} finally {
  await browser.close();
  if (serverChild) serverChild.kill("SIGTERM");
}

if (failures) process.exitCode = 1;
else console.log(`ok ${passed} scenario${passed === 1 ? "" : "s"}`);
