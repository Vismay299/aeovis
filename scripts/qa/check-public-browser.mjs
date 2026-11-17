#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { getPublicUrlInventory } from "../../src/server/publicSite.js";
import { sha256 } from "../../src/server/repairs/releaseEvidence.mjs";

const origin = new URL(process.argv[2] || "http://127.0.0.1:3328");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "browser checks require a disposable local app");
const output = path.resolve(process.argv[3] || "test_reports/public-browser");
await mkdir(output, { recursive: true });
const packet = {
  schemaVersion: 1, environment: "qa",
  sourceClean: !execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).trim(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  manifestHash: sha256(await readFile("tests/fixtures/repairs/manifest.json")), cases: [],
};
const browser = await chromium.launch({ headless: true });
const suite = JSON.parse(await readFile("tests/fixtures/repairs/public-browser.json", "utf8"));
const viewports = suite.viewports;

async function contextFor(viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  const forbidden = [];
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin.origin || (!["GET", "HEAD"].includes(request.method()) && url.pathname !== "/api/demo/scan")) {
      forbidden.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  return { context, forbidden };
}
async function open(page, pathname) {
  const response = await page.goto(new URL(pathname, origin).href, { waitUntil: "networkidle" });
  assert.equal(response.status(), 200, pathname);
}
async function record(id, expected, run) {
  const row = { case: id, suite: "browser", startedAt: new Date().toISOString(), expected,
    command: `npm run qa:public-browser -- ${origin.origin}`, artifacts: [] };
  const artifacts = [];
  try { row.actual = await run(artifacts); row.outcome = "pass"; }
  catch (error) { row.outcome = "fail"; row.actual = error.stack || error.message; process.exitCode = 1; }
  row.endedAt = new Date().toISOString();
  const log = `${id}.txt`;
  await writeFile(path.join(output, log), JSON.stringify({ ...row, artifacts: undefined }, null, 2));
  artifacts.push(log);
  for (const filename of artifacts) row.artifacts.push({ path: filename, sha256: sha256(await readFile(path.join(output, filename))) });
  packet.cases.push(row);
  console.log(`${id}: ${row.outcome} — ${row.actual.split("\n")[0]}`);
}
async function keyboardLink(page, href) {
  for (let i = 0; i < 100; i++) {
    await page.keyboard.press("Tab");
    const current = await page.evaluate(() => document.activeElement?.getAttribute("href"));
    if (current === href) {
      await page.keyboard.press("Enter");
      await page.waitForURL(new URL(href, origin).href);
      return;
    }
  }
  assert.fail(`keyboard could not reach ${href}`);
}

try {
  await record("R20-08", "Public routes and essential links work at desktop and narrow viewports without horizontal overflow.", async (artifacts) => {
    for (const viewport of viewports) {
      const { context, forbidden } = await contextFor(viewport);
      try {
        const page = await context.newPage();
        for (const route of getPublicUrlInventory()) {
          await open(page, route.path);
          assert.ok(await page.locator("h1").first().isVisible(), route.path);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow ${route.path} at ${viewport.width}`);
          for (const link of await page.locator('a[href^="/"]').evaluateAll((links) => links.map((a) => a.getAttribute("href")))) {
            const response = await context.request.get(new URL(link, origin).href, { maxRedirects: 0 });
            assert.ok(response.status() < 400, `${route.path} -> ${link}: ${response.status()}`);
          }
          if (["/methodology", "/use-cases"].includes(route.path)) {
            const filename = `${viewport.width}-${route.path.slice(1)}.png`;
            await page.screenshot({ path: path.join(output, filename), fullPage: true }); artifacts.push(filename);
          }
        }
        assert.deepEqual(forbidden, []);
      } finally { await context.close(); }
    }
    return "Six public pages rendered at 1440px and 390px; internal links resolved and no horizontal overflow or external requests occurred.";
  });
  await record("R20-09", "Each rendered public page has a unique relevant title, description, one production canonical and visible primary content.", async () => {
    const { context } = await contextFor(viewports[0]);
    try {
      const page = await context.newPage(), titles = new Set(), descriptions = new Set();
      for (const route of getPublicUrlInventory()) {
        await open(page, route.path);
        const title = await page.title(), description = await page.locator('meta[name="description"]').getAttribute("content");
        assert.ok(title.includes("Perceev") && !titles.has(title), `duplicate/irrelevant title ${route.path}`);
        assert.ok(description?.length > 30 && !descriptions.has(description), `duplicate description ${route.path}`);
        assert.equal(await page.locator('link[rel="canonical"]').count(), 1);
        assert.equal(new URL(await page.locator('link[rel="canonical"]').getAttribute("href")).href, new URL(route.url).href);
        assert.ok((await page.locator("h1").first().innerText()).trim().length > 5);
        if (route.path === "/methodology") assert.match(await page.locator("main").innerText(), /failures|Failed/);
        titles.add(title); descriptions.add(description);
      }
    } finally { await context.close(); }
    return "All six rendered titles and descriptions are distinct; canonical URLs match the public inventory and primary content is visible.";
  });
  await record("R20-10", "Marketing sample CTA preserves simulation identity, question cardinality, reload state and mutation guards.", async (artifacts) => {
    const { context, forbidden } = await contextFor(viewports[0]);
    try {
      const page = await context.newPage();
      await open(page, "/");
      await page.getByRole("button", { name: /See a sample report/ }).click();
      await page.getByTestId("sample-banner").waitFor();
      const stored = await page.evaluate(() => ({ sample: JSON.parse(sessionStorage.getItem("aeo_sample_scan_v1")), real: sessionStorage.getItem("aeo_last_scan") }));
      assert.equal(stored.sample.isSample, true); assert.equal(stored.real, null);
      assert.equal(stored.sample.promptsTracked, 30);
      assert.equal(await page.getByRole("button", { name: /Generate content|Publish|Schedule/i }).count(), 0);
      await page.reload({ waitUntil: "networkidle" });
      await page.getByTestId("sample-banner").waitFor();
      await page.screenshot({ path: path.join(output, "sample.png"), fullPage: true }); artifacts.push("sample.png");
      await open(page, "/demo");
      await page.getByRole("button", { name: "Run mock scan" }).click();
      await page.getByRole("region", { name: "Mock scan results" }).waitFor();
      assert.match(await page.getByRole("region", { name: "Mock scan results" }).innerText(), /30 example questions.*120 simulated answers/s);
      assert.deepEqual(forbidden, []);
      assert.equal(await page.evaluate(() => sessionStorage.getItem("aeo_last_scan")), null);
    } finally { await context.close(); }
    return "Marketing sample retains 30 questions, simulation identity after reload and no real history; mock scan renders 120 simulated answers with no external or forbidden mutation requests.";
  });
  await record("R20-16", "Keyboard-only users can navigate product → methodology → sample/scan at desktop and narrow widths.", async () => {
    for (const viewport of viewports) {
      const { context, forbidden } = await contextFor(viewport);
      try {
        const page = await context.newPage();
        await open(page, "/use-cases"); await keyboardLink(page, "/methodology");
        await keyboardLink(page, "/demo");
        assert.ok(await page.getByRole("heading", { name: "Test the scan & content workflow" }).isVisible());
        await open(page, "/methodology"); await keyboardLink(page, "/scan");
        await page.locator("input").first().waitFor({ state: "visible" });
        assert.deepEqual(forbidden, []);
      } finally { await context.close(); }
    }
    return "Keyboard Tab/Enter navigation reaches methodology, simulated workflow and scan at 1440px and 390px without authentication gates.";
  });
} finally {
  await browser.close();
  assert.deepEqual(packet.cases.map((row) => row.case), suite.cases, "every required browser case must report an outcome");
  await writeFile(path.join(output, "evidence.json"), JSON.stringify(packet, null, 2) + "\n");
}
