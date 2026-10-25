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
const group = groupIndex >= 0 ? process.argv[groupIndex + 1] : null;
if (group !== "bakeoff-ceiling") {
  console.error("Expected --group bakeoff-ceiling");
  process.exit(2);
}
const pool = new pg.Pool({ max: 4 });
const q = (sql, values = []) => pool.query(sql, values);
const scope = `f02-bakeoff-ceiling-${crypto.randomUUID()}`;
const rows = Array.from({ length: 10 }, (_, index) => {
  const id = crypto.randomUUID();
  return {
    id,
    job_id: null,
    purpose: "canary",
    engine: "chatgpt",
    query: `Synthetic QA query ${index + 1}`,
    context: { budget_scope: scope, max_requests: 10, request_units: 1 },
    config_version: "f02-bakeoff-ceiling-test-v1",
    circuit_key: `${scope}-${index}`,
    deadline_at: new Date(Date.now() + 600_000).toISOString(),
  };
});
async function rpc(name, values) {
  const entries = Object.entries(values);
  const result = await q(`select ${name}(${entries.map(([key], index) => `${key}=>$${index + 1}`).join(",")}) result`, entries.map(([, value]) => value && typeof value === "object" ? JSON.stringify(value) : value));
  return result.rows[0].result;
}
try {
  await rpc("seed_probe_observations", { p_rows: rows });
  let providerCalls = 0;
  let granted = 0;
  let refused = null;
  for (const [index, row] of rows.slice(0, 6).entries()) {
    const claim = await rpc("claim_probe_dispatch", { p_id: row.id, p_reserve: 0.01, p_scan_cap: 0.05, p_day_cap: null, p_lease_seconds: 120 });
    if (!claim.granted) {
      refused = claim.reason;
      assert.equal(index, 5, "the 6th reservation must be refused");
      break;
    }
    granted += 1;
    providerCalls += 1; // synthetic provider: no network request is made
    const finished = await rpc("finish_probe_dispatch", { p_id: row.id, p_token: claim.lease_token, p_result: { answer_present: true, cost: 0.01 }, p_state: "answered", p_failure: null, p_next_at: null });
    assert.equal(finished.accepted, true);
  }
  assert.equal(granted, 5);
  assert.equal(refused, "spend_reservation_refused");
  assert.equal(providerCalls, 5);
  console.log("ok 1 bakeoff-ceiling");
} catch {
  console.error("bakeoff-ceiling database group failed");
  process.exitCode = 1;
} finally {
  try {
    await q("DELETE FROM probe_late_receipts WHERE observation_id = ANY($1::text[])", [rows.map((row) => row.id)]);
    await q("DELETE FROM probe_attempts WHERE observation_id = ANY($1::text[])", [rows.map((row) => row.id)]);
    await q("DELETE FROM probe_observations WHERE id = ANY($1::text[])", [rows.map((row) => row.id)]);
    await q("DELETE FROM provider_canary_budgets WHERE scope = $1", [scope]);
    await q("DELETE FROM provider_dispatch_circuits WHERE circuit_key LIKE $1", [`${scope}-%`]);
  } catch { process.exitCode = 1; }
  await pool.end();
}