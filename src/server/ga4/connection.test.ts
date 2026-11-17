import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encryptToken } from "../gsc/oauthCrypto.js";
import {
  disconnect,
  getConnection,
  getGa4ConnectionState,
  listPropertiesForUser,
  requireUsableConnection,
  setProperty,
} from "./connection.ts";
import { fakeGa4Admin } from "./fakeAdmin.testkit.ts";

process.env.GSC_TOKEN_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/f20/${name}`, import.meta.url), "utf8"));

const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const GRANT = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-11-13T09:00:00.000Z");

function grantRow(over: Record<string, unknown> = {}) {
  const userId = (over.user_id as string) ?? OWNER;
  const sub = "google-sub-a";
  return {
    id: GRANT,
    user_id: userId,
    google_sub: sub,
    google_email: "owner@example.com",
    status: "active",
    created_at: "2026-11-01T00:00:00.000Z",
    access_token_expires_at: new Date(NOW + 3_600_000).toISOString(),
    encrypted_access_token: JSON.stringify(encryptToken("ga4_tok", `ga4:${userId}:${sub}:access`)),
    encrypted_refresh_token: null,
    ...over,
  };
}

function seeded(over: { connections?: any[]; grants?: any[]; members?: any[] } = {}) {
  return fakeGa4Admin({
    ga4_grants: over.grants ?? [grantRow()],
    ga4_connections: over.connections ?? [],
    customer_brand_memberships: over.members ?? [
      { brand_key: "acme", user_id: OWNER, role: "owner" },
      { brand_key: "acme", user_id: MEMBER, role: "member" },
    ],
  });
}

/** Google Admin API fake: account summaries in two pages, then the property. */
function googleFetch(opts: { failList?: number } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("accountSummaries")) {
      if (opts.failList) return new Response("{}", { status: opts.failList });
      return Response.json(fixture(url.includes("pageToken") ? "account-summaries-page2.json" : "account-summaries-page1.json"));
    }
    if (url.endsWith("/properties/22")) return Response.json(fixture("property.json"));
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const tokenDeps = (fetchImpl: typeof fetch) => ({ fetchImpl, now: () => NOW, config: null });
const owner = { brandKey: "acme", user: { id: OWNER }, role: "owner" };
const member = { brandKey: "acme", user: { id: MEMBER }, role: "member" };

describe("setProperty", () => {
  it("connects a listed property with its account name and returns the saved row", async () => {
    const admin = seeded();
    const google = googleFetch();
    const row = await setProperty(admin, owner, { grantId: GRANT, propertyId: "properties/22" }, tokenDeps(google.fetchImpl));
    assert.equal(row.property_id, "properties/22");
    assert.equal(row.property_time_zone, "Asia/Kolkata");
    assert.equal(row.account_display_name, "Client");
    assert.equal(row.connected_account_email, "owner@example.com");
    assert.ok(admin.db.rpcCalls.some((c) => c.fn === "ga4_purge_cache"), "a property change purges the cache");
    assert.equal(google.calls.some((u) => u.includes("userinfo")), false, "no extra userinfo call");
  });

  it("refuses a member before any Google call", async () => {
    const admin = seeded();
    const google = googleFetch();
    await assert.rejects(
      setProperty(admin, member, { grantId: GRANT, propertyId: "properties/22" }, tokenDeps(google.fetchImpl)),
      (err: any) => err.status === 403 && err.code === "owner_required",
    );
    assert.equal(google.calls.length, 0);
  });

  it("refuses another user's grant as ga4_grant_not_found", async () => {
    const admin = seeded({ grants: [grantRow({ user_id: MEMBER })] });
    await assert.rejects(
      setProperty(admin, owner, { grantId: GRANT, propertyId: "properties/22" }, tokenDeps(googleFetch().fetchImpl)),
      (err: any) => err.status === 404 && err.code === "ga4_grant_not_found",
    );
  });

  it("refuses a property the linked account cannot list", async () => {
    const admin = seeded();
    await assert.rejects(
      setProperty(admin, owner, { grantId: GRANT, propertyId: "properties/999" }, tokenDeps(googleFetch().fetchImpl)),
      (err: any) => err.status === 404 && err.code === "ga4_property_not_found",
    );
    assert.equal(admin.db.ga4_connections.length, 0);
  });
});

describe("connection state", () => {
  const connection = (over: Record<string, unknown> = {}) => ({
    brand_key: "acme", grant_id: GRANT, connected_by: OWNER, google_sub: "google-sub-a",
    connected_account_email: "owner@example.com", property_id: "properties/22", property_display_name: "Site B",
    property_time_zone: "Asia/Kolkata", property_currency_code: "INR", account_display_name: "Client",
    created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z", ...over,
  });

  it("reports a usable connection to a member, who cannot manage it", async () => {
    const state = await getGa4ConnectionState(seeded({ connections: [connection()] }), member);
    assert.equal(state.connected, true);
    assert.equal(state.canManage, false);
    assert.equal(state.connectorIsMember, true);
    assert.equal(state.grantStatus, "active");
    assert.equal(state.property.accountDisplayName, "Client");
  });

  it("connector who left the workspace -> ga4_reconnect_required", async () => {
    const admin = seeded({ connections: [connection({ connected_by: "44444444-4444-4444-8444-444444444444" })] });
    const state = await getGa4ConnectionState(admin, owner);
    assert.equal(state.connectorIsMember, false);
    await assert.rejects(requireUsableConnection(admin, "acme"), (err: any) => err.status === 409 && err.code === "ga4_reconnect_required");
  });

  it("grant in error -> ga4_reconnect_required", async () => {
    const admin = seeded({ grants: [grantRow({ status: "error" })], connections: [connection()] });
    await assert.rejects(requireUsableConnection(admin, "acme"), (err: any) => err.code === "ga4_reconnect_required" && /expired or was revoked/.test(err.message));
  });

  it("no connection -> ga4_not_connected, and getConnection returns null", async () => {
    const admin = seeded();
    assert.equal(await getConnection(admin, "acme"), null);
    await assert.rejects(requireUsableConnection(admin, "acme"), (err: any) => err.code === "ga4_not_connected");
  });

  it("disconnect is owner-only and removes the connection", async () => {
    const admin = seeded({ connections: [connection()] });
    await assert.rejects(disconnect(admin, member), (err: any) => err.code === "owner_required");
    assert.equal(await disconnect(admin, owner), true);
    assert.equal(admin.db.ga4_connections.length, 0);
  });
});

describe("listPropertiesForUser", () => {
  it("lists each linked account's properties and marks the selected one", async () => {
    const result = await listPropertiesForUser(seeded(), OWNER, "properties/22", tokenDeps(googleFetch().fetchImpl));
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0].email, "owner@example.com");
    assert.deepEqual(result.accounts[0].properties.map((p: any) => [p.propertyId, p.isSelected]), [["properties/11", false], ["properties/22", true]]);
  });

  it("an account whose list fails keeps its email and is marked unavailable, not reconnect", async () => {
    const result = await listPropertiesForUser(seeded(), OWNER, undefined, tokenDeps(googleFetch({ failList: 500 }).fetchImpl));
    assert.equal(result.accounts[0].email, "owner@example.com");
    assert.equal(result.accounts[0].propertiesUnavailable, true);
    assert.equal(result.accounts[0].requiresReconnect, false);
  });

  it("a revoked grant asks for reconnection", async () => {
    const result = await listPropertiesForUser(seeded(), OWNER, undefined, tokenDeps(googleFetch({ failList: 401 }).fetchImpl));
    assert.equal(result.accounts[0].requiresReconnect, true);
  });
});
