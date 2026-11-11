#!/usr/bin/env node
// F11 Phase 1 database contract; runs only against a disposable loopback DB.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const host = process.env.PGHOST || "";
const database = process.env.PGDATABASE || "";
if (
  !["localhost", "127.0.0.1", "::1"].includes(host) ||
  !/(?:_qa|_uat)$/.test(database) ||
  process.env.DATABASE_URL
) {
  throw new Error(
    "F11 database tests require explicit loopback PGHOST and disposable *_qa/*_uat PGDATABASE; DATABASE_URL is refused",
  );
}

const pool = new pg.Pool({ max: 12 });
let active = pool;
const query = (sql, values = []) => active.query(sql, values);
const passed = [];
const id = () => crypto.randomUUID();
const uuidText = (value = id()) => value;
const hash = (ch = "a") => ch.repeat(64);
const brandKey = () => `f11-${id()}.example`;
const isoAfter = (ms) => new Date(Date.now() + ms).toISOString();

async function rpc(name, args) {
  const entries = Object.entries(args);
  const result = await query(
    `SELECT public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(",")}) AS result`,
    entries.map(([, value]) =>
      value && typeof value === "object" ? JSON.stringify(value) : value,
    ),
  );
  return result.rows[0].result;
}

async function runGroup(name, fn) {
  const client = await pool.connect();
  const previous = active;
  try {
    await client.query("BEGIN");
    active = client;
    await fn();
    await client.query("ROLLBACK");
    passed.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    active = previous;
    client.release();
  }
}

async function createBrand(key = brandKey()) {
  await query(
    `INSERT INTO public.customer_brands(brand_key,display_name,website,website_host)
     VALUES($1,$2,$3,$4)`,
    [key, "F11 QA workspace", `https://${key}`, key],
  );
  return key;
}

async function createUser(userId = id()) {
  await query(
    "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())",
    [userId, `${userId}@example.test`],
  );
  return userId;
}

async function createRun({
  runId = id(),
  brand,
  userId = null,
  status = "queued",
  createdAt = null,
  holdId = null,
  prompt = "Synthetic F11 database fixture",
} = {}) {
  const columns = ["id", "brand_key", "created_by", "prompt", "prompt_hash", "models", "plan", "quote", "approved_max_usd", "status", "hold_id"];
  const values = [runId, brand, userId, prompt, hash(), ["chatgpt"], "[]", "{}", 1, status, holdId];
  if (createdAt) {
    columns.push("created_at");
    values.push(createdAt);
  }
  const placeholders = values.map((_, i) => `$${i + 1}`).join(",");
  await query(
    `INSERT INTO public.explore_runs(${columns.join(",")}) VALUES(${placeholders})`,
    values.map((value) => (Array.isArray(value) ? value : value)),
  );
  return runId;
}

async function seedExplore({
  observationId = id(),
  brand,
  runId = id(),
  queryText = `Synthetic explore prompt ${id()}`,
  context = {},
  engine = "chatgpt",
  circuitKey = `f11-circuit-${id()}`,
  deadlineAt = isoAfter(3_600_000),
} = {}) {
  const row = {
    id: observationId,
    purpose: "explore",
    job_id: null,
    engine,
    query: queryText,
    context: {
      explore_run_id: runId,
      prompt_hash: hash(),
      route: "dataforseo",
      model_name: "qa-model",
      web_search: true,
      country: "IN",
      ...context,
    },
    config_version: "f11-qa-v1",
    circuit_key: circuitKey,
    deadline_at: deadlineAt,
    brand_key: brand,
  };
  await rpc("seed_explore_observations", { p_rows: [row] });
  return row;
}

async function expectSqlFailure(work, pattern = null) {
  await query("SAVEPOINT expected_failure");
  let thrown = null;
  try {
    await work();
  } catch (error) {
    thrown = error;
  }
  await query("ROLLBACK TO SAVEPOINT expected_failure");
  await query("RELEASE SAVEPOINT expected_failure");
  assert.ok(thrown, "expected SQL statement to fail");
  if (pattern) assert.match(String(thrown.message), pattern);
  return thrown;
}

async function updateDispatchControl({ paused, canariesAllowed, allowlist }) {
  await query(
    `UPDATE public.probe_dispatch_control
        SET paused=$1, canaries_allowed=$2, brand_allowlist=$3
      WHERE singleton=true`,
    [paused, canariesAllowed, allowlist],
  );
}

async function claim(idValue, {
  reserve = 0.1,
  scanCap = 1,
  dayCap = null,
  leaseSeconds = 60,
} = {}) {
  return rpc("claim_probe_dispatch", {
    p_id: idValue,
    p_reserve: reserve,
    p_scan_cap: scanCap,
    p_day_cap: dayCap,
    p_lease_seconds: leaseSeconds,
  });
}

async function insertRegressionFixture(c) {
  const brand = await createBrand(c.brandKey);
  const isCanary = c.purpose === "canary";
  const jobId = isCanary ? null : c.jobId;
  if (!isCanary) {
    await query(
      `INSERT INTO public.scan_jobs(id,brand,brand_key,status,checkpoint)
       VALUES($1,$2,$3,'probing',$4)`,
      [jobId, brand, brand, JSON.stringify({ prompt_key: `qa-${jobId}` })],
    );
  }
  const context = {
    budget_scope: c.scope,
    max_requests: c.maxRequests ?? 100,
    request_units: c.requestUnits ?? 1,
    sourcing_cost: 0,
  };
  await query(
    `INSERT INTO public.probe_observations
       (id,job_id,purpose,engine,query,context,config_version,circuit_key,state,attempt_count,
        next_attempt_at,deadline_at,brand_key)
     VALUES($1,$2,$3,'chatgpt',$4,$5,'f11-regression-v1',$6,$7,$8,$9,$10,$11)`,
    [
      c.observationId,
      jobId,
      c.purpose,
      c.queryText,
      JSON.stringify(context),
      c.circuitKey,
      c.state ?? "pending",
      c.attemptCount ?? 0,
      c.nextAttemptAt ?? new Date(Date.now() - 1_000).toISOString(),
      c.deadlineAt ?? isoAfter(3_600_000),
      brand,
    ],
  );
  if (c.priorSpend) {
    const priorId = `prior-${id()}`;
    await query(
      `INSERT INTO public.probe_observations
         (id,job_id,purpose,engine,query,context,config_version,circuit_key,state,deadline_at,brand_key)
       VALUES($1,$2,$3,'chatgpt',$4,$5,'f11-regression-v1',$6,'answered',$7,$8)`,
      [
        priorId,
        jobId,
        c.purpose,
        `prior-${id()}`,
        JSON.stringify(context),
        c.circuitKey,
        isoAfter(3_600_000),
        brand,
      ],
    );
    await query(
      `INSERT INTO public.probe_attempts(observation_id,attempt_no,lease_token,reserved_usd,started_at)
       VALUES($1,1,$2,$3,now())`,
      [priorId, id(), c.priorSpend],
    );
  }
  if (c.priorCanaryRequest) {
    const priorId = `prior-${id()}`;
    await query(
      `INSERT INTO public.probe_observations
         (id,job_id,purpose,engine,query,context,config_version,circuit_key,state,deadline_at)
       VALUES($1,NULL,'canary','chatgpt',$2,$3,'f11-regression-v1',$4,'answered',$5)`,
      [
        priorId,
        `prior-${id()}`,
        JSON.stringify({ ...context, budget_scope: c.scope, request_units: 1, max_requests: 1 }),
        c.circuitKey,
        isoAfter(3_600_000),
      ],
    );
    await query(
      `INSERT INTO public.probe_attempts(observation_id,attempt_no,lease_token,reserved_usd,started_at)
       VALUES($1,1,$2,0.01,now())`,
      [priorId, id()],
    );
  }
  if (c.openCircuit) {
    await query(
      `INSERT INTO public.provider_dispatch_circuits(circuit_key,open_until,failure)
       VALUES($1,now()+interval '15 minutes','{}'::jsonb) ON CONFLICT(circuit_key) DO UPDATE
       SET open_until=excluded.open_until,failure=excluded.failure`,
      [c.circuitKey],
    );
  }
  return { brand, jobId };
}

function normalizeClaim(result) {
  if (!result || typeof result !== "object") return result;
  const copy = { ...result };
  delete copy.lease_token;
  delete copy.lease_until;
  return copy;
}

async function invokeClaim(functionName, c) {
  await query("SAVEPOINT invoke_claim");
  let result = null;
  let error = null;
  try {
    result = await rpc(functionName, {
      p_id: c.observationId,
      p_reserve: c.reserve ?? 0.1,
      p_scan_cap: c.scanCap ?? 10,
      p_day_cap: c.dayCap ?? null,
      p_lease_seconds: c.leaseSeconds ?? 60,
    });
  } catch (thrown) {
    error = String(thrown?.message ?? thrown);
    await query("ROLLBACK TO SAVEPOINT invoke_claim");
  }
  const stateResult = await query(
    `SELECT state,reason,attempt_count,(lease_until IS NOT NULL) AS leased
       FROM public.probe_observations WHERE id=$1`,
    [c.observationId],
  );
  const attemptResult = await query(
    `SELECT attempt_no,dispatch_state,reserved_usd,cost_state
       FROM public.probe_attempts WHERE observation_id=$1 ORDER BY attempt_no`,
    [c.observationId],
  );
  await query("ROLLBACK TO SAVEPOINT invoke_claim");
  await query("RELEASE SAVEPOINT invoke_claim");
  return {
    result: normalizeClaim(result),
    error: error?.replace(/claim_probe_dispatch_035/g, "claim_probe_dispatch"),
    state: stateResult.rows[0] ?? null,
    attempts: attemptResult.rows,
  };
}

async function compareClaimCase(c) {
  await query("SAVEPOINT regression_pair");
  await updateDispatchControl({
    paused: c.paused ?? false,
    canariesAllowed: c.canariesAllowed ?? false,
    allowlist: c.allowlist ?? [],
  });
  await insertRegressionFixture(c);
  const baseline = await invokeClaim("claim_probe_dispatch_035", c);
  await query("ROLLBACK TO SAVEPOINT regression_pair");

  await updateDispatchControl({
    paused: c.paused ?? false,
    canariesAllowed: c.canariesAllowed ?? false,
    allowlist: c.allowlist ?? [],
  });
  await insertRegressionFixture(c);
  const current = await invokeClaim("claim_probe_dispatch", c);
  await query("ROLLBACK TO SAVEPOINT regression_pair");
  await query("RELEASE SAVEPOINT regression_pair");
  assert.deepEqual(current, baseline, `035 claim behavior changed for case ${c.name}`);
}

try {
  await runGroup("explore-shape", async () => {
    const catalog = await query(
      `SELECT c.relrowsecurity, p.policyname, p.roles, p.cmd, p.qual
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         LEFT JOIN pg_policies p ON p.schemaname=n.nspname AND p.tablename=c.relname
        WHERE n.nspname='public' AND c.relname='explore_runs'`,
    );
    assert.equal(catalog.rows[0]?.relrowsecurity, true);
    assert.ok(catalog.rows.some((row) => row.policyname === "explore_runs_read" && row.cmd === "SELECT"));
    const requiredColumns = [
      "id", "brand_key", "created_by", "job_id", "prompt", "prompt_hash", "models", "web_search",
      "country", "highlight_brand", "status", "plan", "quote", "approved_max_usd", "hold_id",
      "question_id", "created_at", "finished_at",
    ];
    const columns = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='explore_runs'`,
    );
    const columnNames = new Set(columns.rows.map((row) => row.column_name));
    for (const column of requiredColumns) assert.ok(columnNames.has(column), `missing explore_runs.${column}`);
    const indexes = await query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='explore_runs'`,
    );
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    for (const name of ["explore_runs_brand_idx", "explore_runs_user_idx", "explore_runs_active_idx"])
      assert.ok(indexNames.has(name), `missing ${name}`);
    const grants = await query(
      `SELECT has_table_privilege('authenticated','public.explore_runs','SELECT') AS customer_read,
              has_table_privilege('authenticated','public.explore_runs','INSERT') AS customer_insert,
              has_table_privilege('anon','public.explore_runs','SELECT') AS anonymous_read`,
    );
    assert.equal(grants.rows[0].customer_read, true);
    assert.equal(grants.rows[0].customer_insert, false);
    assert.equal(grants.rows[0].anonymous_read, false);
    const functions = await query(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND proname = ANY($1::text[])`,
      [["seed_explore_observations", "claim_probe_dispatch", "f11_upsert_explore_attempt_rows", "settle_explore_hold", "settle_finished_explore_holds", "prune_explore_runs"]],
    );
    assert.equal(functions.rows.length, 6);
    const addedColumn = await query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='probe_observations' AND column_name='brand_key'`,
    );
    assert.equal(addedColumn.rows[0]?.is_nullable, "YES");
    const shapeConstraint = await query(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='public.probe_observations'::regclass AND conname='probe_observations_explore_shape'`,
    );
    assert.match(shapeConstraint.rows[0]?.definition ?? "", /explore_run_id/);

    const brandA = await createBrand();
    const brandB = await createBrand();
    const userA = await createUser();
    const userB = await createUser();
    await query(
      `INSERT INTO public.customer_brand_memberships(user_id,brand_key) VALUES($1,$2),($3,$4)`,
      [userA, brandA, userB, brandB],
    );
    const runA = await createRun({ brand: brandA, userId: userA, prompt: "synthetic tenant A" });
    const runB = await createRun({ brand: brandB, userId: userB, prompt: "synthetic tenant B" });
    await query("SET LOCAL ROLE authenticated");
    await query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userA]);
    let visible = await query("SELECT id FROM public.explore_runs ORDER BY id");
    assert.deepEqual(visible.rows.map((row) => row.id), [runA]);
    await query("RESET ROLE");
    await query("SET LOCAL ROLE authenticated");
    await query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userB]);
    visible = await query("SELECT id FROM public.explore_runs ORDER BY id");
    assert.deepEqual(visible.rows.map((row) => row.id), [runB]);
  });

  await runGroup("explore-fence", async () => {
    const allowedBrand = await createBrand();
    const otherBrand = await createBrand();
    const allowedRun = id();
    const allowed = await seedExplore({ brand: allowedBrand, runId: allowedRun });
    await updateDispatchControl({ paused: true, canariesAllowed: false, allowlist: [allowedBrand] });
    const granted = await claim(allowed.id, { scanCap: 1 });
    assert.equal(granted.granted, true, "the paused allowlisted explore brand must be claimable");

    const blocked = await seedExplore({ brand: otherBrand, runId: id() });
    const denied = await claim(blocked.id, { scanCap: 1 });
    assert.deepEqual(denied, { granted: false, reason: "dispatch_paused" });
    assert.equal((await query("SELECT state FROM public.probe_observations WHERE id=$1", [blocked.id])).rows[0].state, "blocked");

    await updateDispatchControl({ paused: true, canariesAllowed: true, allowlist: [] });
    const canaryOnly = await seedExplore({ brand: otherBrand, runId: id() });
    assert.deepEqual(await claim(canaryOnly.id, { scanCap: 1 }), { granted: false, reason: "dispatch_paused" });

    await updateDispatchControl({ paused: false, canariesAllowed: false, allowlist: [] });
    const runOne = id();
    const runTwo = id();
    const first = await seedExplore({ brand: allowedBrand, runId: runOne });
    assert.equal((await claim(first.id, { reserve: 0.1, scanCap: 0.15 })).granted, true);
    const sameRun = await seedExplore({ brand: allowedBrand, runId: runOne });
    assert.deepEqual(await claim(sameRun.id, { reserve: 0.1, scanCap: 0.15 }), { granted: false, reason: "spend_reservation_refused" });
    const otherRun = await seedExplore({ brand: allowedBrand, runId: runTwo });
    assert.equal((await claim(otherRun.id, { reserve: 0.1, scanCap: 0.15 })).granted, true);

    const missingCap = await seedExplore({ brand: allowedBrand, runId: id() });
    await expectSqlFailure(
      () => claim(missingCap.id, { scanCap: null }),
      /explore requires an approved run cap/,
    );

    const circuit = `f11-open-${id()}`;
    await query(
      `INSERT INTO public.provider_dispatch_circuits(circuit_key,open_until,failure)
       VALUES($1,now()+interval '15 minutes','{}'::jsonb)`,
      [circuit],
    );
    const circuitRow = await seedExplore({ brand: allowedBrand, runId: id(), circuitKey: circuit });
    assert.deepEqual(await claim(circuitRow.id, { scanCap: 1 }), { granted: false, reason: "provider_circuit_open" });
  });

  await runGroup("claim-regression", async () => {
    const migrationPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations/035_scoped_provider_rollout.sql");
    const source = await readFile(migrationPath, "utf8");
    const functionMatch = source.match(/CREATE OR REPLACE FUNCTION claim_probe_dispatch\([\s\S]*?\$\$;/);
    assert.ok(functionMatch, "migration 035 claim function must exist for regression copy");
    const copied = functionMatch[0].replace(
      "CREATE OR REPLACE FUNCTION claim_probe_dispatch(",
      "CREATE OR REPLACE FUNCTION public.claim_probe_dispatch_035(",
    );
    await query(copied);

    const cases = [
      { name: "unpaused scan grant", purpose: "scan" },
      { name: "paused nonallowlisted scan", purpose: "scan", paused: true },
      { name: "paused allowlisted scan", purpose: "scan", paused: true, allowlist: "self" },
      { name: "paused canary allowed", purpose: "canary", paused: true, canariesAllowed: true },
      { name: "paused canary denied", purpose: "canary", paused: true },
      { name: "future retry due time", purpose: "scan", nextAttemptAt: isoAfter(600_000) },
      { name: "attempt limit", purpose: "scan", attemptCount: 3 },
      { name: "deadline elapsed", purpose: "scan", deadlineAt: new Date(Date.now() - 1_000).toISOString() },
      { name: "lease exceeds deadline", purpose: "scan", deadlineAt: isoAfter(15_000), leaseSeconds: 60 },
      { name: "open provider circuit", purpose: "scan", openCircuit: true },
      { name: "scan cap refused", purpose: "scan", priorSpend: 0.5, scanCap: 0.25 },
      { name: "canary request budget refused", purpose: "canary", priorCanaryRequest: true, maxRequests: 1 },
    ];
    for (const entry of cases) {
      const brand = brandKey();
      const c = {
        ...entry,
        brandKey: brand,
        observationId: `f11-regression-${id()}`,
        jobId: id(),
        queryText: `f11 regression ${entry.name} ${id()}`,
        circuitKey: `f11-regression-circuit-${id()}`,
        scope: `f11-regression-scope-${id()}`,
        allowlist: entry.allowlist === "self" ? [brand] : [],
        nextAttemptAt: entry.nextAttemptAt,
        deadlineAt: entry.deadlineAt,
      };
      await compareClaimCase(c);
    }
  });

  await runGroup("explore-isolation", async () => {
    const brand = await createBrand();
    const runId = id();
    const row = await seedExplore({ brand, runId, queryText: `F11 isolated ${id()}` });
    await updateDispatchControl({ paused: false, canariesAllowed: false, allowlist: [] });
    const leased = await claim(row.id, { reserve: 0.1, scanCap: 1, leaseSeconds: 60 });
    assert.equal(leased.granted, true);
    const finished = await rpc("finish_probe_dispatch", {
      p_id: row.id,
      p_token: leased.lease_token,
      p_result: {
        engine: "chatgpt",
        answer_present: true,
        text: "Synthetic answer body",
        brand_mentioned_in_text: false,
        brand_cited: false,
        cost: 0.03,
        brands: [],
        provenance: { gateway: "qa" },
      },
      p_state: "answered",
      p_failure: null,
      p_next_at: null,
    });
    assert.equal(finished.accepted, true);
    const state = await query("SELECT state,job_id FROM public.probe_observations WHERE id=$1", [row.id]);
    assert.equal(state.rows[0].state, "answered");
    assert.equal(state.rows[0].job_id, null);
    const projected = await query("SELECT count(*)::int AS n FROM public.prompt_results WHERE query=$1", [row.query]);
    assert.equal(projected.rows[0].n, 0);
  });

  await runGroup("explore-ledger", async () => {
    const brand = await createBrand();
    const user = await createUser();
    const runId = id();
    const holdId = id();
    await query(
      `INSERT INTO public.spend_holds
         (id,brand_key,feature,idempotency_key,subject_kind,subject_id,estimate_usd,max_usd,status,expires_at)
       VALUES($1,$2,'ai_visibility.explore',$3,'explore_run',$4,0.10,1,'held',now()+interval '1 hour')`,
      [holdId, brand, `f11-${runId}`, runId],
    );
    await createRun({ brand, userId: user, runId, holdId, status: "completed" });
    const row = await seedExplore({ brand, runId, context: { explore_run_id: runId } });
    await updateDispatchControl({ paused: false, canariesAllowed: false, allowlist: [] });
    const leased = await claim(row.id, { reserve: 0.1, scanCap: 1, leaseSeconds: 60 });
    assert.equal(leased.granted, true);
    await rpc("finish_probe_dispatch", {
      p_id: row.id,
      p_token: leased.lease_token,
      p_result: {
        engine: "chatgpt",
        answer_present: true,
        text: "Synthetic answer body",
        brand_mentioned_in_text: false,
        brand_cited: false,
        cost: 0.04,
        cost_source: "gateway",
        provenance: { gateway: "dataforseo" },
        brands: [],
      },
      p_state: "answered",
      p_failure: null,
      p_next_at: null,
    });
    const settled = await rpc("settle_explore_hold", { p_run: runId });
    assert.equal(settled.settled, true);
    assert.equal(settled.rows, 1);
    assert.equal(Number(settled.actual_usd), 0.04);
    assert.equal(settled.unknown, false);
    const ledger = await query(
      `SELECT brand_key,feature,hold_id,source_ref,provider,endpoint,actual_usd,accounted_usd,
              cost_source,subject_kind,subject_id,answer_ref
         FROM public.spend_ledger WHERE subject_kind='explore_run' AND subject_id=$1`,
      [runId],
    );
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0].brand_key, brand);
    assert.equal(ledger.rows[0].feature, "ai_visibility.explore");
    assert.equal(ledger.rows[0].hold_id, holdId);
    assert.equal(ledger.rows[0].source_ref, `probe_attempt:${row.id}:1`);
    assert.equal(ledger.rows[0].provider, "dataforseo");
    assert.equal(ledger.rows[0].endpoint, "probe:chatgpt");
    assert.equal(Number(ledger.rows[0].actual_usd), 0.04);
    assert.equal(Number(ledger.rows[0].accounted_usd), 0.04);
    assert.equal(ledger.rows[0].cost_source, "provider_reported");
    assert.equal(ledger.rows[0].subject_kind, "explore_run");
    assert.equal(ledger.rows[0].subject_id, runId);
    assert.equal(ledger.rows[0].answer_ref, row.id);
    const hold = await query("SELECT status,actual_usd FROM public.spend_holds WHERE id=$1", [holdId]);
    assert.equal(hold.rows[0].status, "settled");
    assert.equal(Number(hold.rows[0].actual_usd), 0.04);
    const duplicate = await rpc("settle_explore_hold", { p_run: runId });
    assert.equal(duplicate.settled, false);
    assert.equal((await query("SELECT count(*)::int AS n FROM public.spend_ledger WHERE subject_id=$1", [runId])).rows[0].n, 1);
  });

  await runGroup("explore-retention", async () => {
    const brand = await createBrand();
    const user = await createUser();
    const expiredId = await createRun({ brand, userId: user, createdAt: isoAfter(-396 * 86_400_000), prompt: "expired synthetic run" });
    const recentId = await createRun({ brand, userId: user, createdAt: isoAfter(-394 * 86_400_000), prompt: "recent synthetic run" });
    const expiredObservation = `f11-retention-${id()}`;
    const recentObservation = `f11-retention-${id()}`;
    await seedExplore({ observationId: expiredObservation, brand, runId: expiredId });
    await seedExplore({ observationId: recentObservation, brand, runId: recentId });
    const deleted = await rpc("prune_explore_runs", {
      p_before: isoAfter(-395 * 86_400_000),
      p_limit: 1000,
    });
    assert.equal(deleted, 1);
    const runs = await query("SELECT id FROM public.explore_runs WHERE id=ANY($1::uuid[])", [[expiredId, recentId]]);
    assert.deepEqual(runs.rows.map((row) => row.id), [recentId]);
    const observations = await query(
      "SELECT id FROM public.probe_observations WHERE id=ANY($1::text[]) ORDER BY id",
      [[expiredObservation, recentObservation]],
    );
    assert.equal(observations.rows.length, 2, "run pruning must leave probe observations untouched");
  });

  console.log(`ok ${passed.length} groups`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
