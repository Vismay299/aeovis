import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DUPLICATE_SCAN_INDEX,
  DuplicateScanError,
  isDuplicateScanViolation,
  resolveDuplicateScan,
} from "./duplicateScan.js";

const violation = {
  code: "23505",
  message: `duplicate key value violates unique constraint "${DUPLICATE_SCAN_INDEX}"`,
};
const alive = () => true;
const dead = () => false;

test("isDuplicateScanViolation - recognises our index's 23505", () => {
  assert.equal(isDuplicateScanViolation(violation), true);
});

test("isDuplicateScanViolation - does NOT swallow other failures as 'already scanning'", () => {
  // Fail-soft on a create is the bug class this rebuild exists to close: a
  // connection error must not be reported to the user as a duplicate.
  assert.equal(isDuplicateScanViolation(null), false);
  assert.equal(isDuplicateScanViolation({ code: "08006", message: "connection failure" }), false);
  assert.equal(
    isDuplicateScanViolation({ code: "23505", message: 'violates unique constraint "scans_pkey"' }),
    false,
    "a different unique constraint is a different bug"
  );
  assert.equal(isDuplicateScanViolation({ message: DUPLICATE_SCAN_INDEX }), false, "no 23505 code");
});

test("resolveDuplicateScan - a LIVE holder means reject, not reclaim", () => {
  const out = resolveDuplicateScan([{ id: "job-1", status: "probing" }], alive);
  assert.equal(out.action, "reject");
  assert.equal(out.liveJobId, "job-1");
  assert.deepEqual(out.deadJobIds, []);
});

test("resolveDuplicateScan - a CRASHED holder is reclaimed, so a brand is never locked forever", () => {
  // The index predicate cannot express heartbeat freshness, so without this a
  // job that died in 'probing' would block its brand permanently.
  const out = resolveDuplicateScan([{ id: "job-dead", status: "probing" }], dead);
  assert.equal(out.action, "reclaim");
  assert.deepEqual(out.deadJobIds, ["job-dead"]);
});

test("resolveDuplicateScan - one live job among dead ones still rejects", () => {
  const out = resolveDuplicateScan(
    [{ id: "dead" }, { id: "live" }],
    (job) => job.id === "live"
  );
  assert.equal(out.action, "reject");
  assert.equal(out.liveJobId, "live");
});

test("resolveDuplicateScan - no blocking rows means retry, never a spurious 409", () => {
  const out = resolveDuplicateScan([], alive);
  assert.equal(out.action, "reclaim");
  assert.deepEqual(out.deadJobIds, []);
});

test("DuplicateScanError carries a 409", () => {
  const err = new DuplicateScanError("Italica", "job-1");
  assert.equal(err.status, 409);
  assert.equal(err.name, "DuplicateScanError");
  assert.match(err.message, /Italica/);
});

test("GUARD — migration 007's index predicate matches SCAN_JOB_RUNNING", async () => {
  // A running status added to db.js and not to the index predicate silently
  // reopens the duplicate-scan race, with no test failing anywhere else.
  const sql = await readFile(new URL("../../supabase/migrations/007_scan_seal.sql", import.meta.url), "utf8");
  const dbSrc = await readFile(new URL("./db.js", import.meta.url), "utf8");

  const predicate = /WHERE status IN \(([^)]*)\)/i.exec(sql);
  assert.ok(predicate, "007 must carry the partial-index predicate");
  const inIndex = [...predicate[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

  const declared = /export const SCAN_JOB_RUNNING = \[([^\]]*)\]/.exec(dbSrc);
  assert.ok(declared, "db.js must still export SCAN_JOB_RUNNING");
  const inCode = [...declared[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();

  assert.deepEqual(
    inIndex,
    inCode,
    "supabase/migrations/007_scan_seal.sql and db.js SCAN_JOB_RUNNING have drifted"
  );
  assert.match(sql, new RegExp(DUPLICATE_SCAN_INDEX), "the index name must match the code's constant");
});
