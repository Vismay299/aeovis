import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { register } from "node:module";
import { encryptToken, decryptToken } from "./oauthCrypto.js";
import { handleOAuthCallback, disconnectGsc } from "./oauthFlow.js";

process.env.GSC_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
process.env.GSC_GOOGLE_CLIENT_ID = "TEST_CLIENT_ID";
process.env.GSC_GOOGLE_CLIENT_SECRET = "TEST_CLIENT_SECRET";
process.env.GSC_OAUTH_REDIRECT_URI = "https://app.example.test/api/customer/gsc/callback";
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

function attemptAdmin({ role = "owner", claimable = true } = {}) {
  const writes = [];
  const attempt = {
    id: "attempt", brand_key: "workspace-a", user_id: "user-a", session_token_hash: "session-a",
    encrypted_code_verifier: JSON.stringify(encryptToken("TEST_PKCE_VERIFIER", "workspace-a:verifier")),
  };
  return {
    writes,
    from(table) {
      const query = {
        select() { return this; }, eq() { return this; }, is() { return this; }, gt() { return this; },
        update(value) { writes.push({ table, value }); return this; },
        limit: async () => ({ data: [attempt], error: null }),
        maybeSingle: async () => ({ data: table === "customer_brand_memberships" ? { role } : claimable ? { id: attempt.id } : null, error: null }),
        then(resolve, reject) { return Promise.resolve({ data: null, error: null }).then(resolve, reject); },
      };
      return query;
    },
  };
}

test("OAuth callback stages encrypted credentials without replacing an active grant", async (t) => {
  const admin = attemptAdmin();
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.body.get("code_verifier"), "TEST_PKCE_VERIFIER");
    return Response.json({ access_token: "TEST_ACCESS_TOKEN", refresh_token: "TEST_REFRESH_TOKEN", expires_in: 3600 });
  });
  const result = await handleOAuthCallback({ state: "test-state", code: "test-code", sessionTokenHash: "session-a", userId: "user-a", admin });
  assert.equal(result.attemptId, "attempt");
  assert.equal(admin.writes.some((write) => write.table === "gsc_oauth_credentials"), false);
  const pending = admin.writes.find((write) => write.value.encrypted_pending_grant);
  const grant = JSON.parse(pending.value.encrypted_pending_grant);
  assert.equal(decryptToken(JSON.parse(grant.encrypted_refresh_token), "workspace-a:user-a:refresh"), "TEST_REFRESH_TOKEN");
  assert.equal(pending.value.encrypted_pending_grant.includes("TEST_REFRESH_TOKEN"), false);
});

test("OAuth callback rejects a changed owner, missing binding, and concurrent consumption before token exchange", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Token exchange must not run"); });
  const args = { state: "state", code: "code", sessionTokenHash: "session-a", userId: "user-a" };
  await assert.rejects(handleOAuthCallback({ ...args, admin: attemptAdmin({ role: "member" }) }), /owner access/);
  await assert.rejects(handleOAuthCallback({ ...args, sessionTokenHash: null, admin: attemptAdmin() }), /different session/);
  await assert.rejects(handleOAuthCallback({ ...args, userId: "user-b", admin: attemptAdmin() }), /different session/);
  await assert.rejects(handleOAuthCallback({ ...args, admin: attemptAdmin({ claimable: false }) }), /already used/);
});

test("disconnect uses the transactional RPC and propagates a failed commit", async () => {
  const args = { brandKey: "workspace-a", userId: "owner-a" };
  const result = await disconnectGsc({ ...args, admin: { rpc: async (name, input) => {
    assert.equal(name, "disconnect_customer_gsc");
    assert.deepEqual(input, { p_brand_key: "workspace-a", p_user_id: "owner-a" });
    return { data: 3, error: null };
  } } });
  assert.deepEqual(result, { disconnected: true, generation: 3 });
  await assert.rejects(disconnectGsc({ ...args, admin: { rpc: async () => ({ error: { message: "db unavailable" } }) } }), /Could not disconnect/);
});

register("../cronAuth.route.hooks.mjs", import.meta.url);
const syncWorker = await import("../../app/api/gsc/sync-worker/route.js");
test("sync worker refuses an invalid bearer and accepts the cron helper's boolean result", async () => {
  process.env.NODE_ENV = "production";
  process.env.CRON_SECRET = "TEST_CRON_SECRET";
  const url = "https://app.example.test/api/gsc/sync-worker";
  assert.equal((await syncWorker.GET(new Request(url))).status, 401);
  const authorized = await syncWorker.GET(new Request(url, { headers: { authorization: "Bearer TEST_CRON_SECRET" } }));
  assert.equal(authorized.status, 503, "authorized requests reach the missing database check instead of throwing or returning 401");
});

const { createOAuthAttempt } = await import("./oauthFlow.js");

test("createOAuthAttempt stores default return path when omitted, stores /onboarding, and throws on other values", async () => {
  let inserted = null;
  const admin = {
    from(table) {
      assert.equal(table, "gsc_oauth_attempts");
      return {
        insert: async (row) => {
          inserted = row;
          return { error: null };
        },
      };
    },
  };

  // 1. Default return path left to the column default when omitted
  await createOAuthAttempt({
    userId: "user-a",
    brandKey: "workspace-a",
    sessionTokenHash: "session-hash-1",
    admin,
  });
  assert.equal("return_path" in inserted, false);

  // 2. /onboarding stored
  await createOAuthAttempt({
    userId: "user-a",
    brandKey: "workspace-a",
    sessionTokenHash: "session-hash-1",
    admin,
    returnPath: "/onboarding",
  });
  assert.equal(inserted.return_path, "/onboarding");

  // 3. Other value throws
  await assert.rejects(
    createOAuthAttempt({
      userId: "user-a",
      brandKey: "workspace-a",
      sessionTokenHash: "session-hash-1",
      admin,
      returnPath: "/unsupported/path",
    }),
    /Invalid return path/,
  );
});

test("handleOAuthCallback includes returnPath in result", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    return Response.json({ access_token: "TEST_ACCESS_TOKEN", refresh_token: "TEST_REFRESH_TOKEN", expires_in: 3600 });
  });

  function adminWithReturnPath(returnPath) {
    const attempt = {
      id: "attempt-1",
      brand_key: "workspace-a",
      user_id: "user-a",
      session_token_hash: "session-a",
      return_path: returnPath,
      encrypted_code_verifier: JSON.stringify(encryptToken("TEST_PKCE_VERIFIER", "workspace-a:verifier")),
    };
    return {
      from(table) {
        return {
          select() { return this; },
          eq() { return this; },
          is() { return this; },
          gt() { return this; },
          update() { return this; },
          limit: async () => ({ data: [attempt], error: null }),
          maybeSingle: async () => ({
            data: table === "customer_brand_memberships" ? { role: "owner" } : { id: attempt.id },
            error: null,
          }),
        };
      },
    };
  }

  const resultOnboarding = await handleOAuthCallback({
    state: "test-state",
    code: "test-code",
    sessionTokenHash: "session-a",
    userId: "user-a",
    admin: adminWithReturnPath("/onboarding"),
  });
  assert.equal(resultOnboarding.returnPath, "/onboarding");

  const resultDefault = await handleOAuthCallback({
    state: "test-state",
    code: "test-code",
    sessionTokenHash: "session-a",
    userId: "user-a",
    admin: adminWithReturnPath(null),
  });
  assert.equal(resultDefault.returnPath, "/portal/search-console");
});
