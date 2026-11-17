#!/usr/bin/env node
/**
 * F25 Phase 3 browser checks (F25-AC-13 browser half, F25-AC-14).
 *
 * Drives the real customer app with fixture-route stubs (no database, no
 * credential, no live provider): the Supabase session/membership reads and
 * the customer's own read APIs are answered in the browser context, exactly
 * like the F04 harness. `PUT /api/customer/email/preferences` is stubbed
 * (the harness aborts non-GET writes, so like F10/F26 this script rolls its
 * own context with fixture routes).
 *
 * Scenarios:
 *   B1 tab "Emails" visible, four switches with fixture values
 *   B2 toggling "Scan results" sends PUT { scanResults: false, source: "settings" }
 *   B3 a 502 response reverts the switch and shows the toast
 *   B4 /email/unsubscribe with a links.ts token: valid shows
 *      "Stop scan result emails?", submit posts to the route (intercepted
 *      303) and the page shows "You're unsubscribed"; a tampered token shows
 *      "This link is not valid"
 *   B5 390 px: no horizontal overflow
 *   B6 with lifecycle_email: false the tab is absent and the page is NotFound
 *
 * B4 runs against a dedicated server on port+1 started with a test-only
 * EMAIL_LINK_SECRET, because the shared harness server has no link secret
 * and the unsubscribe page verifies the token server-side (F24 precedent:
 * scripts that need server env spawn their own server).
 *
 * The link secret below is a throwaway QA value, not a credential.
 * Output: "ok 6 scenarios" on pass.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { openPortal as _openPortal } from "./portalFixtureHarness.mjs";

// The real token signer (PM brief §2 P3.T3.S1); inline HMAC fallback is
// byte-identical to links.ts generateUnsubscribeSignature.
let generateUnsubscribeSignature;
try {
  ({ generateUnsubscribeSignature } = await import(
    "../../src/server/email/links.ts"
  ));
} catch {
  const { createHmac } = await import("node:crypto");
  generateUnsubscribeSignature = (secret, userId, category) =>
    createHmac("sha256", secret)
      .update(`email-unsub:v1:${userId}:${category}`)
      .digest("base64url")
      .slice(0, 43);
}
void _openPortal;

let chromium;
try {
  ({ chromium } = await import(
    "../../worker/node_modules/playwright/index.mjs"
  ));
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
const b4Port = port + 1;

const output = path.resolve(process.argv[3] || "test_reports/f25-browser");
await mkdir(output, { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SUPABASE_URL = "https://placeholder.supabase.co";
const QA_PASSWORD = "qa-password-not-a-secret";
const UNSUB_USER_ID = "11111111-2222-4333-8444-555555555555";
const TEST_LINK_SECRET = "f25-qa-unsubscribe-link-secret-0123456789";

const fixturePrefs = JSON.parse(
  await readFile(
    path.join(REPO, "tests/fixtures/portal/email-preferences.json"),
    "utf8",
  ),
);

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function buildSessionToken() {
  const header = base64url({ alg: "none", typ: "JWT" });
  const payload = base64url({
    sub: "qa-user",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `${header}.${payload}.`;
}

async function readJsonFixture(name, fallback) {
  try {
    return JSON.parse(
      await readFile(path.join(REPO, "tests/fixtures/portal", name), "utf8"),
    );
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function waitForServer(targetPort, timeoutMs = 45000) {
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

function spawnNextServer(targetPort, extraEnv = {}) {
  return spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", String(targetPort)],
    {
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key",
        ...extraEnv,
      },
      stdio: "ignore",
    },
  );
}

function killChild(child) {
  if (!child) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"]);
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // ignore
  }
}

let serverChild = null;
if (!(await waitForServer(port, 1500))) {
  serverChild = spawnNextServer(port);
  const up = await waitForServer(port, 45000);
  assert.ok(up, `Next.js server failed to start on port ${port}`);
}

// B4-only server with a test-only link secret (see header).
const b4Child = spawnNextServer(b4Port, {
  EMAIL_LINK_SECRET: TEST_LINK_SECRET,
});
const b4Up = await waitForServer(b4Port, 45000);
assert.ok(b4Up, `B4 Next.js server failed to start on port ${b4Port}`);

const browser = await chromium.launch({ headless: true });

let passedCount = 0;

async function record(id, expected, run) {
  const row = {
    case: id,
    suite: "f25-browser",
    startedAt: new Date().toISOString(),
    expected,
    artifacts: [],
  };
  try {
    row.actual = await run(row.artifacts);
    row.outcome = "pass";
    passedCount++;
  } catch (error) {
    row.outcome = "fail";
    row.actual = error.stack || error.message;
    process.exitCode = 1;
  }
  row.endedAt = new Date().toISOString();
  const log = `${id}.json`;
  await writeFile(
    path.join(output, log),
    JSON.stringify({ ...row, artifacts: undefined }, null, 2),
  );
  row.artifacts.push(log);
  console.log(`${id}: ${row.outcome} — ${String(row.actual).split("\n")[0]}`);
  if (row.outcome === "fail") {
    throw new Error(`${id} failed: ${row.actual}`);
  }
}

/** Mutable stub state, reset per scenario. */
let currentFeatures = { lifecycle_email: true };
let currentPrefs = { ...fixturePrefs };
let putMode = "ok";
let putCalls = [];
let unsubscribePosts = [];

function resetStubState(features = { lifecycle_email: true }) {
  currentFeatures = { ...features };
  currentPrefs = { ...fixturePrefs };
  putMode = "ok";
  putCalls = [];
  unsubscribePosts = [];
}

async function setupPage({ viewport = { width: 1440, height: 1000 } } = {}) {
  const session =
    (await readJsonFixture("session.json", null)) ??
    (await readJsonFixture("session-acme.json", null)) ?? {
      user: { id: "qa-user", email: "owner@example.test" },
    };
  const memberships =
    (await readJsonFixture("memberships.json", null)) ?? [];
  const token = buildSessionToken();
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;

  const context = await browser.newContext({
    viewport,
    reducedMotion: "reduce",
  });

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.origin === SUPABASE_URL || url.hostname.endsWith(".supabase.co")) {
      if (url.pathname === "/auth/v1/token") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            access_token: token,
            token_type: "bearer",
            expires_in: 3600,
            expires_at: expiresAt,
            refresh_token: token,
            user: session.user,
          }),
        });
      }
      if (url.pathname === "/auth/v1/user") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(session.user),
        });
      }
      if (url.pathname.startsWith("/rest/v1/customer_brand_memberships")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(memberships),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "null",
      });
    }

    if (url.pathname === "/api/customer/features") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          brandKey: url.searchParams.get("brand_key") || "acme",
          features: currentFeatures,
        }),
      });
    }

    if (url.pathname === "/api/customer/email/preferences") {
      if (method === "GET") {
        return route.fulfill({
          status: 200,
          headers: { "Cache-Control": "no-store" },
          contentType: "application/json",
          body: JSON.stringify(currentPrefs),
        });
      }
      if (method === "PUT") {
        const payload = JSON.parse(request.postData() || "{}");
        putCalls.push(payload);
        if (putMode === "error502") {
          return route.fulfill({
            status: 502,
            headers: { "Cache-Control": "no-store" },
            contentType: "application/json",
            body: JSON.stringify({
              error: "We couldn't save your email choice. Please try again.",
              code: "email_provider_unavailable",
            }),
          });
        }
        for (const field of [
          "productUpdates",
          "scanResults",
          "scheduleAlerts",
          "spendAlerts",
        ]) {
          if (payload[field] !== undefined) currentPrefs[field] = payload[field];
        }
        return route.fulfill({
          status: 200,
          headers: { "Cache-Control": "no-store" },
          contentType: "application/json",
          body: JSON.stringify({ ...currentPrefs, loopsSynced: true }),
        });
      }
      return route.fulfill({
        status: 405,
        contentType: "application/json",
        body: JSON.stringify({ error: "Method not allowed" }),
      });
    }

    if (url.pathname.startsWith("/api/customer/")) {
      if (method === "GET" || method === "HEAD") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({}),
        });
      }
      return route.abort("blockedbyclient");
    }

    return route.continue();
  });

  const page = await context.newPage();
  await page.goto(new URL("/login", origin.href).href, {
    waitUntil: "networkidle",
  });
  const continueWithEmail = page.getByRole("button", {
    name: "Continue with email",
  });
  await continueWithEmail
    .or(page.locator("#email"))
    .first()
    .waitFor({ state: "visible", timeout: 30000 });
  if (await continueWithEmail.isVisible()) {
    await continueWithEmail.click();
  }
  await page.fill("#email", session.user.email);
  await page.fill("#password", QA_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(new URL("/portal", origin.href).href, {
    timeout: 30000,
  });

  return { context, page };
}

function switchByName(page, name) {
  return page.getByRole("switch", { name });
}

async function checkedState(switchLocator) {
  return (await switchLocator.getAttribute("aria-checked")) === "true";
}

async function waitForPutCall(count, timeoutMs = 10000) {
  const start = Date.now();
  while (putCalls.length < count && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(
    putCalls.length >= count,
    `expected ${count} PUT calls, saw ${putCalls.length}`,
  );
}

try {
  await record(
    "F25-B1",
    'tab "Emails" visible, four switches with fixture values',
    async () => {
      resetStubState({ lifecycle_email: true });
      const { context, page } = await setupPage();
      try {
        await page.goto(
          new URL("/portal/settings/notifications", origin.href).href,
          { waitUntil: "networkidle" },
        );

        const emailsTab = page.getByRole("link", { name: "Emails" });
        await emailsTab.first().waitFor({ state: "visible", timeout: 15000 });
        assert.ok(
          await emailsTab.first().isVisible(),
          "the Emails settings tab is visible",
        );

        for (const title of ["Email notifications", "Product updates"]) {
          assert.ok(
            await page
              .getByText(title, { exact: true })
              .first()
              .isVisible(),
            `CardShell title "${title}" is visible`,
          );
        }
        assert.ok(
          await page
            .getByText("These settings apply to your account in every workspace.")
            .isVisible(),
          "the account-scope description is visible",
        );

        const expectations = [
          ["Scan results", fixturePrefs.scanResults],
          ["Skipped scheduled scans", fixturePrefs.scheduleAlerts],
          ["Spend limits", fixturePrefs.spendAlerts],
          ["Get product update emails", fixturePrefs.productUpdates],
        ];
        for (const [name, value] of expectations) {
          const sw = switchByName(page, name);
          await sw.waitFor({ state: "visible", timeout: 10000 });
          assert.equal(
            await checkedState(sw),
            value,
            `switch "${name}" matches the fixture (${value})`,
          );
        }

        for (const copy of [
          "An email when a scan finishes, with the headline numbers.",
          "Sent to workspace owners when a scheduled scan doesn't run, with the reason.",
          "Sent to workspace owners when a workspace reaches its daily or monthly spend limit.",
          "Occasional emails about new features and tips. Unsubscribe anytime.",
        ]) {
          assert.ok(
            await page.getByText(copy, { exact: true }).isVisible(),
            `description copy is visible: "${copy}"`,
          );
        }

        assert.equal(
          await page
            .getByText(
              "Product update emails aren't set up yet. Your choice is saved.",
            )
            .count(),
          0,
          "the Loops-unconfigured line is hidden when loopsConfigured is true",
        );

        return `Emails tab visible; four switches match fixture ${JSON.stringify(fixturePrefs)}.`;
      } finally {
        await context.close();
      }
    },
  );

  await record(
    "F25-B2",
    'toggling "Scan results" sends PUT { scanResults: false, source: "settings" }',
    async () => {
      resetStubState({ lifecycle_email: true });
      const { context, page } = await setupPage();
      try {
        await page.goto(
          new URL("/portal/settings/notifications", origin.href).href,
          { waitUntil: "networkidle" },
        );

        const sw = switchByName(page, "Scan results");
        await sw.waitFor({ state: "visible", timeout: 15000 });
        assert.equal(await checkedState(sw), true, "Scan results starts on");

        await sw.click();
        await waitForPutCall(1);
        assert.deepEqual(putCalls[0], {
          scanResults: false,
          source: "settings",
        });

        const start = Date.now();
        while ((await checkedState(sw)) !== false && Date.now() - start < 10000) {
          await page.waitForTimeout(100);
        }
        assert.equal(await checkedState(sw), false, "switch shows the new value");

        return `PUT ${JSON.stringify(putCalls[0])}; switch now off.`;
      } finally {
        await context.close();
      }
    },
  );

  await record(
    "F25-B3",
    "a 502 response reverts the switch and shows the toast",
    async () => {
      resetStubState({ lifecycle_email: true });
      putMode = "error502";
      const { context, page } = await setupPage();
      try {
        await page.goto(
          new URL("/portal/settings/notifications", origin.href).href,
          { waitUntil: "networkidle" },
        );

        const sw = switchByName(page, "Spend limits");
        await sw.waitFor({ state: "visible", timeout: 15000 });
        assert.equal(await checkedState(sw), true, "Spend limits starts on");

        await sw.click();
        await waitForPutCall(1);

        const toast = page.getByText("We couldn't save your email choice.", {
          exact: true,
        });
        await toast.waitFor({ state: "visible", timeout: 10000 });
        assert.ok(await toast.isVisible(), "the failure toast is visible");

        const start = Date.now();
        while ((await checkedState(sw)) !== true && Date.now() - start < 10000) {
          await page.waitForTimeout(100);
        }
        assert.equal(
          await checkedState(sw),
          true,
          "the switch reverts after the failed save",
        );

        return "502 reverted Spend limits to on with the exact toast.";
      } finally {
        await context.close();
      }
    },
  );

  await record(
    "F25-B4",
    "signed unsubscribe link: valid shows the stop prompt, submit unsubscribes, tampered is invalid",
    async () => {
      resetStubState({ lifecycle_email: true });
      const b4Origin = `http://127.0.0.1:${b4Port}`;
      const context = await browser.newContext({ reducedMotion: "reduce" });
      try {
        const sig = generateUnsubscribeSignature(
          TEST_LINK_SECRET,
          UNSUB_USER_ID,
          "scan_results",
        );
        assert.equal(sig.length, 43, "links.ts token is 43 chars");
        const validQs = `u=${UNSUB_USER_ID}&c=scan_results&t=${encodeURIComponent(sig)}`;
        const validUrl = `${b4Origin}/email/unsubscribe?${validQs}`;

        await context.route(
          "**/api/customer/email/unsubscribe",
          async (route) => {
            const body = route.request().postData() || "";
            unsubscribePosts.push(Object.fromEntries(new URLSearchParams(body)));
            return route.fulfill({
              status: 303,
              headers: {
                location: `${b4Origin}/email/unsubscribe?${validQs}&done=1`,
                "cache-control": "no-store",
              },
            });
          },
        );

        const page = await context.newPage();
        await page.goto(validUrl, { waitUntil: "networkidle" });

        const robots = await page
          .locator('meta[name="robots"]')
          .getAttribute("content");
        assert.ok(
          robots && robots.includes("noindex"),
          `unsubscribe page is noindexed (got "${robots}")`,
        );

        const heading = page.getByRole("heading", {
          name: "Stop scan result emails?",
        });
        await heading.waitFor({ state: "visible", timeout: 15000 });
        assert.ok(
          await page
            .getByText(
              "We'll stop sending scan result emails to this account. You can turn them back on in Settings → Emails.",
            )
            .isVisible(),
          "the stop prompt body is visible",
        );
        for (const [name, value] of [
          ["u", UNSUB_USER_ID],
          ["c", "scan_results"],
          ["t", sig],
        ]) {
          assert.equal(
            await page.locator(`form input[name="${name}"]`).inputValue(),
            value,
            `hidden field ${name} posts to the route`,
          );
        }

        await page.getByRole("button", { name: "Stop these emails" }).click();
        await page.waitForURL("**/email/unsubscribe*done=1*", {
          timeout: 15000,
        });
        assert.equal(unsubscribePosts.length, 1, "the form posted to the route");
        assert.deepEqual(unsubscribePosts[0], {
          u: UNSUB_USER_ID,
          c: "scan_results",
          t: sig,
        });
        await page
          .getByRole("heading", { name: "You're unsubscribed" })
          .waitFor({ state: "visible", timeout: 15000 });
        assert.ok(
          await page
            .getByText("You won't get scan result emails any more.")
            .isVisible(),
          "the done body is visible",
        );
        assert.ok(
          await page.getByRole("link", { name: "Email settings" }).isVisible(),
          "the done page links to Email settings",
        );

        const badSig = `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
        await page.goto(
          `${b4Origin}/email/unsubscribe?u=${UNSUB_USER_ID}&c=scan_results&t=${encodeURIComponent(badSig)}`,
          { waitUntil: "networkidle" },
        );
        await page
          .getByRole("heading", { name: "This link is not valid" })
          .waitFor({ state: "visible", timeout: 15000 });
        assert.ok(
          await page
            .getByText("Sign in to change your email settings.")
            .isVisible(),
          "the invalid body is visible",
        );
        assert.ok(
          await page.getByRole("link", { name: "Sign in" }).isVisible(),
          "the invalid page links to Sign in",
        );

        return "valid link stops scan emails and confirms; tampered link is invalid.";
      } finally {
        await context.close();
      }
    },
  );

  await record(
    "F25-B5",
    "390 px: no horizontal overflow",
    async () => {
      resetStubState({ lifecycle_email: true });
      const { context, page } = await setupPage({
        viewport: { width: 390, height: 844 },
      });
      try {
        await page.goto(
          new URL("/portal/settings/notifications", origin.href).href,
          { waitUntil: "networkidle" },
        );
        const sw = switchByName(page, "Scan results");
        await sw.waitFor({ state: "visible", timeout: 15000 });

        const scrollWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        assert.ok(
          scrollWidth <= 390,
          `expected no horizontal overflow at 390 px, scrollWidth = ${scrollWidth}`,
        );
        return `390 px renders with scrollWidth = ${scrollWidth}.`;
      } finally {
        await context.close();
      }
    },
  );

  await record(
    "F25-B6",
    "flag off: the Emails tab is absent and the page is NotFound",
    async () => {
      resetStubState({ lifecycle_email: false });
      const { context, page } = await setupPage();
      try {
        await page.goto(new URL("/portal/settings", origin.href).href, {
          waitUntil: "networkidle",
        });
        assert.equal(
          await page.getByRole("link", { name: "Emails", exact: true }).count(),
          0,
          "no Emails tab when lifecycle_email is off",
        );

        await page.goto(
          new URL("/portal/settings/notifications", origin.href).href,
          { waitUntil: "networkidle" },
        );
        await page
          .getByText("The page you are looking for does not exist.")
          .waitFor({ state: "visible", timeout: 15000 });
        assert.ok(
          await page
            .getByText("The page you are looking for does not exist.")
            .isVisible(),
          "flag-off page renders F04 NotFound",
        );

        return "flag off hides the tab and the page is NotFound.";
      } finally {
        await context.close();
      }
    },
  );

  console.log("ok 6 scenarios");
} finally {
  await browser.close();
  killChild(b4Child);
  if (serverChild) killChild(serverChild);
}
