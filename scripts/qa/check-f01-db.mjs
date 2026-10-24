#!/usr/bin/env node
/**
 * F01 database harness — spend guard (migration 041).
 *
 * Runs against a disposable loopback PostgreSQL database that has every
 * migration applied. It never sees production: the guard below refuses any
 * database that is not a loopback `_qa`/`_uat` name with no DATABASE_URL.
 *
 * Usage:
 *   PGHOST=localhost PGDATABASE=perceev_qa PGUSER=... node scripts/qa/check-f01-db.mjs --only spend
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
if (
  !["127.0.0.1", "localhost", "::1"].includes(process.env.PGHOST) ||
  !/(?:_qa|_uat)$/.test(process.env.PGDATABASE || "") ||
  process.env.DATABASE_URL
)
  throw Error("Explicit loopback QA database required; DATABASE_URL refused");
const pool = new pg.Pool({ max: 24 });
const q = (sql, values = []) => pool.query(sql, values);
const passed = [];
const id = () => crypto.randomUUID();
async function rpc(name, values) {
  const entries = Object.entries(values);
  const r = await q(
    `select ${name}(${entries.map(([k], i) => `${k}=>$${i + 1}`).join(",")}) result`,
    entries.map(([, v]) => (v && typeof v === "object" ? JSON.stringify(v) : v)),
  );
  return r.rows[0].result;
}
async function test(name, fn) {
  await fn();
  passed.push(name);
  console.log("PASS " + name);
}
async function asUser(user, sql, values = []) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
    return await c.query(sql, values);
  } finally {
    await c.query("rollback");
    c.release();
  }
}

const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];

const actor = id();
const outsider = id();
const brands = [];
const features = [];
const users = [actor, outsider];

async function createUser(label) {
  const userId = id();
  await q("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [
    userId,
    `qa-${label}-${userId}@example.test`,
  ]);
  users.push(userId);
  return userId;
}

async function createBrand(member = actor) {
  const brand = `qa-${id()}.example`;
  await q("insert into customer_brands(brand_key,display_name,website,website_host) values($1,$1,$2,$2)", [
    brand,
    `https://${brand}`,
  ]);
  await q("insert into customer_brand_memberships(user_id,brand_key,role) values($1,$2,'owner')", [member, brand]);
  brands.push(brand);
  return brand;
}

async function createFeature(overrides = {}) {
  const feature = `qa.guard_${id().replace(/-/g, "_")}`;
  await q(
    "insert into paid_feature_controls(feature,enabled,mode,daily_cap_usd,max_call_usd) values($1,$2,'all',$3,$4)",
    [feature, overrides.enabled ?? true, overrides.dailyCapUsd ?? null, overrides.maxCallUsd ?? null],
  );
  features.push(feature);
  return feature;
}

function reserveArgs(brand, feature, estimateUsd, idempotencyKey, extra = {}) {
  return {
    p_brand: brand,
    p_feature: feature,
    p_estimate: estimateUsd,
    p_max: extra.maxUsd ?? null,
    p_idempotency: idempotencyKey,
    p_job: null,
    p_subject_kind: null,
    p_subject_id: null,
    p_ttl_seconds: extra.ttlSeconds ?? 1800,
    p_default_daily: extra.defaultDailyUsd ?? null,
    p_default_monthly: extra.defaultMonthlyUsd ?? null,
  };
}

const reserve = (brand, feature, estimateUsd, key, extra) =>
  rpc("reserve_spend", reserveArgs(brand, feature, estimateUsd, key, extra));

async function holdCount(brand) {
  return (await q("select count(*)::int n from spend_holds where brand_key=$1", [brand])).rows[0].n;
}

const GROUPS = [
  {
    name: "spend-defaults",
    group: "spend",
    async run() {
      const seeded = (
        await q("select enabled, mode, brand_allowlist from paid_feature_controls where feature='platform.selftest'")
      ).rows[0];
      assert.ok(seeded, "migration 041 seeds platform.selftest");
      assert.equal(seeded.enabled, false, "a fresh database must ship the only seed disabled");
      assert.equal(seeded.mode, "allowlist");
      assert.deepEqual(seeded.brand_allowlist, []);
      const enabled = (await q("select count(*)::int n from paid_feature_controls where enabled")).rows[0].n;
      assert.equal(enabled, 0, "no paid feature may be enabled by a migration");
      const rls = (
        await q(
          `select c.relname, c.relrowsecurity from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname='public'
              and c.relname in ('paid_feature_controls','workspace_spend_limits','spend_holds','spend_ledger')`,
        )
      ).rows;
      assert.equal(rls.length, 4);
      for (const table of rls) assert.equal(table.relrowsecurity, true, `${table.relname} must have RLS enabled`);
    },
  },
  {
    name: "spend-refusals",
    group: "spend",
    async run() {
      const brand = await createBrand();
      const callCapped = await createFeature({ maxCallUsd: 0.5 });
      const featureDailyCapped = await createFeature({ dailyCapUsd: 1 });
      const uncapped = await createFeature();

      const cases = [
        {
          label: "feature_disabled",
          expected: (result) => {
            assert.equal(result.reason, "feature_disabled");
          },
          call: () => reserve(brand, `qa.missing_${id().replace(/-/g, "_")}`, 0.5, `refuse-${id()}`),
        },
        {
          label: "over_approved_max against the caller's max",
          expected: (result) => {
            assert.equal(result.reason, "over_approved_max");
            assert.equal(Number(result.estimate_usd), 1);
          },
          call: () => reserve(brand, callCapped, 1, `refuse-${id()}`, { maxUsd: 0.75 }),
        },
        {
          label: "over_approved_max against the feature's max_call_usd",
          expected: (result) => {
            assert.equal(result.reason, "over_approved_max");
            assert.equal(Number(result.limit_usd), 0.5);
          },
          call: () => reserve(brand, callCapped, 1, `refuse-${id()}`),
        },
        {
          label: "daily_cap on the feature platform cap",
          expected: (result) => {
            assert.equal(result.reason, "daily_cap");
            assert.equal(result.scope, "feature");
          },
          call: () => reserve(brand, featureDailyCapped, 2, `refuse-${id()}`, { maxUsd: 5 }),
        },
      ];
      for (const testCase of cases) {
        const result = await testCase.call();
        assert.equal(result.granted, false, `${testCase.label} must be refused`);
        testCase.expected(result);
        assert.equal(await holdCount(brand), 0, `${testCase.label} must not create a hold`);
      }

      await q("insert into workspace_spend_limits(brand_key,daily_cap_usd,monthly_cap_usd) values($1,3,null)", [brand]);
      const capped = await reserve(brand, uncapped, 4, `refuse-${id()}`, { maxUsd: 5 });
      assert.equal(capped.granted, false);
      assert.equal(capped.reason, "daily_cap");
      assert.equal(capped.scope, "workspace");
      assert.equal(Number(capped.limit_usd), 3);
      assert.equal(await holdCount(brand), 0);

      const other = await createBrand();
      await q("insert into workspace_spend_limits(brand_key,daily_cap_usd,monthly_cap_usd) values($1,null,1)", [other]);
      const monthly = await reserve(other, uncapped, 2, `refuse-${id()}`, { maxUsd: 5 });
      assert.equal(monthly.granted, false);
      assert.equal(monthly.reason, "workspace_cap");
      assert.equal(Number(monthly.limit_usd), 1);
      assert.equal(await holdCount(other), 0);
    },
  },
  {
    name: "spend-concurrency",
    group: "spend",
    async run() {
      const brand = await createBrand();
      const feature = await createFeature();
      await q("insert into workspace_spend_limits(brand_key,daily_cap_usd) values($1,10)", [brand]);
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => reserve(brand, feature, 1, `conc-${i}-${id()}`)),
      );
      const granted = results.filter((result) => result.granted);
      assert.equal(granted.length, 10, `20 reservations of USD 1 against a USD 10 daily cap grant 10, got ${granted.length}`);
      assert.equal(new Set(granted.map((result) => result.hold_id)).size, 10);
      const total = Number((await q("select coalesce(sum(estimate_usd),0) s from spend_holds where brand_key=$1", [brand])).rows[0].s);
      assert.equal(total, 10);
      assert.equal(await holdCount(brand), 10);
    },
  },
  {
    name: "spend-idempotency",
    group: "spend",
    async run() {
      const brand = await createBrand();
      const feature = await createFeature();
      const key = `idem-${id()}`;
      const first = await reserve(brand, feature, 1, key);
      assert.equal(first.granted, true);
      assert.equal(first.existing, false);
      const second = await reserve(brand, feature, 1, key);
      assert.equal(second.granted, true);
      assert.equal(second.existing, true);
      assert.equal(second.hold_id, first.hold_id);
      assert.equal(await holdCount(brand), 1);

      await rpc("settle_spend", {
        p_hold: first.hold_id,
        p_costs: [{ provider: "openrouter", endpoint: "chat:qa", actual_usd: 1, cost_source: "provider_reported" }],
      });
      const afterSettle = await reserve(brand, feature, 1, key);
      assert.equal(afterSettle.granted, false);
      assert.equal(afterSettle.reason, "duplicate_paid_call");
      assert.equal(afterSettle.hold_id, first.hold_id);

      const thirdKey = `idem-${id()}`;
      const third = await reserve(brand, feature, 1, thirdKey);
      assert.equal(third.granted, true);
      assert.equal(await rpc("release_spend", { p_hold: third.hold_id, p_reason: "qa release" }), true);
      const afterRelease = await reserve(brand, feature, 1, thirdKey);
      assert.equal(afterRelease.granted, false);
      assert.equal(afterRelease.reason, "duplicate_paid_call");
    },
  },
  {
    name: "spend-settle",
    group: "spend",
    async run() {
      const brand = await createBrand();
      const feature = await createFeature();

      const multi = await reserve(brand, feature, 1, `settle-${id()}`);
      const settled = await rpc("settle_spend", {
        p_hold: multi.hold_id,
        p_costs: [
          { provider: "openrouter", endpoint: "chat:qa", actual_usd: 0.75, cost_source: "provider_reported" },
          { provider: "openrouter", endpoint: "chat:qa", actual_usd: null, cost_source: "provider_reported" },
        ],
      });
      assert.equal(settled.settled, true);
      assert.equal(settled.unknown, true, "one unknown row makes the hold's actual unknown");
      assert.equal(Number(settled.actual_usd), 0.75);
      const hold = (await q("select status, actual_usd from spend_holds where id=$1", [multi.hold_id])).rows[0];
      assert.equal(hold.status, "settled");
      assert.equal(hold.actual_usd, null);
      const rows = (
        await q(
          "select source_ref, estimate_usd, actual_usd, accounted_usd, cost_source, meta from spend_ledger where hold_id=$1 order by source_ref",
          [multi.hold_id],
        )
      ).rows;
      assert.equal(rows.length, 2, "each cost row is credited separately");
      assert.equal(rows[0].source_ref, `hold:${multi.hold_id}:1`);
      assert.equal(rows[1].source_ref, `hold:${multi.hold_id}:2`);
      assert.equal(Number(rows[0].estimate_usd), 0.5);
      assert.equal(Number(rows[0].actual_usd), 0.75);
      assert.equal(Number(rows[0].accounted_usd), 0.75);
      assert.equal(rows[0].cost_source, "provider_reported");
      assert.equal(rows[0].meta.undershoot, true);
      assert.equal(rows[1].actual_usd, null);
      assert.equal(Number(rows[1].accounted_usd), 0.5);
      assert.equal(rows[1].cost_source, "reservation");
      assert.equal(rows[1].meta.undershoot, false);

      const repeat = await rpc("settle_spend", {
        p_hold: multi.hold_id,
        p_costs: [{ provider: "openrouter", endpoint: "chat:qa", actual_usd: 2, cost_source: "provider_reported" }],
      });
      assert.equal(repeat.settled, false, "a closed hold is not settled twice");
      assert.equal(repeat.status, "settled");

      const undershoot = await reserve(brand, feature, 0.5, `settle-${id()}`);
      const aboveEstimate = await rpc("settle_spend", {
        p_hold: undershoot.hold_id,
        p_costs: [{ provider: "openrouter", endpoint: "chat:qa", actual_usd: 1, cost_source: "provider_reported" }],
      });
      assert.equal(aboveEstimate.undershoot, true, "an actual above the estimate must be flagged");
      const flagged = (
        await q("select meta->>'undershoot' u from spend_ledger where hold_id=$1", [undershoot.hold_id])
      ).rows[0];
      assert.equal(flagged.u, "true", "the ledger row records meta.undershoot");

      const overMax = await reserve(brand, feature, 1, `settle-${id()}`, { maxUsd: 1.5 });
      const aboveMax = await rpc("settle_spend", {
        p_hold: overMax.hold_id,
        p_costs: [{ provider: "openrouter", endpoint: "chat:qa", actual_usd: 2, cost_source: "provider_reported" }],
      });
      assert.equal(aboveMax.over_max, true);

      await assert.rejects(
        () =>
          q(
            `insert into spend_ledger(brand_key,feature,source_ref,provider,endpoint,estimate_usd,actual_usd,accounted_usd,cost_source)
             values($1,$2,$3,'qa','qa',1,null,1,'none')`,
            [brand, feature, `qa-bad-${id()}`],
          ),
        /spend_ledger_accounting/,
        "cost_source 'none' may not carry a non-zero accounted amount",
      );
    },
  },
  {
    name: "spend-expiry",
    group: "spend",
    async run() {
      const brand = await createBrand();
      const feature = await createFeature();
      const held = await reserve(brand, feature, 2, `expire-${id()}`);
      await q("update spend_holds set expires_at = now() - interval '1 minute' where id=$1", [held.hold_id]);
      const expired = await rpc("expire_spend_holds", { p_limit: 500 });
      assert.ok(Number(expired) >= 1, `expire_spend_holds must report the expired hold, got ${expired}`);
      const hold = (await q("select status, actual_usd from spend_holds where id=$1", [held.hold_id])).rows[0];
      assert.equal(hold.status, "expired");
      assert.equal(hold.actual_usd, null);
      const rows = (
        await q(
          "select provider, endpoint, estimate_usd, actual_usd, accounted_usd, cost_source, meta from spend_ledger where hold_id=$1",
          [held.hold_id],
        )
      ).rows;
      assert.equal(rows.length, 1, "an expired hold writes exactly one ledger row");
      assert.equal(rows[0].provider, "unknown");
      assert.equal(rows[0].endpoint, "expired_hold");
      assert.equal(Number(rows[0].estimate_usd), 2);
      assert.equal(rows[0].actual_usd, null);
      assert.equal(Number(rows[0].accounted_usd), 2);
      assert.equal(rows[0].cost_source, "reservation");
      assert.equal(rows[0].meta.expired, true);
      await rpc("expire_spend_holds", { p_limit: 500 });
      const again = (await q("select count(*)::int n from spend_ledger where hold_id=$1", [held.hold_id])).rows[0].n;
      assert.equal(again, 1, "a second sweep must not write a second row");
      assert.equal(
        Number(await rpc("f01_expire_due_holds", { p_brand: brand, p_feature: feature, p_limit: 100 })),
        0,
        "a scoped sweep leaves an already-expired hold alone",
      );

      // Owner review — a workspace's due holds stop counting at its own next reservation.
      const sweepFeature = await createFeature();
      const sweepBrand = await createBrand();
      const abandonedKey = `expire-abandoned-${id()}`;
      const abandoned = await reserve(sweepBrand, sweepFeature, 2, abandonedKey);
      assert.equal(abandoned.granted, true);
      await q("update spend_holds set expires_at = now() - interval '1 minute' where id=$1", [abandoned.hold_id]);
      const fresh = await reserve(sweepBrand, sweepFeature, 1, `expire-fresh-${id()}`);
      assert.equal(fresh.granted, true, "a reservation sweeps its workspace's due holds before the cap check");
      const swept = (await q("select status, actual_usd from spend_holds where id=$1", [abandoned.hold_id])).rows[0];
      assert.equal(swept.status, "expired", "the next reservation for the brand expires its abandoned hold");
      assert.equal(swept.actual_usd, null);
      const sweptRows = (
        await q("select count(*)::int n from spend_ledger where source_ref=$1", [`hold:${abandoned.hold_id}`])
      ).rows[0].n;
      assert.equal(sweptRows, 1, "the scoped sweep writes exactly one hold:<old> reservation row");
      const stale = await reserve(sweepBrand, sweepFeature, 2, abandonedKey);
      assert.equal(stale.granted, false, "an expired idempotency key must not be re-granted");
      assert.equal(stale.reason, "duplicate_paid_call");
      assert.equal(stale.hold_id, abandoned.hold_id);

      // Owner review — the feature scope also sweeps a brand that has not reserved again.
      const featureSweep = await createFeature();
      const quietBrand = await createBrand();
      const quiet = await reserve(quietBrand, featureSweep, 1, `expire-quiet-${id()}`);
      assert.equal(quiet.granted, true);
      await q("update spend_holds set expires_at = now() - interval '1 minute' where id=$1", [quiet.hold_id]);
      const otherBrand = await createBrand();
      const otherGrant = await reserve(otherBrand, featureSweep, 1, `expire-other-${id()}`);
      assert.equal(otherGrant.granted, true);
      const quietAfter = (await q("select status from spend_holds where id=$1", [quiet.hold_id])).rows[0];
      assert.equal(quietAfter.status, "expired", "a reservation for another brand sweeps the feature's due holds");
      await assert.rejects(
        () => rpc("f01_expire_due_holds", { p_brand: quietBrand, p_feature: featureSweep, p_limit: 0 }),
        /1\.\.500/,
        "f01_expire_due_holds validates its limit",
      );

      // Owner review — a late settle reconciles the expired hold instead of dropping the cost.
      const lateBrand = await createBrand();
      const lateFeature = await createFeature();
      const lateHold = await reserve(lateBrand, lateFeature, 1, `late-${id()}`);
      assert.equal(lateHold.granted, true);
      await q("update spend_holds set expires_at = now() - interval '1 minute' where id=$1", [lateHold.hold_id]);
      assert.equal(
        Number(await rpc("f01_expire_due_holds", { p_brand: lateBrand, p_feature: lateFeature, p_limit: 100 })),
        1,
        "the scoped sweep expires the one due hold",
      );
      const stillReserved = (
        await q("select actual_usd, accounted_usd, cost_source from spend_ledger where source_ref=$1", [
          `hold:${lateHold.hold_id}`,
        ])
      ).rows[0];
      assert.equal(stillReserved.actual_usd, null);
      assert.equal(Number(stillReserved.accounted_usd), 1);
      assert.equal(stillReserved.cost_source, "reservation");

      const late = await rpc("settle_spend", {
        p_hold: lateHold.hold_id,
        p_costs: [{ provider: "openrouter", endpoint: "chat:qa", actual_usd: 2, cost_source: "provider_reported" }],
      });
      assert.equal(late.settled, true, "an expired hold is reconciled, not silently dropped");
      assert.equal(late.late, true);
      assert.equal(late.unknown, false);
      assert.equal(Number(late.actual_usd), 2);
      const lateRows = (
        await q(
          "select source_ref, provider, endpoint, actual_usd, accounted_usd, cost_source, meta from spend_ledger where hold_id=$1",
          [lateHold.hold_id],
        )
      ).rows;
      assert.equal(lateRows.length, 1, "a late settle re-prices the one reservation row instead of adding rows");
      assert.equal(lateRows[0].source_ref, `hold:${lateHold.hold_id}`);
      assert.equal(lateRows[0].provider, "openrouter");
      assert.equal(lateRows[0].endpoint, "chat:qa");
      assert.equal(Number(lateRows[0].actual_usd), 2);
      assert.equal(Number(lateRows[0].accounted_usd), 2);
      assert.equal(lateRows[0].cost_source, "provider_reported");
      assert.equal(lateRows[0].meta.late_settle, true);
      const settledLate = (await q("select status, actual_usd from spend_holds where id=$1", [lateHold.hold_id])).rows[0];
      assert.equal(settledLate.status, "settled");
      assert.equal(Number(settledLate.actual_usd), 2);
      const lateRepeat = await rpc("settle_spend", {
        p_hold: lateHold.hold_id,
        p_costs: [{ provider: "openrouter", endpoint: "chat:qa", actual_usd: 3, cost_source: "provider_reported" }],
      });
      assert.equal(lateRepeat.settled, false, "a late-settled hold is settled once");
      assert.equal(lateRepeat.status, "settled");

      // Owner review — a late settle with an unknown cost leaves the hold and its reservation alone.
      const unknownHold = await reserve(lateBrand, lateFeature, 1.5, `late-unknown-${id()}`);
      assert.equal(unknownHold.granted, true);
      await q("update spend_holds set expires_at = now() - interval '1 minute' where id=$1", [unknownHold.hold_id]);
      assert.equal(
        Number(await rpc("f01_expire_due_holds", { p_brand: lateBrand, p_feature: lateFeature, p_limit: 100 })),
        1,
      );
      const unknownLate = await rpc("settle_spend", {
        p_hold: unknownHold.hold_id,
        p_costs: [{ provider: "openrouter", endpoint: "chat:qa", actual_usd: null, cost_source: "provider_reported" }],
      });
      assert.equal(unknownLate.settled, false);
      assert.equal(unknownLate.status, "expired");
      assert.equal(unknownLate.unknown, true);
      assert.equal(Number(unknownLate.actual_usd), 0, "the reply carries the sum of the known costs");
      const unknownAfter = (await q("select status, actual_usd from spend_holds where id=$1", [unknownHold.hold_id])).rows[0];
      assert.equal(unknownAfter.status, "expired", "an unknown late cost leaves the hold expired");
      assert.equal(unknownAfter.actual_usd, null);
      const unknownRows = (
        await q("select provider, endpoint, actual_usd, accounted_usd, cost_source, meta from spend_ledger where hold_id=$1", [
          unknownHold.hold_id,
        ])
      ).rows;
      assert.equal(unknownRows.length, 1);
      assert.equal(unknownRows[0].provider, "unknown");
      assert.equal(unknownRows[0].endpoint, "expired_hold");
      assert.equal(unknownRows[0].actual_usd, null);
      assert.equal(Number(unknownRows[0].accounted_usd), 1.5, "the reservation keeps counting at its estimate");
      assert.equal(unknownRows[0].cost_source, "reservation");
      assert.equal(unknownRows[0].meta.expired, true);
      assert.equal(unknownRows[0].meta.late_settle, undefined);
    },
  },
  {
    name: "spend-rls",
    group: "spend",
    async run() {
      const rlsOwner = await createUser("rls-owner");
      const rlsOther = await createUser("rls-other");
      const mine = await createBrand(rlsOwner);
      const theirs = await createBrand(rlsOther);
      await q("insert into workspace_spend_limits(brand_key,daily_cap_usd,monthly_cap_usd) values($1,5,50)", [mine]);
      await q("insert into workspace_spend_limits(brand_key,daily_cap_usd,monthly_cap_usd) values($1,5,50)", [theirs]);
      const feature = await createFeature();
      const mineHold = await reserve(mine, feature, 1, `rls-${id()}`);
      const theirsHold = await reserve(theirs, feature, 1, `rls-${id()}`);
      await rpc("settle_spend", {
        p_hold: mineHold.hold_id,
        p_costs: [{ provider: "openrouter", endpoint: "chat:qa", actual_usd: 1, cost_source: "provider_reported" }],
      });
      assert.equal(
        (await q("select count(*)::int n from spend_ledger where brand_key=$1", [mine])).rows[0].n,
        1,
        "the fixture needs one settled ledger row to prove the read is filtered, not merely empty",
      );

      const read = async (user) => {
        const limits = (await asUser(user, "select brand_key from workspace_spend_limits order by brand_key")).rows.map((row) => row.brand_key);
        const holds = (await asUser(user, "select brand_key from spend_holds order by brand_key")).rows.map((row) => row.brand_key);
        const ledger = (await asUser(user, "select brand_key from spend_ledger order by brand_key")).rows.map((row) => row.brand_key);
        return { limits, holds, ledger };
      };

      assert.deepEqual(await read(rlsOwner), { limits: [mine], holds: [mine], ledger: [mine] });
      assert.deepEqual(await read(rlsOther), { limits: [theirs], holds: [theirs], ledger: [] });
      assert.equal((await q("select count(*)::int n from spend_holds where brand_key=$1", [theirs])).rows[0].n, 1);
      assert.equal(theirsHold.granted, true);

      await assert.rejects(
        () => asUser(rlsOwner, "select feature from paid_feature_controls"),
        /permission denied/,
        "paid_feature_controls is service-only",
      );
      await assert.rejects(
        () =>
          asUser(rlsOwner, "insert into spend_holds(brand_key,feature,idempotency_key,estimate_usd,expires_at) values($1,$2,'x',1,now())", [
            mine,
            feature,
          ]),
        /permission denied/,
        "customers may never write a hold",
      );
    },
  },
];

const selected = only ? GROUPS.filter((group) => group.group === only) : GROUPS;
if (only && selected.length === 0) {
  console.error(`no database groups for --only ${only}`);
  process.exit(2);
}

try {
  if (actor) {
    await q("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now()),($3,$4,now())", [
      actor,
      `qa-actor-${actor}@example.test`,
      outsider,
      `qa-outsider-${outsider}@example.test`,
    ]);
  }
  for (const group of selected) await test(group.name, group.run);
} finally {
  if (brands.length) {
    await q("update customer_brand_memberships set role='member' where brand_key = any($1)", [brands]);
    await q("delete from customer_brands where brand_key = any($1)", [brands]);
  }
  if (features.length) await q("delete from paid_feature_controls where feature = any($1)", [features]);
  await q("delete from auth.users where id = any($1)", [users]);
  await pool.end();
}

console.log(`\n${passed.length} groups passed on a loopback QA database.`);
