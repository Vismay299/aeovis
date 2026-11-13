import test from "node:test";
import assert from "node:assert/strict";
import { fakeGa4Admin } from "./fakeAdmin.testkit.ts";

const statusRoute = await import(new URL("../../app/api/customer/ga4/route.ts", import.meta.url).href);
const propertiesRoute = await import(new URL("../../app/api/customer/ga4/properties/route.ts", import.meta.url).href);
const propertyRoute = await import(new URL("../../app/api/customer/ga4/property/route.ts", import.meta.url).href);

const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com" };
const MEMBER = { id: "22222222-2222-4222-8222-222222222222", email: "member@example.com" };
const GRANT = "33333333-3333-4333-8333-333333333333";

function admin(over = {}) {
  return fakeGa4Admin({
    ga4_grants: [{ id: GRANT, user_id: OWNER.id, google_sub: "sub-a", google_email: "owner@example.com", status: over.grantStatus ?? "active", created_at: "2026-11-01T00:00:00.000Z" }],
    ga4_connections: over.connections ?? [],
    customer_brand_memberships: over.members ?? [
      { brand_key: "acme", user_id: OWNER.id, role: "owner" },
      { brand_key: "acme", user_id: MEMBER.id, role: "member" },
    ],
  });
}

const connection = (over = {}) => ({
  brand_key: "acme", grant_id: GRANT, connected_by: OWNER.id, google_sub: "sub-a", connected_account_email: "owner@example.com",
  property_id: "properties/22", property_display_name: "Site B", property_time_zone: "Asia/Kolkata", property_currency_code: "INR",
  account_display_name: "Client", created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z", ...over,
});

function deps(db, { user = OWNER, role = "owner", flag = true, ...rest } = {}) {
  return {
    getCustomerContext: async () => ({
      user,
      client: null,
      brands: [{ brandKey: "acme", role, display_name: "Acme", website: "https://acme.example", website_host: "acme.example", aliases: [], is_active: true }],
      error: null,
    }),
    getSupabaseAdmin: () => db,
    isFeatureEnabled: async () => flag,
    isGa4Configured: () => true,
    ...rest,
  };
}

const get = (route, path, d) => route.GET(new Request(`https://app.test${path}`), {}, d);
const send = (route, method, path, body, d) =>
  route[method](new Request(`https://app.test${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {}, d);

test("GET /api/customer/ga4 reads connected_by: a present connector is a member, a departed one is not", async () => {
  const present = await (await get(statusRoute, "/api/customer/ga4?brand_key=acme", deps(admin({ connections: [connection()] }), { user: MEMBER, role: "member" }))).json();
  assert.equal(present.connected, true);
  assert.equal(present.connectorIsMember, true);
  assert.equal(present.canManage, false);
  assert.equal(present.property.accountDisplayName, "Client");

  const left = await (await get(statusRoute, "/api/customer/ga4?brand_key=acme", deps(admin({ connections: [connection({ connected_by: "44444444-4444-4444-8444-444444444444" })] })))).json();
  assert.equal(left.connectorIsMember, false);
});

test("GET /properties: owner only, flag-gated, and passes the saved property for isSelected", async () => {
  const db = admin({ connections: [connection()] });
  let seen = null;
  const lister = async (_admin, userId, selected) => { seen = { userId, selected }; return { accounts: [] }; };
  const ok = await get(propertiesRoute, "/api/customer/ga4/properties?brand_key=acme", deps(db, { listPropertiesForUser: lister }));
  assert.equal(ok.status, 200);
  assert.deepEqual(seen, { userId: OWNER.id, selected: "properties/22" });

  const asMember = await get(propertiesRoute, "/api/customer/ga4/properties?brand_key=acme", deps(db, { user: MEMBER, role: "member", listPropertiesForUser: lister }));
  assert.equal(asMember.status, 403);
  assert.equal((await asMember.json()).code, "owner_required");

  const off = await get(propertiesRoute, "/api/customer/ga4/properties?brand_key=acme", deps(db, { flag: false, listPropertiesForUser: lister }));
  assert.equal(off.status, 404);
});

test("POST /property: 201 with the state read back, 400 on a bad body, 403 for a member", async () => {
  const db = admin();
  const setProperty = async (adm, ws, input) => {
    const { error } = await adm.rpc("ga4_set_connection", {
      p_brand_key: ws.brandKey, p_user_id: ws.user.id, p_grant_id: input.grantId, p_property_id: input.propertyId,
      p_property_display_name: "Site B", p_property_time_zone: "Asia/Kolkata", p_property_currency_code: "INR", p_account_display_name: "Client",
    });
    if (error) throw new Error(error.message);
  };
  const created = await send(propertyRoute, "POST", "/api/customer/ga4/property", { brand_key: "acme", grantId: GRANT, propertyId: "properties/22" }, deps(db, { setProperty }));
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.connected, true);
  assert.equal(body.connectorIsMember, true);
  assert.equal(body.grantStatus, "active");
  assert.equal(body.property.id, "properties/22");
  assert.equal(body.connectedByEmail, "owner@example.com");

  for (const bad of [{ brand_key: "acme", grantId: "nope", propertyId: "properties/22" }, { brand_key: "acme", grantId: GRANT, propertyId: "22" }, { brand_key: "acme", grantId: GRANT, propertyId: "properties/22", extra: 1 }]) {
    const res = await send(propertyRoute, "POST", "/api/customer/ga4/property", bad, deps(db, { setProperty }));
    assert.equal(res.status, 400, JSON.stringify(bad));
  }

  const asMember = await send(propertyRoute, "POST", "/api/customer/ga4/property", { brand_key: "acme", grantId: GRANT, propertyId: "properties/22" }, deps(db, { user: MEMBER, role: "member", setProperty }));
  assert.equal(asMember.status, 403);
});

test("DELETE /api/customer/ga4: owner disconnects; unknown body fields are refused", async () => {
  const db = admin({ connections: [connection()] });
  const bad = await send(statusRoute, "DELETE", "/api/customer/ga4", { brand_key: "acme", extra: true }, deps(db));
  assert.equal(bad.status, 400);
  const asMember = await send(statusRoute, "DELETE", "/api/customer/ga4", { brand_key: "acme" }, deps(db, { user: MEMBER, role: "member" }));
  assert.equal(asMember.status, 403);
  assert.equal(db.db.ga4_connections.length, 1);
  const ok = await send(statusRoute, "DELETE", "/api/customer/ga4", { brand_key: "acme" }, deps(db));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { connected: false });
  assert.equal(db.db.ga4_connections.length, 0);
});
