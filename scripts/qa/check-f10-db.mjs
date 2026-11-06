#!/usr/bin/env node
/**
 * F10 database harness (customer-managed scan schedules, migration 085):
 *   1. schema   (F10-AC-03)
 *   2. legacy   (032 behaviour on operator rows is unchanged)
 *   3. start    (F10-AC-08)
 *   4. race     (F10-AC-08)
 *   5. overlap  (F10-AC-09)
 *   6. skip-panel (F10-AC-07, database half)
 *   7. block    (F10-AC-07, database half)
 *   8. pause    (F10-AC-05, database half)
 *   9. guards   (review fixes: approval cap, missed-window range, legacy-job
 *               overlap, block due/already-recorded, missed count)
 *
 * Runs against a disposable loopback PostgreSQL database that has every
 * migration applied. Every group seeds its own workspace under a fresh random
 * brand key, so nothing here assumes an empty database or reads a global count.
 * probe_dispatch_control is never written: nothing in migration 085 reads it
 * (the pause and allow-list checks are TypeScript).
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { artifactHash, validatePanel } from "../../src/lib/repairs/workflow.js";
import {
  SCHEDULES_TICK_KIND,
  registerAiVisibilityScheduleJobs,
  resetAiVisibilityScheduleJobDeps,
} from "../../src/lib/schedules/aiVisibilitySchedules.jobs.ts";
import { getJobDefinition } from "../../src/lib/jobs/registry.ts";

const host = process.env.PGHOST || "";
const database = process.env.PGDATABASE || "";
if (
  !["localhost", "127.0.0.1", "::1"].includes(host) ||
  !/(?:_qa|_uat)$/.test(database) ||
  process.env.DATABASE_URL
) {
  throw new Error(
    "F10 database tests require explicit loopback PGHOST and disposable *_qa/*_uat PGDATABASE; DATABASE_URL is refused",
  );
}

const pool = new pg.Pool({ max: 16 });
const passed = [];
const query = (sql, values = []) => pool.query(sql, values);
const id = () => crypto.randomUUID();
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

const groupFlagIdx = process.argv.indexOf("--group");
const targetGroup = groupFlagIdx !== -1 ? process.argv[groupFlagIdx + 1] : null;

async function runGroup(groupName, fn) {
  if (targetGroup && targetGroup !== groupName) return;
  await fn();
  passed.push(groupName);
  console.log(`PASS ${groupName}`);
}

const START_SQL =
  "SELECT public.start_customer_window($1, $2::timestamptz, $3::timestamptz, $4::timestamptz, $5::timestamptz[], $6::timestamptz, $7::uuid, $8::numeric, $9::jsonb) AS result";
const BLOCK_SQL =
  "SELECT public.block_customer_window($1, $2::timestamptz, $3::timestamptz, $4::timestamptz, $5::timestamptz[], $6::timestamptz, $7) AS result";

/** Named arguments for the two window functions; defaults describe one due, valid window. */
function plan(brand, overrides = {}) {
  const now = Date.now();
  const observed = now - 2 * DAY;
  return {
    brand,
    now: iso(now),
    observed: iso(observed),
    windowAt: iso(observed),
    missed: [],
    next: iso(observed + DAY),
    jobId: id(),
    max: 1.5,
    quote: { total_usd: 1.25, lines: [{ engine: "qa", usd: 1.25 }] },
    reason: "price_changed",
    ...overrides,
  };
}

async function start(p, client = pool) {
  const r = await client.query(START_SQL, [
    p.brand,
    p.now,
    p.observed,
    p.windowAt,
    p.missed,
    p.next,
    p.jobId,
    p.max,
    p.quote === null ? null : JSON.stringify(p.quote),
  ]);
  return r.rows[0].result;
}

async function block(p, client = pool) {
  const r = await client.query(BLOCK_SQL, [
    p.brand,
    p.now,
    p.observed,
    p.windowAt,
    p.missed,
    p.next,
    p.reason,
  ]);
  return r.rows[0].result;
}

async function createUser(email) {
  const userId = id();
  await query(
    "INSERT INTO auth.users(id, email, email_confirmed_at) VALUES($1, $2, now()) ON CONFLICT (id) DO NOTHING",
    [userId, email],
  );
  return userId;
}

/**
 * A workspace plus, optionally, an approved panel/default head.
 * workspace: 'active' (default), 'inactive' (is_active = false) or 'none' (no customer_brands row).
 */
async function seedWorkspace(
  suffix,
  { workspace = "active", panel = true, actorId = null } = {},
) {
  const brand = `qa-f10-${suffix}-${id()}.example`;
  if (workspace !== "none") {
    await query(
      "INSERT INTO public.customer_brands(brand_key, display_name, website, website_host, aliases, is_active) VALUES($1, $2, $3, $4, $5, $6)",
      [brand, `F10 ${suffix}`, `https://owned-${brand}`, brand, [], workspace === "active"],
    );
  }
  let panelPayload = null;
  if (panel) {
    const actor = actorId || (await createUser(`f10-${suffix}-${id()}@example.com`));
    panelPayload = validatePanel({
      persona: "QA buyers",
      context: { country: "in" },
      prompts: Array.from({ length: 30 }, (_, i) => ({
        text: `Which provider serves sector ${i} buyers?`,
        duplicate_reason: "Distinct fixture segment",
        origin: "manual",
      })),
    });
    await query(
      "INSERT INTO public.customer_brand_memberships(user_id, brand_key, role) VALUES($1, $2, 'owner')",
      [actor, brand],
    );
    await query(
      "SELECT append_repair_artifact(p_brand=>$1, p_kind=>'panel', p_key=>'default', p_expected=>0, p_state=>'approved', p_payload=>$2::jsonb, p_hash=>$3, p_actor=>$4)",
      [brand, JSON.stringify(panelPayload), artifactHash(panelPayload), actor],
    );
  }
  return { brand, panelPayload };
}

async function insertSchedule(
  brand,
  {
    managedBy = "customer",
    interval = "daily",
    max = 1.5,
    enabled = true,
    next = Date.now() - 2 * DAY,
    cadence = "daily",
    lastSkipReason = null,
    lastSkipAt = null,
  } = {},
) {
  await query(
    `INSERT INTO public.scan_schedules(brand, display_name, cadence, enabled, next_run_at, managed_by, schedule_interval, approved_max_usd, last_skip_reason, last_skip_at)
     VALUES($1, $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [brand, cadence, enabled, iso(next), managedBy, interval, max, lastSkipReason, lastSkipAt],
  );
}

const schedule = async (brand) =>
  (await query("SELECT * FROM public.scan_schedules WHERE brand = $1", [brand])).rows[0];
const windows = async (brand) =>
  (
    await query(
      "SELECT * FROM public.measurement_windows WHERE brand = $1 ORDER BY window_at",
      [brand],
    )
  ).rows;
const jobs = async (brand) =>
  (await query("SELECT * FROM public.scan_jobs WHERE brand_key = $1", [brand])).rows;
const ms = (value) => new Date(value).getTime();

async function approvedHeadPanel(brand) {
  const r = await query(
    `SELECT to_jsonb(a) AS panel FROM public.repair_artifact_heads h JOIN public.repair_artifacts a ON a.id = h.artifact_id
      WHERE h.brand = $1 AND h.kind = 'panel' AND h.artifact_key = 'default' AND a.state = 'approved'`,
    [brand],
  );
  return r.rows[0].panel;
}

const isCheckViolation = (error) =>
  error.code === "23514" && error.constraint === "scan_schedules_f10_checks";

try {
  // -------------------------------------------------------------------------
  // Group 1: schema (F10-AC-03)
  // -------------------------------------------------------------------------
  await runGroup("schema", async () => {
    const { brand } = await seedWorkspace("schema", { panel: false });
    const insertRaw = (managedBy, interval, max) =>
      query(
        "INSERT INTO public.scan_schedules(brand, display_name, cadence, enabled, next_run_at, managed_by, schedule_interval, approved_max_usd) VALUES($1, $1, 'daily', true, now() - interval '2 days', $2, $3, $4)",
        [`${brand}-${id()}`, managedBy, interval, max],
      );

    // A customer row needs an interval and an approved maximum.
    await assert.rejects(insertRaw("customer", null, 1.5), isCheckViolation);
    await assert.rejects(insertRaw("customer", "daily", null), isCheckViolation);
    await assert.rejects(insertRaw("customer", null, null), isCheckViolation);
    // The vocabulary and range checks hold too.
    await assert.rejects(insertRaw("superuser", "daily", 1.5), isCheckViolation);
    await assert.rejects(insertRaw("customer", "hourly", 1.5), isCheckViolation);
    await assert.rejects(insertRaw("customer", "daily", 0), isCheckViolation);
    await assert.rejects(
      query(
        "INSERT INTO public.scan_schedules(brand, display_name, cadence, managed_by, schedule_interval, approved_max_usd, last_skip_reason) VALUES($1, $1, 'daily', 'customer', 'daily', 1, 'Not Closed Vocabulary')",
        [`${brand}-${id()}`],
      ),
      isCheckViolation,
    );
    // An operator row keeps working without either value (the legacy default).
    await query(
      "INSERT INTO public.scan_schedules(brand, display_name, cadence) VALUES($1, $1, 'daily')",
      [`${brand}-${id()}`],
    );
    assert.equal(
      (await query("SELECT count(*)::int AS n FROM public.scan_schedules WHERE brand LIKE $1 AND managed_by = 'operator'", [`${brand}-%`])).rows[0].n,
      1,
    );

    // A complete customer row is accepted and the legacy function refuses it.
    const dueAt = Date.now() - 2 * DAY;
    await insertSchedule(brand, { next: dueAt });
    const result = (
      await query("SELECT enqueue_measurement_window($1, now()) AS result", [brand])
    ).rows[0].result;
    assert.deepEqual(result, { started: false, reason: "customer_managed" });
    assert.equal((await windows(brand)).length, 0);
    assert.equal((await jobs(brand)).length, 0);
    assert.equal(ms((await schedule(brand)).next_run_at), dueAt);

    // Grants: only the service role may call the three functions.
    const startSig =
      "public.start_customer_window(text,timestamptz,timestamptz,timestamptz,timestamptz[],timestamptz,uuid,numeric,jsonb)";
    const blockSig =
      "public.block_customer_window(text,timestamptz,timestamptz,timestamptz,timestamptz[],timestamptz,text)";
    for (const sig of [startSig, blockSig, "public.enqueue_measurement_window(text,timestamptz)"]) {
      for (const role of ["anon", "authenticated"]) {
        const r = await query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, sig]);
        assert.equal(r.rows[0].ok, false, `${role} must not execute ${sig}`);
      }
      const r = await query("SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok", [sig]);
      assert.equal(r.rows[0].ok, true, `service_role must execute ${sig}`);
    }

    // Read-only: the dispatch control singleton exists. This harness never writes it.
    const control = await query(
      "SELECT count(*)::int AS n FROM public.probe_dispatch_control WHERE singleton = true",
    );
    assert.equal(control.rows[0].n, 1);
  });

  // -------------------------------------------------------------------------
  // Group 2: legacy (the 032 R11-D assertions on an operator row)
  // -------------------------------------------------------------------------
  await runGroup("legacy", async () => {
    const { brand } = await seedWorkspace("legacy");
    await query(
      "INSERT INTO public.scan_schedules(brand, display_name, cadence, enabled, next_run_at) VALUES($1, $1, 'daily', true, $2)",
      [brand, iso(Date.now() - 3 * DAY)],
    );
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        query("SELECT enqueue_measurement_window($1, $2::timestamptz) AS result", [
          brand,
          new Date().toISOString(),
        ]).then((r) => r.rows[0].result),
      ),
    );
    assert.equal(results.filter((r) => r.started).length, 1);
    const rows = await windows(brand);
    assert.equal(rows.length, 4);
    assert.equal(rows.filter((r) => r.disposition === "missed").length, 3);
    assert.equal(rows.filter((r) => r.disposition === "started").length, 1);
    const job = (
      await query("SELECT * FROM public.scan_jobs WHERE id = $1", [
        rows.find((r) => r.job_id).job_id,
      ])
    ).rows[0];
    assert.equal(job.panel_snapshot.version, 1);
    assert.equal(job.measurement_context.country, "in");
    assert.equal(job.url, `https://owned-${brand}`);
    assert.equal((await schedule(brand)).managed_by, "operator");

    // An operator row without an approved panel is still recorded as blocked.
    const bare = await seedWorkspace("legacy-nopanel", { panel: false });
    await query(
      "INSERT INTO public.scan_schedules(brand, display_name, cadence, enabled, next_run_at) VALUES($1, $1, 'daily', true, $2)",
      [bare.brand, iso(Date.now() - 60_000)],
    );
    const blocked = (
      await query("SELECT enqueue_measurement_window($1, now()) AS result", [bare.brand])
    ).rows[0].result;
    assert.equal(blocked.reason, "reviewed_panel_required");
    assert.equal((await windows(bare.brand))[0].disposition, "blocked");

    // A row that is not due is untouched.
    const future = await seedWorkspace("legacy-future", { panel: false });
    await query(
      "INSERT INTO public.scan_schedules(brand, display_name, cadence, enabled, next_run_at) VALUES($1, $1, 'daily', true, now() + interval '1 day')",
      [future.brand],
    );
    assert.deepEqual(
      (await query("SELECT enqueue_measurement_window($1, now()) AS result", [future.brand])).rows[0].result,
      { started: false, reason: "not_due" },
    );
  });

  // -------------------------------------------------------------------------
  // Group 3: start (F10-AC-08)
  // -------------------------------------------------------------------------
  await runGroup("start", async () => {
    const { brand } = await seedWorkspace("start");
    const observed = Date.now() - 3 * DAY;
    const staleAt = Date.now() - 3600_000;
    await insertSchedule(brand, {
      next: observed,
      lastSkipReason: "price_changed",
      lastSkipAt: iso(staleAt),
    });
    const missedAt = iso(observed);
    const windowAt = iso(observed + DAY);
    const p = plan(brand, {
      observed: iso(observed),
      windowAt,
      missed: [missedAt],
      next: iso(observed + 2 * DAY),
    });
    const result = await start(p);
    assert.equal(result.started, true);
    assert.equal(result.job_id, p.jobId);
    assert.equal(ms(result.window_at), ms(windowAt));
    assert.equal(result.missed, 1);

    const rows = await jobs(brand);
    assert.equal(rows.length, 1);
    const job = rows[0];
    const panel = await approvedHeadPanel(brand);
    assert.equal(job.id, p.jobId);
    assert.equal(job.brand_key, brand);
    assert.equal(job.status, "pending");
    assert.equal(job.query_source, "reviewed_panel");
    assert.equal(job.url, `https://owned-${brand}`);
    assert.equal(job.brand, "F10 start");
    assert.deepEqual(job.panel_snapshot, panel);
    assert.equal(job.measurement_context.country, "in");
    assert.equal(Number(job.approved_max_usd), p.max);
    assert.deepEqual(job.price_quote, p.quote);

    const ledger = await windows(brand);
    assert.equal(ledger.length, 2);
    const missed = ledger.find((w) => w.disposition === "missed");
    assert.equal(ms(missed.window_at), ms(missedAt));
    assert.equal(missed.reason, "bounded_catchup_elapsed");
    const started = ledger.filter((w) => w.disposition === "started");
    assert.equal(started.length, 1);
    assert.equal(started[0].job_id, p.jobId);
    assert.equal(ms(started[0].window_at), ms(windowAt));
    assert.deepEqual(started[0].panel_snapshot, panel);

    const row = await schedule(brand);
    assert.equal(ms(row.next_run_at), ms(p.next));
    assert.equal(ms(row.last_run_at), ms(p.now));
    assert.equal(row.last_skip_reason, null);
    assert.equal(row.last_skip_at, null);

    // The same window again (a second tick) creates nothing.
    const again = await start({ ...p, jobId: id() });
    assert.deepEqual(again, { started: false, reason: "not_due" });
    assert.equal((await jobs(brand)).length, 1);
    assert.equal((await windows(brand)).length, 2);

    // A window recorded for the observed time already advances the schedule and starts nothing.
    const dup = await seedWorkspace("start-dup");
    const dupAt = Date.now() - 2 * DAY;
    await insertSchedule(dup.brand, { next: dupAt });
    await query(
      "INSERT INTO public.measurement_windows(brand, window_at, disposition, reason) VALUES($1, $2, 'missed', 'bounded_catchup_elapsed')",
      [dup.brand, iso(dupAt)],
    );
    const dp = plan(dup.brand, { observed: iso(dupAt), windowAt: iso(dupAt), next: iso(dupAt + DAY) });
    assert.deepEqual(await start(dp), { started: false, reason: "already_recorded" });
    assert.equal(ms((await schedule(dup.brand)).next_run_at), dupAt + DAY);
    assert.equal((await jobs(dup.brand)).length, 0);

    // A window in the future is not due, and bad arguments are refused.
    const fut = await seedWorkspace("start-future");
    const futAt = Date.now() - 2 * DAY;
    await insertSchedule(fut.brand, { next: futAt });
    const early = plan(fut.brand, {
      observed: iso(futAt),
      windowAt: iso(Date.now() + DAY),
      next: iso(Date.now() + 2 * DAY),
    });
    assert.deepEqual(await start(early), { started: false, reason: "not_due" });
    for (const bad of [
      { next: iso(futAt) },
      { max: 0 },
      { max: null },
      { jobId: null },
    ]) {
      await assert.rejects(
        start({ ...plan(fut.brand, { observed: iso(futAt), windowAt: iso(futAt) }), ...bad }),
        /invalid customer window/,
      );
    }
    assert.equal((await jobs(fut.brand)).length, 0);
    assert.equal(ms((await schedule(fut.brand)).next_run_at), futAt);
  });

  // -------------------------------------------------------------------------
  // Group 4: race (F10-AC-08)
  // -------------------------------------------------------------------------
  await runGroup("race", async () => {
    for (const callers of [2, 2, 2, 8]) {
      const { brand } = await seedWorkspace(`race-${callers}`);
      const observed = Date.now() - 2 * DAY;
      await insertSchedule(brand, { next: observed });
      const results = await Promise.all(
        Array.from({ length: callers }, () =>
          start(plan(brand, { observed: iso(observed), windowAt: iso(observed), next: iso(observed + DAY) })),
        ),
      );
      assert.equal(results.filter((r) => r.started === true).length, 1);
      assert.equal(results.filter((r) => r.started === false && r.reason === "not_due").length, callers - 1);
      assert.equal((await jobs(brand)).length, 1);
      const started = (await windows(brand)).filter((w) => w.disposition === "started");
      assert.equal(started.length, 1);
      assert.equal(started[0].job_id, (await jobs(brand))[0].id);
    }
  });

  // -------------------------------------------------------------------------
  // Group 5: overlap (F10-AC-09, active job path)
  // -------------------------------------------------------------------------
  await runGroup("overlap", async () => {
    const { brand } = await seedWorkspace("overlap");
    const observed = Date.now() - 2 * DAY;
    await insertSchedule(brand, { next: observed });
    const activeId = id();
    await query(
      "INSERT INTO public.scan_jobs(id, brand, brand_key, url, status) VALUES($1, 'F10 overlap', $2, 'https://example.com', 'probing')",
      [activeId, brand],
    );
    const p = plan(brand, { observed: iso(observed), windowAt: iso(observed), next: iso(observed + DAY) });
    assert.deepEqual(await start(p), { started: false, reason: "active_scan_overlap" });
    const ledger = await windows(brand);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].disposition, "overlap");
    assert.equal(ledger[0].reason, "active_scan_overlap");
    assert.equal(ms(ledger[0].window_at), observed);
    assert.equal(ledger[0].job_id, null);
    const row = await schedule(brand);
    assert.equal(ms(row.next_run_at), ms(p.next));
    assert.equal(row.last_skip_reason, "active_scan_overlap");
    assert.equal(ms(row.last_skip_at), ms(p.now));
    const all = await jobs(brand);
    assert.equal(all.length, 1);
    assert.equal(all[0].id, activeId);
  });

  // -------------------------------------------------------------------------
  // Group 6: skip-panel (F10-AC-07, database half)
  // -------------------------------------------------------------------------
  await runGroup("skip-panel", async () => {
    const { brand } = await seedWorkspace("skip-panel", { panel: false });
    const observed = Date.now() - 2 * DAY;
    await insertSchedule(brand, { next: observed });
    const p = plan(brand, { observed: iso(observed), windowAt: iso(observed), next: iso(observed + DAY) });
    assert.deepEqual(await start(p), { started: false, reason: "panel_not_approved" });
    const ledger = await windows(brand);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].disposition, "blocked");
    assert.equal(ledger[0].reason, "panel_not_approved");
    const row = await schedule(brand);
    assert.equal(row.last_skip_reason, "panel_not_approved");
    assert.equal(ms(row.last_skip_at), ms(p.now));
    assert.equal(ms(row.next_run_at), ms(p.next));
    assert.equal((await jobs(brand)).length, 0);

    // An inactive workspace, or none at all, is workspace_inactive the same way.
    for (const workspace of ["inactive", "none"]) {
      const w = await seedWorkspace(`skip-${workspace}`, { workspace, panel: false });
      await insertSchedule(w.brand, { next: observed });
      const wp = plan(w.brand, { observed: iso(observed), windowAt: iso(observed), next: iso(observed + DAY) });
      assert.deepEqual(await start(wp), { started: false, reason: "workspace_inactive" });
      const wl = await windows(w.brand);
      assert.equal(wl.length, 1);
      assert.equal(wl[0].disposition, "blocked");
      assert.equal(wl[0].reason, "workspace_inactive");
      assert.equal((await schedule(w.brand)).last_skip_reason, "workspace_inactive");
      assert.equal((await jobs(w.brand)).length, 0);
    }
  });

  // -------------------------------------------------------------------------
  // Group 7: block (F10-AC-07, database half)
  // -------------------------------------------------------------------------
  await runGroup("block", async () => {
    const { brand } = await seedWorkspace("block", { panel: false });
    const observed = Date.now() - 3 * DAY;
    await insertSchedule(brand, { next: observed });
    const missedAt = iso(observed);
    const windowAt = iso(observed + DAY);
    const p = plan(brand, {
      observed: iso(observed),
      windowAt,
      missed: [missedAt],
      next: iso(observed + 2 * DAY),
      reason: "price_changed",
    });
    assert.deepEqual(await block(p), { blocked: true, reason: "price_changed" });
    const ledger = await windows(brand);
    assert.equal(ledger.length, 2);
    const blocked = ledger.find((w) => w.disposition === "blocked");
    assert.equal(blocked.reason, "price_changed");
    assert.equal(ms(blocked.window_at), ms(windowAt));
    assert.equal(ledger.find((w) => w.disposition === "missed").reason, "bounded_catchup_elapsed");
    const row = await schedule(brand);
    assert.equal(row.last_skip_reason, "price_changed");
    assert.equal(ms(row.last_skip_at), ms(p.now));
    assert.equal(ms(row.next_run_at), ms(p.next));
    assert.equal((await jobs(brand)).length, 0);

    // A stale observed time is not due: no window, no change.
    const stale = await seedWorkspace("block-stale", { panel: false });
    const staleNext = Date.now() - 2 * DAY;
    await insertSchedule(stale.brand, { next: staleNext });
    const sp = plan(stale.brand, {
      observed: iso(staleNext - 3600_000),
      windowAt: iso(staleNext),
      next: iso(staleNext + DAY),
    });
    assert.deepEqual(await block(sp), { blocked: false, reason: "not_due" });
    assert.equal((await windows(stale.brand)).length, 0);
    const untouched = await schedule(stale.brand);
    assert.equal(ms(untouched.next_run_at), staleNext);
    assert.equal(untouched.last_skip_reason, null);
    assert.equal(untouched.last_skip_at, null);

    // The reason is a closed vocabulary shape; dates must move forward.
    const fresh = plan(stale.brand, { observed: iso(staleNext), windowAt: iso(staleNext), next: iso(staleNext + DAY) });
    await assert.rejects(block({ ...fresh, reason: "Bad Reason" }), /invalid customer window/);
    await assert.rejects(block({ ...fresh, reason: null }), /invalid customer window/);
    await assert.rejects(block({ ...fresh, next: fresh.windowAt }), /invalid customer window/);
    assert.equal((await windows(stale.brand)).length, 0);
  });

  // -------------------------------------------------------------------------
  // Group 8: pause (F10-AC-05, database half)
  // -------------------------------------------------------------------------
  await runGroup("pause", async () => {
    const { brand } = await seedWorkspace("pause");
    const observed = Date.now() - 2 * DAY;
    await insertSchedule(brand, { next: observed, enabled: false });
    const p = plan(brand, { observed: iso(observed), windowAt: iso(observed), next: iso(observed + DAY) });
    assert.deepEqual(await start(p), { started: false, reason: "not_due" });
    assert.deepEqual(await block(p), { blocked: false, reason: "not_due" });
    assert.equal((await windows(brand)).length, 0);
    assert.equal((await jobs(brand)).length, 0);
    const row = await schedule(brand);
    assert.equal(ms(row.next_run_at), observed);
    assert.equal(row.last_skip_reason, null);
    assert.equal(row.enabled, false);
  });

  // -------------------------------------------------------------------------
  // Group 9: guards (review fixes on start/block)
  // -------------------------------------------------------------------------
  await runGroup("guards", async () => {
    // A job cap above the schedule's current approval reads as a stale plan.
    const cap = await seedWorkspace("guard-cap");
    const capAt = Date.now() - 2 * DAY;
    await insertSchedule(cap.brand, { next: capAt, max: 1 });
    const capPlan = plan(cap.brand, { observed: iso(capAt), windowAt: iso(capAt), next: iso(capAt + DAY), max: 1.5 });
    assert.deepEqual(await start(capPlan), { started: false, reason: "not_due" });
    assert.equal((await jobs(cap.brand)).length, 0);
    assert.equal((await windows(cap.brand)).length, 0);
    const okCap = await start({ ...capPlan, max: 1 });
    assert.equal(okCap.started, true);
    assert.equal(Number((await jobs(cap.brand))[0].approved_max_usd), 1);

    // Missed windows outside [observed, window_at) are refused by both functions.
    const rng = await seedWorkspace("guard-missed", { panel: false });
    const rngAt = Date.now() - 3 * DAY;
    await insertSchedule(rng.brand, { next: rngAt });
    const rngPlan = plan(rng.brand, { observed: iso(rngAt), windowAt: iso(rngAt + DAY), next: iso(rngAt + 2 * DAY) });
    for (const missed of [[iso(rngAt + DAY)], [iso(rngAt - DAY)], [iso(Date.now() + DAY)]]) {
      await assert.rejects(start({ ...rngPlan, missed }), /invalid customer window/);
      await assert.rejects(block({ ...rngPlan, missed }), /invalid customer window/);
    }
    assert.equal((await windows(rng.brand)).length, 0);

    // Block refuses a window that is not yet due.
    const futureBlock = { ...rngPlan, windowAt: iso(Date.now() + DAY), next: iso(Date.now() + 2 * DAY) };
    assert.deepEqual(await block(futureBlock), { blocked: false, reason: "not_due" });
    assert.equal((await windows(rng.brand)).length, 0);

    // Block does not report a window that is already in the ledger as blocked.
    const rec = await seedWorkspace("guard-recorded", { panel: false });
    const recAt = Date.now() - 2 * DAY;
    await insertSchedule(rec.brand, { next: recAt });
    await query(
      "INSERT INTO public.measurement_windows(brand, window_at, disposition, reason) VALUES($1, $2, 'missed', 'bounded_catchup_elapsed')",
      [rec.brand, iso(recAt)],
    );
    const recPlan = plan(rec.brand, { observed: iso(recAt), windowAt: iso(recAt), next: iso(recAt + DAY) });
    assert.deepEqual(await block(recPlan), { blocked: false, reason: "already_recorded" });
    const recRow = await schedule(rec.brand);
    assert.equal(recRow.last_skip_reason, null);
    assert.equal(ms(recRow.next_run_at), ms(recPlan.next));
    assert.equal((await windows(rec.brand)).length, 1);

    // A running legacy job with a NULL brand_key for the same site counts as overlap.
    const leg = await seedWorkspace("guard-legacy-overlap");
    const legAt = Date.now() - 2 * DAY;
    await insertSchedule(leg.brand, { next: legAt });
    const { display_name: legName } = (
      await query("SELECT display_name FROM public.customer_brands WHERE brand_key = $1", [leg.brand])
    ).rows[0];
    await query(
      "INSERT INTO public.scan_jobs(id, brand, brand_key, url, status) VALUES($1, $2, NULL, 'https://example.com', 'probing')",
      [id(), legName.toUpperCase()],
    );
    const legPlan = plan(leg.brand, { observed: iso(legAt), windowAt: iso(legAt), next: iso(legAt + DAY) });
    assert.deepEqual(await start(legPlan), { started: false, reason: "active_scan_overlap" });

    // `missed` counts rows written, not the array passed in.
    const cnt = await seedWorkspace("guard-count");
    const cntAt = Date.now() - 3 * DAY;
    await insertSchedule(cnt.brand, { next: cntAt });
    await query(
      "INSERT INTO public.measurement_windows(brand, window_at, disposition, reason) VALUES($1, $2, 'missed', 'bounded_catchup_elapsed')",
      [cnt.brand, iso(cntAt)],
    );
    const cntResult = await start(
      plan(cnt.brand, { observed: iso(cntAt), windowAt: iso(cntAt + DAY), missed: [iso(cntAt)], next: iso(cntAt + 2 * DAY) }),
    );
    assert.equal(cntResult.started, true);
    assert.equal(cntResult.missed, 0);
  });

  // -------------------------------------------------------------------------
  // Group 10: tick (F10-AC-06 DB)
  // -------------------------------------------------------------------------
  await runGroup("tick", async () => {
    const wsStart = await seedWorkspace("tick-start", { panel: true });
    const wsSkip = await seedWorkspace("tick-skip", { panel: false });

    const past = Date.now() - 2 * DAY;
    await insertSchedule(wsStart.brand, { next: past, max: 20 });
    await insertSchedule(wsSkip.brand, { next: past, max: 20 });

    const fakeAdmin = {
      from: (table) => ({
        select: (cols) => ({
          eq: (c1, v1) => ({
            eq: (c2, v2) => ({
              lte: (c3, v3) => ({
                order: (c4, opts) => ({
                  limit: async (lim) => {
                    const r = await query(
                      "SELECT brand, next_run_at, schedule_interval, approved_max_usd FROM public.scan_schedules WHERE managed_by = $1 AND enabled = $2 AND next_run_at <= $3::timestamptz ORDER BY next_run_at ASC LIMIT $4",
                      [v1, v2, v3, lim],
                    );
                    return { data: r.rows, error: null };
                  },
                }),
              }),
            }),
            maybeSingle: async () => {
              if (table === "customer_brands") {
                const r = await query("SELECT is_active FROM public.customer_brands WHERE brand_key = $1", [v1]);
                return { data: r.rows[0] || null, error: null };
              }
              if (table === "probe_dispatch_control") {
                return { data: { paused: false, brand_allowlist: null }, error: null };
              }
              return { data: null, error: null };
            },
          }),
        }),
      }),
      rpc: async (fn, args) => {
        if (fn === "start_customer_window") {
          const res = await start({
            brand: args.p_brand,
            now: args.p_now,
            observed: args.p_observed_next,
            windowAt: args.p_window_at,
            missed: args.p_missed,
            next: args.p_next,
            jobId: args.p_job_id,
            approvedMax: args.p_approved_max,
            quote: args.p_quote,
          });
          return { data: res, error: null };
        }
        if (fn === "block_customer_window") {
          const res = await block(
            {
              brand: args.p_brand,
              now: args.p_now,
              observed: args.p_observed_next,
              windowAt: args.p_window_at,
              missed: args.p_missed,
              next: args.p_next,
            },
            args.p_reason,
          );
          return { data: res, error: null };
        }
        return { data: null, error: null };
      },
    };

    const quoteMock = async (_k, ctx) => {
      const r = await query(
        "SELECT a.id FROM public.repair_artifact_heads h JOIN public.repair_artifacts a ON a.id = h.artifact_id WHERE h.brand = $1 AND h.kind = 'panel' AND h.artifact_key = 'default' AND a.state = 'approved'",
        [ctx.brandKey],
      );
      if (r.rows.length === 0) {
        return {
          action: "ai_visibility.scan.run",
          totalUsd: 15,
          expectedUsd: 10,
          monthly: { interval: "daily", runsPerMonth: 30, totalUsd: 450 },
          warnings: [],
          blocked: { code: "panel_not_approved", message: "Review and approve question panel" },
          units: [],
          lines: [],
        };
      }
      return {
        action: "ai_visibility.scan.run",
        totalUsd: 15,
        expectedUsd: 10,
        monthly: { interval: "daily", runsPerMonth: 30, totalUsd: 450 },
        warnings: [],
        blocked: null,
        units: [],
        lines: [],
      };
    };

    const fakeCtx = {
      jobId: id(),
      brandKey: "system",
      payload: {},
      trigger: { type: "system" },
      step: {
        do: async (_name, _opts, fn) => {
          if (typeof _opts === "function") return _opts();
          return fn();
        },
        sleep: async () => {},
      },
    };

    let wakeCount = 0;
    const scheduleDeps = {
      isFeatureEnabled: async () => true,
      quote: quoteMock,
      dispatchBudget: () => ({ dayCap: null }),
      reserveSpend: async () => ({ holdId: "hold-tick", existing: false }),
      releaseSpend: async () => {},
      wakeScanWorker: () => {
        wakeCount += 1;
        return { fired: true, reason: null };
      },
    };

    registerAiVisibilityScheduleJobs({
      admin: fakeAdmin,
      now: () => new Date(),
      scheduleDeps,
    });

    const def = getJobDefinition(SCHEDULES_TICK_KIND);
    const result = await def.handler(fakeCtx);
    assert.equal(result.status, "completed");
    assert.equal(result.result.started, 1);
    assert.equal(result.result.skipped.panel_not_approved, 1);
    assert.equal(result.result.failed, 0);
    assert.equal(wakeCount, 1);

    const sStart = await schedule(wsStart.brand);
    assert.ok(ms(sStart.next_run_at) > past, "wsStart next_run_at advanced");
    assert.equal((await jobs(wsStart.brand)).length, 1);
    assert.equal((await windows(wsStart.brand)).length, 1);

    const sSkip = await schedule(wsSkip.brand);
    assert.ok(ms(sSkip.next_run_at) > past, "wsSkip next_run_at advanced");
    assert.equal(sSkip.last_skip_reason, "panel_not_approved");
    assert.equal((await jobs(wsSkip.brand)).length, 0);
    assert.equal((await windows(wsSkip.brand)).length, 1);

    resetAiVisibilityScheduleJobDeps();
  });

  if (targetGroup) {
    assert.equal(passed.length, 1);
    console.log(`ok 1 group (${targetGroup})`);
  } else {
    assert.equal(passed.length, 10);
    console.log("ok 10 groups");
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
