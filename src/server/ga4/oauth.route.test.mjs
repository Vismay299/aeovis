import test from "node:test";
import assert from "node:assert/strict";

const statusRoute = await import(new URL("../../app/api/customer/ga4/route.ts", import.meta.url).href);
const connectRoute = await import(new URL("../../app/api/customer/ga4/connect/route.ts", import.meta.url).href);
const callbackRoute = await import(new URL("../../app/api/customer/ga4/callback/route.ts", import.meta.url).href);
const accountsRoute = await import(new URL("../../app/api/customer/ga4/accounts/route.ts", import.meta.url).href);
const accountDeleteRoute = await import(new URL("../../app/api/customer/ga4/accounts/[grantId]/route.ts", import.meta.url).href);

const OWNER_USER = { id: "user-owner-1", email: "owner@example.com" };
const MEMBER_USER = { id: "user-member-2", email: "member@example.com" };

function makeCustomerContext(user = OWNER_USER, role = "owner") {
  return {
    user,
    client: {
      auth: {
        getSession: async () => ({
          data: {
            session: {
              access_token: `header.${Buffer.from(JSON.stringify({ sub: user.id, session_id: "sess-123" })).toString("base64url")}.sig`,
            },
          },
          error: null,
        }),
      },
    },
    brands: [
      {
        brandKey: "workspace-1",
        role,
        display_name: "Workspace 1",
        website: "https://example.com",
        website_host: "example.com",
        aliases: [],
        is_active: true,
      },
    ],
    error: null,
  };
}

function makeMockAdmin(options = {}) {
  return {
    from: (table) => {
      if (table === "ga4_connections") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: options.connection || null,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "customer_brand_memberships") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: options.connectorMember ? { role: "owner" } : null,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "ga4_grants") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: options.grantStatus ? { status: options.grantStatus } : null,
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

async function read(res) {
  return {
    status: res.status,
    cacheControl: res.headers.get("cache-control"),
    body: await res.json(),
  };
}

test("GET /api/customer/ga4: feature flag off returns 404", async () => {
  const deps = {
    getCustomerContext: async () => makeCustomerContext(),
    getSupabaseAdmin: () => makeMockAdmin(),
    isFeatureEnabled: async () => false,
  };

  const req = new Request("https://perceev.xyz/api/customer/ga4?brand_key=workspace-1");
  const res = await statusRoute.GET(req, {}, deps);
  const { status, body } = await read(res);

  assert.equal(status, 404);
  assert.equal(body.code, "feature_unavailable");
});

test("GET /api/customer/ga4: not connected returns 200 with property null", async () => {
  const deps = {
    getCustomerContext: async () => makeCustomerContext(),
    getSupabaseAdmin: () => makeMockAdmin({ connection: null }),
    isFeatureEnabled: async () => true,
    isGa4Configured: () => true,
    listGrantsForUser: async () => [],
  };

  const req = new Request("https://perceev.xyz/api/customer/ga4?brand_key=workspace-1");
  const res = await statusRoute.GET(req, {}, deps);
  const { status, cacheControl, body } = await read(res);

  assert.equal(status, 200);
  assert.equal(cacheControl, "no-store");
  assert.equal(body.connected, false);
  assert.equal(body.configured, true);
  assert.equal(body.canManage, true);
  assert.equal(body.currentUserHasGrant, false);
  assert.equal(body.property, null);
});

test("GET /api/customer/ga4: connected returns 200 with connection and property details", async () => {
  const connection = {
    brand_key: "workspace-1",
    grant_id: "grant-uuid-1",
    property_id: "properties/123456789",
    property_display_name: "Test Site",
    property_time_zone: "UTC",
    property_currency_code: "USD",
    account_display_name: "Test Account",
    connected_by: OWNER_USER.id,
    connected_account_email: "owner@example.com",
    connected_at: "2026-10-22T09:00:00.000Z",
  };

  const deps = {
    getCustomerContext: async () => makeCustomerContext(),
    getSupabaseAdmin: () => makeMockAdmin({ connection, connectorMember: true, grantStatus: "active" }),
    isFeatureEnabled: async () => true,
    isGa4Configured: () => true,
    listGrantsForUser: async () => [{ grantId: "grant-uuid-1" }],
  };

  const req = new Request("https://perceev.xyz/api/customer/ga4?brand_key=workspace-1");
  const res = await statusRoute.GET(req, {}, deps);
  const { status, body } = await read(res);

  assert.equal(status, 200);
  assert.equal(body.connected, true);
  assert.equal(body.connectorIsMember, true);
  assert.equal(body.grantStatus, "active");
  assert.equal(body.property.id, "properties/123456789");
  assert.equal(body.connectedByEmail, "owner@example.com");
});

test("POST /api/customer/ga4/connect: non-owner gets 403 owner_required", async () => {
  const deps = {
    getCustomerContext: async () => makeCustomerContext(MEMBER_USER, "member"),
    getSupabaseAdmin: () => makeMockAdmin(),
    isFeatureEnabled: async () => true,
    isGa4Configured: () => true,
  };

  const req = new Request("https://perceev.xyz/api/customer/ga4/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brand_key: "workspace-1" }),
  });

  const res = await connectRoute.POST(req, {}, deps);
  const { status, body } = await read(res);

  assert.equal(status, 403);
  assert.equal(body.code, "owner_required");
});

test("POST /api/customer/ga4/connect: unconfigured gets 503 ga4_not_configured", async () => {
  const deps = {
    getCustomerContext: async () => makeCustomerContext(),
    getSupabaseAdmin: () => makeMockAdmin(),
    isFeatureEnabled: async () => true,
    isGa4Configured: () => false,
  };

  const req = new Request("https://perceev.xyz/api/customer/ga4/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brand_key: "workspace-1" }),
  });

  const res = await connectRoute.POST(req, {}, deps);
  const { status, body } = await read(res);

  assert.equal(status, 503);
  assert.equal(body.code, "ga4_not_configured");
});

test("POST /api/customer/ga4/connect: owner receives authorizationUrl", async () => {
  const expectedAuthUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=test";
  const deps = {
    getCustomerContext: async () => makeCustomerContext(),
    getSupabaseAdmin: () => makeMockAdmin(),
    isFeatureEnabled: async () => true,
    isGa4Configured: () => true,
    customerSessionBinding: async () => "session-hash-123",
    createGa4AuthorizationUrl: async () => ({ authorizationUrl: expectedAuthUrl }),
  };

  const req = new Request("https://perceev.xyz/api/customer/ga4/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brand_key: "workspace-1", returnTo: "/portal/settings/integrations" }),
  });

  const res = await connectRoute.POST(req, {}, deps);
  const { status, cacheControl, body } = await read(res);

  assert.equal(status, 200);
  assert.equal(cacheControl, "no-store");
  assert.equal(body.authorizationUrl, expectedAuthUrl);
});

test("GET /api/customer/ga4/callback: unauthenticated redirects to login", async () => {
  const deps = {
    getCustomerContext: async () => ({ user: null }),
  };

  const req = new Request("https://perceev.xyz/api/customer/ga4/callback?code=abc&state=xyz");
  const res = await callbackRoute.GET(req, {}, deps);

  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), "/login?next=/portal/settings/integrations");
});

test("GET /api/customer/ga4/callback: delegates to handleGa4Callback and redirects", async () => {
  const deps = {
    getCustomerContext: async () => makeCustomerContext(),
    getSupabaseAdmin: () => makeMockAdmin(),
    customerSessionBinding: async () => "session-hash-123",
    handleGa4Callback: async () => ({
      redirect: "/portal/settings/integrations?ga4=linked",
      outcome: "linked",
    }),
  };

  const req = new Request("https://perceev.xyz/api/customer/ga4/callback?code=abc&state=xyz");
  const res = await callbackRoute.GET(req, {}, deps);

  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), "/portal/settings/integrations?ga4=linked");
});

test("GET /api/customer/ga4/accounts: returns caller's accounts", async () => {
  const accounts = [
    {
      grantId: "g1",
      email: "owner@example.com",
      status: "active",
      linkedAt: "2026-10-22T09:00:00.000Z",
      workspaces: 1,
    },
  ];

  const deps = {
    getCustomerContext: async () => makeCustomerContext(),
    getSupabaseAdmin: () => makeMockAdmin(),
    isFeatureEnabled: async () => true,
    listGrantsForUser: async () => accounts,
  };

  const req = new Request("https://perceev.xyz/api/customer/ga4/accounts?brand_key=workspace-1");
  const res = await accountsRoute.GET(req, {}, deps);
  const { status, body } = await read(res);

  assert.equal(status, 200);
  assert.deepEqual(body.accounts, accounts);
});

test("DELETE /api/customer/ga4/accounts/[grantId]: removes account and disconnects workspaces", async () => {
  const deps = {
    getCustomerContext: async () => makeCustomerContext(),
    getSupabaseAdmin: () => makeMockAdmin(),
    isFeatureEnabled: async () => true,
    getGrant: async () => ({ id: "f0000000-0000-0000-0000-000000000001", user_id: OWNER_USER.id }),
    removeGoogleAccount: async () => ({ removed: true, workspacesDisconnected: 2 }),
  };

  const req = new Request("https://perceev.xyz/api/customer/ga4/accounts/f0000000-0000-0000-0000-000000000001", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brand_key: "workspace-1", confirmed: true }),
  });

  const res = await accountDeleteRoute.DELETE(
    req,
    { params: { grantId: "f0000000-0000-0000-0000-000000000001" } },
    deps,
  );
  const { status, body } = await read(res);
  assert.equal(status, 200);
  assert.deepEqual(body, { removed: true, workspacesDisconnected: 2 });
});
