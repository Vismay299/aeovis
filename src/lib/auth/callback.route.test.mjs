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
        return { data: exchangeError ? null : { session: {} }, error: exchangeError };
      },
      verifyOtp: async (params) => {
        calls.verifyOtp++;
        return { data: otpError ? null : { session: {} }, error: otpError };
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
