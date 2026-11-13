import test from "node:test";
import assert from "node:assert/strict";

const { getConnection, requireUsableConnection } = await import(new URL("./connection.ts", import.meta.url).href);

function makeAdmin(conn: any) {
  return {
    from: (table: string) => {
      if (table === "ga4_connections") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: conn, error: null }) }) }) };
      }
      if (table === "customer_brand_memberships") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "owner" }, error: null }) }) }) }) };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

test("getConnection returns null when no connection", async () => {
  const admin = makeAdmin(null);
  const conn = await getConnection(admin, "brand-1");
  assert.equal(conn, null);
});

test("requireUsableConnection throws ga4_not_connected when no connection", async () => {
  const admin = makeAdmin(null);
  await assert.rejects(() => requireUsableConnection(admin, "brand-1"), (err: any) => err.code === "ga4_not_connected");
});

test("requireUsableConnection returns connection when usable", async () => {
  const conn = { brand_key: "brand-1", grant_id: "g1", connected_by: "u1", property_id: "properties/1", property_display_name: "P", property_time_zone: "UTC", property_currency_code: "USD", account_display_name: "A", connected_account_email: "e@x.com", created_at: "2026-01-01", updated_at: "2026-01-01", status: undefined };
  // need grant status active
  const admin = {
    from: (table: string) => {
      if (table === "ga4_connections") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: conn, error: null }) }) }) };
      if (table === "customer_brand_memberships") return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "owner" }, error: null }) }) }) }) };
      if (table === "ga4_grants") return { select: () => ({ eq: () => ({ single: async () => ({ data: { status: "active" }, error: null }), maybeSingle: async () => ({ data: { status: "active" }, error: null }) }) }) };
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
    },
    rpc: async () => ({ data: null, error: null }),
  };
  const c = await requireUsableConnection(admin, "brand-1");
  assert.equal(c.property_id, "properties/1");
});