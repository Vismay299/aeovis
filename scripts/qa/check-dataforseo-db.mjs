#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

const host = process.env.PGHOST;
const database = process.env.PGDATABASE;
if (!["127.0.0.1", "localhost", "::1"].includes(host) || !/(?:_qa|_uat)$/.test(database ?? "") || process.env.DATABASE_URL) {
  console.error("Explicit loopback QA database required; DATABASE_URL refused");
  process.exit(2);
}
const groupIndex = process.argv.indexOf("--group");
const requested = new Set((groupIndex >= 0 ? process.argv[groupIndex + 1] : "")?.split(",").filter(Boolean) ?? []);
const supported = new Set(["bakeoff-ceiling", "posted-states", "collect-projection", "queued-flow", "posted-sweep"]);
if (!requested.size || [...requested].some((name) => !supported.has(name))) {
  console.error(`Expected --group ${[...supported].join(",")}`);
  process.exit(2);
}

const pool = new pg.Pool({ max: 4 });
const q = (sql, values = []) => pool.query(sql, values);
const runId = crypto.randomUUID();
const scope = `f02-queued-${runId}`;
const observationIds = [];
const jobIds = [];
const passed = [];

async function rpc(name, values) {
  const entries = Object.entries(values);
  const result = await q(
    `select ${name}(${entries.map(([key], index) => `${key}=>$${index + 1}`).join(",")}) result`,
    entries.map(([, value]) => value && typeof value === "object" ? JSON.stringify(value) : value),
  );
  return result.rows[0].result;
}

function observation({ jobId = null, engine = "chatgpt", query, suffix, deadlineMs = Date.now() + 3_600_000 }) {
  const id = crypto.randomUUID();
  observationIds.push(id);
  return {
    id,
    job_id: jobId,
    purpose: jobId ? "scan" : "canary",
    engine,
    query,
    context: { budget_scope: scope, max_requests: 100, request_units: 1 },
    config_version: `f02-queued-db-${runId}`,
    circuit_key: `${scope}-${suffix}`,
    deadline_at: new Date(deadlineMs).toISOString(),
  };
}

async function seed(rows) {
  await rpc("seed_probe_observations", { p_rows: rows });
}

async function claim(row, reserve = 0.01) {
  const result = await rpc("claim_probe_dispatch", {
    p_id: row.id,
    p_reserve: reserve,
    p_scan_cap: row.purpose === "canary" ? 1 : null,
    p_day_cap: null,
    p_lease_seconds: 120,
  });
  return result;
}

async function addScanJob(promptKey = "f02-queued-db", brand = promptKey) {
  const id = crypto.randomUUID();
  jobIds.push(id);
  await q("INSERT INTO scan_jobs(id,brand,status,checkpoint) VALUES($1,$2,'probing',$3)", [
    id,
    brand,
    JSON.stringify({ prompt_key: promptKey }),
  ]);
  return id;
}

async function runBakeoffCeiling() {
  const rows = Array.from({ length: 10 }, (_, index) => observation({
    query: `Synthetic QA query ${index + 1}`,
    suffix: `bakeoff-${index}`,
  }));
  await seed(rows);
  let providerCalls = 0;
  let granted = 0;
  let refused = null;
  for (const [index, row] of rows.slice(0, 6).entries()) {
    const result = await rpc("claim_probe_dispatch", {
      p_id: row.id,
      p_reserve: 0.01,
      p_scan_cap: 0.05,
      p_day_cap: null,
      p_lease_seconds: 120,
    });
    if (!result.granted) {
      refused = result.reason;
      assert.equal(index, 5, "the 6th reservation must be refused");
      break;
    }
    granted++;
    providerCalls++; // synthetic provider: no network request is made
    const finished = await rpc("finish_probe_dispatch", {
      p_id: row.id,
      p_token: result.lease_token,
      p_result: { answer_present: true, cost: 0.01 },
      p_state: "answered",
      p_failure: null,
      p_next_at: null,
    });
    assert.equal(finished.accepted, true);
  }
  assert.equal(granted, 5);
  assert.equal(refused, "spend_reservation_refused");
  assert.equal(providerCalls, 5);
  passed.push("bakeoff-ceiling");
}

async function runPostedStates() {
  const stale = observation({ query: `stale post ${runId}`, suffix: "stale" });
  const posted = observation({ query: `accepted post ${runId}`, suffix: "posted" });
  await seed([stale, posted]);

  const staleClaim = await claim(stale);
  assert.equal(staleClaim.granted, true);
  await q("UPDATE probe_observations SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1", [stale.id]);
  const late = await rpc("post_probe_dispatch", {
    p_id: stale.id,
    p_token: staleClaim.lease_token,
    p_task_id: `late-${runId}`,
    p_post_cost: 0.01,
    p_next_at: new Date(Date.now() + 120_000).toISOString(),
    p_collect_until: new Date(Date.now() + 1_800_000).toISOString(),
  });
  assert.equal(late.accepted, false);
  assert.equal(late.reason, "stale_lease");
  assert.equal(late.late_receipt, true);
  const staleRow = await q("SELECT state,reason FROM probe_observations WHERE id=$1", [stale.id]);
  assert.equal(staleRow.rows[0].state, "ambiguous");
  assert.equal(staleRow.rows[0].reason, "late_post");
  const receipt = await q("SELECT count(*)::int n FROM probe_late_receipts WHERE observation_id=$1", [stale.id]);
  assert.equal(receipt.rows[0].n, 1);

  const postedClaim = await claim(posted);
  const accepted = await rpc("post_probe_dispatch", {
    p_id: posted.id,
    p_token: postedClaim.lease_token,
    p_task_id: `task-${runId}`,
    p_post_cost: 0.01,
    p_next_at: new Date(Date.now() + 120_000).toISOString(),
    p_collect_until: new Date(Date.now() + 1_800_000).toISOString(),
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.duplicate, false);
  const refused = await claim(posted);
  assert.equal(refused.granted, false);
  assert.equal(refused.reason, "posted");
  passed.push("posted-states");
}

async function runCollectProjection() {
  const promptKey = `f02-projection-${runId}`;
  const jobA = await addScanJob(promptKey, `${promptKey}-a`);
  const jobB = await addScanJob(promptKey, `${promptKey}-b`);
  const first = observation({ jobId: jobA, query: `projection-${runId}`, suffix: "projection-a" });
  const second = observation({ jobId: jobB, query: first.query, suffix: "projection-b" });
  await seed([first, second]);
  const result = {
    engine: "chatgpt",
    answer_present: true,
    brand_mentioned_in_text: true,
    brand_cited: false,
    intent_tier: "informational",
    is_branded_query: false,
    text: "Acme is a relevant option.",
    cost: 0.01,
    brands: [{ is_self: true, position: 3, sentiment: 7 }],
  };
  const firstClaim = await claim(first);
  await rpc("finish_probe_dispatch", {
    p_id: first.id,
    p_token: firstClaim.lease_token,
    p_result: result,
    p_state: "answered",
    p_failure: null,
    p_next_at: null,
  });
  const expected = await q(
    "SELECT brand,query,engine,answered,mentioned,brand_cited,intent,is_branded_query,answer_text,raw,position,sentiment FROM prompt_results WHERE job_id=$1",
    [jobA],
  );

  const secondClaim = await claim(second);
  await rpc("post_probe_dispatch", {
    p_id: second.id,
    p_token: secondClaim.lease_token,
    p_task_id: `projection-task-${runId}`,
    p_post_cost: 0.01,
    p_next_at: new Date(Date.now() + 120_000).toISOString(),
    p_collect_until: new Date(Date.now() + 1_800_000).toISOString(),
  });
  const collected = await rpc("collect_probe_dispatch", {
    p_id: second.id,
    p_token: secondClaim.lease_token,
    p_result: result,
    p_state: "answered",
    p_failure: null,
    p_next_at: null,
    p_settled_cost: 0.01,
  });
  assert.equal(collected.accepted, true);
  const actual = await q(
    "SELECT brand,query,engine,answered,mentioned,brand_cited,intent,is_branded_query,answer_text,raw,position,sentiment FROM prompt_results WHERE job_id=$1",
    [jobB],
  );
  assert.deepEqual(actual.rows[0], expected.rows[0]);

  const duplicate = await rpc("collect_probe_dispatch", {
    p_id: second.id,
    p_token: secondClaim.lease_token,
    p_result: result,
    p_state: "answered",
    p_failure: null,
    p_next_at: null,
    p_settled_cost: 0.01,
  });
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.duplicate, true);

  const refund = observation({ query: `refund-${runId}`, suffix: "refund" });
  const overcharge = observation({ query: `overcharge-${runId}`, suffix: "overcharge" });
  await seed([refund, overcharge]);
  for (const [row, settled] of [[refund, 0.005], [overcharge, 0.02]]) {
    const held = await claim(row);
    await rpc("post_probe_dispatch", {
      p_id: row.id,
      p_token: held.lease_token,
      p_task_id: `task-${row.id}`,
      p_post_cost: 0.01,
      p_next_at: new Date(Date.now() + 120_000).toISOString(),
      p_collect_until: new Date(Date.now() + 1_800_000).toISOString(),
    });
    await rpc("collect_probe_dispatch", {
      p_id: row.id,
      p_token: held.lease_token,
      p_result: { answer_present: false, cost: 0.01 },
      p_state: "failed",
      p_failure: { kind: "provider_capacity", opens_circuit: false },
      p_next_at: null,
      p_settled_cost: settled,
    });
  }
  const costs = await q("SELECT id,total_cost FROM probe_observations WHERE id = ANY($1::text[])", [[refund.id, overcharge.id]]);
  const costById = Object.fromEntries(costs.rows.map((row) => [row.id, Number(row.total_cost)]));
  assert.equal(costById[refund.id], 0.005);
  assert.equal(costById[overcharge.id], 0.01);
  passed.push("collect-projection");
}

async function runQueuedFlow() {
  const row = observation({ query: `queued-flow-${runId}`, suffix: "flow" });
  await seed([row]);
  const held = await claim(row);
  const firstNext = new Date(Date.now() + 4 * 60_000).toISOString();
  const posted = await rpc("post_probe_dispatch", {
    p_id: row.id,
    p_token: held.lease_token,
    p_task_id: `flow-task-${runId}`,
    p_post_cost: 0.01,
    p_next_at: firstNext,
    p_collect_until: new Date(Date.now() + 1_800_000).toISOString(),
  });
  assert.equal(posted.accepted, true);
  assert.equal(await rpc("reschedule_probe_collection", {
    p_id: row.id,
    p_token: held.lease_token,
    p_next_at: new Date(Date.now() + 7 * 60_000).toISOString(),
  }), true);
  const retryAt = new Date(Date.now() + 2 * 60_000).toISOString();
  const collected = await rpc("collect_probe_dispatch", {
    p_id: row.id,
    p_token: held.lease_token,
    p_result: { answer_present: false, error: "Temporary backend failure", cost: 0.01 },
    p_state: "retry",
    p_failure: { kind: "transient", opens_circuit: false, retryable: true },
    p_next_at: retryAt,
    p_settled_cost: null,
  });
  assert.equal(collected.accepted, true);
  const current = await q("SELECT state,total_cost FROM probe_observations WHERE id=$1", [row.id]);
  assert.equal(current.rows[0].state, "retry");
  assert.equal(Number(current.rows[0].total_cost), 0.01);
  assert.equal((await claim(row)).reason, "not_due");
  passed.push("queued-flow");
}

async function runPostedSweep() {
  const row = observation({ query: `posted-sweep-${runId}`, suffix: "sweep" });
  await seed([row]);
  const held = await claim(row);
  await rpc("post_probe_dispatch", {
    p_id: row.id,
    p_token: held.lease_token,
    p_task_id: `sweep-task-${runId}`,
    p_post_cost: 0.01,
    p_next_at: new Date(Date.now() - 60_000).toISOString(),
    p_collect_until: new Date(Date.now() - 1_000).toISOString(),
  });
  const expired = await rpc("expire_posted_probe_dispatch", { p_limit: 200 });
  assert.ok(expired >= 1);
  const current = await q("SELECT state,reason,total_cost FROM probe_observations WHERE id=$1", [row.id]);
  assert.equal(current.rows[0].state, "failed");
  assert.equal(current.rows[0].reason, "not_collected");
  assert.equal(Number(current.rows[0].total_cost), 0.01);
  passed.push("posted-sweep");
}

try {
  if (requested.has("bakeoff-ceiling")) await runBakeoffCeiling();
  if (requested.has("posted-states")) await runPostedStates();
  if (requested.has("collect-projection")) await runCollectProjection();
  if (requested.has("queued-flow")) await runQueuedFlow();
  if (requested.has("posted-sweep")) await runPostedSweep();
  console.log(`ok ${passed.length} ${passed.join(",")}`);
} catch (error) {
  const failed = [...requested].filter((group) => !passed.includes(group));
  console.error(`${failed.join(",")} database group failed: ${error?.message || "assertion failed"}`);
  process.exitCode = 1;
} finally {
  try {
    if (jobIds.length) await q("DELETE FROM prompt_results WHERE job_id = ANY($1::uuid[])", [jobIds]);
    if (observationIds.length) {
      await q("DELETE FROM probe_late_receipts WHERE observation_id = ANY($1::text[])", [observationIds]);
      await q("DELETE FROM probe_attempts WHERE observation_id = ANY($1::text[])", [observationIds]);
      await q("DELETE FROM probe_observations WHERE id = ANY($1::text[])", [observationIds]);
      await q("DELETE FROM provider_dispatch_circuits WHERE circuit_key LIKE $1", [`${scope}-%`]);
    }
    if (jobIds.length) await q("DELETE FROM scan_jobs WHERE id = ANY($1::uuid[])", [jobIds]);
    await q("DELETE FROM provider_canary_budgets WHERE scope = $1", [scope]);
  } catch {
    process.exitCode = 1;
  }
  await pool.end();
}
