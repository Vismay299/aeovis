/**
 * R1.2.23(a) — what retention may delete, and what it may never delete.
 *
 * The accept criterion is two sentences: "non-noop rows are never deleted by
 * retention; tests pin both." This file pins the first half twice, at the two
 * layers where it can actually be broken:
 *
 *   1. THE CALLER (this module). `pruneNoopScanRuns` must not grow a way to
 *      say which outcome to delete. The test that matters here is not "it
 *      passes 'noop'" — it is that the RPC payload carries NO outcome at all
 *      and that a caller offering one is refused rather than ignored.
 *   2. THE SQL (022). Since the delete itself is a function body, a JS test
 *      cannot execute it without a database. What it CAN do is read the file
 *      and assert the two properties that make the function safe: the filter
 *      is a literal, and there is no parameter through which to widen it. That
 *      is a text assertion and is described as one — it proves the shipped SQL
 *      says this, not that Postgres did it.
 *
 * The rest pins the reporting rules that make a retention pass legible: a
 * count the database gave us, or `null` with a reason. Never `?? 0`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  pruneNoopScanRuns,
  retentionCutoff,
  SCAN_RUNS_RETENTION_DAYS,
  SCAN_RUNS_DELETABLE_OUTCOME,
  SCAN_RUNS_OUTCOMES,
  SCAN_RUNS_PRUNE_FN,
} from "./scanRunsRetention.js";

const MIGRATION = path.join(
  process.cwd(),
  "supabase/migrations/022_scan_runs_retention.sql"
);

/**
 * A PostgREST stand-in that records every call and answers with the counts it
 * was handed. `calls` is the assertion surface: what the module asked the
 * database to do is the thing under test.
 */
function fakeClient(answers) {
  const calls = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push({ fn, args });
      const next = answers[calls.length - 1];
      if (next === undefined) throw new Error(`fake client: unexpected call ${calls.length}`);
      if (next instanceof Error) return Promise.resolve({ data: null, error: next });
      return Promise.resolve({ data: next, error: null });
    },
  };
}

const NOW = "2026-09-22T00:00:00.000Z";

test("the RPC payload names no outcome — the filter is not the caller's to set", async () => {
  const client = fakeClient([0]);
  await pruneNoopScanRuns({ client, nowIso: NOW });

  assert.equal(client.calls.length, 1);
  const [{ fn, args }] = client.calls;
  assert.equal(fn, SCAN_RUNS_PRUNE_FN);
  assert.deepEqual(Object.keys(args).sort(), ["p_cutoff", "p_limit"]);
  // Said explicitly rather than implied by the key list above, because this is
  // the property the accept criterion asks for: there is no channel here
  // through which 'failed' could ever be requested.
  for (const key of Object.keys(args)) {
    assert.ok(!/outcome/i.test(key), `payload key ${key} would let a caller pick an outcome`);
  }
});

test("a caller that offers an outcome is REFUSED, not quietly ignored", async () => {
  for (const outcome of SCAN_RUNS_OUTCOMES) {
    await assert.rejects(
      () => pruneNoopScanRuns({ client: fakeClient([0]), nowIso: NOW, outcome }),
      /outcome` is not an argument/,
      `deps.outcome=${outcome} must be refused`
    );
  }
  // Including the one that WOULD have been harmless. A refusal that makes an
  // exception for 'noop' teaches the next caller that the key is supported.
  await assert.rejects(
    () => pruneNoopScanRuns({ client: fakeClient([0]), nowIso: NOW, outcome: "noop" }),
    /outcome` is not an argument/
  );
});

test("022's delete filters on a literal 'noop' and takes no outcome parameter", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION prune_noop_scan_runs"));
  assert.ok(body.length > 0, "022 must create prune_noop_scan_runs — the module rpc()s it by name");

  // The signature, up to the first ')', is the whole surface a caller can
  // reach. Nothing outcome-shaped may appear in it.
  const signature = body.slice(0, body.indexOf(")"));
  assert.ok(!/outcome/i.test(signature), `signature must take no outcome parameter: ${signature}`);

  assert.match(body, /outcome\s*=\s*'noop'/, "the filter must be a literal in the function body");
  assert.match(body, /ended_at\s+IS\s+NOT\s+NULL/, "an OPEN row is a live worker's row and must survive");
  assert.match(body, /ended_at\s*<\s*p_cutoff/, "age is counted from ended_at, not started_at");
  assert.match(
    body,
    /p_cutoff\s*>\s*v_min_cutoff/,
    "the database boundary must refuse a direct RPC caller's too-recent cutoff"
  );
  assert.match(
    body,
    /p_limit\s*>\s*50000/,
    "the database boundary must cap a direct RPC caller's transaction"
  );
});

test("the index 022 ships covers exactly the rows the delete touches", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const idx = sql.slice(sql.indexOf("CREATE INDEX IF NOT EXISTS scan_runs_noop_retention_idx"));
  const stmt = idx.slice(0, idx.indexOf(";"));
  assert.match(stmt, /ON scan_runs \(ended_at\)/, "keyed on the range column the delete orders by");
  assert.match(stmt, /WHERE outcome = 'noop' AND ended_at IS NOT NULL/);
});

test("the window is the operator's 30 days, counted back from the given instant", () => {
  assert.equal(SCAN_RUNS_RETENTION_DAYS, 30);
  assert.equal(SCAN_RUNS_DELETABLE_OUTCOME, "noop");
  assert.equal(retentionCutoff(NOW), "2026-08-23T00:00:00.000Z");
  assert.equal(retentionCutoff(NOW, 7), "2026-09-15T00:00:00.000Z");
});

test("an unparsable clock or a too-short window is refused, not guessed", () => {
  assert.throws(() => retentionCutoff("not-a-date"), /refusing to guess the clock/);
  assert.throws(() => retentionCutoff(NOW, 1), /retentionDays must be a number >= 7/);
  assert.throws(() => retentionCutoff(NOW, "30"), /retentionDays must be a number >= 7/);
});

test("invalid batch controls are refused before the first RPC", async () => {
  for (const batchSize of [0, -1, 1.5, 50001, "5000"]) {
    const client = fakeClient([0]);
    await assert.rejects(
      () => pruneNoopScanRuns({ client, nowIso: NOW, batchSize }),
      /batchSize must be an integer between 1 and 50000/
    );
    assert.equal(client.calls.length, 0);
  }

  for (const maxBatches of [0, -1, 1.5, "20"]) {
    const client = fakeClient([0]);
    await assert.rejects(
      () => pruneNoopScanRuns({ client, nowIso: NOW, maxBatches }),
      /maxBatches must be a positive integer/
    );
    assert.equal(client.calls.length, 0);
  }
});

test("an unconfigured Supabase reports that, and NOT '0 rows deleted'", async () => {
  const report = await pruneNoopScanRuns({ client: null, nowIso: NOW });
  assert.equal(report.ok, false);
  assert.equal(report.deleted, null, "a pass that never ran has no count");
  assert.equal(report.batches, 0);
  assert.match(report.reason, /not configured/);
});

test("batches until a short one, and reports what the database counted", async () => {
  const client = fakeClient([10, 10, 3]);
  const report = await pruneNoopScanRuns({ client, nowIso: NOW, batchSize: 10 });

  assert.equal(report.ok, true);
  assert.equal(report.deleted, 23);
  assert.equal(report.batches, 3);
  assert.equal(report.truncated, false);
  assert.equal(report.cutoff, retentionCutoff(NOW));
  assert.equal(report.retention_days, 30);
  for (const call of client.calls) assert.equal(call.args.p_limit, 10);
});

test("a full last batch stops at the cap and says rows remain — not 'clean'", async () => {
  const client = fakeClient([5, 5]);
  const report = await pruneNoopScanRuns({ client, nowIso: NOW, batchSize: 5, maxBatches: 2 });

  assert.equal(report.ok, true);
  assert.equal(report.deleted, 10);
  assert.equal(report.truncated, true);
  assert.match(report.reason, /rows older than the window remain/);
});

test("an RPC error keeps what earlier batches really deleted and still fails the pass", async () => {
  const client = fakeClient([5, new Error("connection reset")]);
  const report = await pruneNoopScanRuns({ client, nowIso: NOW, batchSize: 5 });

  assert.equal(report.ok, false);
  assert.equal(report.deleted, 5, "five rows really were deleted — that happened");
  assert.equal(report.batches, 2);
  assert.match(report.reason, /connection reset/);
});

test("an error on the FIRST batch reports no count at all", async () => {
  const client = fakeClient([new Error("permission denied")]);
  const report = await pruneNoopScanRuns({ client, nowIso: NOW });

  assert.equal(report.ok, false);
  assert.equal(report.deleted, null);
  assert.match(report.reason, /failed before deleting anything/);
});

test("an answer that is not a row count is refused rather than coerced", async () => {
  for (const answer of [null, undefined, {}, [], "many", -1, 1.5, true]) {
    const client = fakeClient([answer === undefined ? null : answer]);
    const report = await pruneNoopScanRuns({ client, nowIso: NOW });
    assert.equal(report.ok, false, `data=${JSON.stringify(answer)} must not be read as a count`);
    assert.equal(report.deleted, null);
    assert.match(report.reason, /not a row count/);
  }
});

test("a count arriving as a numeric string is accepted — PostgREST returns bigint as text", async () => {
  const report = await pruneNoopScanRuns({ client: fakeClient(["7"]), nowIso: NOW, batchSize: 10 });
  assert.equal(report.ok, true);
  assert.equal(report.deleted, 7);
});
