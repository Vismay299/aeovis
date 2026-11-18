#!/usr/bin/env node
/**
 * F27 phase 2–3 browser checks. Every API response is a checked-in fixture or a
 * deterministic transformation of one. All mutating requests are recorded;
 * requests outside the loopback app are refused and counted.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../../tests/fixtures/f27");
const origin = new URL(process.argv[2] || "http://127.0.0.1:3328");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "browser checks require a loopback app");
const output = path.resolve(process.argv[3] || "test_reports/f27-browser");
await mkdir(output, { recursive: true });

async function fixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURES, name), "utf8"));
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function bodyOf(request) {
  try { return JSON.parse(request.postData() || "{}"); } catch { return {}; }
}
function response(route, status, body) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

const [newUser, workspace, ga4Off, approved, user, membership, questionQuote, blockedQuote, scanQuote, gscProperties, ga4Connection, emailPreferences] = await Promise.all([
  fixture("onboarding-state-new-user.json"),
  fixture("onboarding-state-workspace.json"),
  fixture("onboarding-state-ga4-off.json"),
  fixture("onboarding-state-approved.json"),
  fixture("onboarding-user.json"),
  fixture("onboarding-membership.json"),
  fixture("onboarding-price-questions.json"),
  fixture("onboarding-price-questions-blocked.json"),
  fixture("onboarding-price-scan.json"),
  fixture("onboarding-gsc-properties.json"),
  fixture("onboarding-ga4-connection.json"),
  fixture("onboarding-email-preferences.json"),
]);

const browser = await chromium.launch({ headless: true });
const results = [];
let totalExternal = 0;

async function startCase({ state = workspace, memberships = [], priceMode = "normal", setup = [], features = {} } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const scenario = {
    state: clone(state),
    memberships: clone(memberships),
    writes: [],
    onboardingGets: 0,
    setupGets: 0,
    setupSteps: clone(setup),
    features: { product_analytics: true, lifecycle_email: true, price_review: true, ...features },
    privacyWrites: [],
    emailWrites: [],
    priceMode,
    priceReads: { questions: 0, scan: 0 },
    external: [],
    completed: false,
    gscAuthorization: "",
  };

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const appOrigin = origin.origin;
    if (url.hostname.endsWith(".supabase.co")) {
      if (method !== "GET" && method !== "HEAD") {
        scenario.writes.push({ method, path: url.pathname, fixture: "auth-only" });
      }
      if (url.pathname === "/auth/v1/token") {
        const token = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.`;
        return response(route, 200, { access_token: token, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: token, user });
      }
      if (url.pathname === "/auth/v1/user") return response(route, 200, user);
      if (url.pathname === "/rest/v1/rpc/accept_customer_team_invites") return response(route, 200, null);
      if (url.pathname.startsWith("/rest/v1/customer_brand_memberships")) return response(route, 200, scenario.memberships);
      if (url.pathname.startsWith("/rest/v1/user_onboarding")) {
        return response(route, 200, scenario.completed ? [{ completed_at: "2026-11-15T00:00:00.000Z", brand_key: scenario.state.workspace?.brandKey || "f27-workspace" }] : []);
      }
      return response(route, 200, null);
    }
    if (url.origin !== appOrigin) {
      scenario.external.push(`${method} ${url.origin}${url.pathname}`);
      totalExternal += 1;
      return route.abort("blockedbyclient");
    }

    if (url.pathname.startsWith("/api/customer/") && method !== "GET" && method !== "HEAD") {
      const record = { method, path: url.pathname, body: bodyOf(request) };
      scenario.writes.push(record);
      if (url.pathname === "/api/customer/privacy") scenario.privacyWrites.push(record.body);
      if (url.pathname === "/api/customer/email/preferences") scenario.emailWrites.push(record.body);
    }

    if (url.pathname === "/api/customer/onboarding" && method === "GET") {
      scenario.onboardingGets += 1;
      return response(route, 200, scenario.completed ? { ...scenario.state, needsOnboarding: false, completedAt: "2026-11-15T00:00:00.000Z" } : scenario.state);
    }
    if (url.pathname === "/api/customer/onboarding/website" && method === "POST") {
      const body = bodyOf(request);
      if (body.website === "invalid") return response(route, 400, { code: "website_invalid", error: "Enter a valid website, like acme.com." });
      if (!body.brandName) return response(route, 400, { code: "brand_name_invalid", error: "Enter your company or brand name." });
      scenario.state = clone(workspace);
      scenario.state.research = { available: true, status: "none", jobId: null };
      scenario.state.workspace.website = body.website.startsWith("http") ? body.website : `https://${body.website}`;
      scenario.state.workspace.websiteHost = "acme.example";
      scenario.state.workspace.displayName = body.brandName;
      scenario.memberships = clone(membership);
      return response(route, 200, scenario.state);
    }
    if (url.pathname === "/api/customer/onboarding/step" && method === "POST") {
      const body = bodyOf(request);
      scenario.state.steps[body.step] = body.status;
      return response(route, 200, { steps: scenario.state.steps });
    }
    if (url.pathname === "/api/customer/onboarding/complete" && method === "POST") {
      scenario.completed = true;
      const body = bodyOf(request);
      if (scenario.state.workspace) scenario.state.workspace.hasScans = body.via === "first_scan";
      return response(route, 200, { completedAt: "2026-11-15T00:00:00.000Z", via: body.via, destination: "/portal" });
    }
    if (url.pathname === "/api/customer/price/estimate" && method === "POST") {
      const action = bodyOf(request).action;
      if (action === "questions.setup.run") {
        scenario.priceReads.questions += 1;
        return response(route, 200, scenario.priceMode === "blocked" ? blockedQuote : questionQuote);
      }
      if (action === "ai_visibility.scan.run") {
        scenario.priceReads.scan += 1;
        return response(route, 200, scanQuote);
      }
      return response(route, 500, { code: "fixture_missing", error: "No fixture quote for this action." });
    }
    if (url.pathname === "/api/customer/questions/setup" && method === "POST") {
      scenario.state.research = { available: true, status: "running", jobId: "job-research-f27" };
      return response(route, 202, { jobId: "job-research-f27", deduped: false });
    }
    if (url.pathname === "/api/customer/scan" && method === "POST") {
      scenario.state.workspace ||= clone(workspace.workspace);
      scenario.state.workspace.hasScans = true;
      return response(route, 201, { jobId: "job-scan-f27" });
    }
    if (url.pathname === "/api/customer/gsc/connect" && method === "POST") {
      scenario.gscAuthorization = new URL("/gsc-authorize", appOrigin).href;
      return response(route, 200, { authorization_url: scenario.gscAuthorization });
    }
    if (url.pathname === "/api/customer/gsc/properties" && method === "GET") return response(route, 200, gscProperties);
    if (url.pathname === "/api/customer/gsc/property" && method === "POST") {
      scenario.state.gsc = { connected: true, property: "sc-domain:acme.example" };
      return response(route, 200, { property: { siteUrl: "sc-domain:acme.example" } });
    }
    if (url.pathname === "/api/customer/ga4" && method === "GET") return response(route, 200, ga4Connection);
    if (url.pathname === "/api/customer/ga4/properties" && method === "GET") return response(route, 200, { accounts: [] });
    if (url.pathname === "/api/customer/privacy" && method === "GET") return response(route, 200, { analytics: null, decidedAt: null, source: null, policyVersion: "2026-10-22", telemetryAvailable: true });
    if (url.pathname === "/api/customer/email/preferences" && method === "GET") return response(route, 200, emailPreferences);
    if (url.pathname === "/api/customer/features" && method === "GET") return response(route, 200, { brandKey: "f27-workspace", features: scenario.features });
    if (url.pathname === "/api/customer/setup" && method === "GET") {
      scenario.setupGets += 1;
      return response(route, 200, { brandKey: "f27-workspace", steps: scenario.setupSteps });
    }
    if (url.pathname === "/api/customer/setup/dismiss" && method === "POST") {
      const body = bodyOf(request);
      scenario.setupSteps = scenario.setupSteps.map((step) =>
        step.id === body.step
          ? { ...step, status: body.dismissed ? (step.status === "done" ? "done" : "skipped") : "todo" }
          : step
      );
      return response(route, 200, { brandKey: "f27-workspace", steps: scenario.setupSteps });
    }
    if (url.pathname === "/api/customer/gsc" && method === "GET") return response(route, 200, { connected: false, connection: null });
    if (url.pathname.startsWith("/api/customer/")) return response(route, 200, {});

    if (url.pathname === "/gsc-authorize") return route.fulfill({ status: 200, contentType: "text/html", body: "fixture" });
    return route.continue();
  });

  await page.goto(new URL("/login", origin).href, { waitUntil: "domcontentloaded" });
  const emailButton = page.getByRole("button", { name: "Continue with email" });
  await emailButton.or(page.locator("#email")).first().waitFor({ state: "visible", timeout: 30000 });
  if (await emailButton.isVisible()) await emailButton.click();
  await page.fill("#email", user.email);
  await page.fill("#password", "qa-password-not-a-secret");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/portal", { timeout: 30000 });
  return { context, page, scenario };
}

async function record(id, run) {
  const startedAt = new Date().toISOString();
  try {
    const { details, ...rest } = await run();
    const result = { case: id, outcome: "ok", startedAt, endedAt: new Date().toISOString(), details: details || null, ...rest };
    results.push(result);
    await writeFile(path.join(output, `${id}.json`), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    const result = { case: id, outcome: "fail", startedAt, endedAt: new Date().toISOString(), error: error.stack || error.message };
    results.push(result);
    await writeFile(path.join(output, `${id}.json`), JSON.stringify(result, null, 2));
    process.exitCode = 1;
    console.error(`${id}: FAIL — ${error.message}`);
    return result;
  }
}

try {
  await record("W1", async () => {
    const { context, page, scenario } = await startCase({ state: newUser });
    try {
      await page.goto(new URL("/onboarding?domain=acme.example&scan=0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90", origin).href, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "What's your website?" }).waitFor();
      assert.equal(await page.locator("#onboarding-website").inputValue(), "https://acme.example");
      assert.equal(await page.locator("#onboarding-brand").inputValue(), "Acme");
      assert.match(await page.locator("main").innerText(), /the 24 questions from your free scan/);
      assert.deepEqual(scenario.external, []);
      return { details: "Website and brand prefill plus the 24-question hand-off banner are visible.", writes: scenario.writes, external: scenario.external };
    } finally { await context.close(); }
  });

  await record("W2", async () => {
    const { context, page, scenario } = await startCase({ state: workspace });
    try {
      await page.goto(new URL("/onboarding?step=website", origin).href, { waitUntil: "networkidle" });
      await page.locator("#onboarding-website").fill("invalid");
      await page.getByRole("button", { name: "Save and continue" }).click();
      await page.getByRole("alert").getByText("Enter a valid website, like acme.com.").waitFor();
      assert.equal(scenario.writes.filter((write) => write.path.endsWith("/website")).length, 1);
      assert.deepEqual(scenario.external, []);
      return { details: "The route refusal appears inline before any paid or provider action.", writes: scenario.writes, external: scenario.external };
    } finally { await context.close(); }
  });

  await record("W3", async () => {
    const normal = await startCase({ state: newUser });
    try {
      await normal.page.goto(new URL("/onboarding", origin).href, { waitUntil: "networkidle" });
      await normal.page.getByRole("button", { name: "Save and continue" }).click();
      const dialog = normal.page.getByRole("dialog");
      await dialog.getByRole("heading", { name: "Research your questions" }).waitFor();
      // The quote loads after the dialog opens; wait for it instead of reading once.
      await dialog.getByText(/Up to \$1\.23/).first().waitFor();
      await dialog.getByRole("button", { name: "Start research" }).click();
      await normal.page.getByRole("heading", { name: "Connect Google Search Console" }).waitFor();
      const researchWrite = normal.scenario.writes.find((write) => write.path === "/api/customer/questions/setup");
      assert.equal(researchWrite?.body.maxUsd, 1.23);
      assert.deepEqual(normal.scenario.external, []);
    } finally { await normal.context.close(); }

    const blocked = await startCase({ state: newUser, priceMode: "blocked" });
    try {
      await blocked.page.goto(new URL("/onboarding", origin).href, { waitUntil: "networkidle" });
      await blocked.page.getByRole("button", { name: "Save and continue" }).click();
      const dialog = blocked.page.getByRole("dialog");
      await dialog.getByText("Question research is unavailable for this workspace.").waitFor();
      assert.equal(await dialog.getByRole("button", { name: "Start research" }).count(), 0);
      assert.equal(await dialog.getByRole("button", { name: "Skip research" }).count(), 1);
      assert.equal(blocked.scenario.writes.some((write) => write.path === "/api/customer/questions/setup"), false);
      return { details: "The shown research ceiling is sent on confirm; a blocked quote offers only Skip research and sends no setup call.", writes: [...normal.scenario.writes, ...blocked.scenario.writes], external: [...normal.scenario.external, ...blocked.scenario.external] };
    } finally { await blocked.context.close(); }
  });

  await record("W4", async () => {
    const { context, page, scenario } = await startCase({ state: workspace });
    try {
      await page.goto(new URL("/onboarding?step=search_console", origin).href, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Connect with Google" }).click();
      await page.waitForURL((url) => url.pathname === "/gsc-authorize");
      const connect = scenario.writes.find((write) => write.path === "/api/customer/gsc/connect");
      assert.equal(connect?.body.return_to, "/onboarding");
      await page.goto(new URL("/onboarding?step=search_console&gsc_connected=true&brand_key=f27-workspace&gsc_attempt=5b8f0000-0000-4000-8000-000000000001", origin).href, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Choose a Search Console property" }).waitFor();
      await page.getByRole("button", { name: "Connect selected property" }).click();
      await page.getByRole("heading", { name: "Connect Google Analytics" }).waitFor();
      assert.ok(scenario.writes.some((write) => write.path === "/api/customer/gsc/property"));
      assert.deepEqual(scenario.external, []);
      return { details: "The connect request returns to onboarding, the fixture property picker appears, and selecting it advances.", writes: scenario.writes, external: scenario.external };
    } finally { await context.close(); }
  });

  await record("W5", async () => {
    const { context, page, scenario } = await startCase({ state: ga4Off });
    try {
      await page.goto(new URL("/onboarding?step=analytics", origin).href, { waitUntil: "networkidle" });
      assert.equal(await page.getByRole("navigation", { name: "Onboarding steps" }).getByRole("button").count(), 4);
      assert.equal(await page.getByRole("button", { name: "Step 3: Google Analytics" }).count(), 0);
      assert.deepEqual(scenario.external, []);
      return { details: "Analytics is hidden when unavailable and the progress bar has four steps.", writes: scenario.writes, external: scenario.external };
    } finally { await context.close(); }
  });

  await record("W6", async () => {
    const { context, page, scenario } = await startCase({ state: approved });
    try {
      await page.goto(new URL("/onboarding?step=preferences", origin).href, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("heading", { name: "Review your questions and run your first scan" }).waitFor();
      assert.deepEqual(scenario.privacyWrites.at(-1), { analytics: false, source: "onboarding" });
      assert.deepEqual(scenario.emailWrites, [], "untouched email preference sends no PUT");
      assert.equal(scenario.writes.some((write) => write.path === "/api/customer/scan"), false, "the scan waits for a click");
      await page.getByRole("button", { name: "Run first scan" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("heading", { name: "Run your first scan" }).waitFor();
      await dialog.getByRole("button", { name: "Run first scan" }).click();
      await page.waitForURL((url) => url.pathname === "/portal", { timeout: 30000 });
      const scanWrite = scenario.writes.find((write) => write.path === "/api/customer/scan");
      assert.equal(scanWrite?.body.maxUsd, 0.15);
      assert.ok(scenario.writes.some((write) => write.path === "/api/customer/onboarding/complete" && write.body.via === "first_scan"));
      assert.deepEqual(scenario.external, []);
      return { details: "Preferences are saved; no scan starts before approval, and the confirmed ceiling is sent with the scan request.", writes: scenario.writes, external: scenario.external };
    } finally { await context.close(); }
  });

  await record("W7", async () => {
    const { context, page, scenario } = await startCase({ state: workspace });
    try {
      await page.goto(new URL("/onboarding?step=website", origin).href, { waitUntil: "networkidle" });
      for (const step of ["website", "search_console", "analytics", "preferences", "first_scan"]) {
        const completion = step === "first_scan"
          ? page.waitForResponse((response) => new URL(response.url()).pathname === "/api/customer/onboarding/complete")
          : null;
        await page.getByRole("button", { name: "Skip for now" }).click();
        if (completion) await completion;
        if (step !== "first_scan") await page.getByRole("button", { name: `Step ${["website", "search_console", "analytics", "preferences", "first_scan"].indexOf(step) + 2}:` }).first().waitFor({ timeout: 3000 }).catch(() => {});
      }
      assert.equal(scenario.writes.filter((write) => write.path === "/api/customer/onboarding/step").length, 5);
      assert.ok(scenario.writes.some((write) => write.path === "/api/customer/onboarding/complete"));
      assert.deepEqual(scenario.external, []);
      const empty = await startCase({ state: newUser });
      try {
        await empty.page.goto(new URL("/onboarding", origin).href, { waitUntil: "networkidle" });
        await empty.page.getByRole("button", { name: "Skip for now" }).click();
        await empty.page.waitForURL((url) => url.pathname === "/portal");
        await empty.page.getByRole("heading", { name: "Your account is ready" }).waitFor();
        assert.ok(empty.scenario.writes.some((write) => write.path === "/api/customer/onboarding/complete" && write.body.via === "skipped"));
        return { details: "Skip works on all five workspace steps; skipping before workspace creation completes onboarding and shows the account-ready screen.", writes: [...scenario.writes, ...empty.scenario.writes], external: [...scenario.external, ...empty.scenario.external] };
      } finally { await empty.context.close(); }
    } finally { await context.close(); }
  });

  await record("W8", async () => {
    const { context, page, scenario } = await startCase({ state: workspace });
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(new URL("/onboarding?step=preferences", origin).href, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Help make Perceev better" }).waitFor();
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Help make Perceev better" }).waitFor();
      await page.getByRole("button", { name: "Step 2: Google Search Console" }).click();
      await page.getByRole("heading", { name: "Connect Google Search Console" }).waitFor();
      await page.getByRole("button", { name: "Back" }).click();
      await page.getByRole("heading", { name: "What's your website?" }).waitFor();
      const widths = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(widths.scroll <= widths.client, `390px view overflows: ${JSON.stringify(widths)}`);
      assert.deepEqual(scenario.external, []);
      return { details: "The URL restores the active step; progress buttons and Back navigate; 390px has no horizontal overflow.", viewport: widths, writes: scenario.writes, external: scenario.external };
    } finally { await context.close(); }
  });

  await record("W9", async () => {
    const existing = await startCase({ state: approved, memberships: membership });
    try {
      await existing.page.goto(new URL("/portal/scans", origin).href, { waitUntil: "networkidle" });
      assert.equal(new URL(existing.page.url()).pathname, "/portal/scans");
      assert.equal(existing.scenario.onboardingGets, 0, "existing workspace with no onboarding row does not call the onboarding route");
    } finally { await existing.context.close(); }

    const fresh = await startCase({ state: newUser, memberships: [] });
    try {
      await fresh.page.goto(new URL("/portal/scans", origin).href, { waitUntil: "networkidle" });
      await fresh.page.waitForURL((url) => url.pathname === "/onboarding");
      assert.equal(new URL(fresh.page.url()).searchParams.get("redirect"), "/portal/scans");
      const current = clone(newUser);
      current.workspace = clone(workspace.workspace);
      fresh.scenario.state = current;
      await fresh.page.goto(new URL("/onboarding?step=first_scan&redirect=%2Fportal%2Fscans", origin).href, { waitUntil: "networkidle" });
      await fresh.page.getByRole("button", { name: "Finish" }).click();
      await fresh.page.waitForURL((url) => url.pathname === "/portal/scans", { timeout: 30000 });
      assert.deepEqual(fresh.scenario.external, []);
      return { details: "Existing workspace remains on the requested page; a new user preserves the requested path through Finish.", writes: [...existing.scenario.writes, ...fresh.scenario.writes], external: [...existing.scenario.external, ...fresh.scenario.external] };
    } finally { await fresh.context.close(); }
  });

  await record("W10", async () => {
    const setupRows = [
      { id: "questions", status: "todo" },
      { id: "scan", status: "todo" },
      { id: "gsc", status: "todo" },
      { id: "audit", status: "done" },
      { id: "draft", status: "done" },
    ];

    const enabled = await startCase({
      memberships: membership,
      features: { onboarding_wizard: true },
      setup: setupRows,
    });
    try {
      await enabled.page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
      await enabled.page.getByRole("heading", { name: "Get started", exact: true, level: 2 }).waitFor();
      assert.equal(
        enabled.scenario.writes.some((write) => write.path === "/api/customer/setup/dismiss"),
        false,
        "no row is deferred before a click"
      );
      await enabled.page.getByRole("button", { name: /Approve your questions/ }).click();
      await enabled.page.getByRole("button", { name: "Skip for now", exact: true }).first().click();
      await enabled.page.getByRole("button", { name: "1 saved for later", exact: true }).waitFor();
      const deferred = enabled.scenario.writes.find((write) => write.path === "/api/customer/setup/dismiss");
      assert.equal(deferred?.body.step, "questions");
      assert.equal(deferred?.body.dismissed, true);
      await enabled.page.getByRole("button", { name: "1 saved for later", exact: true }).click();
      await enabled.page.getByRole("button", { name: "Restore Approve your questions", exact: true }).click();
      await enabled.page.getByRole("button", { name: "1 saved for later", exact: true }).waitFor({ state: "detached" });
      await enabled.page.getByRole("button", { name: /Approve your questions/ }).waitFor();
      assert.ok(
        enabled.scenario.writes.some(
          (write) => write.path === "/api/customer/setup/dismiss" && write.body.dismissed === false
        ),
        "Restore sends dismissed: false"
      );
      assert.ok(enabled.scenario.setupGets >= 1, "the checklist reads the setup route");
      assert.deepEqual(enabled.scenario.external, []);
    } finally {
      await enabled.context.close();
    }

    const allDone = await startCase({
      memberships: membership,
      features: { onboarding_wizard: true },
      setup: setupRows.map((step) => ({ ...step, status: "done" })),
    });
    try {
      await allDone.page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
      await allDone.page.getByRole("heading", { name: "Acme", exact: true, level: 1 }).waitFor();
      assert.equal(await allDone.page.getByRole("heading", { name: "Get started", exact: true, level: 2 }).count(), 0, "nothing renders when every row is done");
      assert.equal(await allDone.page.getByRole("heading", { name: "Getting started", exact: true, level: 2 }).count(), 0);
      assert.deepEqual(allDone.scenario.external, []);
    } finally {
      await allDone.context.close();
    }

    const flagOff = await startCase({
      memberships: membership,
      features: { onboarding_wizard: false },
      setup: setupRows,
    });
    try {
      await flagOff.page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
      await flagOff.page.getByRole("heading", { name: "Acme", exact: true, level: 1 }).waitFor();
      assert.equal(await flagOff.page.getByRole("heading", { name: "Get started", exact: true, level: 2 }).count(), 0, "SetupChecklist renders only with the flag on; flag off renders nothing");
      assert.equal(await flagOff.page.getByRole("heading", { name: "Getting started", exact: true, level: 2 }).count(), 0);
      assert.equal(flagOff.scenario.setupGets, 0, "the checklist route is not called when the flag is off");
      assert.deepEqual(flagOff.scenario.external, []);
      return {
        details: "SetupChecklist renders only with the flag on; flag off renders nothing; moves a skipped row into saved for later, and Restore brings it back; an all-done workspace renders no card.",
        writes: [
          ...enabled.scenario.writes,
          ...allDone.scenario.writes,
          ...flagOff.scenario.writes,
        ],
        external: [
          ...enabled.scenario.external,
          ...allDone.scenario.external,
          ...flagOff.scenario.external,
        ],
      };
    } finally {
      await flagOff.context.close();
    }
  });
} finally {
  await browser.close();
  const summary = {
    suite: "f27-browser",
    scenarios: results.length,
    passed: results.filter((result) => result.outcome === "ok").length,
    failed: results.filter((result) => result.outcome === "fail").length,
    externalRequests: totalExternal,
    writesRecorded: results.reduce((sum, result) => sum + (result.writes?.length || 0), 0),
    results,
  };
  await writeFile(path.join(output, "report.json"), JSON.stringify(summary, null, 2));
  if (summary.failed === 0 && summary.scenarios === 10 && summary.externalRequests === 0) {
    console.log("ok 10 scenarios");
    console.log("0 external requests");
  } else {
    console.error(`failed ${summary.failed} of ${summary.scenarios} scenarios; ${summary.externalRequests} external requests`);
    process.exitCode = 1;
  }
}
