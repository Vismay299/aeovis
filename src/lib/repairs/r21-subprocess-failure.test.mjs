import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("R21-01 — runner fails when a passing test is followed by process, hook, signal or timeout failure", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "perceev-runner-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const file of ["scripts/qa/run-repair.mjs", "src/lib/repairs/caseInventory.mjs", "src/lib/repairs/releaseEvidence.mjs",
    "src/lib/liveWriteGuardAuto.mjs", "src/lib/liveWriteGuard.js", "tests/fixtures/repairs/synthetic-prompts.json"]) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await copyFile(path.join(root, file), path.join(dir, file));
  }
  await symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  const registry = JSON.parse(await readFile(path.join(root, "tests/fixtures/repairs/manifest.json"), "utf8"));
  await writeFile(path.join(dir, "tests/fixtures/repairs/manifest.json"), JSON.stringify({
    fixtures: [registry.fixtures.find((f) => f.name === "synthetic-prompts")], required_test_files: [],
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(API_KEY|_KEY|TOKEN|SECRET|PASSWORD|DATABASE|SUPABASE|NODE_TEST_|PERCEEV_REPAIR_RUNNER_DEPTH)/i.test(name)));
  // This is an independent, tiny repository. It cannot recurse into the parent suite.
  const caseId = ["R20", "01"].join("-");
  const prefix = `import test from 'node:test'; test('${caseId} passing case',()=>{});\n`;
  for (const [name, suffix, timeout] of [
    ["exit", "process.on('exit',()=>{process.exitCode=1;});", 5000],
    ["hook", "test.after(()=>{throw new Error('after hook failed');});", 5000],
    ["rejection", "setTimeout(()=>{Promise.reject(new Error('late rejection'));},20);", 5000],
    ["signal", "setTimeout(()=>process.kill(process.pid,'SIGTERM'),20);", 5000],
    ["timeout", "setInterval(()=>{},1000);", 100],
  ]) {
    await writeFile(path.join(dir, "src/lib/repairs/injected.test.mjs"), prefix + suffix);
    const result = spawnSync(process.execPath, ["scripts/qa/run-repair.mjs", "--repair", "R20", "--suite", "offline", "--case", caseId], {
      cwd: dir, env: { ...env, PERCEEV_REPAIR_CHILD_TIMEOUT_MS: String(timeout) }, encoding: "utf8", timeout: 10000,
    });
    const summary = JSON.parse(result.stdout);
    assert.notEqual(result.status, 0, name);
    assert.equal(summary.verdict, "failed", name);
    assert.equal(summary.counts.passed, 0, name);
    assert.ok(summary.errors.length > 0, name);
    if (name === "exit") {
      const release = spawnSync(process.execPath, ["scripts/qa/run-repair.mjs", "--repair", "R20", "--suite", "release", "--environment", "qa"], {
        cwd: dir, env, encoding: "utf8", timeout: 10000,
      });
      const report = JSON.parse(release.stdout);
      const offline = report.suites.find((suite) => suite.suite === "offline");
      assert.notEqual(release.status, 0);
      assert.notEqual(offline.status, "passed");
      assert.equal(offline.casesPassed, 0);
      assert.match(offline.reason, /subprocess failed/);
    }
  }
});
