import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { allCaseIds, inventoryFromIds, validateInventory } from "./caseInventory.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RUNNER = path.join(REPO, "scripts/qa/run-repair.mjs");

function run(args, env = {}) {
  const child = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPO,
    env: { ...process.env, ...env, PERCEEV_REPAIR_RUNNER_DEPTH: "2" },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  return { code: child.status, summary: JSON.parse(child.stdout), stderr: child.stderr };
}

test("R21-01 — unknown selection and zero collected tests never pass", () => {
  const unknown = run(["--repair", "R99", "--suite", "offline"]);
  assert.notEqual(unknown.code, 0);
  assert.equal(unknown.summary.verdict, "invalid");
  assert.equal(unknown.summary.counts.passed, 0);
  const empty = run(["--repair", "R20", "--suite", "offline"]);
  assert.notEqual(empty.code, 0);
  assert.equal(empty.summary.counts.passed, 0);
  assert.notEqual(empty.summary.verdict, "passed");
});

test("R21-02 — duplicate and missing case IDs are exact inventory failures", () => {
  const ids = allCaseIds();
  assert.equal(ids.length, 404);
  assert.equal(new Set(ids).size, 404);
  const complete = validateInventory(inventoryFromIds(ids));
  assert.equal(complete.ok, true);
  const damaged = validateInventory(inventoryFromIds([...ids.filter((id) => id !== "R05-02"), "R05-01"]));
  assert.equal(damaged.ok, false);
  assert.deepEqual(damaged.duplicates, ["R05-01"]);
  assert.deepEqual(damaged.missing, ["R05-02"]);
});

test("R21-03 — a production database identity is refused before QA dispatch", () => {
  const outcome = run(["--repair", "R02", "--suite", "database", "--environment", "qa"], {
    SUPABASE_URL: "https://prod.example.invalid",
    NEXT_PUBLIC_SUPABASE_URL: "https://prod.example.invalid",
  });
  assert.notEqual(outcome.code, 0);
  assert.equal(outcome.summary.dispatch.dispatched, false);
  assert.ok(outcome.summary.errors.some((message) => /production-looking|not an allowlisted QA/.test(message)));
});

test("R21-04 — an offline child refuses a database write before opening a socket", () => {
  const childEnv = { ...process.env, PERCEEV_OFFLINE_ONLY: "1" };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  const probe = spawnSync(process.execPath, [
    "--import", "./src/lib/liveWriteGuardAuto.mjs", "--test",
    "tests/fixtures/repairs/synthetic-guard-probe.test.mjs",
  ], { cwd: REPO, env: childEnv,
    encoding: "utf8", timeout: 15_000 });
  assert.equal(probe.error, undefined, probe.error?.message);
  assert.notEqual(probe.status, 0, "the guard marks the whole child run failed even when the refusal is caught");
  assert.match(probe.stdout, /GUARD-PROBE.*undeclared live write/);
  assert.match(probe.stdout, /LIVE WRITE REFUSED/);
});

test("R21-05 — release stays unverified when required suites have no evidence", () => {
  const outcome = run(["--repair", "R05", "--suite", "release", "--environment", "qa"]);
  assert.notEqual(outcome.code, 0);
  assert.equal(outcome.summary.verdict, "unverified");
  assert.ok(outcome.summary.suites.some((suite) => suite.suite === "database" && suite.status !== "passed"));
  assert.ok(outcome.summary.suites.some((suite) => suite.suite === "browser" && suite.status !== "passed"));
});

test("R21-06 — a test outside the collected glob is reported as an orphan", () => {
  const outcome = run(["--repair", "R21", "--suite", "offline", "--case", "R21-06"]);
  assert.ok(outcome.summary.orphans.some((orphan) =>
    orphan.file.endsWith("synthetic-orphan-supplement.test.mjs") && orphan.case === "R19-23"));
  assert.notEqual(outcome.summary.verdict, "passed", "a nested run with no dispatch cannot pass");
});
