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

// ---- F01 phase 3: jobs fixtures -------------------------------------------
// The rows these helpers create are tracked so the cleanup below removes them
// even when a group throws halfway: a failed group must not poison the next one.
const jobIds = [];
const periodics = [];

/** `enqueue_job` with the §6.3.3 defaults; every argument is overridable. */
async function enqueueJob(overrides = {}) {
  const args = {
    p_kind: "qa.job",
    p_brand: null,
    p_payload: {},
    p_trigger: "manual",
    p_dedupe: null,
    p_single_active: null,
    p_run_at: null,
    p_created_by: null,
    p_deadline_seconds: 86_400,
    p_max_invocations: null,
    ...overrides,
  };
  if (args.p_brand === null) args.p_trigger = overrides.p_trigger ?? "system";
  const result = await rpc("enqueue_job", args);
  if (result.job_id) jobIds.push(result.job_id);
  return result;
}

/** `claim_due_jobs` is SETOF public.jobs, so it is read from the FROM clause. */
async function claimDue(owner, limit, jobId = null, leaseSeconds = 300) {
  const r = await q(
    "select * from claim_due_jobs(p_owner=>$1, p_limit=>$2, p_lease_seconds=>$3, p_job_id=>$4)",
    [owner, limit, leaseSeconds, jobId],
  );
  return r.rows;
}

const jobRow = async (jobId) => (await q("select * from jobs where id=$1", [jobId])).rows[0];
const stepRow = async (jobId, name) =>
  (await q("select * from job_steps where job_id=$1 and name=$2", [jobId, name])).rows[0];
const periodicRow = async (name) => (await q("select * from job_periodic where name=$1", [name])).rows[0];


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

// 043 installs jobs_tick_http everywhere but reads its url and secret from Vault, so the
// "not configured" branch is only reachable where a vault schema exists. CI's postgres:16
// and local QA have neither pg_cron nor vault, so the group is skipped rather than faked.
const hasVault = (await q("select count(*)::int n from pg_namespace where nspname='vault'")).rows[0].n > 0;

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

      // Owner review — the key is scoped per feature. The documented convention
      // (job:<jobId>:<stepName>) carries no feature, so a (brand, key) match alone could
      // answer one feature's reservation with another feature's hold and settle the cost
      // against the wrong feature's cap.
      const otherFeature = await createFeature();
      const sharedKey = `idem-shared-${id()}`;
      const onFirst = await reserve(brand, feature, 1, sharedKey);
      assert.equal(onFirst.granted, true);
      assert.equal(onFirst.existing, false);
      const onOther = await reserve(brand, otherFeature, 1, sharedKey);
      assert.equal(onOther.granted, true);
      assert.equal(onOther.existing, false, "the other feature's hold must not answer this reservation");
      assert.notEqual(onOther.hold_id, onFirst.hold_id);
      const scoped = (
        await q("select feature from spend_holds where id = any($1::uuid[]) order by feature", [
          [onFirst.hold_id, onOther.hold_id],
        ])
      ).rows.map((row) => row.feature);
      assert.deepEqual(scoped, [feature, otherFeature].sort(), "each hold keeps its own feature");
      const repeatOnOther = await reserve(brand, otherFeature, 1, sharedKey);
      assert.equal(repeatOnOther.existing, true, "the key still dedups within its own feature");
      assert.equal(repeatOnOther.hold_id, onOther.hold_id);
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

      // Owner review — each scope gets its own budget, so other workspaces' due holds on a
      // shared feature cannot spend the whole sweep and leave the caller's own hold counted.
      const sharedFeature = await createFeature();
      const starvedBrand = await createBrand();
      const noisyBrand = await createBrand();
      const starved = await reserve(starvedBrand, sharedFeature, 1, `starve-mine-${id()}`);
      assert.equal(starved.granted, true);
      const noisy = [];
      for (let n = 0; n < 3; n += 1) {
        const hold = await reserve(noisyBrand, sharedFeature, 1, `starve-other-${n}-${id()}`);
        assert.equal(hold.granted, true);
        noisy.push(hold.hold_id);
      }
      await q(
        "update spend_holds set expires_at = now() - interval '2 minutes' where id = any($1::uuid[])",
        [[starved.hold_id, ...noisy]],
      );
      // The caller's own hold is the newest, so a shared LIMIT 1 ordered by expires_at would
      // spend the whole budget on the other workspace and never reach it.
      assert.equal(
        Number(
          await rpc("f01_expire_due_holds", { p_brand: starvedBrand, p_feature: sharedFeature, p_limit: 1 }),
        ),
        2,
        "one budget per scope: the brand pass and the feature pass each expire a hold",
      );
      const starvedAfter = (await q("select status from spend_holds where id=$1", [starved.hold_id])).rows[0];
      assert.equal(starvedAfter.status, "expired", "the caller's own due hold is swept with the smallest budget");

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
  {
    name: "jobs-enqueue",
    group: "jobs",
    async run() {
      const brand = await createBrand();
      const dedupe = `qa-dedupe-${id()}`;

      const first = await enqueueJob({ p_kind: "qa.enqueue", p_brand: brand, p_dedupe: dedupe });
      assert.equal(first.deduped, false);
      assert.ok(first.job_id, "a fresh dedupe key creates a job");
      const second = await enqueueJob({ p_kind: "qa.enqueue", p_brand: brand, p_dedupe: dedupe });
      assert.equal(second.deduped, true);
      assert.equal(second.job_id, first.job_id, "the same dedupe key answers with the same job id");

      // jobs_dedupe_idx is (kind, brand_key, dedupe_key) with NO status predicate, so the key
      // keeps answering after the job finished — until prune_jobs removes it at 30 days. That
      // is why §6.3.6 date-scopes its dedupe keys ("jobs.retention:" + YYYY-MM-DD).
      await q("update jobs set status='completed', finished_at=now() where id=$1", [first.job_id]);
      const afterFinish = await enqueueJob({ p_kind: "qa.enqueue", p_brand: brand, p_dedupe: dedupe });
      assert.equal(afterFinish.deduped, true, "a permanent dedupe index still answers for a finished job");
      assert.equal(afterFinish.job_id, first.job_id);
      assert.equal(await q("select count(*)::int n from jobs where kind='qa.enqueue' and dedupe_key=$1", [dedupe]).then((r) => r.rows[0].n), 1);

      // jobs_single_active_idx, by contrast, IS partial: it covers queued/running only.
      const active = `qa-active-${id()}`;
      const blocker = await enqueueJob({ p_kind: "qa.enqueue", p_brand: brand, p_single_active: active });
      assert.ok(blocker.job_id);
      const conflict = await enqueueJob({ p_kind: "qa.enqueue", p_brand: brand, p_single_active: active });
      assert.equal(conflict.job_id, null);
      assert.equal(conflict.deduped, false);
      assert.equal(conflict.conflict_job_id, blocker.job_id, "the blocked enqueue names the job holding the key");

      // The key is (kind, single_active_key): another kind is another key space.
      const otherKind = await enqueueJob({ p_kind: "qa.enqueue_other", p_brand: brand, p_single_active: active });
      assert.ok(otherKind.job_id, "single-active is scoped per kind");

      await q("update jobs set status='completed', finished_at=now() where id=$1", [blocker.job_id]);
      const released = await enqueueJob({ p_kind: "qa.enqueue", p_brand: brand, p_single_active: active });
      assert.ok(released.job_id, "a finished blocker no longer holds the key");
      await q("update jobs set status='completed', finished_at=now() where id=$1", [released.job_id]);
      await q("update jobs set status='completed', finished_at=now() where id=$1", [otherKind.job_id]);
    },
  },
  {
    name: "jobs-leases",
    group: "jobs",
    async run() {
      const brand = await createBrand();
      const dueAt = new Date(Date.now() - 60_000).toISOString();
      const created = [];
      for (let n = 0; n < 6; n += 1) {
        const job = await enqueueJob({ p_kind: "qa.leases", p_brand: brand, p_run_at: dueAt });
        created.push(job.job_id);
      }

      const [firstTick, secondTick] = await Promise.all([claimDue("leases-a", 5), claimDue("leases-b", 5)]);
      const a = firstTick.map((row) => row.id);
      const b = secondTick.map((row) => row.id);
      assert.ok(a.length <= 5 && b.length <= 5, "each claim respects its limit");
      assert.equal(new Set([...a, ...b]).size, 6, `both ticks together claim all six, got ${a.length}+${b.length}`);
      assert.equal(a.filter((claimed) => b.includes(claimed)).length, 0, "SKIP LOCKED keeps the two claims disjoint");
      assert.deepEqual([...a, ...b].sort(), [...created].sort(), "every claim is one of the six due jobs");
      const claimedRows = await q("select id, invocations, lease_owner, status from jobs where id = any($1::uuid[])", [created]);
      for (const row of claimedRows.rows) {
        assert.equal(row.invocations, 1, "a row is claimed exactly once");
        assert.equal(row.status, "running");
        assert.ok(["leases-a", "leases-b"].includes(row.lease_owner));
      }

      // G8: a fenced `job_step_complete` answers false — it is `job_step_begin`'s action that
      // says lost_lease, and `job_step_fail`'s return value. Assert the SQL, not AC-20's prose.
      const leased = claimedRows.rows[0];
      const begin = await rpc("job_step_begin", {
        p_job: leased.id,
        p_owner: leased.lease_owner,
        p_name: "step-1",
        p_billed: false,
        p_max_attempts: 1,
        p_timeout_ms: 1000,
      });
      assert.equal(begin.action, "run");

      await q("update jobs set lease_until = now() - interval '1 minute' where id=$1", [leased.id]);
      const before = await jobRow(leased.id);
      const completed = await rpc("job_step_complete", {
        p_job: leased.id,
        p_owner: leased.lease_owner,
        p_name: "step-1",
        p_output: { ok: true },
        p_lease_seconds: 300,
      });
      assert.equal(completed, false, "a stale owner's step completion is refused");
      const after = await jobRow(leased.id);
      assert.equal(after.lease_until.getTime(), before.lease_until.getTime(), "a fenced write does not renew the lease");
      assert.equal(after.lease_owner, leased.lease_owner, "a fenced write does not move ownership");
      assert.equal(after.heartbeat_at.getTime(), before.heartbeat_at.getTime(), "a fenced write does not heartbeat");
      const step = await stepRow(leased.id, "step-1");
      assert.equal(step.status, "running", "the step row is untouched");
      assert.equal(step.output, null);
      assert.equal(step.finished_at, null);
    },
  },
  {
    name: "jobs-steps",
    group: "jobs",
    async run() {
      const brand = await createBrand();
      const dueAt = new Date(Date.now() - 60_000).toISOString();

      // A billed step found `running` on replay: the invocation that started it died.
      const paid = await enqueueJob({ p_kind: "qa.steps_paid", p_brand: brand, p_run_at: dueAt });
      const [paidClaim] = await claimDue("steps-owner", 1, paid.job_id);
      assert.ok(paidClaim);
      const beginArgs = {
        p_job: paid.job_id,
        p_owner: "steps-owner",
        p_name: "paid",
        p_billed: true,
        p_max_attempts: 1,
        p_timeout_ms: 1000,
      };
      const started = await rpc("job_step_begin", beginArgs);
      assert.deepEqual(started, { action: "run", attempt: 1 });
      const replay = await rpc("job_step_begin", beginArgs);
      assert.equal(replay.action, "failed");
      assert.equal(replay.error_code, "billed_step_interrupted");
      assert.match(replay.error_message, /never re-run/);
      const paidStep = await stepRow(paid.job_id, "paid");
      assert.equal(paidStep.status, "failed");
      assert.equal(paidStep.attempts, 1, "the interrupted billed step is never re-run");
      assert.equal(paidStep.output, null);
      assert.ok(paidStep.finished_at);
      assert.equal((await rpc("job_step_begin", beginArgs)).error_code, "billed_step_interrupted", "the failure is persisted");

      // A sleep returns its wake time while the wake is ahead and NULL once it has passed.
      const sleepy = await enqueueJob({ p_kind: "qa.steps_sleep", p_brand: brand, p_run_at: dueAt });
      await claimDue("steps-sleeper", 1, sleepy.job_id);
      const sleepArgs = { p_job: sleepy.job_id, p_owner: "steps-sleeper", p_name: "wait-1", p_seconds: 60 };
      const wake = await rpc("job_sleep", sleepArgs);
      assert.ok(wake instanceof Date, `job_sleep returns the wake time, got ${wake}`);
      const secondsOut = (wake.getTime() - Date.now()) / 1000;
      assert.ok(secondsOut > 55 && secondsOut <= 65, `the wake time is ~60 s out, got ${secondsOut.toFixed(1)}`);
      const sleeping = await stepRow(sleepy.job_id, "wait-1");
      assert.equal(sleeping.step_kind, "sleep");
      assert.equal(sleeping.status, "sleeping");
      assert.equal(sleeping.timeout_ms, 1);
      assert.equal(sleeping.max_attempts, 1);
      assert.equal((await rpc("job_sleep", sleepArgs)).getTime(), wake.getTime(), "the same wake time comes back early");

      await q("update job_steps set wake_at = now() - interval '1 second' where job_id=$1 and name='wait-1'", [
        sleepy.job_id,
      ]);
      assert.equal(await rpc("job_sleep", sleepArgs), null, "a wake that has passed returns NULL and continues");
      const woke = await stepRow(sleepy.job_id, "wait-1");
      assert.equal(woke.status, "completed");
      assert.equal(woke.wake_at, null);
      assert.ok(woke.finished_at);
      assert.equal(await rpc("job_sleep", sleepArgs), null, "a completed sleep keeps answering NULL");
    },
  },
  {
    name: "jobs-watchdog",
    group: "jobs",
    async run() {
      const brand = await createBrand();

      const expired = await enqueueJob({ p_kind: "qa.watchdog_deadline", p_brand: brand });
      await q("update jobs set deadline_at = now() - interval '1 minute' where id=$1", [expired.job_id]);

      const runaway = await enqueueJob({ p_kind: "qa.watchdog_invocations", p_brand: brand, p_max_invocations: 1 });
      await claimDue("watchdog-runaway", 1, runaway.job_id);
      await q("update jobs set lease_until = now() - interval '1 minute' where id=$1", [runaway.job_id]);

      // The bad row: stale by deadline but still leased. It must be left alone AND must not
      // stop the two sweeps reaching the rows above it.
      const leased = await enqueueJob({ p_kind: "qa.watchdog_leased", p_brand: brand });
      await claimDue("watchdog-leased", 1, leased.job_id);
      await q("update jobs set deadline_at = now() - interval '1 minute' where id=$1", [leased.job_id]);

      const report = await rpc("reconcile_stale_jobs", { p_limit: 100 });
      assert.ok(Number(report.deadline_exceeded) >= 1, `the deadline sweep reports a failure, got ${report.deadline_exceeded}`);
      assert.ok(Number(report.invocation_limit) >= 1, `the invocation sweep reports a failure, got ${report.invocation_limit}`);

      const expiredRow = await jobRow(expired.job_id);
      assert.equal(expiredRow.status, "failed");
      assert.equal(expiredRow.error_code, "deadline_exceeded");
      assert.ok(expiredRow.finished_at);
      assert.equal(expiredRow.lease_owner, null);

      const runawayRow = await jobRow(runaway.job_id);
      assert.equal(runawayRow.status, "failed");
      assert.equal(runawayRow.error_code, "invocation_limit");
      assert.ok(runawayRow.finished_at);

      const leasedRow = await jobRow(leased.job_id);
      assert.equal(leasedRow.status, "running", "a live lease protects a row past its deadline");
      assert.equal(leasedRow.error_code, null);
      assert.equal(leasedRow.lease_owner, "watchdog-leased");
    },
  },
  {
    name: "jobs-cancel",
    group: "jobs",
    async run() {
      const brand = await createBrand();

      const queued = await enqueueJob({ p_kind: "qa.cancel_queued", p_brand: brand });
      assert.equal(await rpc("cancel_job", { p_job: queued.job_id }), "cancelled");
      const queuedRow = await jobRow(queued.job_id);
      assert.equal(queuedRow.status, "cancelled", "a queued job is cancelled at once");
      assert.ok(queuedRow.cancel_requested_at);
      assert.ok(queuedRow.finished_at);
      assert.equal(queuedRow.error_code, "cancelled");
      assert.equal(await rpc("cancel_job", { p_job: queued.job_id }), "cancelled", "a repeat returns the current status");

      const running = await enqueueJob({ p_kind: "qa.cancel_running", p_brand: brand });
      await claimDue("cancel-owner", 1, running.job_id);
      assert.equal(await rpc("cancel_job", { p_job: running.job_id }), "cancel_requested");
      const runningRow = await jobRow(running.job_id);
      assert.equal(runningRow.status, "running", "a live lease leaves the status to the runner");
      assert.ok(runningRow.cancel_requested_at, "the request is recorded");
      const requestedAt = runningRow.cancel_requested_at.getTime();
      assert.equal(await rpc("cancel_job", { p_job: running.job_id }), "cancel_requested");
      assert.equal(
        (await jobRow(running.job_id)).cancel_requested_at.getTime(),
        requestedAt,
        "a repeat keeps the first request's timestamp",
      );

      const terminal = await enqueueJob({ p_kind: "qa.cancel_terminal", p_brand: brand });
      await q("update jobs set status='completed', finished_at=now() where id=$1", [terminal.job_id]);
      assert.equal(await rpc("cancel_job", { p_job: terminal.job_id }), "completed");
      assert.equal((await jobRow(terminal.job_id)).status, "completed", "cancelling never rewrites a terminal row");

      assert.equal(await rpc("cancel_job", { p_job: id() }), "not_found", "an unknown id is a 404 upstairs");
    },
  },
  {
    name: "jobs-periodic",
    group: "jobs",
    async run() {
      const name = `qa.periodic_${id().replace(/-/g, "")}`;
      periodics.push(name);
      const now = new Date();
      const args = (at) => ({ p_name: name, p_interval_seconds: 3600, p_now: at.toISOString() });

      const claims = await Promise.all([rpc("claim_due_periodic", args(now)), rpc("claim_due_periodic", args(now))]);
      assert.equal(claims.filter((claimed) => claimed === true).length, 1, "exactly one of two concurrent claims wins");
      assert.equal(claims.filter((claimed) => claimed === false).length, 1);

      const row = await periodicRow(name);
      assert.equal(row.next_run_at.getTime(), now.getTime() + 3_600_000, "the next slot is advanced by claim time");
      assert.equal(row.last_started_at.getTime(), now.getTime(), "last_started_at is the claimed slot");
      assert.equal(row.last_error, null);
      assert.equal(await rpc("claim_due_periodic", args(now)), false, "the advanced slot is not claimable at the same instant");

      // Five missed slots collapse into one catch-up run, then land on the next slot.
      const later = new Date(now.getTime() + 5 * 3_600_000);
      assert.equal(await rpc("claim_due_periodic", args(later)), true);
      const collapsed = await periodicRow(name);
      assert.equal(collapsed.next_run_at.getTime(), later.getTime() + 3_600_000);
      assert.equal(collapsed.last_started_at.getTime(), later.getTime());
    },
  },
  {
    name: "jobs-cron",
    group: "jobs",
    skip: hasVault
      ? null
      : "this database has no vault schema, so the vault/NOTICE path cannot be reached (CI and local QA have neither pg_cron nor vault)",
    async run() {
      // With the vault present but its two secrets absent, 043's function must say so in a
      // NOTICE and return NULL rather than raise from inside pg_cron.
      const client = await pool.connect();
      const notices = [];
      const onNotice = (notice) => notices.push(notice.message);
      client.on("notice", onNotice);
      let result;
      try {
        result = (await client.query("select public.jobs_tick_http() result")).rows[0].result;
      } finally {
        client.off("notice", onNotice);
        client.release();
      }
      assert.equal(result, null, "no url/secret in vault means no request is fired");
      assert.ok(
        notices.some((message) => message.includes("jobs tick not configured")),
        `expected 043's NOTICE, got ${JSON.stringify(notices)}`,
      );
    },
  },
];

const selected = only ? GROUPS.filter((group) => group.group === only) : GROUPS;
if (only && selected.length === 0) {
  console.error(`no database groups for --only ${only}`);
  process.exit(2);
}

const skipped = [];

try {
  if (actor) {
    await q("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now()),($3,$4,now())", [
      actor,
      `qa-actor-${actor}@example.test`,
      outsider,
      `qa-outsider-${outsider}@example.test`,
    ]);
  }
  // A run that died before its own finally leaves qa.* jobs behind. jobs-leases has to know
  // that every due row belongs to its six, so leftovers are cleared up front.
  await q("delete from jobs where kind like 'qa.%'");
  await q("delete from job_periodic where name like 'qa.%'");
  for (const group of selected) {
    if (group.skip) {
      skipped.push(group.name);
      console.log("SKIP " + group.name + " — " + group.skip);
      continue;
    }
    await test(group.name, group.run);
  }
} finally {
  if (jobIds.length) await q("delete from jobs where id = any($1::uuid[])", [jobIds]);
  if (periodics.length) await q("delete from job_periodic where name = any($1)", [periodics]);
  if (brands.length) {
    await q("update customer_brand_memberships set role='member' where brand_key = any($1)", [brands]);
    await q("delete from customer_brands where brand_key = any($1)", [brands]);
  }
  if (features.length) await q("delete from paid_feature_controls where feature = any($1)", [features]);
  await q("delete from auth.users where id = any($1)", [users]);
  await pool.end();
}

console.log(
  `\n${passed.length} groups passed on a loopback QA database.` +
    (skipped.length ? ` ${skipped.length} skipped: ${skipped.join(", ")}.` : ""),
);
