/**
 * In-memory stand-in for the service-role Supabase client, covering the GA4
 * tables and functions the connection service and its routes touch. Test-only.
 */
type Row = Record<string, any>;

export type FakeGa4Db = {
  ga4_grants: Row[];
  ga4_connections: Row[];
  customer_brand_memberships: Row[];
  rpcCalls: { fn: string; args: Row }[];
};

class Query {
  private filters: Array<(row: Row) => boolean> = [];
  private db: FakeGa4Db;
  private table: keyof FakeGa4Db;
  constructor(db: FakeGa4Db, table: keyof FakeGa4Db) {
    this.db = db;
    this.table = table;
  }
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this; }
  order() { return this; }
  private rows() { return (this.db[this.table] as Row[]).filter((row) => this.filters.every((f) => f(row))); }
  async maybeSingle() { return { data: this.rows()[0] ?? null, error: null }; }
  async single() {
    const rows = this.rows();
    return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: "not one row" } };
  }
  then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
    return Promise.resolve({ data: this.rows(), error: null }).then(resolve, reject);
  }
}

export function fakeGa4Admin(seed: Partial<FakeGa4Db> = {}) {
  const db: FakeGa4Db = {
    ga4_grants: seed.ga4_grants ?? [],
    ga4_connections: seed.ga4_connections ?? [],
    customer_brand_memberships: seed.customer_brand_memberships ?? [],
    rpcCalls: [],
  };
  const admin = {
    db,
    from: (table: keyof FakeGa4Db) => new Query(db, table),
    rpc: async (fn: string, args: Row) => {
      db.rpcCalls.push({ fn, args });
      if (fn === "ga4_purge_cache") return { data: [], error: null };
      const isOwner = db.customer_brand_memberships.some((m) => m.brand_key === args.p_brand_key && m.user_id === args.p_user_id && m.role === "owner");
      if (fn === "ga4_set_connection") {
        if (!isOwner) return { data: null, error: { message: "owner_required" } };
        const grant = db.ga4_grants.find((g) => g.id === args.p_grant_id && g.user_id === args.p_user_id && g.status === "active");
        if (!grant) return { data: null, error: { message: "ga4_grant_not_found" } };
        db.ga4_connections = db.ga4_connections.filter((c) => c.brand_key !== args.p_brand_key);
        db.ga4_connections.push({
          brand_key: args.p_brand_key, grant_id: grant.id, connected_by: args.p_user_id, google_sub: grant.google_sub,
          connected_account_email: grant.google_email, property_id: args.p_property_id,
          property_display_name: args.p_property_display_name, property_time_zone: args.p_property_time_zone,
          property_currency_code: args.p_property_currency_code, account_display_name: args.p_account_display_name,
          created_at: "2026-11-13T09:00:00.000Z", updated_at: "2026-11-13T09:00:00.000Z",
        });
        return { data: "conn-1", error: null };
      }
      if (fn === "ga4_disconnect") {
        if (!isOwner) return { data: null, error: { message: "owner_required" } };
        const before = db.ga4_connections.length;
        db.ga4_connections = db.ga4_connections.filter((c) => c.brand_key !== args.p_brand_key);
        return { data: db.ga4_connections.length < before, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    },
  };
  return admin;
}
