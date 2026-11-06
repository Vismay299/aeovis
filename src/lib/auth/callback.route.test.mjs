import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./callback.route.hooks.mjs", import.meta.url);

const { GET } = await import("../../app/auth/callback/route.js");
const { setAuthServerTracker } = await import("./telemetry.ts");

function createFixture({
  exchangeError = null,
  otpError = null,
  inviteError = null,
  user = null,
} = {}) {
  const calls = {
    exchangeCode: 0,
    verifyOtp: 0,
    getUser: 0,
    rpc: [],
  };

  const client = {
    auth: {
      exchangeCodeForSession: async (code) => {
        calls.exchangeCode++;
        return { data: exchangeError ? null : { session: {}, user }, error: exchangeError };
      },
      verifyOtp: async (params) => {
        calls.verifyOtp++;
        return { data: otpError ? null : { session: {}, user }, error: otpError };
      },
      getUser: async () => {
        calls.getUser++;
        return { data: { user }, error: null };
      },
    },
    rpc: async (name, params) => {
      calls.rpc.push({ name, params });
      return { data: null, error: inviteError };
    },
  };

  globalThis.callbackRouteFixture = {
    createClient: () => client,
    calls,
  };

  return { client, calls };
}

test("F24-AC-09 - ?error=access_denied redirects to 303 /auth/error?error=access_denied and skips exchange", async () => {
  const { calls } = createFixture();
  const request = new Request("https://app.example.test/auth/callback?error=access_denied&error_description=Denied");
  const response = await GET(request);

  assert.equal(response.status, 303);
  const location = response.headers.get("location");
  assert.equal(location, "https://app.example.test/auth/error?error=access_denied");
  assert.equal(calls.exchangeCode, 0);
});

test("F24-AC-09 - error description containing non-disposable maps to disposable_email", async () => {
  const { calls } = createFixture();
  const request = new Request(
    "https://app.example.test/auth/callback?error=bad_request&error_description=" +
      encodeURIComponent("Please sign up with a non-disposable email address.")
  );
  const response = await GET(request);

  assert.equal(response.status, 303);
  const location = response.headers.get("location");
  assert.equal(location, "https://app.example.test/auth/error?error=disposable_email");
  assert.equal(calls.exchangeCode, 0);
});

test("F24-AC-09 - ?code=x&next=... calls exchange, calls accept_customer_team_invites, and preserves next query", async () => {
  const { calls } = createFixture();
  const request = new Request(
    "https://app.example.test/auth/callback?code=test-code&next=" +
      encodeURIComponent("/onboarding?domain=acme.com")
  );
  const response = await GET(request);

  assert.equal(calls.exchangeCode, 1);
  assert.equal(calls.rpc.length, 1);
  assert.equal(calls.rpc[0].name, "accept_customer_team_invites");

  const location = response.headers.get("location");
  assert.ok(location.endsWith("/onboarding?domain=acme.com"), `Expected location to end with /onboarding?domain=acme.com, got ${location}`);
});

test("F24-AC-09 - exchange error redirects to /login?error=link_expired", async () => {
  const { calls } = createFixture({ exchangeError: new Error("Code invalid or expired") });
  const request = new Request(
    "https://app.example.test/auth/callback?code=bad-code&next=" +
      encodeURIComponent("/onboarding?domain=acme.com")
  );
  const response = await GET(request);

  assert.equal(calls.exchangeCode, 1);
  const location = response.headers.get("location");
  assert.equal(location, "https://app.example.test/login?error=link_expired");
});

test("F24-AC-09 - first-session user within 10 minutes emits auth:sign_up_completed telemetry", async () => {
  const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
  const user = {
    id: "user-123",
    created_at: oneMinuteAgo,
    last_sign_in_at: oneMinuteAgo,
    app_metadata: { provider: "google" },
  };

  createFixture({ user });

  const events = [];
  setAuthServerTracker((name, props, distinctId) => {
    events.push({ name, props, distinctId });
  });

  try {
    const request = new Request(
      "https://app.example.test/auth/callback?code=test-code&next=" +
        encodeURIComponent("/onboarding?domain=acme.com")
    );
    await GET(request);

    assert.equal(events.length, 1);
    assert.equal(events[0].name, "auth:sign_up_completed");
    assert.deepEqual(events[0].props, {
      method: "google",
      from_free_scan: false,
      from_domain: true,
    });
    assert.equal(events[0].distinctId, "user-123");
    assert.equal(globalThis.callbackRouteFixture.calls.getUser, 0, "the user comes from the exchange");
  } finally {
    setAuthServerTracker(null);
  }
});

test("F24-AC-09 - older returning user does not emit auth:sign_up_completed telemetry", async () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
  const user = {
    id: "user-456",
    created_at: twoDaysAgo,
    last_sign_in_at: oneMinuteAgo,
    app_metadata: { provider: "google" },
  };

  createFixture({ user });

  const events = [];
  setAuthServerTracker((name, props, distinctId) => {
    events.push({ name, props, distinctId });
  });

  try {
    const request = new Request(
      "https://app.example.test/auth/callback?code=test-code&next=" +
        encodeURIComponent("/onboarding?domain=acme.com")
    );
    await GET(request);

    assert.equal(events.length, 0);
  } finally {
    setAuthServerTracker(null);
  }
});

test("an expired email link (access_denied + otp_expired) goes to the verify page with next kept", async () => {
  const { calls } = createFixture();
  const request = new Request(
    "https://app.example.test/auth/callback?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&next=" +
      encodeURIComponent("/onboarding?domain=acme.com"),
  );
  const response = await GET(request);
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.pathname, "/auth/verify");
  assert.equal(location.searchParams.get("error"), "link_expired");
  assert.equal(location.searchParams.get("next"), "/onboarding?domain=acme.com");
  assert.equal(calls.exchangeCode, 0);
});

test("an OAuth error keeps a safe next and drops an unsafe one", async () => {
  createFixture();
  const kept = await GET(new Request(
    "https://app.example.test/auth/callback?error=invalid_request&error_code=bad_oauth_state&next=" + encodeURIComponent("/onboarding?scan=x"),
  ));
  const keptUrl = new URL(kept.headers.get("location"));
  assert.equal(keptUrl.pathname, "/auth/error");
  assert.equal(keptUrl.searchParams.get("next"), "/onboarding?scan=x");
  const dropped = await GET(new Request("https://app.example.test/auth/callback?error=access_denied&next=%2F%09%2Fevil.com"));
  assert.equal(new URL(dropped.headers.get("location")).searchParams.has("next"), false);
});

test("a next with a tab (/\\t/evil.com) cannot redirect off-site after sign-in", async () => {
  createFixture();
  const response = await GET(new Request("https://app.example.test/auth/callback?code=c&next=%2F%09%2Fevil.com"));
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, "https://app.example.test");
  assert.equal(location.pathname, "/portal");
});

test("an email sign-up confirmed minutes after creation still counts as the first session", async () => {
  const now = Date.now();
  const user = {
    id: "user-email",
    created_at: new Date(now - 4 * 60_000).toISOString(),
    email_confirmed_at: new Date(now - 1_000).toISOString(),
    last_sign_in_at: new Date(now - 500).toISOString(),
    app_metadata: { provider: "email" },
  };
  createFixture({ user });
  const events = [];
  setAuthServerTracker((name, props) => events.push({ name, props }));
  try {
    await GET(new Request("https://app.example.test/auth/callback?code=c"));
    assert.equal(events.length, 1);
    assert.equal(events[0].props.method, "email");
  } finally {
    setAuthServerTracker(null);
  }
});

test("isFirstSession: Google timestamps straddling a second, and a later sign-in", async () => {
  const { isFirstSession } = await import("./telemetry.ts");
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  assert.equal(isFirstSession({ created_at: "2026-11-06T11:59:59.900Z", last_sign_in_at: "2026-11-06T12:00:00.100Z" }, now), true);
  assert.equal(
    isFirstSession({
      created_at: "2026-11-06T09:00:00.000Z",
      email_confirmed_at: "2026-11-06T09:05:00.000Z",
      last_sign_in_at: "2026-11-06T11:59:00.000Z",
    }, now),
    false,
  );
  assert.equal(isFirstSession({ created_at: "2026-11-04T12:00:00.000Z", last_sign_in_at: "2026-11-04T12:00:00.000Z" }, now), false);
  assert.equal(isFirstSession(null, now), false);
});
