#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const rawArg = process.argv[2] || "http://127.0.0.1:3328";
const originUrl = new URL(rawArg);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(originUrl.hostname),
  "browser checks require a disposable local app"
);
const port = parseInt(originUrl.port || "3328", 10);
const SUPABASE_URL = "https://placeholder.supabase.co";

const externalRequests = [];

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

function spawnNextServer(targetPort, envOverrides) {
  const child = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", String(targetPort)],
    {
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key",
        ...envOverrides,
      },
      stdio: "ignore",
    }
  );
  return child;
}

async function stopServer(child) {
  if (!child) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  await new Promise((r) => setTimeout(r, 1000));
}

// Setup Playwright browser
const browser = await chromium.launch({ headless: true });

async function createInterceptedContext(targetPort) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });

  const recordedRequests = [];

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    // Intercept Turnstile script
    if (url.origin === "https://challenges.cloudflare.com") {
      if (url.pathname.includes("turnstile")) {
        return route.fulfill({
          status: 200,
          contentType: "application/javascript",
          body: `
            window.turnstile = {
              render(el, o) {
                el.dataset.qa = "turnstile";
                el.style.width = "300px";
                el.style.height = "65px";
                setTimeout(() => { if (o && o.callback) o.callback("qa-token"); }, 10);
                return "w1";
              },
              reset(id) {},
              remove(id) {}
            };
          `,
        });
      }
    }

    // Intercept Supabase Auth
    if (url.origin === SUPABASE_URL) {
      recordedRequests.push({
        method: request.method(),
        url: request.url(),
        pathname: url.pathname,
        searchParams: url.searchParams,
        headers: request.headers(),
        postData: request.postData(),
        json: (() => {
          try {
            return request.postDataJSON();
          } catch {
            return null;
          }
        })(),
      });

      if (url.pathname === "/auth/v1/authorize") {
        return route.abort("blockedbyclient");
      }

      // Default mock responses for Supabase Auth
      if (url.pathname === "/auth/v1/user") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "qa-user",
            email: "qa@example.test",
            email_confirmed_at: "2026-11-01T00:00:00Z",
          }),
        });
      }

      if (url.pathname === "/auth/v1/token") {
        const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
        const payload = Buffer.from(
          JSON.stringify({
            sub: "qa-user",
            exp: Math.floor(Date.now() / 1000) + 3600,
          })
        ).toString("base64url");
        const token = `${header}.${payload}.`;

        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            access_token: token,
            token_type: "bearer",
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            refresh_token: token,
            user: {
              id: "qa-user",
              email: "qa@example.test",
              email_confirmed_at: "2026-11-01T00:00:00Z",
            },
          }),
        });
      }

      if (url.pathname === "/auth/v1/signup") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            user: { id: "qa-user-new", email: "qa@example.test" },
            session: null,
          }),
        });
      }

      if (url.pathname === "/auth/v1/resend") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({}),
        });
      }

      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    }

    // Check external requests
    const isLocal =
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]";

    if (!isLocal) {
      externalRequests.push(`${request.method()} ${request.url()}`);
      return route.abort("blockedbyclient");
    }

    return route.continue();
  });

  return { context, recordedRequests };
}

let passedScenarios = 0;

try {
  // ==========================================
  // SERVER START 1: No key, Google sign-in OFF
  // ==========================================
  const server1 = spawnNextServer(port, {
    FEATURE_GOOGLE_SIGN_IN: "off",
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "",
  });

  const s1Ready = await waitForServer(port);
  assert.ok(s1Ready, "Server 1 ready on port " + port);

  try {
    // ----------------------------------------------------
    // Scenario B1: /login shows email form directly, no Turnstile,
    // sign-in POST body has no gotrue_meta_security.captcha_token
    // ----------------------------------------------------
    {
      const { context, recordedRequests } = await createInterceptedContext(port);
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/login`, { waitUntil: "networkidle" });

      const emailInput = page.locator("#email");
      assert.ok(await emailInput.isVisible(), "B1: Work email input visible directly");

      const turnstileEl = page.locator('[data-qa="turnstile"]');
      assert.equal(await turnstileEl.count(), 0, "B1: No turnstile widget present");

      await page.fill("#email", "user@example.test");
      await page.fill("#password", "password123");
      await page.click('button[type="submit"]');

      await page.waitForTimeout(500);
      const tokenReq = recordedRequests.find((r) => r.pathname === "/auth/v1/token");
      assert.ok(tokenReq, "B1: POST /auth/v1/token requested");
      assert.ok(
        !tokenReq.json?.gotrue_meta_security?.captcha_token,
        "B1: No captcha token in gotrue_meta_security"
      );

      await context.close();
      passedScenarios++;
      console.log("PASS B1");
    }

    // ----------------------------------------------------
    // Scenario B2: /signup with qa@mailinator.com -> inline error,
    // zero /auth/v1/signup requests (AC-05)
    // ----------------------------------------------------
    {
      const { context, recordedRequests } = await createInterceptedContext(port);
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/signup`, { waitUntil: "networkidle" });

      await page.fill("#email", "qa@mailinator.com");
      await page.fill("#password", "password12345");
      await page.fill("#confirmPassword", "password12345");
      await page.click('button[type="submit"]');

      await page.waitForTimeout(300);
      const alert = page.locator('p[role="alert"]');
      const text = await alert.textContent();
      assert.ok(
        text?.includes("Please sign up with a non-disposable email address."),
        "B2: Shows disposable email error"
      );

      const signupReqs = recordedRequests.filter((r) => r.pathname === "/auth/v1/signup");
      assert.equal(signupReqs.length, 0, "B2: Zero requests to /auth/v1/signup");

      await context.close();
      passedScenarios++;
      console.log("PASS B2");
    }
  } finally {
    await stopServer(server1);
  }

  // ==========================================
  // SERVER START 2: Key set, Google sign-in ON
  // ==========================================
  const server2 = spawnNextServer(port, {
    FEATURE_GOOGLE_SIGN_IN: "on",
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "qa-site-key",
  });

  const s2Ready = await waitForServer(port);
  assert.ok(s2Ready, "Server 2 ready on port " + port);

  try {
    // ----------------------------------------------------
    // Scenario B3: With key: widget on login, signup, forgot, verify;
    // button disabled before token; signup gotrue_meta_security.captcha_token === "qa-token";
    // 400 captcha disallowed disables button again (AC-06)
    // ----------------------------------------------------
    {
      const { context, recordedRequests } = await createInterceptedContext(port);
      const page = await context.newPage();

      // Check login form has widget when continuing with email
      await page.goto(`http://127.0.0.1:${port}/login`, { waitUntil: "networkidle" });
      await page.click('button:has-text("Continue with email")');
      await page.locator('[data-qa="turnstile"]').waitFor({ state: "visible", timeout: 5000 });
      assert.ok(await page.locator('[data-qa="turnstile"]').isVisible(), "B3: Turnstile visible on login");

      // Check forgot form has widget
      await page.goto(`http://127.0.0.1:${port}/auth/forgot`, { waitUntil: "networkidle" });
      await page.locator('[data-qa="turnstile"]').waitFor({ state: "visible", timeout: 5000 });
      assert.ok(await page.locator('[data-qa="turnstile"]').isVisible(), "B3: Turnstile visible on forgot");

      // Check verify form has widget
      await page.goto(`http://127.0.0.1:${port}/auth/verify?email=qa@example.test`, { waitUntil: "networkidle" });
      await page.locator('[data-qa="turnstile"]').waitFor({ state: "visible", timeout: 5000 });
      assert.ok(await page.locator('[data-qa="turnstile"]').isVisible(), "B3: Turnstile visible on verify");

      // Check signup flow and captcha failure
      await context.route(`${SUPABASE_URL}/auth/v1/signup*`, async (route) => {
        const req = route.request();
        recordedRequests.push({
          method: req.method(),
          url: req.url(),
          pathname: new URL(req.url()).pathname,
          searchParams: new URL(req.url()).searchParams,
          headers: req.headers(),
          postData: req.postData(),
          json: (() => {
            try {
              return req.postDataJSON();
            } catch {
              return null;
            }
          })(),
        });
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ msg: "captcha protection: request disallowed" }),
        });
      });

      await page.goto(`http://127.0.0.1:${port}/signup`, { waitUntil: "networkidle" });
      await page.click('button:has-text("Continue with email")');
      await page.locator('[data-qa="turnstile"]').waitFor({ state: "visible", timeout: 5000 });
      assert.ok(await page.locator('[data-qa="turnstile"]').isVisible(), "B3: Turnstile visible on signup");

      await page.fill("#email", "valid@example.test");
      await page.fill("#password", "password12345");
      await page.fill("#confirmPassword", "password12345");

      const submitBtn = page.locator('button[type="submit"]');
      await submitBtn.click();

      await page.waitForTimeout(500);
      const signupReq = recordedRequests.find((r) => r.pathname === "/auth/v1/signup");
      assert.ok(signupReq, "B3: POST /auth/v1/signup sent");
      assert.equal(
        signupReq.json?.gotrue_meta_security?.captcha_token,
        "qa-token",
        "B3: gotrue_meta_security.captcha_token === 'qa-token'"
      );

      const errorAlert = page.locator('div[role="alert"][data-slot="alert"]');
      const errorText = await errorAlert.textContent();
      assert.ok(
        errorText?.includes("The security check didn't pass. Try again."),
        "B3: Error text shows captcha failure"
      );

      await context.close();
      passedScenarios++;
      console.log("PASS B3");
    }

    // ----------------------------------------------------
    // Scenario B4: Google on: chooser visible on login and signup;
    // click -> authorize URL with provider=google, prompt=select_account,
    // redirect_to decoding to /auth/callback?next=/portal and next=/onboarding (AC-08)
    // ----------------------------------------------------
    {
      const { context, recordedRequests } = await createInterceptedContext(port);
      const page = await context.newPage();

      // On /login
      await page.goto(`http://127.0.0.1:${port}/login`, { waitUntil: "networkidle" });
      const googleBtnLogin = page.locator('button:has-text("Continue with Google")');
      assert.ok(await googleBtnLogin.isVisible(), "B4: Chooser visible on login");

      await googleBtnLogin.click();
      await page.waitForTimeout(500);

      const authReqLogin = recordedRequests.find((r) => r.pathname === "/auth/v1/authorize");
      assert.ok(authReqLogin, "B4: /auth/v1/authorize called from login");
      assert.equal(authReqLogin.searchParams.get("provider"), "google");
      assert.equal(authReqLogin.searchParams.get("prompt"), "select_account");
      const redirectLogin = authReqLogin.searchParams.get("redirect_to");
      assert.ok(
        redirectLogin?.includes("/auth/callback?next=%2Fportal") ||
          decodeURIComponent(redirectLogin || "").includes("/auth/callback?next=/portal"),
        "B4: redirect_to decodes to .../auth/callback?next=/portal"
      );

      // On /signup
      recordedRequests.length = 0;
      await page.goto(`http://127.0.0.1:${port}/signup`, { waitUntil: "networkidle" });
      const googleBtnSignup = page.locator('button:has-text("Continue with Google")');
      assert.ok(await googleBtnSignup.isVisible(), "B4: Chooser visible on signup");

      await googleBtnSignup.click();
      await page.waitForTimeout(500);

      const authReqSignup = recordedRequests.find((r) => r.pathname === "/auth/v1/authorize");
      assert.ok(authReqSignup, "B4: /auth/v1/authorize called from signup");
      assert.equal(authReqSignup.searchParams.get("provider"), "google");
      const redirectSignup = authReqSignup.searchParams.get("redirect_to");
      assert.ok(
        decodeURIComponent(redirectSignup || "").includes("/auth/callback?next=/onboarding"),
        "B4: redirect_to decodes to .../auth/callback?next=/onboarding"
      );

      await context.close();
      passedScenarios++;
      console.log("PASS B4");
    }

    // ----------------------------------------------------
    // Scenario B5: /signup?domain=acme.com&scan=<uuid>&next=/portal/scans:
    // email_redirect_to and Google redirect_to match AC-11 value
    // ----------------------------------------------------
    {
      const { context, recordedRequests } = await createInterceptedContext(port);
      const page = await context.newPage();
      const uuid = "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90";
      const signupUrl = `http://127.0.0.1:${port}/signup?domain=acme.com&scan=${uuid}&next=%2Fportal%2Fscans`;

      // 1. Google click
      await page.goto(signupUrl, { waitUntil: "networkidle" });
      await page.click('button:has-text("Continue with Google")');
      await page.waitForTimeout(500);

      const authReq = recordedRequests.find((r) => r.pathname === "/auth/v1/authorize");
      assert.ok(authReq, "B5: Google authorize called");
      const googleRedirect = decodeURIComponent(authReq.searchParams.get("redirect_to") || "");
      assert.ok(
        googleRedirect.includes(`/onboarding?domain=acme.com&scan=${uuid}&redirect=%2Fportal%2Fscans`),
        "B5: Google redirect_to carries domain, scan, and redirect: " + googleRedirect
      );

      // 2. Email form submit
      recordedRequests.length = 0;
      await page.goto(signupUrl, { waitUntil: "networkidle" });
      await page.click('button:has-text("Continue with email")');
      await page.fill("#email", "person@example.test");
      await page.fill("#password", "password12345");
      await page.fill("#confirmPassword", "password12345");
      await page.click('button[type="submit"]');
      await page.waitForTimeout(500);

      const signupReq = recordedRequests.find((r) => r.pathname === "/auth/v1/signup");
      assert.ok(signupReq, "B5: /auth/v1/signup called");
      const emailRedirect =
        signupReq.searchParams.get("redirect_to") ||
        signupReq.json?.options?.email_redirect_to ||
        signupReq.json?.options?.emailRedirectTo;
      const decodedEmailRedirect = decodeURIComponent(emailRedirect || "");
      assert.ok(
        decodedEmailRedirect.includes(`/onboarding?domain=acme.com&scan=${uuid}&redirect=%2Fportal%2Fscans`),
        "B5: email redirect_to carries domain, scan, and redirect: " + decodedEmailRedirect
      );

      await context.close();
      passedScenarios++;
      console.log("PASS B5");
    }

    // ----------------------------------------------------
    // Scenario B6: /auth/error?error=access_denied shows
    // "Google sign-in was canceled" and "Code: access_denied" (AC-10)
    // ----------------------------------------------------
    {
      const { context } = await createInterceptedContext(port);
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/auth/error?error=access_denied`, { waitUntil: "networkidle" });

      const heading = page.locator("h1");
      const titleText = await heading.textContent();
      assert.ok(
        titleText?.includes("Google sign-in was canceled"),
        "B6: Title shows Google sign-in was canceled"
      );

      const codeFooter = page.locator('p:has-text("Code: access_denied")');
      assert.ok(await codeFooter.isVisible(), "B6: Shows Code: access_denied");

      await context.close();
      passedScenarios++;
      console.log("PASS B6");
    }

    // ----------------------------------------------------
    // Scenario B7: Password sign-in returning 400 email_not_confirmed ->
    // URL /auth/verify?email=qa%40example.test; Resend email -> POST /auth/v1/resend
    // with type: "signup" and captcha token; toast "A new email is on the way." (AC-12)
    // ----------------------------------------------------
    {
      const { context, recordedRequests } = await createInterceptedContext(port);

      await context.route(`${SUPABASE_URL}/auth/v1/token*`, async (route) => {
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error_code: "email_not_confirmed", message: "Email not confirmed" }),
        });
      });

      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/login`, { waitUntil: "networkidle" });
      await page.click('button:has-text("Continue with email")');
      await page.fill("#email", "qa@example.test");
      await page.fill("#password", "password123");
      await page.click('button[type="submit"]');

      await page.waitForURL((url) => url.pathname === "/auth/verify", { timeout: 10000 });
      assert.ok(page.url().includes("email=qa%40example.test") || page.url().includes("email=qa@example.test"), "B7: Navigated to /auth/verify with email");

      const resendBtn = page.locator('button:has-text("Resend email")');
      await resendBtn.click();
      await page.waitForTimeout(500);

      const resendReq = recordedRequests.find((r) => r.pathname === "/auth/v1/resend");
      assert.ok(resendReq, "B7: POST /auth/v1/resend called");
      assert.equal(resendReq.json?.type, "signup");
      assert.equal(resendReq.json?.email, "qa@example.test");
      assert.equal(resendReq.json?.gotrue_meta_security?.captcha_token, "qa-token");

      // Verify toast
      const toast = page.locator('[data-sonner-toast], [role="status"]:has-text("A new email is on the way.")');
      assert.ok(await toast.first().isVisible(), "B7: Toast shown with 'A new email is on the way.'");

      await context.close();
      passedScenarios++;
      console.log("PASS B7");
    }

    // ----------------------------------------------------
    // Scenario B8: Stored session (confirmed user) on /login?next=/portal/scans ->
    // URL becomes /portal/scans (AC-13)
    // ----------------------------------------------------
    {
      const { context } = await createInterceptedContext(port);
      const page = await context.newPage();

      // Sign in on /login first to establish a stored session
      await page.goto(`http://127.0.0.1:${port}/login`, { waitUntil: "networkidle" });
      await page.click('button:has-text("Continue with email")');
      await page.locator('[data-qa="turnstile"]').waitFor({ state: "visible", timeout: 5000 });
      await page.fill("#email", "qa@example.test");
      await page.fill("#password", "password123");
      await page.click('button[type="submit"]');
      await page.waitForTimeout(500);

      // Now with stored session in context, revisit /login?next=/portal/scans
      await page.goto(`http://127.0.0.1:${port}/login?next=%2Fportal%2Fscans`);
      await page.waitForURL((url) => url.pathname === "/portal/scans", { timeout: 10000 });
      assert.equal(new URL(page.url()).pathname, "/portal/scans", "B8: Redirected to /portal/scans");

      await context.close();
      passedScenarios++;
      console.log("PASS B8");
    }

    // ----------------------------------------------------
    // Scenario B9: 390 px viewport: every auth page has one h1
    // and no horizontal overflow (scrollWidth <= 391)
    // ----------------------------------------------------
    {
      const { context } = await createInterceptedContext(port);
      const page = await context.newPage();
      await page.setViewportSize({ width: 390, height: 844 });

      const authPaths = [
        "/login",
        "/signup",
        "/auth/verify",
        "/auth/forgot",
        "/auth/reset",
        "/auth/error?error=access_denied",
      ];

      for (const p of authPaths) {
        await page.goto(`http://127.0.0.1:${port}${p}`, { waitUntil: "networkidle" });
        const h1Count = await page.locator("h1").count();
        assert.equal(h1Count, 1, `B9: ${p} must have exactly one h1, got ${h1Count}`);

        const overflow = await page.evaluate(() => {
          return document.documentElement.scrollWidth > window.innerWidth + 1;
        });
        assert.ok(!overflow, `B9: ${p} must not have horizontal overflow at 390px`);
      }

      await context.close();
      passedScenarios++;
      console.log("PASS B9");
    }
  } finally {
    await stopServer(server2);
  }
} finally {
  await browser.close();
}

console.log(`ok ${passedScenarios} scenarios`);
console.log(`${externalRequests.length} external requests`);

if (passedScenarios === 9 && externalRequests.length === 0) {
  process.exit(0);
} else {
  process.exit(1);
}
