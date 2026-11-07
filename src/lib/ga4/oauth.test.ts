import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGa4AuthorizationUrl, handleGa4Callback } from "./oauth.ts";
import { hashValue, encryptToken } from "../gsc/oauthCrypto.js";
import { AppError } from "../http/errors.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturesDir = path.join(ROOT, "tests/fixtures/f20");

const tokenExchangeJson = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, "token-exchange.json"), "utf8"),
);
const tokenExchangeNoScopeJson = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, "token-exchange-no-scope.json"), "utf8"),
);

function makeMockAdmin(options: {
  attempt?: any;
  membership?: { role: string };
  upsertResult?: string;
  updateAttemptError?: any;
  insertAttemptError?: any;
} = {}) {
  let storedAttempt = options.attempt ? { ...options.attempt } : null;
  let insertedAttempt: any = null;
  let upsertGrantPayload: any = null;

  return {
    getInsertedAttempt: () => insertedAttempt,
    getUpsertGrantPayload: () => upsertGrantPayload,
    from: (table: string) => {
      if (table === "ga4_oauth_attempts") {
        return {
          insert: async (data: any) => {
            if (options.insertAttemptError) return { error: options.insertAttemptError };
            insertedAttempt = data;
            storedAttempt = { ...data, id: "attempt-uuid", consumed_at: null };
            return { error: null };
          },
          update: (updateData: any) => ({
            eq: (_field: string, val: string) => ({
              is: (_col: string, nullVal: null) => ({
                gt: (_expCol: string, _now: string) => ({
                  select: () => ({
                    single: async () => {
                      if (options.updateAttemptError) return { data: null, error: options.updateAttemptError };
                      if (!storedAttempt || storedAttempt.state_hash !== val || storedAttempt.consumed_at !== null) {
                        return { data: null, error: new Error("Row not found or already consumed") };
                      }
                      storedAttempt = { ...storedAttempt, ...updateData };
                      return { data: storedAttempt, error: null };
                    },
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "customer_brand_memberships") {
        return {
          select: (_fields: string) => ({
            eq: (_col1: string, _brand: string) => ({
              eq: (_col2: string, _user: string) => ({
                single: async () => {
                  if (options.membership) {
                    return { data: options.membership, error: null };
                  }
                  return { data: null, error: new Error("Membership not found") };
                },
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table in mockAdmin: ${table}`);
    },
    rpc: async (func: string, params: any) => {
      if (func === "ga4_upsert_grant") {
        upsertGrantPayload = params;
        return { data: options.upsertResult || "grant-uuid-1", error: null };
      }
      throw new Error(`Unexpected rpc in mockAdmin: ${func}`);
    },
  };
}

const originalEnv = { ...process.env };

test("createGa4AuthorizationUrl: F20-AC-01 exact URL parameters", async () => {
  process.env.GA4_GOOGLE_CLIENT_ID = "ga4_test_client_id";
  process.env.GA4_GOOGLE_CLIENT_SECRET = "ga4_test_client_secret";
  process.env.GA4_OAUTH_REDIRECT_URI = "https://perceev.xyz/api/customer/ga4/callback";
  process.env.GSC_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const admin = makeMockAdmin();
  const res = await createGa4AuthorizationUrl({
    admin,
    userId: "user-1",
    brandKey: "workspace-1",
    sessionTokenHash: "session-hash-1",
    returnPath: "/portal/settings/integrations",
  });

  const parsed = new URL(res.authorizationUrl);
  assert.equal(parsed.origin, "https://accounts.google.com");
  assert.equal(parsed.pathname, "/o/oauth2/v2/auth");
  assert.equal(parsed.searchParams.get("client_id"), "ga4_test_client_id");
  assert.equal(parsed.searchParams.get("redirect_uri"), "https://perceev.xyz/api/customer/ga4/callback");
  assert.equal(parsed.searchParams.get("response_type"), "code");
  assert.equal(
    parsed.searchParams.get("scope"),
    "openid email https://www.googleapis.com/auth/analytics.readonly",
  );
  assert.equal(parsed.searchParams.get("access_type"), "offline");
  assert.equal(parsed.searchParams.get("prompt"), "select_account consent");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  assert.ok(parsed.searchParams.get("state"));
  assert.ok(parsed.searchParams.get("code_challenge"));
  assert.equal(parsed.searchParams.get("include_granted_scopes"), null);

  const attempt = admin.getInsertedAttempt();
  assert.ok(attempt);
  assert.equal(attempt.user_id, "user-1");
  assert.equal(attempt.brand_key, "workspace-1");
  assert.equal(attempt.session_token_hash, "session-hash-1");
  assert.equal(attempt.return_path, "/portal/settings/integrations");
  assert.equal(attempt.state_hash, hashValue(parsed.searchParams.get("state")!));
});

test("createGa4AuthorizationUrl: throws 503 when ga4 is not configured", async () => {
  delete process.env.GA4_GOOGLE_CLIENT_ID;
  const admin = makeMockAdmin();
  await assert.rejects(
    createGa4AuthorizationUrl({
      admin,
      userId: "user-1",
      brandKey: "workspace-1",
      sessionTokenHash: "session-hash-1",
    }),
    (err: any) => err instanceof AppError && err.status === 503 && err.code === "ga4_not_configured",
  );
});

test("handleGa4Callback: F20-AC-02 successful flow upserts grant and redirects with ga4=linked", async () => {
  process.env.GA4_GOOGLE_CLIENT_ID = "ga4_test_client_id";
  process.env.GA4_GOOGLE_CLIENT_SECRET = "ga4_test_client_secret";
  process.env.GA4_OAUTH_REDIRECT_URI = "https://perceev.xyz/api/customer/ga4/callback";
  process.env.GSC_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const rawState = "test-raw-state-nonce";
  const stateHash = hashValue(rawState);
  const verifierAad = "ga4:workspace-1:verifier";
  const encryptedVerifier = JSON.stringify(encryptToken("test-code-verifier-32-chars", verifierAad));

  const admin = makeMockAdmin({
    attempt: {
      id: "attempt-1",
      user_id: "user-1",
      brand_key: "workspace-1",
      state_hash: stateHash,
      session_token_hash: "session-hash-1",
      encrypted_code_verifier: encryptedVerifier,
      return_path: "/portal/settings/integrations",
      consumed_at: null,
      expires_at: new Date(Date.now() + 600000).toISOString(),
    },
    membership: { role: "owner" },
  });

  const mockFetch = async () =>
    new Response(JSON.stringify(tokenExchangeJson), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const callbackUrl = `https://perceev.xyz/api/customer/ga4/callback?state=${rawState}&code=google-auth-code`;
  const result = await handleGa4Callback({
    admin,
    url: callbackUrl,
    userId: "user-1",
    sessionTokenHash: "session-hash-1",
    fetchImpl: mockFetch as any,
  });

  assert.equal(result.outcome, "linked");
  assert.equal(result.redirect, "/portal/settings/integrations?ga4=linked");

  const upsert = admin.getUpsertGrantPayload();
  assert.ok(upsert);
  assert.equal(upsert.p_user_id, "user-1");
  assert.equal(upsert.p_google_sub, "109876543210987654321");
  assert.equal(upsert.p_google_email, "owner@example.com");
});

test("handleGa4Callback: missing state or replay returns state_mismatch", async () => {
  const admin = makeMockAdmin({ attempt: null });
  const result = await handleGa4Callback({
    admin,
    url: "https://perceev.xyz/api/customer/ga4/callback?state=unknown-state&code=code",
    userId: "user-1",
    sessionTokenHash: "session-hash-1",
  });

  assert.equal(result.outcome, "state_mismatch");
  assert.equal(result.redirect, "/portal/settings/integrations?ga4_error=state_mismatch");
});

test("handleGa4Callback: session mismatch returns state_mismatch", async () => {
  const rawState = "state-session-mismatch";
  const stateHash = hashValue(rawState);
  const admin = makeMockAdmin({
    attempt: {
      user_id: "user-1",
      brand_key: "workspace-1",
      state_hash: stateHash,
      session_token_hash: "session-hash-1",
      return_path: "/portal/settings/integrations",
      consumed_at: null,
      expires_at: new Date(Date.now() + 600000).toISOString(),
    },
    membership: { role: "owner" },
  });

  const result = await handleGa4Callback({
    admin,
    url: `https://perceev.xyz/api/customer/ga4/callback?state=${rawState}&code=code`,
    userId: "other-user",
    sessionTokenHash: "session-hash-1",
  });

  assert.equal(result.outcome, "state_mismatch");
  assert.equal(result.redirect, "/portal/settings/integrations?ga4_error=state_mismatch");
});

test("handleGa4Callback: non-owner member returns owner_required", async () => {
  const rawState = "state-non-owner";
  const stateHash = hashValue(rawState);
  const admin = makeMockAdmin({
    attempt: {
      user_id: "user-member",
      brand_key: "workspace-1",
      state_hash: stateHash,
      session_token_hash: "session-hash-1",
      return_path: "/portal/settings/integrations",
      consumed_at: null,
      expires_at: new Date(Date.now() + 600000).toISOString(),
    },
    membership: { role: "member" },
  });

  const result = await handleGa4Callback({
    admin,
    url: `https://perceev.xyz/api/customer/ga4/callback?state=${rawState}&code=code`,
    userId: "user-member",
    sessionTokenHash: "session-hash-1",
  });

  assert.equal(result.outcome, "owner_required");
  assert.equal(result.redirect, "/portal/settings/integrations?ga4_error=owner_required");
});

test("handleGa4Callback: Google access_denied redirects with access_denied", async () => {
  const rawState = "state-access-denied";
  const stateHash = hashValue(rawState);
  const admin = makeMockAdmin({
    attempt: {
      user_id: "user-1",
      brand_key: "workspace-1",
      state_hash: stateHash,
      session_token_hash: "session-hash-1",
      return_path: "/portal/settings/integrations",
      consumed_at: null,
      expires_at: new Date(Date.now() + 600000).toISOString(),
    },
    membership: { role: "owner" },
  });

  const result = await handleGa4Callback({
    admin,
    url: `https://perceev.xyz/api/customer/ga4/callback?state=${rawState}&error=access_denied`,
    userId: "user-1",
    sessionTokenHash: "session-hash-1",
  });

  assert.equal(result.outcome, "access_denied");
  assert.equal(result.redirect, "/portal/settings/integrations?ga4_error=access_denied");
});

test("handleGa4Callback: missing analytics scope results in scope_not_granted and nothing stored", async () => {
  process.env.GA4_GOOGLE_CLIENT_ID = "ga4_test_client_id";
  process.env.GA4_GOOGLE_CLIENT_SECRET = "ga4_test_client_secret";
  process.env.GA4_OAUTH_REDIRECT_URI = "https://perceev.xyz/api/customer/ga4/callback";
  process.env.GSC_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const rawState = "state-no-scope";
  const stateHash = hashValue(rawState);
  const verifierAad = "ga4:workspace-1:verifier";
  const encryptedVerifier = JSON.stringify(encryptToken("test-code-verifier-32-chars", verifierAad));

  const admin = makeMockAdmin({
    attempt: {
      user_id: "user-1",
      brand_key: "workspace-1",
      state_hash: stateHash,
      session_token_hash: "session-hash-1",
      encrypted_code_verifier: encryptedVerifier,
      return_path: "/portal/settings/integrations",
      consumed_at: null,
      expires_at: new Date(Date.now() + 600000).toISOString(),
    },
    membership: { role: "owner" },
  });

  const mockFetch = async () =>
    new Response(JSON.stringify(tokenExchangeNoScopeJson), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const result = await handleGa4Callback({
    admin,
    url: `https://perceev.xyz/api/customer/ga4/callback?state=${rawState}&code=auth-code`,
    userId: "user-1",
    sessionTokenHash: "session-hash-1",
    fetchImpl: mockFetch as any,
  });

  assert.equal(result.outcome, "scope_not_granted");
  assert.equal(result.redirect, "/portal/settings/integrations?ga4_error=scope_not_granted");
  assert.equal(admin.getUpsertGrantPayload(), null, "nothing stored when scope is not granted");
});

test.after(() => {
  process.env = originalEnv;
});
