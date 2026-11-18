#!/usr/bin/env node
/** F23 Phase 5 S1: reports UI flows + hostile document in a real browser, fixtures only. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openPortal, SUPABASE_URL } from "./portalFixtureHarness.mjs";
// Every body the page POSTs/PUTs/DELETEs is checked against the schemas the
// real routes use, so a page that sends something the real route would refuse
// fails here, not in prod.
const {
  reportDeleteBodySchema,
  reportShareBodySchema,
  templateSaveBodySchema,
  generateBodySchema,
} = await import("../../src/server/reports/reports.contract.ts");

let chromium;
let playwrightSource = "";
try {
  ({ chromium } = await import("../../worker/node_modules/playwright/index.mjs"));
  playwrightSource = "worker/node_modules/playwright";
} catch {
  // worker/ ships no node_modules in this checkout (owner override names the
  // worker path, but only the root install exists); same fallback as F22.
  ({ chromium } = await import("playwright"));
  playwrightSource = "root node_modules/playwright (fallback; worker/node_modules/playwright missing)";
}

const BENIGN_ID = "11111111-1111-1111-1111-111111111111";
const HOSTILE_ID = "22222222-2222-2222-2222-222222222222";
const TOKEN_A = "a".repeat(32);
const GEN_SESSION = "6c8f0000-0000-4000-8000-000000000002";
const TEMPLATE_ID = "44444444-4444-4444-8444-444444444444";
const NEW_TEMPLATE_ID = "55555555-5555-5555-8555-555555555555";
const REMOTE_HOST = "127.0.0.1:9";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", new URL(SUPABASE_URL).hostname]);

const originArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "http://127.0.0.1:3343";
const origin = new URL(originArg);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "browser checks require a disposable local app");
const port = Number(origin.port || 3343);

async function waitForServer(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(new URL("/portal/reports", origin), { redirect: "manual" });
      if (response.status !== 404 && response.status !== 503) return true;
    } catch { /* wait */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

let serverChild = null;
if (!(await waitForServer(1000))) {
  serverChild = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", String(port)], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    env: {
      ...process.env,
      NODE_ENV: "development",
      F23_FIXTURE_DOCUMENTS: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_POSTHOG_KEY: "",
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key",
    },
    stdio: "ignore",
  });
  if (!(await waitForServer(180000))) {
    serverChild.kill("SIGTERM");
    throw new Error(`Next.js dev server failed to start on port ${port}`);
  }
}

// Warm the routes the cases touch so the first browser navigation does not
// pay for compilation under the assertion timeouts.
for (const warm of [
  "/portal/reports",
  "/portal/reports/templates",
  `/r/${BENIGN_ID}`,
  `/s/${TOKEN_A}`,
  `/s/${TOKEN_A}/og.png`,
]) {
  try {
    await fetch(new URL(warm, origin), { redirect: "manual" });
  } catch { /* best effort */ }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_FIXTURES = path.resolve(HERE, "../../tests/fixtures/f23/api");
async function apiFixture(name) {
  return JSON.parse(await readFile(path.join(API_FIXTURES, name), "utf8"));
}
const FEATURES = await apiFixture("features.json");
const CONFIG = await apiFixture("config.json");
const REPORTS_SEED = await apiFixture("reports.json");
const DETAIL_SEED = {
  [BENIGN_ID]: await apiFixture("report-benign.json"),
  [HOSTILE_ID]: await apiFixture("report-hostile.json"),
};
const TEMPLATES_SEED = await apiFixture("templates.json");

const browser = await chromium.launch({ headless: true });
const allRequests = [];
const frameNavigations = [];
// The fixture remote host is a closed port by design (§9): a regression shows
// as a request that LEAVES the browser, while a working sandbox/CSP blocks the
// attempt first. Playwright still emits `request` for blocked attempts, so the
// discriminator is the outcome, not the attempt.
const remoteOutcomes = [];
const contractViolations = [];
let failures = 0;
let passed = 0;

async function record(id, expected, run) {
  try {
    const actual = await run();
    passed += 1;
    console.log(`${id}: PASS — ${actual}`);
  } catch (error) {
    failures += 1;
    console.error(`${id}: FAIL — ${error?.stack || error}`);
  }
}

function jsonBody(value, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(value) };
}

function matchesRealRoute(label, schema, body) {
  const parsed = schema.safeParse(body);
  if (parsed.success) return true;
  contractViolations.push(`${label}: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
  return false;
}
const REFUSED = {
  status: 400,
  contentType: "application/json",
  body: JSON.stringify({ error: "The request was not valid.", code: "invalid_request" }),
};

function freshState(overrides = {}) {
  return {
    reports: structuredClone(REPORTS_SEED.reports),
    details: structuredClone(DETAIL_SEED),
    templates: structuredClone(TEMPLATES_SEED.templates),
    remaining: TEMPLATES_SEED.remaining,
    detailHold: null,
    generatePosts: [],
    ...overrides,
  };
}

/**
 * One portal page: Supabase login + memberships from the harness, every
 * /api/customer/** response from the F23 fixtures with in-memory mutations.
 * Document routes (/r, /s) are NOT intercepted: they hit the real dev server
 * in fixture mode.
 */
async function makePage(state, options = {}) {
  const { context, page } = await openPortal(browser, origin, {
    viewport: options.viewport ?? { width: 1280, height: 900 },
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  page.setDefaultTimeout(60000);

  context.on("request", (request) => {
    allRequests.push(request.url());
  });
  context.on("requestfailed", (request) => {
    if (request.url().includes(REMOTE_HOST)) {
      remoteOutcomes.push({ url: request.url(), finished: false, error: request.failure()?.errorText ?? "unknown" });
    }
  });
  context.on("requestfinished", (request) => {
    if (request.url().includes(REMOTE_HOST)) {
      remoteOutcomes.push({ url: request.url(), finished: true, error: null });
    }
  });
  context.on("page", (sub) => {
    sub.on("framenavigated", (frame) => frameNavigations.push(frame.url()));
  });
  page.on("framenavigated", (frame) => frameNavigations.push(frame.url()));

  await page.route("**/api/customer/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();
    try {
      if (method === "GET" && pathname === "/api/customer/features") {
        return route.fulfill(jsonBody({ ...FEATURES, brandKey: url.searchParams.get("brand_key") || "acme" }));
      }
      if (method === "GET" && pathname === "/api/customer/onboarding") {
        return route.fulfill(jsonBody({ enabled: false, needsOnboarding: false, has_workspace: true }));
      }
      if (method === "GET" && pathname === "/api/customer/overview") {
        return route.fulfill(jsonBody({ scans: [], content_items: [], metrics: {}, scan_jobs: [] }));
      }
      if (method === "GET" && pathname === "/api/customer/gsc") {
        return route.fulfill(jsonBody({ connected: false, connection: null }));
      }
      if (method === "GET" && pathname === "/api/customer/assistant/config") {
        return route.fulfill(jsonBody(CONFIG));
      }
      if (method === "GET" && pathname === "/api/customer/assistant/sessions") {
        return route.fulfill(jsonBody({ sessions: [] }));
      }
      if (method === "GET" && pathname === "/api/customer/reports") {
        return route.fulfill(jsonBody({ reports: state.reports }));
      }
      if (method === "GET" && pathname === "/api/customer/reports/templates") {
        return route.fulfill(jsonBody({ templates: state.templates, remaining: state.remaining }));
      }
      const detailMatch = pathname.match(/^\/api\/customer\/reports\/([^/]+)$/);
      if (detailMatch && detailMatch[1] !== "templates" && detailMatch[1] !== "generate") {
        const id = decodeURIComponent(detailMatch[1]);
        if (method === "GET") {
          if (state.detailHold && id === BENIGN_ID) await state.detailHold;
          const detail = state.details[id];
          if (!detail) {
            return route.fulfill(jsonBody({ error: "No such report.", code: "report_not_found" }, 404));
          }
          return route.fulfill(jsonBody(detail));
        }
        if (method === "DELETE") {
          const body = request.postDataJSON();
          if (!matchesRealRoute("report delete", reportDeleteBodySchema, body)) return route.fulfill(REFUSED);
          state.reports = state.reports.filter((report) => report.id !== id);
          delete state.details[id];
          return route.fulfill(jsonBody({ reportId: id, deleted: true }));
        }
      }
      const shareMatch = pathname.match(/^\/api\/customer\/reports\/([^/]+)\/share$/);
      if (shareMatch && method === "POST") {
        const id = decodeURIComponent(shareMatch[1]);
        const body = request.postDataJSON();
        if (!matchesRealRoute("report share", reportShareBodySchema, body)) return route.fulfill(REFUSED);
        const detail = state.details[id]?.report;
        if (!detail) {
          return route.fulfill(jsonBody({ error: "No such report.", code: "report_not_found" }, 404));
        }
        if (body.public) {
          detail.shared = true;
          detail.shareToken = TOKEN_A;
          detail.sharedAt = new Date().toISOString();
          detail.views30d = 0;
          const row = state.reports.find((report) => report.id === id);
          if (row) row.shared = true;
          return route.fulfill(jsonBody({ shareToken: TOKEN_A, sharedAt: detail.sharedAt }));
        }
        detail.shared = false;
        detail.shareToken = null;
        detail.sharedAt = null;
        detail.views30d = null;
        const row = state.reports.find((report) => report.id === id);
        if (row) row.shared = false;
        return route.fulfill(jsonBody({ shareToken: null, sharedAt: null }));
      }
      if (method === "POST" && pathname === "/api/customer/reports/templates") {
        const body = request.postDataJSON();
        if (!matchesRealRoute("template create", templateSaveBodySchema, body)) return route.fulfill(REFUSED);
        const now = new Date().toISOString();
        state.templates.unshift({
          id: NEW_TEMPLATE_ID,
          name: body.name,
          description: body.description,
          instructions: body.instructions,
          createdAt: now,
          updatedAt: now,
        });
        state.remaining = Math.max(0, state.remaining - 1);
        return route.fulfill(jsonBody({ templateId: NEW_TEMPLATE_ID, created: true }));
      }
      const templateMatch = pathname.match(/^\/api\/customer\/reports\/templates\/([^/]+)$/);
      if (templateMatch) {
        const id = decodeURIComponent(templateMatch[1]);
        if (method === "PUT") {
          const body = request.postDataJSON();
          if (!matchesRealRoute("template update", templateSaveBodySchema, body)) return route.fulfill(REFUSED);
          const template = state.templates.find((entry) => entry.id === id);
          if (!template) {
            return route.fulfill(jsonBody({ error: "No such template.", code: "template_not_found" }, 404));
          }
          template.name = body.name;
          template.description = body.description;
          template.instructions = body.instructions;
          template.updatedAt = new Date().toISOString();
          return route.fulfill(jsonBody({ templateId: id, created: false }));
        }
        if (method === "DELETE") {
          const body = request.postDataJSON();
          if (!matchesRealRoute("template delete", reportDeleteBodySchema, body)) return route.fulfill(REFUSED);
          state.templates = state.templates.filter((entry) => entry.id !== id);
          state.remaining += 1;
          return route.fulfill(jsonBody({ templateId: id, deleted: true }));
        }
      }
      if (method === "POST" && pathname === "/api/customer/reports/generate") {
        const body = request.postDataJSON();
        if (!matchesRealRoute("report generate", generateBodySchema, body)) return route.fulfill(REFUSED);
        state.generatePosts.push(body);
        return route.fulfill(jsonBody({ sessionId: GEN_SESSION, path: `/portal/assistant?s=${GEN_SESSION}` }));
      }
      if (method === "GET") return route.fulfill(jsonBody({}));
      return route.fulfill(REFUSED);
    } catch (error) {
      console.error(`fixture route failed: ${error?.stack || error}`);
      return route.abort("failed");
    }
  });

  return { context, page, state };
}

const BENIGN_TITLE = "Acme Tees AI Visibility Audit";

try {
  await record("C0", "playwright resolves from the expected install", async () => {
    assert.ok(chromium, "chromium loaded");
    return playwrightSource;
  });

  await record("C1", "list columns, rows, badges, header copy and actions", async () => {
    const { context, page } = await makePage(freshState());
    try {
      await page.goto(new URL("/portal/reports", origin).href, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Reports" }).waitFor();
      await page.getByText("Reports the assistant wrote for Acme. Open one to read, print or share it.").waitFor();
      await page.getByRole("button", { name: "Templates" }).waitFor();
      await page.getByRole("button", { name: "Generate report" }).waitFor();
      for (const column of ["Title", "Written by", "Type", "Sharing", "Updated"]) {
        await page.getByRole("columnheader", { name: column }).waitFor();
      }
      await page.getByRole("link", { name: BENIGN_TITLE }).waitFor();
      await page.getByText("Assistant · you").waitFor();
      await page.getByText("AI Visibility Audit").first().waitFor();
      await page.getByText("Perceev app").waitFor();
      await page.getByText("Monthly client check-in").first().waitFor();
      await page.getByText("Private").waitFor();
      await page.getByText("Public").waitFor();
      const href = await page.getByRole("link", { name: BENIGN_TITLE }).getAttribute("href");
      assert.equal(href, `/portal/reports/${BENIGN_ID}`);
      return "2 rows, badges, links, header copy";
    } finally { await context.close(); }
  });

  await record("C2", "empty state with assistant and generate actions", async () => {
    const { context, page } = await makePage(freshState({ reports: [] }));
    try {
      await page.goto(new URL("/portal/reports", origin).href, { waitUntil: "networkidle" });
      await page.getByText("No reports yet").waitFor();
      await page.getByText("Ask the assistant for a report, or generate one from a template.").waitFor();
      await page.getByRole("button", { name: "Open assistant" }).waitFor();
      // The header and the empty state each offer generation.
      assert.equal(await page.getByRole("button", { name: "Generate report" }).count(), 2);
      assert.equal(await page.getByRole("columnheader").count(), 0, "no table when empty");
      return "empty copy with both actions";
    } finally { await context.close(); }
  });

  // The detail page drives export, fullscreen, share and delete, so one page
  // carries C3–C7 in dependency order.
  const detail = await makePage(freshState());
  let releaseDetail = null;
  detail.state.detailHold = new Promise((resolve) => { releaseDetail = resolve; });
  try {
    await record("C3", "detail skeleton resolves into the framed report", async () => {
      const { page } = detail;
      await page.goto(new URL(`/portal/reports/${BENIGN_ID}`, origin).href, { waitUntil: "domcontentloaded" });
      await page.locator('[aria-busy="true"]').first().waitFor({ state: "visible" });
      assert.equal(await page.locator(`iframe[title="${BENIGN_TITLE}"]`).count(), 0, "no frame while loading");
      releaseDetail();
      detail.state.detailHold = null;
      const frame = page.locator(`iframe[title="${BENIGN_TITLE}"]`);
      await frame.waitFor({ state: "visible" });
      const reportFrame = page.frame({ url: /\/r\// });
      assert.ok(reportFrame, "report frame attached");
      await reportFrame.waitForLoadState("load");
      const frameText = await reportFrame.evaluate(() => document.body.textContent);
      assert.match(frameText, /Acme Tees quarterly check-in/);
      await page.locator("#app-content").getByRole("link", { name: "Reports" }).waitFor();
      await page.getByRole("heading", { name: BENIGN_TITLE }).waitFor();
      for (const term of ["Written by", "Type", "Updated"]) {
        await page.getByText(term, { exact: true }).first().waitFor();
      }
      await page.getByText("Assistant · you").first().waitFor();
      await page.getByRole("button", { name: "Share" }).waitFor();
      await page.getByRole("button", { name: "Report actions" }).waitFor();
      await page.getByRole("button", { name: "Full screen" }).waitFor();
      await page.getByRole("button", { name: "Open in new tab" }).waitFor();
      return "skeleton, then frame with the fixture document";
    });

    await record("C4", "Export opens /r/<id>?print=1 with the print script", async () => {
      const { page } = detail;
      await page.getByRole("button", { name: "Report actions" }).click();
      await page.getByRole("menuitem", { name: "Export to PDF" }).waitFor();
      await page.getByRole("menuitem", { name: "Open the chat that wrote this" }).waitFor();
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.getByRole("menuitem", { name: "Export to PDF" }).click(),
      ]);
      await popup.waitForLoadState("load");
      assert.ok(popup.url().includes(`/r/${BENIGN_ID}?print=1`), `popup url is ${popup.url()}`);
      const content = await popup.content();
      assert.match(content, /print\(\)/, "print script appended");
      await popup.close();
      return `popup ${popup.url()}`;
    });

    await record("C5", "full screen focuses Exit and Esc leaves it", async () => {
      const { page } = detail;
      await page.getByRole("button", { name: "Full screen" }).click();
      await page.waitForURL(`**/portal/reports/${BENIGN_ID}?full=1`);
      const exit = page.getByRole("button", { name: "Exit" });
      await exit.waitFor();
      const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
      assert.match(focused, /Exit/, "Exit focused on entry");
      await page.locator(`iframe[title="${BENIGN_TITLE}"]`).waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      await page.waitForURL(new URL(`/portal/reports/${BENIGN_ID}`, origin).href);
      await page.getByRole("button", { name: "Full screen" }).waitFor();
      return "full=1, focused Exit, Esc back";
    });

    await record("C6", "share on shows the link, copies it, opens it; off restores private", async () => {
      const { page } = detail;
      await page.getByRole("button", { name: "Share" }).click();
      await page.getByRole("dialog").getByText(BENIGN_TITLE).waitFor();
      await page.getByText("Only members of this workspace can open it.").waitFor();
      await page.getByText("Check the report before you share it. It was written by an AI assistant from your data and from other websites.").waitFor();
      await page.getByRole("switch").click();
      await page.getByText("Anyone with the link can view. No sign-in needed.").waitFor();
      const linkInput = page.getByLabel("Share link");
      await linkInput.waitFor();
      assert.equal(await linkInput.inputValue(), `${origin.origin}/s/${TOKEN_A}`);
      await page.getByText("Shows the latest saved version. Hidden from search engines.").waitFor();
      await page.getByRole("button", { name: "Copy link" }).click();
      await page.getByText("Link copied").waitFor();
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.getByRole("button", { name: "Open link" }).click(),
      ]);
      assert.ok(popup.url().includes(`/s/${TOKEN_A}`), `share popup url is ${popup.url()}`);
      await popup.close();
      // Off again: the link input goes away and the private copy returns.
      // (The link-lag sentence only shows mid-flight; the settled state is
      // what a regression-proof assertion can wait on.)
      await page.getByRole("switch").click();
      await linkInput.waitFor({ state: "detached" });
      await page.getByText("Only members of this workspace can open it.").waitFor();
      assert.equal(await page.getByRole("switch").getAttribute("aria-checked"), "false");
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      return "public copy, link, copied toast, popup, private copy";
    });

    await record("C7", "delete confirms, toasts, and lands back on the list", async () => {
      const { page } = detail;
      await page.getByRole("button", { name: "Report actions" }).click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await page.getByText(`Delete “${BENIGN_TITLE}”?`).waitFor();
      await page.getByText("This cannot be undone. A public link stops working.").waitFor();
      await page.getByRole("button", { name: "Delete report" }).click();
      await page.getByText("Report deleted").waitFor();
      await page.waitForURL(new URL("/portal/reports", origin).href);
      await page.getByRole("link", { name: BENIGN_TITLE }).waitFor({ state: "detached" });
      await page.getByRole("link", { name: "Acme Tees monthly check-in" }).waitFor();
      return "confirm copy, toast, redirect, row gone";
    });
  } finally {
    if (releaseDetail) releaseDetail();
    await detail.context.close();
  }

  await record("C8", "templates empty state, create, edit and delete", async () => {
    const empty = await makePage(freshState({ templates: [], remaining: 10 }));
    try {
      await empty.page.goto(new URL("/portal/reports/templates", origin).href, { waitUntil: "networkidle" });
      await empty.page.getByRole("heading", { name: "Report templates" }).waitFor();
      await empty.page.getByText("Reusable briefs the assistant follows when it writes a report: who it is for, which sections it has, and how it should sound.").waitFor();
      await empty.page.getByText("No templates yet").waitFor();
      await empty.page.getByText("A template is a reusable brief for a kind of report: who it is for, which sections it has, how it sounds.").waitFor();
    } finally { await empty.context.close(); }

    const { context, page, state } = await makePage(freshState());
    try {
      await page.goto(new URL("/portal/reports/templates", origin).href, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Monthly client check-in", exact: true }).waitFor();
      await page.getByRole("button", { name: "New template" }).click();
      await page.getByRole("dialog").getByText("New template", { exact: true }).waitFor();
      const nameInput = page.getByLabel("Name");
      assert.equal(await nameInput.getAttribute("placeholder"), "Monthly client check-in");
      assert.equal(await page.getByLabel("Description").getAttribute("placeholder"), "The monthly update we send retainer clients.");
      const instructions = page.getByLabel("Instructions");
      assert.match(await instructions.getAttribute("placeholder") ?? "", /Accent: #3730CE/);
      await page.getByText("One line saying when to use it. This is what the assistant reads to decide.").waitFor();
      await page.getByText(/Brand voice for the whole workspace lives in Context/).waitFor();
      await nameInput.fill("Quarterly business review");
      await page.getByLabel("Description").fill("The quarterly summary we send key accounts.");
      await instructions.fill("Audience: the client's marketing lead.\nTone: plain.");
      await page.getByRole("button", { name: "Create template" }).click();
      await page.getByText("Template created").waitFor();
      await page.getByRole("button", { name: "Quarterly business review", exact: true }).waitFor();
      assert.equal(state.remaining, 8, "create decrements remaining");

      await page.getByRole("button", { name: "Quarterly business review", exact: true }).click();
      await page.getByRole("dialog").getByText("Edit template").waitFor();
      await page.getByLabel("Name").fill("Quarterly business review v2");
      await page.getByRole("button", { name: "Save changes" }).click();
      await page.getByText("Template saved").waitFor();
      await page.getByRole("button", { name: "Quarterly business review v2", exact: true }).waitFor();

      await page.getByRole("button", { name: "Actions for Quarterly business review v2", exact: true }).click();
      await page.getByRole("menuitem", { name: "Edit" }).waitFor();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await page.getByText("Delete “Quarterly business review v2”?").waitFor();
      await page.getByText("Reports already written from it are not affected.").waitFor();
      await page.getByRole("button", { name: "Delete template" }).click();
      await page.getByText("Template deleted").waitFor();
      await page.getByRole("button", { name: "Quarterly business review v2", exact: true }).waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Monthly client check-in", exact: true }).waitFor();
      return "empty copy, placeholders, created/saved/deleted toasts";
    } finally { await context.close(); }
  });

  await record("C9", "Generate starts a session and navigates to the assistant", async () => {
    const { context, page, state } = await makePage(freshState());
    try {
      await page.goto(new URL("/portal/reports", origin).href, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Generate report" }).click();
      await page.getByText("Generate a report").waitFor();
      await page.getByText("Template", { exact: true }).waitFor();
      await page.getByText("Each assistant reply uses up to $0.50.").waitFor();
      const trigger = page.getByRole("combobox");
      assert.match(await trigger.textContent() ?? "", /Monthly client check-in/);
      await page.getByRole("button", { name: "Start" }).click();
      await page.waitForURL(`**/portal/assistant?s=${GEN_SESSION}`);
      assert.equal(state.generatePosts.length, 1, "one generate POST");
      assert.equal(state.generatePosts[0].templateId, TEMPLATE_ID);
      return `navigated to /portal/assistant?s=${GEN_SESSION}`;
    } finally { await context.close(); }
  });

  await record("C10", "hostile document: no script, no cookie, no remote fetch, no navigation", async () => {
    const { context, page } = await makePage(freshState());
    try {
      await page.goto(new URL(`/portal/reports/${HOSTILE_ID}`, origin).href, { waitUntil: "networkidle" });
      await page.locator('iframe[title="Acme Tees hostile fixture"]').waitFor({ state: "visible" });
      const frame = page.frame({ url: /\/r\// });
      assert.ok(frame, "hostile frame attached");
      await frame.waitForLoadState("load");
      // The served bytes are the raw hostile fixture; the sandbox + CSP keep
      // every marker inert.
      const html = await frame.evaluate(() => document.documentElement.outerHTML);
      for (const marker of [
        "window.__pwned",
        `http://${REMOTE_HOST}/x.png`,
        'http-equiv="refresh"',
        "<form",
      ]) {
        assert.ok(html.includes(marker), `frame served the hostile marker ${marker}`);
      }
      const pwned = await frame.evaluate(() => window.__pwned);
      assert.equal(pwned, undefined, "no script ran in the frame");
      const cookie = await frame.evaluate(() => {
        try {
          return { threw: false, value: document.cookie };
        } catch (error) {
          return { threw: true, name: error?.name ?? "unknown" };
        }
      });
      assert.ok(cookie.threw || cookie.value === "", `cookie unreadable in opaque origin (got ${JSON.stringify(cookie)})`);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      assert.ok(frame.url().includes(`/r/${HOSTILE_ID}`), `frame stayed on the document (got ${frame.url()})`);
      // The remote image IS attempted (the markup is served raw) but the CSP
      // blocks it before it leaves: every attempt must fail as blocked, and
      // none may finish.
      const attempts = remoteOutcomes.filter((outcome) => outcome.url.includes(REMOTE_HOST));
      assert.ok(attempts.length >= 1, "the remote image was attempted, proving the marker executed");
      const finished = attempts.filter((outcome) => outcome.finished);
      assert.deepEqual(finished, [], "no remote request completed");
      const unblocked = attempts.filter((outcome) => !/blocked|csp/i.test(outcome.error ?? ""));
      assert.deepEqual(unblocked, [], `every remote attempt was blocked: ${JSON.stringify(attempts)}`);
      const frameLeaves = frameNavigations.filter((url) => url.includes(REMOTE_HOST));
      assert.deepEqual(frameLeaves, [], "no frame navigation to the remote host");
      const causes = [...new Set(attempts.map((outcome) => outcome.error))].join(", ");
      return `pwned undefined, cookie blocked, ${attempts.length} remote attempt(s) blocked (${causes}), frame stayed`;
    } finally { await context.close(); }
  });

  await record("C11", "share wrapper at 390x844: no h-scroll, header wraps, framed sandbox", async () => {
    const { context, page } = await makePage(freshState(), { viewport: { width: 390, height: 844 } });
    try {
      await page.goto(new URL(`/s/${TOKEN_A}`, origin).href, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Synthetic fixture report" }).waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(overflow, false, "390px wrapper must not scroll horizontally");
      const wrap = await page.evaluate(() => getComputedStyle(document.querySelector("body > header")).flexWrap);
      assert.equal(wrap, "wrap", "wrapper header wraps");
      const sandbox = await page.locator('iframe[title="Synthetic fixture report"]').getAttribute("sandbox");
      assert.ok(sandbox && !sandbox.includes("allow-same-origin"), `sandbox without same-origin (got ${sandbox})`);
      // The portal list at the same phone size must not scroll the page either.
      await page.goto(new URL("/portal/reports", origin).href, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Reports" }).waitFor();
      const portalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(portalOverflow, false, "390px portal list must not scroll horizontally");
      return "wrapper + portal list, no horizontal overflow";
    } finally { await context.close(); }
  });

  await record("C12", "OG image is PNG 1200x630", async () => {
    const { context, page } = await makePage(freshState());
    try {
      const response = await page.request.get(`${origin.origin}/s/${TOKEN_A}/og.png`);
      assert.equal(response.status(), 200, "og 200");
      const contentType = response.headers()["content-type"] ?? "";
      assert.ok(contentType.startsWith("image/png"), `og content-type (got ${contentType})`);
      const body = await response.body();
      assert.equal(body.subarray(1, 4).toString("latin1"), "PNG", "PNG signature");
      const width = body.readUInt32BE(16);
      const height = body.readUInt32BE(20);
      assert.equal(width, 1200, "og width");
      assert.equal(height, 630, "og height");
      return `image/png ${width}x${height}`;
    } finally { await context.close(); }
  });

  await record("C13", "zero requests outside localhost; zero to the fixture remote host", async () => {
    const foreign = [];
    for (const raw of allRequests) {
      let hostname = "";
      try {
        hostname = new URL(raw).hostname;
      } catch {
        continue;
      }
      if (!LOCAL_HOSTS.has(hostname)) foreign.push(raw);
    }
    assert.deepEqual(foreign, [], `non-localhost requests: ${JSON.stringify(foreign.slice(0, 10))}`);
    const finishedRemote = remoteOutcomes.filter((outcome) => outcome.finished);
    assert.deepEqual(finishedRemote, [], "a remote request completed");
    const unblockedRemote = remoteOutcomes.filter((outcome) => !/blocked|csp/i.test(outcome.error ?? ""));
    assert.deepEqual(unblockedRemote, [], `a remote request left the browser: ${JSON.stringify(unblockedRemote)}`);
    const placeholder = allRequests.filter((raw) => {
      try {
        return new URL(raw).hostname === new URL(SUPABASE_URL).hostname;
      } catch {
        return false;
      }
    }).length;
    return `${allRequests.length} requests logged (${placeholder} to the route-mocked Supabase placeholder), 0 requests outside localhost, ${remoteOutcomes.length} remote attempt(s) all blocked before the network`;
  });

  await record("C14", "every mutating body satisfies the real routes' schemas", async () => {
    assert.deepEqual(contractViolations, [], `the real routes would have refused: ${contractViolations.join("; ")}`);
    return "share, delete, template and generate bodies all valid";
  });
} finally {
  await browser.close();
  if (serverChild) serverChild.kill("SIGTERM");
}

if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exitCode = 1;
} else {
  console.log("f23 browser: all cases passed");
}
