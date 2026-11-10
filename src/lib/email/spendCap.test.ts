import test from "node:test";
import assert from "node:assert/strict";
import { reserveSpend, SpendRefused } from "../spend/index.ts";
import { notifySpendCapRefused } from "./spendCap.ts";

function createFakeAdmin(opts: {
  owners?: string[];
  ownerPrefs?: Record<string, boolean>;
  brandActive?: boolean;
  throwOnQuery?: boolean;
} = {}) {
  const outbox: Array<Record<string, unknown>> = [];
  const owners = opts.owners ?? ["owner_1"];
  const brandActive = opts.brandActive !== false;

  const admin = {
    from(table: string) {
      if (opts.throwOnQuery) {
        throw new Error("Admin query failure");
      }

      let filterBrand = "";
      const builder: any = {
        select(fields?: string) {
          return builder;
        },
        eq(col: string, val: unknown) {
          if (col === "brand_key") filterBrand = String(val);
          return builder;
        },
        in(col: string, vals: unknown[]) {
          return builder;
        },
        maybeSingle() {
          return Promise.resolve({
            data: brandActive
              ? { brand_key: filterBrand || "brand_acme", display_name: "Acme", is_active: true }
              : null,
            error: null,
          });
        },
        then(resolve: (res: any) => void) {
          if (table === "customer_brands") {
            resolve({
              data: brandActive
                ? [{ brand_key: filterBrand || "brand_acme", display_name: "Acme", is_active: true }]
                : [],
              error: null,
            });
          } else if (table === "customer_brand_memberships") {
            resolve({
              data: owners.map((uid) => ({ user_id: uid, role: "owner" })),
              error: null,
            });
          } else if (table === "user_email_preferences") {
            resolve({
              data: owners.map((uid) => ({
                user_id: uid,
                spend_alerts: opts.ownerPrefs?.[uid] ?? true,
                scan_results: true,
                schedule_alerts: true,
                product_updates: false,
              })),
              error: null,
            });
          } else {
            resolve({ data: [], error: null });
          }
        },
        upsert(recordOrRecords: any) {
          const records = Array.isArray(recordOrRecords) ? recordOrRecords : [recordOrRecords];
          for (const r of records) {
            outbox.push(r);
          }
          return {
            then(resolve: (res: any) => void) {
              resolve({ data: records, error: null });
            },
            select() {
              return Promise.resolve({ data: records, error: null });
            },
          };
        },
      };

      return builder;
    },
  };

  return { admin: admin as any, outbox };
}

test("notifySpendCapRefused: enqueues spend_cap_reached row for owners with spend_alerts enabled", async () => {
  const { admin, outbox } = createFakeAdmin({
    owners: ["owner_a", "owner_b"],
    ownerPrefs: { owner_a: true, owner_b: false },
  });

  const now = new Date("2026-10-22T14:30:00.000Z");
  await notifySpendCapRefused(
    {
      brandKey: "brand_acme",
      reason: "daily_cap",
      limitUsd: 5.0,
      now,
    },
    {
      admin,
      appUrl: "https://app.example.test",
      isFeatureEnabled: async () => true,
    },
  );

  assert.equal(outbox.length, 1, "only owner_a has spend_alerts enabled");
  assert.equal(outbox[0].template, "spend_cap_reached");
  assert.equal(outbox[0].dedupe_key, "spend_cap_reached:brand_acme:daily_cap:2026-10-22:owner_a");
  assert.equal(outbox[0].user_id, "owner_a");
});

test("notifySpendCapRefused: never throws even if admin throws", async () => {
  const { admin } = createFakeAdmin({ throwOnQuery: true });

  await assert.doesNotReject(async () => {
    await notifySpendCapRefused(
      {
        brandKey: "brand_acme",
        reason: "daily_cap",
      },
      {
        admin,
        isFeatureEnabled: async () => true,
      },
    );
  });
});

test("F25-AC-08: reserveSpend refusal hook sends spend_cap_reached for workspace-scope daily_cap and workspace_cap, and ignores feature-scope / feature_disabled / notifyCap:false", async () => {
  const promises: Promise<unknown>[] = [];
  const keepAlive = (p: Promise<unknown>) => {
    promises.push(p);
  };

  // 1. Memory store refusing with daily_cap, workspace scope
  const mockStoreDaily = {
    async reserve() {
      return {
        granted: false,
        reason: "daily_cap" as const,
        scope: "workspace" as const,
        limitUsd: 10,
        estimateUsd: 1,
      };
    },
  } as any;

  const fakeAdmin = createFakeAdmin({ owners: ["owner_1"] });

  // Hook up global/injected admin for dynamic import in reserveSpend
  // We can pass a store that refuses
  await assert.rejects(
    async () => {
      await reserveSpend(
        {
          brandKey: "brand_acme",
          feature: "keywords.research" as any,
          estimateUsd: 1,
          idempotencyKey: "k1",
        },
        {
          store: mockStoreDaily,
          keepAlive: keepAlive as any,
        },
      );
    },
    (err: any) => {
      assert.ok(err instanceof SpendRefused);
      assert.equal(err.reason, "daily_cap");
      assert.equal(err.scope, "workspace");
      assert.equal(err.limitUsd, 10);
      return true;
    },
  );

  assert.equal(promises.length, 1, "keepAlive was called for workspace daily_cap");
  await Promise.all(promises);

  // 2. Memory store refusing with workspace_cap, workspace scope
  promises.length = 0;
  const mockStoreMonthly = {
    async reserve() {
      return {
        granted: false,
        reason: "workspace_cap" as const,
        scope: "workspace" as const,
        limitUsd: 100,
        estimateUsd: 2,
      };
    },
  } as any;

  await assert.rejects(
    async () => {
      await reserveSpend(
        {
          brandKey: "brand_acme",
          feature: "keywords.research" as any,
          estimateUsd: 2,
          idempotencyKey: "k2",
        },
        {
          store: mockStoreMonthly,
          keepAlive: keepAlive as any,
        },
      );
    },
    (err: any) => {
      assert.ok(err instanceof SpendRefused);
      assert.equal(err.reason, "workspace_cap");
      assert.equal(err.scope, "workspace");
      return true;
    },
  );

  assert.equal(promises.length, 1, "keepAlive was called for workspace monthly cap");
  await Promise.all(promises);

  // 3. Scope feature -> no keepAlive call
  promises.length = 0;
  const mockStoreFeatureScope = {
    async reserve() {
      return {
        granted: false,
        reason: "daily_cap" as const,
        scope: "feature" as const,
        limitUsd: 5,
        estimateUsd: 1,
      };
    },
  } as any;

  await assert.rejects(
    async () => {
      await reserveSpend(
        {
          brandKey: "brand_acme",
          feature: "keywords.research" as any,
          estimateUsd: 1,
          idempotencyKey: "k3",
        },
        {
          store: mockStoreFeatureScope,
          keepAlive: keepAlive as any,
        },
      );
    },
    (err: any) => err instanceof SpendRefused,
  );

  assert.equal(promises.length, 0, "feature scope must not trigger keepAlive notification");

  // 4. Reason feature_disabled -> no keepAlive call
  promises.length = 0;
  const mockStoreDisabled = {
    async reserve() {
      return {
        granted: false,
        reason: "feature_disabled" as const,
        scope: "workspace" as const,
      };
    },
  } as any;

  await assert.rejects(
    async () => {
      await reserveSpend(
        {
          brandKey: "brand_acme",
          feature: "keywords.research" as any,
          estimateUsd: 1,
          idempotencyKey: "k4",
        },
        {
          store: mockStoreDisabled,
          keepAlive: keepAlive as any,
        },
      );
    },
    (err: any) => err instanceof SpendRefused,
  );

  assert.equal(promises.length, 0, "feature_disabled must not trigger keepAlive notification");

  // 5. notifyCap: false -> no keepAlive call
  promises.length = 0;
  await assert.rejects(
    async () => {
      await reserveSpend(
        {
          brandKey: "brand_acme",
          feature: "keywords.research" as any,
          estimateUsd: 1,
          idempotencyKey: "k5",
        },
        {
          store: mockStoreDaily,
          keepAlive: keepAlive as any,
          notifyCap: false,
        },
      );
    },
    (err: any) => err instanceof SpendRefused,
  );

  assert.equal(promises.length, 0, "notifyCap: false must disable notification");
});
