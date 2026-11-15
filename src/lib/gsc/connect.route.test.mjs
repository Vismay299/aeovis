import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { register } from "node:module";
import { encryptToken } from "./oauthCrypto.js";

process.env.GSC_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
process.env.GSC_GOOGLE_CLIENT_ID = "TEST_CLIENT_ID";
process.env.GSC_GOOGLE_CLIENT_SECRET = "TEST_CLIENT_SECRET";
process.env.GSC_OAUTH_REDIRECT_URI = "https://app.example.test/api/customer/gsc/callback";
process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";

register("../customerRoutes.test.hooks.mjs", import.meta.url);

const connectRoute = await import("../../app/api/customer/gsc/connect/route.js");
const callbackRoute = await import("../../app/api/customer/gsc/callback/route.js");

function createFakeJwt(userId, sessionId = "sess-1") {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: userId, session_id: sessionId })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function setupFixture(opts = {}) {
  const userId = opts.userId ?? "user-a";
  const brandKey = opts.brandKey ?? "workspace-a";
  const insertedAttempts = [];
  const attemptRow = opts.attemptRow ?? null;

  const admin = {
    from(table) {
      if (table === "gsc_oauth_attempts") {
        return {
          insert: async (data) => {
            insertedAttempts.push(data);
            return { error: null };
          },
          select: () => ({
            eq: () => ({
              is: () => ({
                gt: () => ({
                  limit: async () => ({
                    data: attemptRow ? [attemptRow] : [],
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              is: () => ({
                gt: () => ({
                  select: () => ({
                    maybeSingle: async () => ({ data: { id: attemptRow?.id }, error: null }),
                  }),
                }),
              }),
              then(resolve) {
                return resolve({ data: null, error: null });
              },
            }),
          }),
        };
      }
      if (table === "customer_brand_memberships") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { role: "owner" }, error: null }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      };
    },
  };

  const client = {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: createFakeJwt(userId) } },
        error: null,
      }),
    },
  };

  globalThis.customerRouteFixture = {
    admin,
    context: {
      client,
      user: { id: userId },
      error: null,
      brands: [{ brandKey, role: "owner", display_name: "Acme", website: "https://acme.example" }],
    },
  };

  return { insertedAttempts, admin };
}

test("POST /api/customer/gsc/connect - return_to: '/onboarding' stores /onboarding in attempt", async () => {
  const { insertedAttempts } = setupFixture();

  const req = new Request("https://app.example.test/api/customer/gsc/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brand_key: "workspace-a", return_to: "/onboarding" }),
  });

  const res = await connectRoute.POST(req);
  assert.equal(res.status, 200);
  assert.equal(insertedAttempts.length, 1);
  assert.equal(insertedAttempts[0].return_path, "/onboarding");
});

test("POST /api/customer/gsc/connect - return_to: '/x' is ignored and defaults to /portal/search-console", async () => {
  const { insertedAttempts } = setupFixture();

  const req = new Request("https://app.example.test/api/customer/gsc/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brand_key: "workspace-a", return_to: "/x" }),
  });

  const res = await connectRoute.POST(req);
  assert.equal(res.status, 200);
  assert.equal(insertedAttempts.length, 1);
  assert.equal(insertedAttempts[0].return_path, "/portal/search-console");
});

test("GET /api/customer/gsc/callback - onboarding attempt redirects to /onboarding?step=search_console...", async (t) => {
  const sessionTokenHash = crypto
    .createHash("sha256")
    .update("user-a:sess-1")
    .digest("hex");

  const attemptRow = {
    id: "attempt-onboarding-123",
    brand_key: "workspace-a",
    user_id: "user-a",
    session_token_hash: sessionTokenHash,
    return_path: "/onboarding",
    encrypted_code_verifier: JSON.stringify(encryptToken("TEST_PKCE", "workspace-a:verifier")),
    expires_at: new Date(Date.now() + 600000).toISOString(),
    consumed_at: null,
  };

  setupFixture({ attemptRow });

  t.mock.method(globalThis, "fetch", async () => {
    return Response.json({ access_token: "TEST_ACCESS", refresh_token: "TEST_REFRESH", expires_in: 3600 });
  });

  const req = new Request("https://app.example.test/api/customer/gsc/callback?code=mock-code&state=mock-state");
  const res = await callbackRoute.GET(req);

  assert.equal(res.status, 307);
  const location = res.headers.get("Location") || res.headers.get("location");
  assert.ok(location, "Redirect response must include Location header");
  assert.ok(
    location.startsWith("https://app.example.test/onboarding?step=search_console&gsc_connected=true&brand_key=workspace-a&gsc_attempt=attempt-onboarding-123"),
    `Unexpected redirect location: ${location}`,
  );
});

test("GET /api/customer/gsc/callback - default attempt redirects to /portal/search-console?...", async (t) => {
  const sessionTokenHash = crypto
    .createHash("sha256")
    .update("user-a:sess-1")
    .digest("hex");

  const attemptRow = {
    id: "attempt-default-456",
    brand_key: "workspace-a",
    user_id: "user-a",
    session_token_hash: sessionTokenHash,
    return_path: "/portal/search-console",
    encrypted_code_verifier: JSON.stringify(encryptToken("TEST_PKCE", "workspace-a:verifier")),
    expires_at: new Date(Date.now() + 600000).toISOString(),
    consumed_at: null,
  };

  setupFixture({ attemptRow });

  t.mock.method(globalThis, "fetch", async () => {
    return Response.json({ access_token: "TEST_ACCESS", refresh_token: "TEST_REFRESH", expires_in: 3600 });
  });

  const req = new Request("https://app.example.test/api/customer/gsc/callback?code=mock-code&state=mock-state");
  const res = await callbackRoute.GET(req);

  assert.equal(res.status, 307);
  const location = res.headers.get("Location") || res.headers.get("location");
  assert.ok(location, "Redirect response must include Location header");
  assert.ok(
    location.startsWith("https://app.example.test/portal/search-console?gsc_connected=true&brand_key=workspace-a&gsc_attempt=attempt-default-456"),
    `Unexpected redirect location: ${location}`,
  );
});
