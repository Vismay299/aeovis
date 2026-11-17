import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, copyFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadReleaseEvidence, sha256 } from "./releaseEvidence.mjs";

async function fixture(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "perceev-evidence-"));
  try {
    await writeFile(path.join(dir, "browser.txt"), "actual browser output");
    const row = {
      case: "R20-08", suite: "browser", outcome: "pass",
      startedAt: "2026-10-19T00:00:00Z", endedAt: "2026-10-19T00:01:00Z",
      expected: "navigation works", actual: "desktop and mobile navigation succeeded",
      command: "node scripts/qa/check-public-browser.mjs",
      artifacts: [{ path: "browser.txt", sha256: sha256("actual browser output") }],
    };
    const packet = { schemaVersion: 1, sourceClean: true, commit: "a".repeat(40), manifestHash: "b".repeat(64), environment: "qa", cases: [row] };
    const file = path.join(dir, "evidence.json");
    const check = async () => {
      await writeFile(file, JSON.stringify(packet));
      return loadReleaseEvidence(file, { commit: "a".repeat(40), manifestHash: "b".repeat(64), now: Date.parse("2026-10-20T00:00:00Z") });
    };
    await fn({ dir, row, packet, check });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("R21-05 — current external evidence retains pass, failure, skip and block as distinct outcomes", async () => {
  await fixture(async ({ row, check }) => {
    for (const outcome of ["pass", "fail", "skipped", "blocked"]) {
      row.outcome = outcome;
      assert.equal((await check()).get("R20-08").outcome, outcome);
    }
  });
});

test("R21-05 — stale commit, fixture changes, duplicate IDs and wrong levels cannot qualify a release", async () => {
  await fixture(async ({ row, packet, check }) => {
    packet.sourceClean = false;
    await assert.rejects(check, /uncommitted source/);
    packet.sourceClean = true;
    packet.commit = "c".repeat(40);
    await assert.rejects(check, /commit/);
    packet.commit = "a".repeat(40);
    packet.manifestHash = "c".repeat(64);
    await assert.rejects(check, /manifest hash/);
    packet.manifestHash = "b".repeat(64);
    packet.cases.push(row);
    await assert.rejects(check, /duplicate/);
    packet.cases.pop();
    row.suite = "database";
    await assert.rejects(check, /wrong external suite/);
    row.suite = "browser";
    row.case = "R20-01";
    await assert.rejects(check, /wrong external suite/);
  });
});

test("R21-05 — tampered, absent, escaping or empty artifacts never establish passing evidence", async () => {
  await fixture(async ({ dir, row, check }) => {
    row.artifacts[0].sha256 = "0".repeat(64);
    await assert.rejects(check, /hash mismatch/);
    row.artifacts[0].path = "missing.txt";
    await assert.rejects(check, /ENOENT/);
    row.artifacts[0].path = `../${path.basename(dir)}-outside.txt`;
    await writeFile(path.join(dir, `../${path.basename(dir)}-outside.txt`), "outside");
    try { await assert.rejects(check, /escapes/); }
    finally { await rm(path.join(dir, `../${path.basename(dir)}-outside.txt`)); }
    row.artifacts = [];
    await assert.rejects(check, /no artifacts/);
  });
});

test("R21-05 — manual pass requires reviewer, rubric and approved decision; invalid time or environment is refused", async () => {
  await fixture(async ({ row, packet, check }) => {
    row.case = "R20-11"; row.suite = "manual";
    await assert.rejects(check, /signed reviewer/);
    row.review = { reviewer: "QA reviewer", rubric: "all material claims checked against cited source", decision: "approved" };
    assert.equal((await check()).get("R20-11").outcome, "pass");
    row.endedAt = "2026-10-21T00:00:00Z";
    await assert.rejects(check, /timestamps/);
    row.endedAt = "2026-10-19T00:01:00Z";
    packet.environment = "production";
    await assert.rejects(check, /environment/);
  });
});

test("R21-05 — release combines actual offline dispatch with external browser evidence and retains every missing case", async (t) => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const dir = await mkdtemp(path.join(tmpdir(), "perceev-release-aggregate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const file of ["scripts/qa/run-repair.mjs", "src/server/repairs/caseInventory.mjs", "src/server/repairs/releaseEvidence.mjs",
    "src/server/liveWriteGuardAuto.mjs", "src/server/liveWriteGuard.js", "tests/fixtures/repairs/synthetic-prompts.json"]) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await copyFile(path.join(root, file), path.join(dir, file));
  }
  await symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  const original = JSON.parse(await readFile(path.join(root, "tests/fixtures/repairs/manifest.json"), "utf8"));
  const manifest = JSON.stringify({ fixtures: [original.fixtures.find((f) => f.name === "synthetic-prompts")], required_test_files: [] });
  await writeFile(path.join(dir, "tests/fixtures/repairs/manifest.json"), manifest);
  await writeFile(path.join(dir, ".gitignore"), "node_modules/\nevidence/\n");
  const names = Array.from({ length: 7 }, (_, i) => `R20-${String(i + 1).padStart(2, "0")}`);
  await writeFile(path.join(dir, "src/server/repairs/injected.test.mjs"), "import test from 'node:test';\n" + names.map((id) => `test('${id} synthetic harness fixture',()=>{});`).join("\n"));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_AUTHOR_NAME: "Synthetic QA", GIT_AUTHOR_EMAIL: "qa@example.invalid", GIT_COMMITTER_NAME: "Synthetic QA", GIT_COMMITTER_EMAIL: "qa@example.invalid" };
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init"); git("add", "."); git("commit", "-m", "synthetic release harness fixture");
  await mkdir(path.join(dir, "evidence"));
  await writeFile(path.join(dir, "evidence/browser.txt"), "synthetic harness evidence, not product acceptance");
  const packet = { schemaVersion: 1, sourceClean: true, environment: "qa", commit: git("rev-parse", "HEAD"), manifestHash: sha256(manifest),
    cases: [8, 9, 10, 16].map((n) => ({ case: `R20-${String(n).padStart(2, "0")}`, suite: "browser", outcome: "pass",
      startedAt: "2026-10-19T00:00:00Z", endedAt: "2026-10-19T00:01:00Z", expected: "synthetic fixture accepted", actual: "synthetic fixture output",
      command: "synthetic dedicated job", artifacts: [{ path: "browser.txt", sha256: sha256("synthetic harness evidence, not product acceptance") }] })) };
  const run = async () => {
    await writeFile(path.join(dir, "evidence/packet.json"), JSON.stringify(packet));
    const result = spawnSync(process.execPath, ["scripts/qa/run-repair.mjs", "--repair", "R20", "--suite", "release", "--environment", "qa", "--evidence", "evidence/packet.json"], { cwd: dir, env, encoding: "utf8", timeout: 20_000 });
    return { result, report: JSON.parse(result.stdout) };
  };
  let { result, report } = await run();
  assert.equal(result.status, 1);
  assert.equal(report.verdict, "unverified");
  assert.equal(report.counts.selected, 16);
  assert.equal(report.counts.passed, 11);
  assert.equal(report.counts.blocked, 5);
  assert.equal(report.suites.find((s) => s.suite === "browser").status, "passed");
  assert.equal(report.suites.find((s) => s.suite === "manual").status, "incomplete");
  packet.cases[0].outcome = "fail";
  ({ report } = await run());
  assert.equal(report.counts.failed, 1); assert.equal(report.counts.passed, 10);
  packet.cases.pop();
  ({ report } = await run());
  assert.equal(report.counts.blocked, 6);
  packet.commit = "0".repeat(40);
  ({ result, report } = await run());
  assert.equal(result.status, 2); assert.equal(report.verdict, "invalid");
  assert.match(report.errors.join(" "), /commit/);
});
