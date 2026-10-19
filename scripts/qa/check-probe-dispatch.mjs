#!/usr/bin/env node
// Dedicated real-PostgreSQL contract job; never part of offline npm tests.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import pg from "pg";
import {
  createProbeDispatchStore,
  resultDecision,
} from "../../src/lib/db/probeDispatch.js";
import { runDurableProbing } from "../../src/lib/workers/durableProbing.js";
const host = process.env.PGHOST || "";
const database = process.env.PGDATABASE || "";
if (
  !["localhost", "127.0.0.1", "::1"].includes(host) ||
  !/(?:_qa|_uat)$/.test(database) ||
  process.env.DATABASE_URL
) {
  throw new Error(
    "Dispatch database tests require explicit loopback PGHOST and disposable *_qa/*_uat PGDATABASE; DATABASE_URL is refused",
  );
}
const pool = new pg.Pool({ max: 24 });
const passed = [];
const query = (sql, values = []) => pool.query(sql, values);
async function rpc(name, args) {
  const entries = Object.entries(args);
  const result = await query(
    `SELECT ${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(",")}) AS result`,
    entries.map(([, v]) =>
      typeof v === "object" && v !== null ? JSON.stringify(v) : v,
    ),
  );
  return result.rows[0].result;
}
const store = createProbeDispatchStore({
  rpc: async (name, args) => ({ data: await rpc(name, args), error: null }),
});
store.list = async (jobId) =>
  (
    await query(
      "SELECT * FROM probe_observations WHERE job_id=$1 ORDER BY created_at",
      [jobId],
    )
  ).rows;
const budget = { reserve: 0.1, scanCap: 10, dayCap: null };
async function fixture(
  count = 1,
  {
    circuit = crypto.randomUUID(),
    purpose = "scan",
    scope = crypto.randomUUID(),
  } = {},
) {
  const jobId = crypto.randomUUID();
  const cp = {
    brand: "Acme",
    url: "https://acme.example",
    prompt_key: `qa-${jobId}`,
    engines: ["chatgpt"],
    queries: Array.from({ length: count }, (_, i) => ({
      text: `Fixture question ${i}?`,
    })),
    geo: { country: "in" },
    stats: { cost: 0 },
  };
  await query(
    "INSERT INTO scan_jobs(id,brand,status,checkpoint) VALUES($1,$2,'probing',$3)",
    [jobId, cp.prompt_key, JSON.stringify(cp)],
  );
  const rows = cp.queries.map((q) => ({
    id: crypto.randomUUID(),
    job_id: purpose === "scan" ? jobId : null,
    purpose,
    engine: "chatgpt",
    query: q.text,
    context: {
      sourcing_cost: 0,
      budget_scope: scope,
      max_requests: 100,
      request_units: 1,
    },
    config_version: "fixture-v1",
    circuit_key: circuit,
    deadline_at: new Date(Date.now() + 3600_000).toISOString(),
  }));
  await store.seed(rows);
  return { jobId, cp, rows };
}
function result(row, overrides = {}) {
  return {
    engine: row.engine,
    prompt: row.query,
    answer_present: true,
    text: "Acme is an option.",
    brand_mentioned_in_text: true,
    brand_cited: false,
    cost: 0.02,
    brands: [],
    ...overrides,
  };
}
async function finish(row, claim, overrides = {}) {
  const r = result(row, overrides);
  return store.finish(
    row.id,
    claim.lease_token,
    r,
    resultDecision(r, claim.attempt_no, Date.now() + 3600_000),
  );
}
async function run(ids, fn) {
  await fn();
  passed.push(...ids);
  console.log(`PASS ${ids.join(", ")}`);
}
try {
  await run(["R02-07", "R02-09", "R01-13"], async () => {
    const { rows } = await fixture(1, { purpose: "canary" });
    const id = rows[0].id;
    const claims = await Promise.all(
      Array.from({ length: 20 }, () => store.claim(id, budget)),
    );
    assert.equal(claims.filter((c) => c.granted).length, 1);
    assert.equal((await store.claim(id, budget)).reason, "leased");
    assert.equal(
      await rpc("renew_probe_dispatch", {
        p_id: id,
        p_token: claims.find((c) => c.granted).lease_token,
        p_seconds: 120,
      }),
      true,
    );
    assert.equal(
      await rpc("renew_probe_dispatch", {
        p_id: id,
        p_token: crypto.randomUUID(),
        p_seconds: 120,
      }),
      false,
    );
    assert.equal(
      (
        await query(
          "SELECT count(*)::int AS n FROM probe_attempts WHERE observation_id=$1",
          [id],
        )
      ).rows[0].n,
      1,
    );
  });
  await run(["R02-08"], async () => {
    const { rows } = await fixture(20);
    const races = await Promise.all(
      rows.flatMap((row) => [
        store.claim(row.id, budget),
        store.claim(row.id, budget),
      ]),
    );
    assert.equal(races.filter((r) => r.granted).length, 20);
  });
  await run(["R02-10", "R02-13"], async () => {
    const { rows } = await fixture();
    const row = rows[0];
    const old = await store.claim(row.id, budget);
    await query(
      "UPDATE probe_observations SET lease_until=now()-interval '1 second' WHERE id=$1",
      [row.id],
    );
    assert.equal(
      (await store.claim(row.id, budget)).reason,
      "dispatch_unknown",
    );
    await rpc("reconcile_probe_dispatch", {
      p_id: row.id,
      p_token: old.lease_token,
      p_action: "confirm_not_dispatched",
      p_note: "Fixture provider ledger proves no accepted operation",
    });
    const next = await store.claim(row.id, budget);
    assert.equal(next.attempt_no, 2);
    await finish(row, next);
    assert.equal(
      (await finish(row, old, { text: "Stale payload" })).accepted,
      false,
    );
    const o = (
      await query("SELECT * FROM probe_observations WHERE id=$1", [row.id])
    ).rows[0];
    assert.equal(o.result.text, "Acme is an option.");
    assert.equal(o.state, "answered");
    assert.equal(
      (
        await query(
          "SELECT count(*)::int n FROM probe_late_receipts WHERE observation_id=$1",
          [row.id],
        )
      ).rows[0].n,
      1,
    );
  });
  await run(["R02-11"], async () => {
    const { rows } = await fixture();
    const id = rows[0].id;
    // A separate process commits intent, signals a provider response, then is
    // terminated before completion. The exact uncertainty boundary is durable.
    const child = fork(
      new URL("./probe-crash-child.mjs", import.meta.url),
      [id],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    await once(child, "message");
    child.kill("SIGKILL");
    await once(child, "exit");
    await query(
      "UPDATE probe_observations SET lease_until=now()-interval '1 second' WHERE id=$1",
      [id],
    );
    assert.equal((await store.claim(id, budget)).reason, "dispatch_unknown");
    const attempt = (
      await query("SELECT * FROM probe_attempts WHERE observation_id=$1", [id])
    ).rows[0];
    assert.equal(attempt.dispatch_state, "unknown");
    assert.equal(attempt.charged_usd, null);
    assert.equal((await store.claim(id, budget)).granted, false);
  });
  await run(["R02-14", "R02-16"], async () => {
    const { rows, jobId } = await fixture();
    const claim = await store.claim(rows[0].id, budget);
    await finish(rows[0], claim);
    assert.equal((await finish(rows[0], claim)).duplicate, true);
    assert.equal((await store.claim(rows[0].id, budget)).granted, false);
    const report = await query("SELECT * FROM prompt_results WHERE job_id=$1", [
      jobId,
    ]);
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].raw.text, "Acme is an option.");
  });
  await run(["R02-15"], async () => {
    const { rows } = await fixture(2);
    const claims = await Promise.all(
      rows.map((r) => store.claim(r.id, budget)),
    );
    await finish(rows[0], claims[0]);
    const r = result(rows[1], {
      answer_present: false,
      error: "HTTP 503",
      cost: null,
    });
    const decision = resultDecision(r, 1, Date.now() + 3600_000);
    assert.equal(decision.state, "retry");
    await store.finish(rows[1].id, claims[1].lease_token, r, decision);
    assert.equal((await store.claim(rows[1].id, budget)).reason, "not_due");
    await query(
      "UPDATE probe_observations SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
      [rows[1].id],
    );
    assert.equal((await store.claim(rows[0].id, budget)).granted, false);
    const retry = await store.claim(rows[1].id, budget);
    await finish(rows[1], retry);
    const o = (
      await query("SELECT * FROM probe_observations WHERE id=$1", [rows[1].id])
    ).rows[0];
    assert.equal(o.attempt_count, 2);
    assert.equal(o.unknown_cost_calls, 1);
  });
  await run(["R02-17", "R02-18", "R02-21"], async () => {
    const circuit = crypto.randomUUID();
    const { rows } = await fixture(2, { circuit });
    const first = await store.claim(rows[0].id, budget);
    const r = result(rows[0], {
      answer_present: false,
      error: "HTTP 401",
      cost: null,
    });
    const decision = resultDecision(r, first.attempt_no, Date.now() + 3600_000);
    assert.equal(decision.failure.opens_circuit, true);
    await store.finish(rows[0].id, first.lease_token, r, decision);
    assert.equal(
      (await store.claim(rows[1].id, budget)).reason,
      "provider_circuit_open",
    );
    const independent = await fixture();
    assert.equal(
      (await store.claim(independent.rows[0].id, budget)).granted,
      true,
    );
    const attempt = (
      await query("SELECT * FROM probe_attempts WHERE observation_id=$1", [
        rows[0].id,
      ])
    ).rows[0];
    assert.equal(attempt.cost_state, "unknown_billed");
    assert.equal(attempt.charged_usd, null);
    assert.equal(Number(attempt.reserved_usd), budget.reserve);
  });
  await run(["P0-shared-canary-budget-and-pause"], async () => {
    const scope = crypto.randomUUID();
    const { rows } = await fixture(3, { purpose: "canary", scope });
    await query(
      "UPDATE probe_observations SET context=jsonb_set(context,'{max_requests}','1') WHERE id=ANY($1)",
      [rows.map((r) => r.id)],
    );
    const claims = await Promise.all(
      rows.map((r) => store.claim(r.id, budget)),
    );
    assert.equal(claims.filter((c) => c.granted).length, 1);
    assert.equal(
      claims.filter((c) => c.reason === "request_budget_refused").length,
      2,
    );
    const { rows: more } = await fixture(1, { purpose: "canary", scope });
    await assert.rejects(
      store.claim(more[0].id, budget),
      /shared budget mismatch/,
    );
    await query("UPDATE probe_dispatch_control SET paused=true");
    const paused = await fixture();
    assert.equal(
      (await store.claim(paused.rows[0].id, budget)).reason,
      "dispatch_paused",
    );
    await query("UPDATE probe_dispatch_control SET paused=false");
  });
  await run(["R02-19"], async () => {
    const circuit = crypto.randomUUID();
    await query(
      "INSERT INTO provider_dispatch_circuits(circuit_key,open_until) VALUES($1,now()-interval '1 second')",
      [circuit],
    );
    const { rows } = await fixture(10, { purpose: "canary", circuit });
    const claims = await Promise.all(
      rows.map((r) => store.claim(r.id, budget)),
    );
    assert.equal(claims.filter((c) => c.granted).length, 1);
  });
  await run(["R02-20"], async () => {
    // Reset previous fixture day charges; this database belongs only to this job.
    await query(
      "TRUNCATE measurement_evidence,measurement_incidents,probe_reconciliations,probe_late_receipts,probe_attempts,probe_observations,provider_dispatch_circuits,provider_canary_budgets",
    );
    const { rows } = await fixture(10);
    const claims = await Promise.all(
      rows.map((r) =>
        store.claim(r.id, { reserve: 0.1, scanCap: 0.35, dayCap: 0.35 }),
      ),
    );
    assert.equal(claims.filter((c) => c.granted).length, 3);
    const spend = (
      await query("SELECT sum(reserved_usd) usd FROM probe_attempts")
    ).rows[0].usd;
    assert.equal(Number(spend), 0.3);
  });
  await run(["R02-22"], async () => {
    for (const role of ["anon", "authenticated"]) {
      const client = await pool.connect();
      try {
        await client.query(`SET ROLE ${role}`);
        for (const table of [
          "probe_observations",
          "probe_attempts",
          "provider_dispatch_circuits",
          "probe_late_receipts",
          "probe_reconciliations",
        ]) {
          await assert.rejects(
            client.query(`SELECT * FROM ${table}`),
            /permission denied/,
          );
          await assert.rejects(
            client.query(`DELETE FROM ${table}`),
            /permission denied/,
          );
        }
        await assert.rejects(
          client.query("SELECT claim_probe_dispatch('forbidden',1)"),
          /permission denied/,
        );
      } finally {
        await client.query("RESET ROLE");
        client.release();
      }
    }
  });
  await run(["R02-23", "P0-worker-database-integration"], async () => {
    const { jobId, cp } = await fixture(0);
    cp.queries = [{ text: "Controlled runtime question?" }];
    let calls = 0;
    const deps = {
      jobId,
      checkpoint: cp,
      engines: [
        {
          name: "chatgpt",
          probe: async (q) => {
            calls++;
            return {
              engine: "chatgpt",
              prompt: q.text,
              answer_present: true,
              text: "A measured answer",
              cost: 0.01,
              brands: [],
            };
          },
        },
      ],
      store,
      getResults: async (id) =>
        (await query("SELECT * FROM prompt_results WHERE job_id=$1", [id]))
          .rows,
      updateJob: async (id, patch) => {
        if (patch.checkpoint)
          await query("UPDATE scan_jobs SET checkpoint=$2 WHERE id=$1", [
            id,
            JSON.stringify(patch.checkpoint),
          ]);
      },
      chunkStartMs: Date.now(),
      budgetMs: 150_000,
      env: {
        LLM_API_KEY: "EXAMPLE-NOT-A-REAL-CREDENTIAL",
        LLM_BASE_URL: "https://openrouter.ai/api/v1",
      },
    };
    let updates = 0;
    await assert.rejects(
      runDurableProbing({
        ...deps,
        updateJob: async (id, patch) => {
          await deps.updateJob(id, patch);
          if (++updates === 2)
            throw new Error("Fixture crash after result commit");
        },
      }),
      /Fixture crash/,
    );
    const resumed = (
      await query("SELECT checkpoint FROM scan_jobs WHERE id=$1", [jobId])
    ).rows[0].checkpoint;
    const first = await runDurableProbing({ ...deps, checkpoint: resumed });
    assert.equal(first.budgetHit, false);
    assert.equal(calls, 1);
    await runDurableProbing({ ...deps, checkpoint: first.checkpoint });
    assert.equal(calls, 1);
    assert.equal(
      (
        await query(
          "SELECT count(*)::int n FROM prompt_results WHERE job_id=$1",
          [jobId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(first.checkpoint.stats.cost, 0.01);
  });
  console.log(
    JSON.stringify({
      suite: "database",
      outcome: "pass",
      cases: passed,
      productionProviderRequests: 0,
    }),
  );
} finally {
  await pool.end();
}
