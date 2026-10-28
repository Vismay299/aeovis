#!/usr/bin/env node
/**
 * F03 database harness — cost ledger extensions (050), attempt sync, scan holds, reconciliations.
 *
 * Runs against a disposable loopback PostgreSQL database that has every
 * migration applied.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

if (
  !["127.0.0.1", "localhost", "::1"].includes(process.env.PGHOST) ||
  !/(?:_qa|_uat)$/.test(process.env.PGDATABASE || "") ||
  process.env.DATABASE_URL
) {
  throw Error("Explicit loopback QA database required; DATABASE_URL refused");
}

const pool = new pg.Pool({ max: 12 });
const q = (sql, values = []) => pool.query(sql, values);
const passed = [];
const id = () => crypto.randomUUID();

async function rpc(name, values = {}) {
  const entries = Object.entries(values);
  const r = await q(
    `SELECT ${name}(${entries.map(([k], i) => `${k}=>$${i + 1}`).join(",")}) AS result`,
    entries.map(([, v]) => (v && typeof v === "object" ? JSON.stringify(v) : v))
  );
  return r.rows[0].result;
}

async function test(name, fn) {
  await fn();
  passed.push(name);
  console.log("PASS " + name);
}

async function createUser(email) {
  const userId = id();
  await q("INSERT INTO auth.users(id, email, email_confirmed_at) VALUES($1, $2, now())", [userId, email]);
  return userId;
}

async function createBrand(suffix, ownerUserId = null) {
  const brandKey = `qa-f03-${suffix}-${id()}.example`;
  await q(
    "INSERT INTO public.customer_brands(brand_key, display_name, website, website_host, aliases) VALUES($1, $2, $3, $4, $5)",
    [brandKey, `F03 ${suffix}`, `https://${brandKey}`, brandKey, []]
  );
  if (ownerUserId) {
    await q("INSERT INTO public.customer_brand_memberships(user_id, brand_key, role) VALUES($1, $2, 'owner')", [
      ownerUserId,
      brandKey,
    ]);
  }
  return brandKey;
}

async function asUser(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId]);
    return await fn(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    client.release();
  }
}

async function main() {
  const fixturesPath = path.resolve("tests/fixtures/f03/probe-attempts.json");
  const fixtureData = JSON.parse(await readFile(fixturesPath, "utf8"));

  // ─────────────────────────────────────────────────────────────
  // 1. SEED GROUP
  // ─────────────────────────────────────────────────────────────
  await test("seed", async () => {
    const { rows } = await q("SELECT * FROM public.paid_feature_controls WHERE feature = 'ai_visibility.scan'");
    assert.equal(rows.length, 1, "paid_feature_controls must contain ai_visibility.scan");
    assert.equal(rows[0].enabled, true, "ai_visibility.scan must be enabled");
    assert.equal(rows[0].mode, "all", "ai_visibility.scan must be mode 'all'");
  });

  // ─────────────────────────────────────────────────────────────
  // 2. SYNC GROUP
  // ─────────────────────────────────────────────────────────────
  await test("sync", async () => {
    const brandA = await createBrand("sync-a");
    const jobIdA = id();
    await q(
      "INSERT INTO public.scan_jobs(id, brand, brand_key, status) VALUES($1, $2, $2, 'complete')",
      [jobIdA, brandA]
    );

    // Job with no brand_key (should never sync)
    const jobIdNoBrand = id();
    await q("INSERT INTO public.scan_jobs(id, brand, brand_key, status) VALUES($1, 'qa-f03-unowned', NULL, 'complete')", [
      jobIdNoBrand,
    ]);

    // `explore` arrives with F11's migration. Until then the P0 purpose check
    // refuses it, and the harness must not rewrite a P0 constraint to fit.
    const exploreAllowed = (
      await q("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'probe_observations_purpose_check'")
    ).rows.some((r) => r.d.includes("'explore'"));

    // Insert observations and attempts from fixture
    for (const item of fixtureData) {
      let targetJobId = jobIdA;
      if (item.purpose === "explore") {
        if (!exploreAllowed) continue;
        targetJobId = null; // Explore has no scan_job
      }

      await q(
        `INSERT INTO public.probe_observations(id, job_id, purpose, engine, query, context, config_version, circuit_key, deadline_at)
         VALUES($1, $2, $3, $4, $5, '{}', '1.0', 'default', now() + interval '1 hour')
         ON CONFLICT (id) DO NOTHING`,
        [item.observation_id, targetJobId, item.purpose, item.engine, item.query]
      );

      await q(
        `INSERT INTO public.probe_attempts(observation_id, attempt_no, lease_token, started_at, finished_at, dispatch_state, reserved_usd, charged_usd, cost_state, result)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (observation_id, attempt_no) DO NOTHING`,
        [
          item.observation_id,
          item.attempt_no,
          item.lease_token,
          item.started_at,
          item.finished_at,
          item.dispatch_state,
          item.reserved_usd,
          item.charged_usd,
          item.cost_state,
          JSON.stringify(item.result || {}),
        ]
      );
    }

    // Insert canary attempt
    const canaryObsId = `canary-obs-${id()}`;
    await q(
      `INSERT INTO public.probe_observations(id, job_id, purpose, engine, query, context, config_version, circuit_key, deadline_at)
       VALUES($1, $2, 'canary', 'chatgpt', 'canary test', '{}', '1.0', 'default', now() + interval '1 hour')`,
      [canaryObsId, jobIdA]
    );
    await q(
      `INSERT INTO public.probe_attempts(observation_id, attempt_no, lease_token, started_at, finished_at, dispatch_state, reserved_usd, charged_usd, cost_state, result)
       VALUES($1, 1, $2, now(), now(), 'recorded', 0.20, 0.004, 'measured', '{"cost_source":"gateway"}')`,
      [canaryObsId, id()]
    );

    // Insert brandless attempt
    const noBrandObsId = `nobrand-obs-${id()}`;
    await q(
      `INSERT INTO public.probe_observations(id, job_id, purpose, engine, query, context, config_version, circuit_key, deadline_at)
       VALUES($1, $2, 'scan', 'chatgpt', 'nobrand test', '{}', '1.0', 'default', now() + interval '1 hour')`,
      [noBrandObsId, jobIdNoBrand]
    );
    await q(
      `INSERT INTO public.probe_attempts(observation_id, attempt_no, lease_token, started_at, finished_at, dispatch_state, reserved_usd, charged_usd, cost_state, result)
       VALUES($1, 1, $2, now(), now(), 'recorded', 0.20, 0.004, 'measured', '{"cost_source":"gateway"}')`,
      [noBrandObsId, id()]
    );

    // Run sync
    const syncedCount1 = await rpc("sync_probe_attempt_costs", { p_limit: 1000 });
    assert.ok(syncedCount1 >= 13, `expected at least 13 attempts synced, got ${syncedCount1}`);

    // Verify canary, brandless, and explore are NOT synced
    const { rows: canaryRows } = await q("SELECT * FROM public.spend_ledger WHERE source_ref LIKE $1", [`probe_attempt:${canaryObsId}:%`]);
    assert.equal(canaryRows.length, 0, "canary attempt must never be synced");

    const { rows: noBrandRows } = await q("SELECT * FROM public.spend_ledger WHERE source_ref LIKE $1", [`probe_attempt:${noBrandObsId}:%`]);
    assert.equal(noBrandRows.length, 0, "attempt of brandless job must never be synced");

    if (exploreAllowed) {
      const { rows: exploreRows } = await q("SELECT * FROM public.spend_ledger WHERE source_ref LIKE 'probe_attempt:f03-obs-14:%'");
      assert.equal(exploreRows.length, 0, "explore attempt must never be synced");
    }

    // Idempotency: second run produces 0 newly synced rows
    const syncedCount2 = await rpc("sync_probe_attempt_costs", { p_limit: 1000 });
    assert.equal(syncedCount2, 0, "second sync run must be idempotent (0 synced)");

    // Check cost sources
    const { rows: obs1 } = await q("SELECT * FROM public.spend_ledger WHERE source_ref = 'probe_attempt:f03-obs-01:1'");
    assert.equal(obs1[0].cost_source, "provider_reported");
    assert.equal(Number(obs1[0].accounted_usd), 0.004);

    const { rows: obs8 } = await q("SELECT * FROM public.spend_ledger WHERE source_ref = 'probe_attempt:f03-obs-08:1'");
    assert.equal(obs8[0].cost_source, "price_table");
    assert.equal(Number(obs8[0].accounted_usd), 0.0015);

    const { rows: obs9 } = await q("SELECT * FROM public.spend_ledger WHERE source_ref = 'probe_attempt:f03-obs-09:1'");
    assert.equal(obs9[0].cost_source, "reservation");
    assert.equal(Number(obs9[0].accounted_usd), 0.20);
    assert.equal(obs9[0].actual_usd, null);

    const { rows: obs11 } = await q("SELECT * FROM public.spend_ledger WHERE source_ref = 'probe_attempt:f03-obs-11:1'");
    assert.equal(obs11[0].cost_source, "none");
    assert.equal(Number(obs11[0].accounted_usd), 0);

    const { rows: obs12 } = await q("SELECT * FROM public.spend_ledger WHERE source_ref = 'probe_attempt:f03-obs-12:1'");
    assert.equal(obs12[0].cost_source, "provider_reported");

    // reconciliation_conflict landing as reservation even though charged_usd is set
    const { rows: obs13 } = await q("SELECT * FROM public.spend_ledger WHERE source_ref = 'probe_attempt:f03-obs-13:1'");
    assert.equal(obs13[0].cost_source, "reservation");
    assert.equal(Number(obs13[0].accounted_usd), 0.20);
    assert.equal(obs13[0].actual_usd, null);

    // Update after flipping one attempt to confirmed_not_dispatched
    await q("UPDATE public.probe_attempts SET cost_state = 'confirmed_not_dispatched', charged_usd = 0 WHERE observation_id = 'f03-obs-01' AND attempt_no = 1");
    const updateSync = await rpc("sync_probe_attempt_costs", { p_limit: 1000 });
    assert.equal(updateSync, 1, "flipping to confirmed_not_dispatched must update 1 row");

    const { rows: obs1Updated } = await q("SELECT * FROM public.spend_ledger WHERE source_ref = 'probe_attempt:f03-obs-01:1'");
    assert.equal(obs1Updated[0].cost_source, "none");
    assert.equal(Number(obs1Updated[0].accounted_usd), 0);

    // AC-19 equality: sum of accounted_usd across ledger matches the attempt calculation
    const { rows: ledgerSumRows } = await q(
      "SELECT sum(accounted_usd) as total, sum(actual_usd) filter (where cost_source in ('provider_reported','price_table')) as known FROM public.spend_ledger WHERE subject_kind = 'scan_job' AND subject_id = $1",
      [jobIdA]
    );

    const { rows: attemptSumRows } = await q(
      `SELECT
         sum(CASE
               WHEN a.cost_state = 'confirmed_not_dispatched' THEN 0
               WHEN a.cost_state = 'reconciliation_conflict' OR a.charged_usd IS NULL THEN a.reserved_usd
               ELSE a.charged_usd END) as total,
         sum(CASE
               WHEN a.cost_state = 'confirmed_not_dispatched' THEN 0
               WHEN a.cost_state = 'reconciliation_conflict' OR a.charged_usd IS NULL THEN 0
               ELSE a.charged_usd END) as known
       FROM probe_attempts a
       JOIN probe_observations o ON o.id = a.observation_id
       WHERE o.job_id = $1 AND o.purpose = 'scan'`,
      [jobIdA]
    );

    assert.equal(Number(ledgerSumRows[0].total), Number(attemptSumRows[0].total), "AC-19: total accounted USD must match");
    assert.equal(Number(ledgerSumRows[0].known), Number(attemptSumRows[0].known), "AC-19: known USD must match");
  });

  // ─────────────────────────────────────────────────────────────
  // 3. SCAN-HOLD GROUP
  // ─────────────────────────────────────────────────────────────
  await test("scan-hold", async () => {
    const brandKey = await createBrand("hold-brand");
    const jobId = id();
    await q("INSERT INTO public.scan_jobs(id, brand, brand_key, status) VALUES($1, $2, $2, 'running')", [
      jobId,
      brandKey,
    ]);

    // Reserve hold
    const holdId = id();
    await q(
      `INSERT INTO public.spend_holds(id, brand_key, feature, estimate_usd, max_usd, idempotency_key, subject_kind, subject_id, status, expires_at)
       VALUES($1, $2, 'ai_visibility.scan', 1.00, 2.00, $3, 'scan_job', $4, 'held', now() + interval '1 hour')`,
      [holdId, brandKey, `hold-idem-${id()}`, jobId]
    );

    // Add probe observations and attempts for running scan
    const obsId1 = `hold-obs-1-${id()}`;
    await q(
      `INSERT INTO public.probe_observations(id, job_id, purpose, engine, query, context, config_version, circuit_key, deadline_at)
       VALUES($1, $2, 'scan', 'chatgpt', 'hold q1', '{}', '1.0', 'default', now() + interval '1 hour')`,
      [obsId1, jobId]
    );
    await q(
      `INSERT INTO public.probe_attempts(observation_id, attempt_no, lease_token, started_at, finished_at, dispatch_state, reserved_usd, charged_usd, cost_state, result)
       VALUES($1, 1, $2, now(), now(), 'recorded', 0.20, 0.05, 'measured', '{"cost_source":"gateway"}')`,
      [obsId1, id()]
    );

    // While job is running: settle_scan_hold returns scan_running, sync_probe_attempt_costs writes 0 rows
    const settleRunning = await rpc("settle_scan_hold", { p_job: jobId });
    assert.equal(settleRunning.settled, false);
    assert.equal(settleRunning.reason, "scan_running");

    const syncRunning = await rpc("sync_probe_attempt_costs", { p_limit: 1000 });
    const { rows: preLedger } = await q("SELECT * FROM public.spend_ledger WHERE subject_id = $1", [jobId]);
    assert.equal(preLedger.length, 0, "open hold prevents periodic sync from adding attempt rows");

    // Committed USD before completion: equals hold estimate (1.00)
    const committedBefore = await rpc("f01_committed_usd", { p_brand: brandKey, p_feature: null, p_since: new Date(Date.now() - 3600000).toISOString() });
    assert.equal(Number(committedBefore), 1.00, "f01_committed_usd counts the open hold estimate");

    // Mark job complete and settle
    await q("UPDATE public.scan_jobs SET status = 'complete' WHERE id = $1", [jobId]);
    const settleDone = await rpc("settle_scan_hold", { p_job: jobId });
    assert.equal(settleDone.settled, true);
    assert.equal(Number(settleDone.actual_usd), 0.05);

    // After settle: attempt row exists with hold_id set, and hold status is settled
    const { rows: postLedger } = await q("SELECT * FROM public.spend_ledger WHERE subject_id = $1", [jobId]);
    assert.equal(postLedger.length, 1);
    assert.equal(postLedger[0].hold_id, holdId);

    const { rows: settledHold } = await q("SELECT * FROM public.spend_holds WHERE id = $1", [holdId]);
    assert.equal(settledHold[0].status, "settled");
    assert.equal(Number(settledHold[0].actual_usd), 0.05);

    // Committed USD equals actual attempt sum (no double counting)
    const committedAfter = await rpc("f01_committed_usd", { p_brand: brandKey, p_feature: null, p_since: new Date(Date.now() - 3600000).toISOString() });
    assert.equal(Number(committedAfter), 0.05, "committed USD after settlement equals actual attempt sum");

    // ── Expired hold path ──
    const jobIdExpired = id();
    await q("INSERT INTO public.scan_jobs(id, brand, brand_key, status) VALUES($1, $2, $2, 'running')", [
      jobIdExpired,
      brandKey,
    ]);
    const holdExpiredId = id();
    await q(
      `INSERT INTO public.spend_holds(id, brand_key, feature, estimate_usd, max_usd, idempotency_key, subject_kind, subject_id, status, expires_at, closed_at)
       VALUES($1, $2, 'ai_visibility.scan', 0.80, 1.00, $3, 'scan_job', $4, 'expired', now() - interval '1 minute', now())`,
      [holdExpiredId, brandKey, `hold-exp-${id()}`, jobIdExpired]
    );
    // F01 expiry creates hold:<id> reservation row in spend_ledger
    await q(
      `INSERT INTO public.spend_ledger(brand_key, feature, hold_id, source_ref, provider, endpoint, estimate_usd, actual_usd, accounted_usd, cost_source)
       VALUES($1, 'ai_visibility.scan', $2, $3, 'openrouter', 'probe:chatgpt', 0.80, NULL, 0.80, 'reservation')`,
      [brandKey, holdExpiredId, `hold:${holdExpiredId}`]
    );

    const obsExpired = `obs-exp-${id()}`;
    await q(
      `INSERT INTO public.probe_observations(id, job_id, purpose, engine, query, context, config_version, circuit_key, deadline_at)
       VALUES($1, $2, 'scan', 'chatgpt', 'expired q', '{}', '1.0', 'default', now() + interval '1 hour')`,
      [obsExpired, jobIdExpired]
    );
    await q(
      `INSERT INTO public.probe_attempts(observation_id, attempt_no, lease_token, started_at, finished_at, dispatch_state, reserved_usd, charged_usd, cost_state, result)
       VALUES($1, 1, $2, now(), now(), 'recorded', 0.20, 0.04, 'measured', '{"cost_source":"gateway"}')`,
      [obsExpired, id()]
    );

    // While job is running with expired hold: sync_probe_attempt_costs must NOT write attempt row
    await rpc("sync_probe_attempt_costs", { p_limit: 1000 });
    const { rows: noAttemptWhileExpiredRunning } = await q(
      "SELECT * FROM public.spend_ledger WHERE source_ref = $1",
      [`probe_attempt:${obsExpired}:1`]
    );
    assert.equal(noAttemptWhileExpiredRunning.length, 0, "attempt rows and expired hold: reservation row must never coexist");

    // Complete job and settle: hold: reservation row is deleted, attempt rows written
    await q("UPDATE public.scan_jobs SET status = 'complete' WHERE id = $1", [jobIdExpired]);
    const settleExpired = await rpc("settle_scan_hold", { p_job: jobIdExpired });
    assert.equal(settleExpired.settled, true);

    const { rows: reservationRowDeleted } = await q("SELECT * FROM public.spend_ledger WHERE source_ref = $1", [`hold:${holdExpiredId}`]);
    assert.equal(reservationRowDeleted.length, 0, "hold: reservation row must be deleted on settlement");

    const { rows: attemptRowNowPresent } = await q("SELECT * FROM public.spend_ledger WHERE source_ref = $1", [`probe_attempt:${obsExpired}:1`]);
    assert.equal(attemptRowNowPresent.length, 1, "attempt row is now present in spend_ledger");

    // ── Expired hold whose scan_jobs row was deleted ──
    const missingJobId = id();
    const holdMissingId = id();
    await q(
      `INSERT INTO public.spend_holds(id, brand_key, feature, estimate_usd, max_usd, idempotency_key, subject_kind, subject_id, status, expires_at, closed_at)
       VALUES($1, $2, 'ai_visibility.scan', 0.50, 1.00, $3, 'scan_job', $4, 'expired', now() - interval '1 minute', now())`,
      [holdMissingId, brandKey, `hold-mis-${id()}`, missingJobId]
    );
    await q(
      `INSERT INTO public.spend_ledger(brand_key, feature, hold_id, source_ref, provider, endpoint, estimate_usd, actual_usd, accounted_usd, cost_source)
       VALUES($1, 'ai_visibility.scan', $2, $3, 'openrouter', 'probe:chatgpt', 0.50, NULL, 0.50, 'reservation')`,
      [brandKey, holdMissingId, `hold:${holdMissingId}`]
    );

    const settleMissing = await rpc("settle_finished_scan_holds", { p_limit: 50 });
    const { rows: missingHoldPost } = await q("SELECT * FROM public.spend_holds WHERE id = $1", [holdMissingId]);
    assert.equal(missingHoldPost[0].status, "settled");
    assert.equal(Number(missingHoldPost[0].actual_usd), 0);

    const settleMissingAgain = await rpc("settle_finished_scan_holds", { p_limit: 50 });
    // Should not re-select or loop
    assert.equal(typeof settleMissingAgain, "number");

    // ── Malformed subject_id does not break sweep ──
    await q(
      `INSERT INTO public.spend_holds(id, brand_key, feature, estimate_usd, max_usd, idempotency_key, subject_kind, subject_id, status, expires_at)
       VALUES($1, $2, 'ai_visibility.scan', 0.10, 0.20, $3, 'scan_job', 'not-a-valid-uuid', 'held', now() + interval '1 hour')`,
      [id(), brandKey, `hold-mal-${id()}`]
    );
    const sweepMalformed = await rpc("settle_finished_scan_holds", { p_limit: 50 });
    assert.equal(typeof sweepMalformed, "number", "malformed subject_id must not crash sweep");

    // ── Job with two open holds settles one per run and strands neither ──
    const twoHoldsJobId = id();
    await q("INSERT INTO public.scan_jobs(id, brand, brand_key, status) VALUES($1, $2, $2, 'complete')", [
      twoHoldsJobId,
      brandKey,
    ]);
    const h1 = id();
    const h2 = id();
    await q(
      `INSERT INTO public.spend_holds(id, brand_key, feature, estimate_usd, max_usd, idempotency_key, subject_kind, subject_id, status, created_at, expires_at)
       VALUES($1, $2, 'ai_visibility.scan', 0.50, 1.00, $3, 'scan_job', $4, 'held', now() - interval '2 minutes', now() + interval '1 hour'),
             ($5, $2, 'ai_visibility.scan', 0.50, 1.00, $6, 'scan_job', $4, 'held', now() - interval '1 minute', now() + interval '1 hour')`,
      [h1, brandKey, `two-1-${id()}`, twoHoldsJobId, h2, `two-2-${id()}`]
    );

    await rpc("settle_finished_scan_holds", { p_limit: 50 });
    const { rows: h1Post } = await q("SELECT * FROM public.spend_holds WHERE id = $1", [h1]);
    const { rows: h2Post } = await q("SELECT * FROM public.spend_holds WHERE id = $1", [h2]);
    assert.equal(h1Post[0].status, "settled");
    assert.equal(h2Post[0].status, "settled");
  });

  // ─────────────────────────────────────────────────────────────
  // 4. RECONCILE GROUP
  // ─────────────────────────────────────────────────────────────
  await test("reconcile", async () => {
    const brandKey = await createBrand("reconcile-brand");

    // Undershoot: actual_usd > estimate_usd
    const ledgerUndershoot = id();
    await q(
      `INSERT INTO public.spend_ledger(id, brand_key, feature, source_ref, provider, endpoint, estimate_usd, actual_usd, accounted_usd, cost_source)
       VALUES($1, $2, 'ai_visibility.scan', $3, 'openrouter', 'probe:chatgpt', 0.05, 0.08, 0.08, 'provider_reported')`,
      [ledgerUndershoot, brandKey, `under:${id()}`]
    );

    const { rows: undershootRecon } = await q(
      "SELECT * FROM public.cost_reconciliations WHERE ledger_id = $1 AND kind = 'undershoot'",
      [ledgerUndershoot]
    );
    assert.equal(undershootRecon.length, 1, "undershoot row created");
    assert.equal(Number(undershootRecon[0].actual_usd), 0.08);

    // Unknown cost: cost_source = 'reservation'
    const ledgerUnknown = id();
    await q(
      `INSERT INTO public.spend_ledger(id, brand_key, feature, source_ref, provider, endpoint, estimate_usd, actual_usd, accounted_usd, cost_source)
       VALUES($1, $2, 'ai_visibility.scan', $3, 'openrouter', 'probe:chatgpt', 0.20, NULL, 0.20, 'reservation')`,
      [ledgerUnknown, brandKey, `unk:${id()}`]
    );

    const { rows: unkRecon } = await q(
      "SELECT * FROM public.cost_reconciliations WHERE ledger_id = $1 AND kind = 'unknown_cost'",
      [ledgerUnknown]
    );
    assert.equal(unkRecon.length, 1, "unknown_cost row created");
    assert.equal(unkRecon[0].resolution, null);

    // Auto-resolve when reservation row is updated
    await q(
      "UPDATE public.spend_ledger SET actual_usd = 0.06, accounted_usd = 0.06, cost_source = 'provider_reported' WHERE id = $1",
      [ledgerUnknown]
    );
    const { rows: unkReconUpdated } = await q(
      "SELECT * FROM public.cost_reconciliations WHERE ledger_id = $1 AND kind = 'unknown_cost'",
      [ledgerUnknown]
    );
    assert.equal(unkReconUpdated[0].resolution, "provider_confirmed");
    assert.equal(unkReconUpdated[0].resolved_by, "sync");
    assert.equal(Number(unkReconUpdated[0].actual_usd), 0.06);

    // Operator resolve validations
    const reconId = undershootRecon[0].id;

    // Short note (< 10 chars) refused
    await assert.rejects(
      () => rpc("resolve_cost_reconciliation", { p_id: reconId, p_resolution: "accepted", p_note: "too short", p_by: "op" }),
      /resolution and a note of at least 10 characters are required/
    );

    // Resolve as accepted
    const resAccepted = await rpc("resolve_cost_reconciliation", {
      p_id: reconId,
      p_resolution: "accepted",
      p_note: "Accepted by operator after review",
      p_by: "operator",
    });
    assert.equal(resAccepted.resolved, true);

    // not_billed refused for probe attempts
    const probeLedgerId = id();
    await q(
      `INSERT INTO public.spend_ledger(id, brand_key, feature, source_ref, provider, endpoint, estimate_usd, actual_usd, accounted_usd, cost_source)
       VALUES($1, $2, 'ai_visibility.scan', $3, 'openrouter', 'probe:chatgpt', 0.20, NULL, 0.20, 'reservation')`,
      [probeLedgerId, brandKey, `probe_attempt:fake-obs-${id()}:1`]
    );
    const { rows: probeRecon } = await q("SELECT * FROM public.cost_reconciliations WHERE ledger_id = $1", [probeLedgerId]);

    await assert.rejects(
      () =>
        rpc("resolve_cost_reconciliation", {
          p_id: probeRecon[0].id,
          p_resolution: "not_billed",
          p_note: "Attempting not billed on probe",
          p_by: "operator",
        }),
      /probe attempts are reconciled with reconcile_probe_dispatch/
    );

    // not_billed on non-probe reservation row succeeds and zeroes accounted_usd
    const holdLedgerId = id();
    await q(
      `INSERT INTO public.spend_ledger(id, brand_key, feature, source_ref, provider, endpoint, estimate_usd, actual_usd, accounted_usd, cost_source)
       VALUES($1, $2, 'keywords.research', $3, 'dataforseo', 'labs', 0.15, NULL, 0.15, 'reservation')`,
      [holdLedgerId, brandKey, `hold:${id()}`]
    );
    const { rows: holdRecon } = await q("SELECT * FROM public.cost_reconciliations WHERE ledger_id = $1", [holdLedgerId]);
    const resNotBilled = await rpc("resolve_cost_reconciliation", {
      p_id: holdRecon[0].id,
      p_resolution: "not_billed",
      p_note: "Provider confirmed call was not billed",
      p_by: "operator",
    });
    assert.equal(resNotBilled.resolved, true);

    const { rows: zeroedLedger } = await q("SELECT * FROM public.spend_ledger WHERE id = $1", [holdLedgerId]);
    assert.equal(Number(zeroedLedger[0].accounted_usd), 0);
    assert.equal(zeroedLedger[0].cost_source, "none");
    assert.equal(zeroedLedger[0].meta?.reconciled, "not_billed");

    // resolve_unknown_cost_backlog bulk accept
    // Insert 3 unknown cost rows back-dated
    for (let i = 0; i < 3; i++) {
      const lid = id();
      await q(
        `INSERT INTO public.spend_ledger(id, brand_key, feature, source_ref, provider, endpoint, estimate_usd, actual_usd, accounted_usd, cost_source, occurred_at)
         VALUES($1, $2, 'ai_visibility.scan', $3, 'openrouter', 'probe:chatgpt', 0.20, NULL, 0.20, 'reservation', now() - interval '10 days')`,
        [lid, brandKey, `backlog:${id()}`]
      );
      await q("UPDATE public.cost_reconciliations SET created_at = now() - interval '10 days' WHERE ledger_id = $1", [lid]);
    }

    // Short note fails
    await assert.rejects(
      () =>
        rpc("resolve_unknown_cost_backlog", {
          p_before: new Date(Date.now() - 5 * 86400000).toISOString(),
          p_note: "too short",
          p_by: "operator",
          p_limit: 1000,
        }),
      /resolution and a note of at least 10 characters are required/
    );

    // Valid bulk accept resolves open rows older than 5 days
    const bulkResolved = await rpc("resolve_unknown_cost_backlog", {
      p_before: new Date(Date.now() - 5 * 86400000).toISOString(),
      p_note: "Bulk accepted historical unknown backlog",
      p_by: "operator",
      p_limit: 1000,
    });
    assert.ok(bulkResolved >= 3, `expected at least 3 resolved, got ${bulkResolved}`);
  });

  // ─────────────────────────────────────────────────────────────
  // 5. STATS GROUP
  // ─────────────────────────────────────────────────────────────
  await test("stats", async () => {
    const brandKey = await createBrand("stats-brand");
    const testEngine = `stat-engine-${id().slice(0, 8)}`;
    const statJobId = id();
    await q("INSERT INTO public.scan_jobs(id, brand, brand_key, status) VALUES($1, $2, $2, 'complete')", [
      statJobId,
      brandKey,
    ]);

    // Insert 19 measured attempts
    for (let i = 1; i <= 19; i++) {
      const obs = `obs-stat-${i}-${id()}`;
      await q(
        `INSERT INTO public.probe_observations(id, job_id, purpose, engine, query, context, config_version, circuit_key, deadline_at)
         VALUES($1, $2, 'scan', $3, $4, '{}', '1.0', 'default', now() + interval '1 hour')`,
        [obs, statJobId, testEngine, `stat query ${i}`]
      );
      await q(
        `INSERT INTO public.probe_attempts(observation_id, attempt_no, lease_token, started_at, finished_at, dispatch_state, reserved_usd, charged_usd, cost_state, result)
         VALUES($1, 1, $2, now() - interval '5 days', now() - interval '5 days', 'recorded', 0.20, $3, 'measured', '{"cost_source":"gateway"}')`,
        [obs, id(), 0.01 + i * 0.001]
      );
    }

    const { rows: stats19 } = await q("SELECT * FROM public.engine_cost_stats(30) WHERE engine = $1", [testEngine]);
    assert.equal(stats19.length, 0, "19 samples must produce no stats row (minimum 20 required)");

    // Insert 20th attempt
    const obs20 = `obs-stat-20-${id()}`;
    await q(
      `INSERT INTO public.probe_observations(id, job_id, purpose, engine, query, context, config_version, circuit_key, deadline_at)
       VALUES($1, $2, 'scan', $3, 'stat query 20', '{}', '1.0', 'default', now() + interval '1 hour')`,
      [obs20, statJobId, testEngine]
    );
    await q(
      `INSERT INTO public.probe_attempts(observation_id, attempt_no, lease_token, started_at, finished_at, dispatch_state, reserved_usd, charged_usd, cost_state, result)
       VALUES($1, 1, $2, now() - interval '5 days', now() - interval '5 days', 'recorded', 0.20, 0.03, 'measured', '{"cost_source":"gateway"}')`,
      [obs20, id()]
    );

    const { rows: stats20 } = await q("SELECT * FROM public.engine_cost_stats(30) WHERE engine = $1", [testEngine]);
    assert.equal(stats20.length, 1, "20 samples must produce 1 stats row");
    assert.equal(stats20[0].samples, 20);
    assert.ok(Number(stats20[0].median_usd) > 0);
    assert.ok(Number(stats20[0].p90_usd) >= Number(stats20[0].median_usd));
  });

  // ─────────────────────────────────────────────────────────────
  // 6. RLS GROUP
  // ─────────────────────────────────────────────────────────────
  await test("rls", async () => {
    const userA = await createUser(`user-a-${id()}@example.com`);
    const userB = await createUser(`user-b-${id()}@example.com`);
    const brandA = await createBrand("rls-a", userA);
    const brandB = await createBrand("rls-b", userB);

    // Insert ledger rows for brand A and brand B
    await q(
      `INSERT INTO public.spend_ledger(brand_key, feature, source_ref, provider, endpoint, estimate_usd, actual_usd, accounted_usd, cost_source)
       VALUES($1, 'ai_visibility.scan', $2, 'openrouter', 'probe:chatgpt', 0.05, 0.05, 0.05, 'provider_reported'),
             ($3, 'ai_visibility.scan', $4, 'openrouter', 'probe:chatgpt', 0.05, 0.05, 0.05, 'provider_reported')`,
      [brandA, `rls-a-${id()}`, brandB, `rls-b-${id()}`]
    );

    // User A should see only brand A rows
    await asUser(userA, async (client) => {
      const { rows } = await client.query("SELECT * FROM public.spend_ledger");
      assert.ok(rows.length > 0, "user A sees own rows");
      assert.ok(rows.every((r) => r.brand_key === brandA), "user A sees ONLY brand A rows");

      // cost_reconciliations is operator-only: a customer's read is refused outright.
      await assert.rejects(client.query("SELECT * FROM public.cost_reconciliations"), { code: "42501" });
    });

    // User B should see only brand B rows
    await asUser(userB, async (client) => {
      const { rows } = await client.query("SELECT * FROM public.spend_ledger");
      assert.ok(rows.length > 0, "user B sees own rows");
      assert.ok(rows.every((r) => r.brand_key === brandB), "user B sees ONLY brand B rows");

      // cost_reconciliations is operator-only: a customer's read is refused outright.
      await assert.rejects(client.query("SELECT * FROM public.cost_reconciliations"), { code: "42501" });
    });
  });

  console.log(`\nAll ${passed.length} DB groups passed!`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error("FATAL in check-f03-db.mjs:", err);
    pool.end().finally(() => process.exit(1));
  });
