#!/usr/bin/env node
/** F06 phase 2 browser checks (B01-B05), using only loopback fixtures. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Papa from "papaparse";
import { chromium } from "../../worker/node_modules/playwright/index.mjs";
import { openPortal, readFixture } from "./portalFixtureHarness.mjs";

const origin = new URL(process.argv[2] || "http://127.0.0.1:3328");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "browser checks require a disposable local app");
const output = path.resolve(process.argv[3] || "test_reports/f06-browser");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });

async function record(id, expected, run) {
  const row = { case: id, suite: "f06-browser", startedAt: new Date().toISOString(), expected, artifacts: [] };
  try {
    row.actual = await run(row.artifacts);
    row.outcome = "pass";
  } catch (error) {
    row.outcome = "fail";
    row.actual = error.stack || error.message;
    process.exitCode = 1;
  }
  row.endedAt = new Date().toISOString();
  await writeFile(path.join(output, `${id}.json`), JSON.stringify({ ...row, artifacts: undefined }, null, 2));
  console.log(`${id}: ${row.outcome} — ${String(row.actual).split("\n")[0]}`);
}

async function setScanResponse(page, body, { status = 200, delayMs = 0 } = {}) {
  await page.route("**/api/customer/scan*", async (route) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
}

async function openScans() {
  const session = await openPortal(browser, origin, { viewport: { width: 1440, height: 1000 } });
  await session.context.grantPermissions(["clipboard-read", "clipboard-write"]);
  return session;
}

try {
  // Warm the first dynamic portal navigation so B01 measures the table load, not
  // the local Next server's initial route compilation.
  await fetch(new URL("/login", origin));
  await fetch(new URL("/portal", origin));

  await record("F06-B01", "Scans history shows six labeled/selection headers and 8 skeleton rows while loading; an empty-cache failure replaces the table with Scans did not load.", async () => {
    const history = await readFixture("scans-acme-history.json");
    const { context, page, blockedWrites } = await openScans();
    let contextClosed = false;
    try {
      await setScanResponse(page, history, { delayMs: 1000 });
      await page.goto(new URL("/portal/scans", origin).href, { waitUntil: "domcontentloaded" });
      const table = page.locator("table");
      await table.waitFor({ state: "visible", timeout: 15000 });
      assert.equal(await page.locator("thead th").count(), 7, "§6.6.4 defines seven physical columns, including the blank actions header");
      const meaningfulHeaders = await page.locator("thead th").evaluateAll((cells) =>
        cells.filter((cell) => cell.querySelector('[role="checkbox"]') || cell.textContent.trim()).length,
      );
      assert.equal(meaningfulHeaders, 6, "B01's six populated/selection header cells are present; the seventh actions header is intentionally blank");
      assert.equal(await page.locator("tbody tr").count(), 8, "the first load has exactly 8 skeleton rows");
      await page.locator('a[href="/portal/scans/scan-1"]').waitFor({ state: "visible", timeout: 15000 });
      assert.equal(blockedWrites.length, 0);
      await context.close();
      contextClosed = true;

      const failed = await openScans();
      try {
        const errorFixture = await readFixture("scans-acme-error.json");
        await setScanResponse(failed.page, errorFixture, { status: 500 });
        await failed.page.goto(new URL("/portal/scans", origin).href, { waitUntil: "networkidle" });
        await failed.page.getByText("Scans did not load", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
        assert.equal(await failed.page.locator("table").count(), 0, "an empty-cache error replaces the table");
        assert.equal(failed.blockedWrites.length, 0);
      } finally {
        await failed.context.close();
      }
      return "Loading rendered six meaningful headers and 8 skeleton rows; empty-cache error replaced the table.";
    } finally {
      if (!contextClosed) await context.close();
    }
  });

  await record("F06-B02", "Shift selection applies an anchor range; clear works; bulk CSV contains only selected rows.", async () => {
    const history = await readFixture("scans-acme-history.json");
    const { context, page, blockedWrites } = await openScans();
    try {
      await setScanResponse(page, history);
      await page.goto(new URL("/portal/scans", origin).href, { waitUntil: "networkidle" });
      const rows = page.locator("tbody tr");
      await rows.nth(11).waitFor({ state: "visible", timeout: 15000 });
      const checkbox = (row) => rows.nth(row - 1).getByRole("checkbox");
      await checkbox(2).click();
      await checkbox(6).click({ modifiers: ["Shift"] });
      assert.match(await page.getByRole("toolbar", { name: "Bulk actions" }).innerText(), /5\s+selected\s+Export/);
      for (let row = 1; row <= 12; row++) {
        assert.equal(await rows.nth(row - 1).getAttribute("data-state"), row >= 2 && row <= 6 ? "selected" : null);
      }

      await checkbox(4).click();
      await checkbox(4).click({ modifiers: ["Shift"] });
      for (let row = 1; row <= 12; row++) {
        assert.equal(await rows.nth(row - 1).getAttribute("data-state"), [2, 3, 5, 6].includes(row) ? "selected" : null);
      }
      await page.getByRole("button", { name: "Clear selection" }).click();
      assert.equal(await page.getByRole("toolbar", { name: "Bulk actions" }).count(), 0);

      await checkbox(1).click();
      await checkbox(2).click();
      await checkbox(3).click();
      const bulk = page.getByRole("toolbar", { name: "Bulk actions" });
      const downloadEvent = page.waitForEvent("download");
      await bulk.getByRole("button", { name: "Export" }).click();
      await page.getByRole("menuitem", { name: "CSV" }).click();
      const download = await downloadEvent;
      const csv = await readFile(await download.path(), "utf8");
      assert.equal(csv.trim().split("\n").length, 4, "selection export has the header and exactly 3 records");
      assert.equal(blockedWrites.length, 0);
      return "Selected and cleared the required shift ranges; bulk CSV contained exactly 3 selected scans.";
    } finally {
      await context.close();
    }
  });

  await record("F06-B03", "Sheets export copies 12 scans, opens sheets.new, and the modal closes on navigation.", async () => {
    const history = await readFixture("scans-acme-history.json");
    const { context, page, blockedWrites } = await openScans();
    try {
      await setScanResponse(page, history);
      await page.goto(new URL("/portal/scans", origin).href, { waitUntil: "networkidle" });
      const exportMenu = page.getByRole("button", { name: "Export" }).first();
      let sheetsUrl = null;
      await context.route("https://sheets.new/**", async (route) => {
        sheetsUrl = route.request().url();
        return route.abort("blockedbyclient");
      });
      await exportMenu.click();
      await page.getByRole("menuitem", { name: "Export to Sheets" }).click();
      await page.getByRole("dialog").getByText("Copied 12 rows to your clipboard").waitFor({ state: "visible", timeout: 10000 });
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      assert.ok(clipboard.startsWith("Date\tAI visibility (%)"), "clipboard begins with the scan history headers");

      const popupEvent = page.waitForEvent("popup");
      await page.getByRole("button", { name: "Open new Google Sheet" }).click();
      const popup = await popupEvent;
      await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
      assert.ok(sheetsUrl?.startsWith("https://sheets.new"), "the popup navigates to sheets.new before the local route guard aborts it");
      await popup.close();

      await exportMenu.click();
      await page.getByRole("menuitem", { name: "Export to Sheets" }).click();
      await page.getByRole("dialog").waitFor({ state: "visible" });
      await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.equal(blockedWrites.length, 0);
      return "Copied 12 rows, opened sheets.new, and closed the Sheets modal after navigation.";
    } finally {
      await context.close();
    }
  });

  await record("F06-B04", "Report JSON preserves its DTO; question CSV includes planned missing engines; unmeasured history cells are blank.", async () => {
    const baseReport = await readFixture("report-scan-1.json");
    const report = {
      ...baseReport,
      scan: {
        ...baseReport.scan,
        brand: "Acme",
        planned_questions: {
          prompts: ["Which accounting tool?", "Which project tool?", "Which support tool?"],
          engines: ["chatgpt", "gemini"],
        },
      },
      results: [
        { query: "Which accounting tool?", engine: "chatgpt", answered: true, mentioned: false, brand_cited: false, position: 2, answer_text: "Compare accounting tools.", raw: {} },
        { query: "Which accounting tool?", engine: "gemini", answered: true, mentioned: true, brand_cited: true, position: 1, answer_text: "Acme is an option.", raw: {} },
        { query: "Which project tool?", engine: "chatgpt", answered: false, raw: {} },
        { query: "Which support tool?", engine: "chatgpt", answered: true, mentioned: false, answer_text: "Compare support tools.", raw: {} },
      ],
    };

    const reportSession = await openScans();
    try {
      await reportSession.page.route("**/api/customer/scan/report/scan-1", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(report) }));
      await reportSession.page.goto(new URL("/portal/scans/scan-1", origin).href, { waitUntil: "networkidle" });
      const menu = reportSession.page.getByRole("button", { name: "Export" });
      await menu.click();
      const jsonEvent = reportSession.page.waitForEvent("download");
      await reportSession.page.getByRole("menuitem", { name: "Download JSON" }).click();
      const jsonDownload = await jsonEvent;
      assert.equal(jsonDownload.suggestedFilename(), "measurement-scan-1.json");
      assert.deepEqual(JSON.parse(await readFile(await jsonDownload.path(), "utf8")), report);

      await menu.click();
      const csvEvent = reportSession.page.waitForEvent("download");
      await reportSession.page.getByRole("menuitem", { name: "Export CSV" }).click();
      const questionsCsv = await readFile(await (await csvEvent).path(), "utf8");
      assert.match(questionsCsv, /Not collected/);
      assert.match(questionsCsv, /Which accounting tool\?/);
      assert.equal(reportSession.blockedWrites.length, 0);
    } finally {
      await reportSession.context.close();
    }

    const history = await readFixture("scans-acme-history.json");
    const scansSession = await openScans();
    try {
      await setScanResponse(scansSession.page, history);
      await scansSession.page.goto(new URL("/portal/scans", origin).href, { waitUntil: "networkidle" });
      const menu = scansSession.page.getByRole("button", { name: "Export" }).first();
      await menu.click();
      const csvEvent = scansSession.page.waitForEvent("download");
      await scansSession.page.getByRole("menuitem", { name: "Export CSV" }).click();
      const csv = await readFile(await (await csvEvent).path(), "utf8");
      const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true }).data;
      assert.ok(parsed.some((row) => row["AI visibility (%)"] === ""), "unmeasured scan visibility is an empty CSV cell");
      assert.equal(scansSession.blockedWrites.length, 0);
      return "Report JSON matched the served DTO; question CSV included Not collected; unmeasured scan visibility exported blank.";
    } finally {
      await scansSession.context.close();
    }
  });

  await record("F06-B05", "AI visibility sorting is URL-backed, keeps nulls last in both directions, survives reload, and prefetches a report once.", async () => {
    const history = await readFixture("scans-acme-history.json");
    const { context, page, blockedWrites } = await openScans();
    try {
      await setScanResponse(page, history);
      let reportGets = 0;
      await page.route("**/api/customer/scan/report/*", async (route) => {
        reportGets++;
        const fixture = await readFixture("report-scan-1.json");
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) });
      });
      await page.goto(new URL("/portal/scans", origin).href, { waitUntil: "networkidle" });
      const sortButton = page.getByRole("button", { name: "Sort by AI visibility" });
      await sortButton.click();
      await page.waitForURL((url) => url.search === "?order=desc&sort=visibility");
      const descendingUrl = new URL(page.url());
      assert.equal(descendingUrl.search, "?order=desc&sort=visibility");
      const visibilityValues = async () => page.locator("tbody tr").evaluateAll((rows) => rows.map((row) => {
        const text = row.cells[2]?.textContent || "";
        const match = text.match(/(-?\d+(?:\.\d+)?)%/);
        return match ? Number(match[1]) : null;
      }));
      let values = await visibilityValues();
      assert.deepEqual(values.slice(-2), [null, null], "descending sort keeps missing visibility last");
      assert.deepEqual(values.filter((value) => value !== null), [...values.filter((value) => value !== null)].sort((a, b) => b - a));

      await sortButton.click();
      await page.waitForFunction(() => {
        const params = new URLSearchParams(location.search);
        return params.get("order") === "asc" && params.get("sort") === "visibility";
      });
      values = await visibilityValues();
      assert.deepEqual(values.slice(-2), [null, null], "ascending sort keeps missing visibility last");
      assert.deepEqual(values.filter((value) => value !== null), [...values.filter((value) => value !== null)].sort((a, b) => a - b));
      await page.reload({ waitUntil: "networkidle" });
      assert.equal(new URL(page.url()).searchParams.get("order"), "asc");
      assert.equal(new URL(page.url()).searchParams.get("sort"), "visibility");

      reportGets = 0;
      const dateLink = page.locator('a[href="/portal/scans/scan-1"]').first();
      await dateLink.hover();
      await page.waitForFunction(() => window.__REACT_QUERY_CLIENT__?.getQueryCache().findAll({ queryKey: ["scanReport", "scan-1"] }).length > 0, undefined, { timeout: 10000 });
      await page.waitForTimeout(200);
      assert.equal(reportGets, 1, "hovering the report link triggers one GET prefetch");
      assert.equal(blockedWrites.length, 0);
      return "URL sorting persisted after reload; visibility nulls stayed last; report prefetch made one GET.";
    } finally {
      await context.close();
    }
  });

  await record("F06-B06", "With server_exports on, the All answers CSV scope posts once, navigates to the signed link and shows the ready toast; with it off the scope is absent.", async () => {
    const history = await readFixture("scans-acme-history.json");
    const features = await readFixture("features-acme-server-exports.json");
    const { context, page, blockedWrites } = await openScans();
    try {
      await setScanResponse(page, history);
      await page.route("**/api/customer/features*", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(features) }),
      );
      let exportPosts = 0;
      await page.route("**/api/customer/exports", async (route) => {
        exportPosts += 1;
        assert.equal(route.request().method(), "POST");
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            exportId: "3f1c8a52-7d4e-4b8a-9a3e-2c6f0d9b1e47",
            url: new URL("/__qa/download.csv", origin).href,
            expiresAt: "2026-10-21T11:00:00.000Z",
            format: "csv",
            rowCount: 12,
            filename: "perceev-acme-answers-2026-07-23-to-2026-10-21.csv",
          }),
        });
      });
      let downloads = 0;
      await page.route("**/__qa/download.csv", (route) => {
        downloads += 1;
        return route.fulfill({
          status: 200,
          headers: {
            "content-type": "text/csv",
            "content-disposition": 'attachment; filename="qa-export.csv"',
          },
          body: '"Date","AI visibility (%)"\r\n"2026-08-01","50"',
        });
      });

      await page.goto(new URL("/portal/scans", origin).href, { waitUntil: "networkidle" });
      const menu = page.getByRole("button", { name: "Export" }).first();
      await menu.click();
      await page.getByRole("menuitem", { name: "All answers, last 90 days (CSV)" }).click();
      await page.getByText("Export ready. Your download has started.").waitFor({ state: "visible", timeout: 10000 });
      assert.equal(exportPosts, 1, "one POST to the export route");
      assert.equal(downloads, 1, "the browser navigates to the signed link once");
      assert.equal(blockedWrites.length, 0, "the page-level route fulfils the POST, so the write guard never sees it");

      const off = await openScans();
      try {
        await setScanResponse(off.page, history);
        await off.page.goto(new URL("/portal/scans", origin).href, { waitUntil: "networkidle" });
        await off.page.getByRole("button", { name: "Export" }).first().click();
        assert.equal(await off.page.getByRole("menuitem", { name: /All answers/ }).count(), 0);
        assert.equal(off.blockedWrites.length, 0);
      } finally {
        await off.context.close();
      }
      return "Server scope posted once, downloaded the signed link and toasted; it was absent with the flag off.";
    } finally {
      await context.close();
    }
  });
} finally {
  await browser.close();
}
