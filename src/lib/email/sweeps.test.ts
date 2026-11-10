import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  sweepScans,
  sweepWindows,
  sweepMilestones,
} from "./sweeps.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURES_DIR = path.join(ROOT, "tests/fixtures/f25");

const windowRowsFixture = JSON.parse(
  fs.readFileSync(path.join(FIXTURES_DIR, "window-rows.json"), "utf8"),
);
const milestoneCandidatesFixture = JSON.parse(
  fs.readFileSync(path.join(FIXTURES_DIR, "milestone-candidates.json"), "utf8"),
);

type MockStore = {
  scans: Array<Record<string, unknown>>;
  customer_brands: Array<Record<string, unknown>>;
  customer_brand_memberships: Array<Record<string, unknown>>;
  user_email_preferences: Array<Record<string, unknown>>;
  measurement_windows: Array<Record<string, unknown>>;
  scan_schedules: Array<Record<string, unknown>>;
  workspace_milestones: Array<Record<string, unknown>>;
  email_outbox: Array<Record<string, unknown>>;
  rpcMilestones: Array<Record<string, unknown>>;
};

function createMockAdmin(
  initial: Partial<MockStore> = {},
  hooks: { insertError?: (table: string, rec: Record<string, any>) => Record<string, unknown> | null } = {},
) {
  const store: MockStore = {
    scans: initial.scans ?? [],
    customer_brands: initial.customer_brands ?? [],
    customer_brand_memberships: initial.customer_brand_memberships ?? [],
    user_email_preferences: initial.user_email_preferences ?? [],
    measurement_windows: initial.measurement_windows ?? [],
    scan_schedules: initial.scan_schedules ?? [],
    workspace_milestones: initial.workspace_milestones ?? [],
    email_outbox: initial.email_outbox ?? [],
    rpcMilestones: initial.rpcMilestones ?? [],
  };

  const admin = {
    from(table: keyof MockStore) {
      let filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let selectFields = "*";

      const queryBuilder: any = {
        select(fields: string) {
          selectFields = fields;
          return queryBuilder;
        },
        eq(col: string, val: unknown) {
          filters.push((r) => r[col] === val);
          return queryBuilder;
        },
        in(col: string, vals: unknown[]) {
          filters.push((r) => vals.includes(r[col]));
          return queryBuilder;
        },
        not(col: string, op: string, val: unknown) {
          if (op === "is" && val === null) {
            filters.push((r) => r[col] !== null && r[col] !== undefined);
          }
          return queryBuilder;
        },
        gte(col: string, val: string | number) {
          filters.push((r) => {
            const rowVal = r[col];
            if (typeof rowVal === "string" || typeof rowVal === "number") {
              return rowVal >= val;
            }
            return false;
          });
          return queryBuilder;
        },
        order() {
          return queryBuilder;
        },
        limit(n: number) {
          return {
            then(resolve: (res: { data: unknown; error: null }) => void) {
              const rows = (store[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, n);
              resolve({ data: rows, error: null });
            },
          };
        },
        maybeSingle() {
          return Promise.resolve().then(() => {
            const rows = (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
            return { data: rows[0] ?? null, error: null };
          });
        },
        insert(recordOrRecords: any) {
          const records = Array.isArray(recordOrRecords) ? recordOrRecords : [recordOrRecords];
          for (const rec of records) {
            const hookError = hooks.insertError?.(table, rec);
            if (hookError) {
              return {
                then(resolve: (res: { data: null; error: unknown }) => void) {
                  resolve({ data: null, error: hookError });
                },
                select() {
                  return Promise.resolve({ data: null, error: hookError });
                },
              };
            }
            if (table === "workspace_milestones") {
              const exists = store.workspace_milestones.some(
                (m) => m.brand_key === rec.brand_key && m.milestone === rec.milestone,
              );
              if (exists) {
                return {
                  then(resolve: (res: { data: null; error: Error }) => void) {
                    resolve({ data: null, error: Object.assign(new Error("duplicate milestone"), { code: "23505" }) });
                  },
                  select() {
                    return Promise.resolve({ data: null, error: Object.assign(new Error("duplicate milestone"), { code: "23505" }) });
                  },
                };
              }
            }
            store[table].push(rec);
          }
          return {
            then(resolve: (res: { data: unknown; error: null }) => void) {
              resolve({ data: records, error: null });
            },
            select() {
              return Promise.resolve({ data: records, error: null });
            },
          };
        },
        upsert(recordOrRecords: any, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
          const records = Array.isArray(recordOrRecords) ? recordOrRecords : [recordOrRecords];
          const out: any[] = [];
          for (const rec of records) {
            if (table === "email_outbox" && opts?.onConflict === "dedupe_key") {
              const existingIdx = store.email_outbox.findIndex(
                (r) => r.dedupe_key === rec.dedupe_key,
              );
              if (existingIdx !== -1) {
                if (!opts.ignoreDuplicates) {
                  store.email_outbox[existingIdx] = { ...store.email_outbox[existingIdx], ...rec };
                  out.push(store.email_outbox[existingIdx]);
                }
                continue;
              }
            }
            const newRec = { id: `id-${store.email_outbox.length + 1}`, ...rec };
            store.email_outbox.push(newRec);
            out.push(newRec);
          }
          return {
            then(resolve: (res: { data: unknown; error: null }) => void) {
              resolve({ data: out, error: null });
            },
            select(fields?: string) {
              return Promise.resolve({ data: out, error: null });
            },
          };
        },
      };

      queryBuilder.then = (resolve: (res: { data: unknown; error: null }) => void) => {
        const rows = (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
        resolve({ data: rows, error: null });
      };

      return queryBuilder;
    },
    async rpc(fn: string, params: any) {
      if (fn === "email_milestone_candidates") {
        const limit = params?.p_limit ?? 500;
        return { data: store.rpcMilestones.slice(0, limit), error: null };
      }
      return { data: null, error: null };
    },
  };

  return { admin: admin as any, store };
}

test("F25-AC-06: sweepScans enqueues scan_finished for members with scan_results on, ignores anonymous scans, and repeats enqueue zero", async () => {
  const now = new Date("2026-10-22T10:00:00.000Z");
  const tenMinsAgo = new Date(now.getTime() - 10 * 60_000).toISOString();

  const { admin, store } = createMockAdmin({
    customer_brands: [
      { brand_key: "brand_acme", display_name: "Acme Corp", is_active: true },
    ],
    customer_brand_memberships: [
      { brand_key: "brand_acme", user_id: "u1", role: "owner" },
      { brand_key: "brand_acme", user_id: "u2", role: "member" },
    ],
    user_email_preferences: [
      { user_id: "u1", scan_results: true, schedule_alerts: true, spend_alerts: true, product_updates: false },
      { user_id: "u2", scan_results: false, schedule_alerts: true, spend_alerts: true, product_updates: false },
    ],
    scans: [
      // Named workspace scan
      {
        id: "scan_1",
        brand_key: "brand_acme",
        created_at: tenMinsAgo,
        prompts_tracked: 25,
        prompts_mentioned: 10,
        raw_results: { summary_stats: { terminal_outcome: { outcome: "complete" } } },
      },
      // Anonymous scan (brand_key null)
      {
        id: "scan_anon",
        brand_key: null,
        created_at: tenMinsAgo,
        prompts_tracked: 5,
        prompts_mentioned: 0,
      },
    ],
  });

  // First sweep
  const res1 = await sweepScans(admin, now, { appUrl: "https://app.example.test" });
  assert.equal(res1.scans, 1, "only 1 named scan was found");
  assert.equal(res1.enqueued, 1, "exactly 1 email enqueued (u1 has scan_results=true, u2 has scan_results=false)");
  assert.equal(store.email_outbox.length, 1);
  assert.equal(store.email_outbox[0].template, "scan_finished");
  assert.equal(store.email_outbox[0].dedupe_key, "scan_finished:scan_1:u1");

  // Second sweep: idempotency test (repeat creates 0)
  const res2 = await sweepScans(admin, now, { appUrl: "https://app.example.test" });
  assert.equal(res2.scans, 1);
  assert.equal(res2.enqueued, 0, "second sweep creates 0 new rows");
  assert.equal(store.email_outbox.length, 1);
});

test("F25-AC-07: sweepWindows ignores overlap/catch-up, maps price_changed to schedule_skipped, maps caps to spend_cap_reached with notifier key, and dedupes multiple windows on same day", async () => {
  const now = new Date("2026-10-22T10:00:00.000Z");

  const { admin, store } = createMockAdmin({
    customer_brands: [
      { brand_key: "brand_acme", display_name: "Acme Corp", is_active: true },
    ],
    customer_brand_memberships: [
      { brand_key: "brand_acme", user_id: "u_owner", role: "owner" },
      { brand_key: "brand_acme", user_id: "u_member", role: "member" },
    ],
    user_email_preferences: [
      { user_id: "u_owner", scan_results: true, schedule_alerts: true, spend_alerts: true, product_updates: false },
      { user_id: "u_member", scan_results: true, schedule_alerts: true, spend_alerts: true, product_updates: false },
    ],
    scan_schedules: [
      { brand: "brand_acme", managed_by: "customer", next_run_at: "2026-10-23T08:00:00.000Z" },
    ],
    measurement_windows: windowRowsFixture,
  });

  const res = await sweepWindows(admin, now, { appUrl: "https://app.example.test" });
  assert.equal(res.windows, 6);
  // Expected outbox rows:
  // 1. active_scan_overlap -> ignored
  // 2. bounded_catchup_elapsed -> ignored
  // 3. price_changed (09:00) -> schedule_skipped:brand_acme:price_changed:2026-10-22:u_owner
  // 4. price_changed (09:15) -> duplicate key for same day -> ignored
  // 5. daily_cap (09:30) -> spend_cap_reached:brand_acme:daily_cap:2026-10-22:u_owner
  // 6. workspace_cap (09:45) -> spend_cap_reached:brand_acme:workspace_cap:2026-10:u_owner
  // Total enqueued = 3
  assert.equal(res.enqueued, 3, "expected 3 distinct notification rows");

  const keys = store.email_outbox.map((r) => r.dedupe_key);
  assert.ok(keys.includes("schedule_skipped:brand_acme:price_changed:2026-10-22:u_owner"));
  assert.ok(keys.includes("spend_cap_reached:brand_acme:daily_cap:2026-10-22:u_owner"));
  assert.ok(keys.includes("spend_cap_reached:brand_acme:workspace_cap:2026-10:u_owner"));

  // Only owner received them, not member
  for (const row of store.email_outbox) {
    assert.equal(row.user_id, "u_owner");
  }

  // Second run produces 0 new enqueued rows
  const res2 = await sweepWindows(admin, now, { appUrl: "https://app.example.test" });
  assert.equal(res2.enqueued, 0);
});

test("sweepMilestones: processes candidates, inserts workspace_milestones, and fans out one contact_milestones per member per sweep", async () => {
  const now = new Date("2026-10-22T10:00:00.000Z");

  const { admin, store } = createMockAdmin({
    customer_brands: [
      { brand_key: "brand_acme", display_name: "Acme Corp", is_active: true },
    ],
    customer_brand_memberships: [
      { brand_key: "brand_acme", user_id: "u1", role: "owner" },
      { brand_key: "brand_acme", user_id: "u2", role: "member" },
    ],
    rpcMilestones: milestoneCandidatesFixture, // 3 milestone candidates for brand_acme
  });

  const res = await sweepMilestones(admin, now);
  assert.equal(res.candidates, 3);
  assert.equal(res.milestones, 3);
  assert.equal(store.workspace_milestones.length, 3);

  // 2 members in the workspace -> each gets 1 contact_milestones row for this sweep slot
  assert.equal(res.contacts, 2);
  assert.equal(store.email_outbox.length, 2);
  assert.equal(store.email_outbox[0].template, "contact_milestones");
  assert.equal(store.email_outbox[0].dedupe_key, "contact_milestones:u1:2026-10-22T10:00");
  assert.equal(store.email_outbox[1].template, "contact_milestones");
  assert.equal(store.email_outbox[1].dedupe_key, "contact_milestones:u2:2026-10-22T10:00");
});

test("sweepMilestones: non-23505 insert error is thrown (not swallowed) so the step retries", async () => {
  const now = new Date("2026-10-22T10:00:00.000Z");
  const { admin } = createMockAdmin(
    {
      customer_brands: [{ brand_key: "brand_acme", display_name: "Acme Corp", is_active: true }],
      customer_brand_memberships: [{ brand_key: "brand_acme", user_id: "u1", role: "owner" }],
      rpcMilestones: milestoneCandidatesFixture,
    },
    {
      insertError: (table) =>
        table === "workspace_milestones" ? { code: "XX000", message: "db down" } : null,
    },
  );

  await assert.rejects(() => sweepMilestones(admin, now), (e: any) => e.code === "XX000");
});

test("sweepMilestones: duplicate (23505) milestone inserts are skipped, not thrown", async () => {
  const now = new Date("2026-10-22T10:00:00.000Z");
  const { admin, store } = createMockAdmin({
    customer_brands: [{ brand_key: "brand_acme", display_name: "Acme Corp", is_active: true }],
    customer_brand_memberships: [{ brand_key: "brand_acme", user_id: "u1", role: "owner" }],
    workspace_milestones: [{ brand_key: "brand_acme", milestone: "workspace_created" }],
    rpcMilestones: milestoneCandidatesFixture,
  });

  const res = await sweepMilestones(admin, now);
  assert.equal(res.milestones, 2);
  assert.equal(store.workspace_milestones.length, 3);
});

test("sweepMilestones: contact rows are enqueued even when a milestone insert fails afterwards, and a retry does not duplicate them", async () => {
  const now = new Date("2026-10-22T10:00:00.000Z");
  let fail = true;
  const { admin, store } = createMockAdmin(
    {
      customer_brands: [{ brand_key: "brand_acme", display_name: "Acme Corp", is_active: true }],
      customer_brand_memberships: [
        { brand_key: "brand_acme", user_id: "u1", role: "owner" },
        { brand_key: "brand_acme", user_id: "u2", role: "member" },
      ],
      rpcMilestones: milestoneCandidatesFixture,
    },
    {
      insertError: (table, rec) =>
        fail && table === "workspace_milestones" && rec.milestone === "draft_approved"
          ? { code: "XX000", message: "db down" }
          : null,
    },
  );

  await assert.rejects(() => sweepMilestones(admin, now));
  assert.equal(store.email_outbox.length, 2);
  assert.ok(store.email_outbox.every((r) => r.template === "contact_milestones"));

  fail = false;
  const retry = await sweepMilestones(admin, now);
  assert.equal(retry.contacts, 0);
  assert.equal(store.email_outbox.length, 2);
});
