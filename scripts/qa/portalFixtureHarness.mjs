#!/usr/bin/env node
/**
 * F04 — the portal fixture harness.
 *
 * Opens the customer app in a browser with the API answered from files under
 * `tests/fixtures/portal/`, so the shell, the navigation and the workspace
 * switcher can be exercised without a database, a credential or a network
 * call to any third party.
 *
 * WHAT IS SUBSTITUTED: the Supabase session and membership reads, and the
 * customer's own read APIs. Nothing under test is replaced — the real shell,
 * the real navigation model and the real theme script all run.
 *
 * THE TOKEN IS BUILT AT RUNTIME. The harness mints an unsigned JWT-shaped
 * string from `{"alg":"none"}` and a far-future expiry, so no credential is
 * ever written down. It is not a key and grants nothing: every request it
 * could authenticate is answered by this harness.
 *
 * NO WRITES. A non-GET to a customer route is aborted and counted, so a case
 * that tried to change something would fail rather than quietly succeed.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.resolve(HERE, "../../tests/fixtures/portal");

/** The placeholder Supabase the app is built against (see `.github/workflows/ci.yml`). */
export const SUPABASE_URL = "https://placeholder.supabase.co";

/** The password the harness types into the sign-in form. It opens nothing. */
const QA_PASSWORD = "qa-password-not-a-secret";

/** base64url, without padding. */
function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * An unsigned, runtime-built session token.
 *
 * Never a literal: the header and the payload are minted here, so nothing in
 * the repository holds a token-shaped string.
 */
export function buildSessionToken() {
  const header = base64url({ alg: "none", typ: "JWT" });
  const payload = base64url({
    sub: "qa-user",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `${header}.${payload}.`;
}

/** A fixture file, or undefined when it is not there. */
export async function readFixture(name) {
  try {
    return JSON.parse(await readFile(path.join(FIXTURE_DIR, name), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * A workspace-scoped fixture: the workspace's own file when it has one, the
 * first workspace's file otherwise, and the built-in default last.
 */
async function brandFixture(base, brand, fallback) {
  const own = await readFixture(`${base}-${brand}.json`);
  if (own !== undefined) return own;
  const first = await readFixture(`${base}-acme.json`);
  if (first !== undefined) return first;
  return fallback;
}

/** The body the customer's read APIs answer with, per path. */
async function customerApiFixture(url) {
  const brand = url.searchParams.get("brand_key") || "acme";
  const { pathname } = url;

  if (pathname === "/api/customer/overview") {
    return brandFixture("overview", brand, { scans: [], content_items: [], metrics: {} });
  }
  if (pathname === "/api/customer/gsc") {
    return brandFixture("gsc", brand, { connected: false, connection: null });
  }
  if (pathname === "/api/customer/features") {
    return brandFixture("features", brand, { brandKey: brand, features: {} });
  }
  if (pathname === "/api/customer/scan") {
    return brandFixture("scans", brand, { scans: [], jobs: [] });
  }
  if (pathname.startsWith("/api/customer/scan/report/")) {
    const id = pathname.split("/").pop();
    return (await readFixture(`report-${id}.json`)) ?? (await readFixture("report-scan-1.json")) ?? {};
  }
  if (pathname === "/api/customer/team") {
    return brandFixture("team", brand, { members: [], invites: [] });
  }
  if (pathname === "/api/customer/content") {
    return brandFixture("content", brand, { items: [], jobs: [] });
  }
  if (pathname === "/api/customer/repairs/panel") {
    return brandFixture("panel", brand, { items: [] });
  }
  if (pathname === "/api/customer/measurement") {
    return brandFixture("panel", brand, { items: [] });
  }
  return {};
}

/**
 * Opens the portal and signs in.
 *
 * @param {import("playwright").Browser} browser
 * @param {string|URL} origin the local app
 * @param {{ viewport?: { width: number, height: number }, theme?: "system"|"light"|"dark", fixtures?: { memberships?: unknown } }} [options]
 * @returns {Promise<{ context: import("playwright").BrowserContext, page: import("playwright").Page, blockedWrites: string[], featureRequests: (string|null)[] }>}
 */
export async function openPortal(browser, origin, options = {}) {
  const {
    viewport = { width: 1440, height: 1000 },
    theme,
    fixtures = {},
  } = options;

  const base = typeof origin === "string" ? origin : origin.href;
  const appOrigin = new URL(base).origin;

  const session = (await readFixture("session.json")) ?? { user: { id: "qa-user", email: "owner@example.test" } };
  const memberships = fixtures.memberships ?? (await readFixture("memberships.json")) ?? [];
  const token = buildSessionToken();
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;

  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });

  /** Every non-GET to a customer route the app tried to make. */
  const blockedWrites = [];
  /** The brand_key of every feature-flags read. */
  const featureRequests = [];

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.origin === SUPABASE_URL) {
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
      if (url.pathname === "/rest/v1/rpc/accept_customer_team_invites") {
        return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
      }
      if (url.pathname.startsWith("/rest/v1/customer_brand_memberships")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(memberships),
        });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    }

    if (url.pathname.startsWith("/api/customer/")) {
      if (method !== "GET" && method !== "HEAD") {
        blockedWrites.push(`${method} ${url.pathname}`);
        return route.abort("blockedbyclient");
      }
      if (url.pathname === "/api/customer/features") {
        featureRequests.push(url.searchParams.get("brand_key"));
      }
      const body = await customerApiFixture(url);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    }

    if (url.origin !== appOrigin) {
      // No third party is reached from the portal.
      return route.abort("blockedbyclient");
    }

    return route.continue();
  });

  const page = await context.newPage();

  if (theme) {
    await page.addInitScript((value) => {
      try {
        window.localStorage.setItem("perceev:theme-preference", value);
      } catch {
        /* storage unavailable */
      }
    }, theme);
  }

  await page.goto(new URL("/login", base).href, { waitUntil: "networkidle" });
  await page.fill("#email", session.user.email);
  await page.fill("#password", QA_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(new URL("/portal", base).href, { timeout: 30000 });

  return { context, page, blockedWrites, featureRequests };
}
