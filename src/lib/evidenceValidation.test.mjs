import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateEvidenceCitation } from "../../.claude/orchestration/orchestrate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const ORCHESTRATE_CLI = path.join(REPO, ".claude/orchestration/orchestrate.mjs");

test("R6.1.10: refuse evidence citation whose line number exceeds file length", () => {
  const err = validateEvidenceCitation("package.json:999999", REPO);
  assert.ok(err, "should fail on past-the-end line");
  assert.match(err, /package\.json:999999/);
  assert.match(err, /exceeds file length/);
});

test("R6.1.10: refuse evidence citation to a blank line", () => {
  // Line 163 of orchestrate.mjs is an empty line
  const err = validateEvidenceCitation(".claude/orchestration/orchestrate.mjs:163", REPO);
  assert.ok(err, "should fail on blank line");
  assert.match(err, /\.claude\/orchestration\/orchestrate\.mjs:163/);
  assert.match(err, /points to blank line 163/);
});

test("R6.1.10: refuse evidence citation with range exceeding file length or inverted", () => {
  const errExceed = validateEvidenceCitation("package.json:1-999999", REPO);
  assert.ok(errExceed, "should fail on range exceeding file length");
  assert.match(errExceed, /exceeds file length/);

  const errInverted = validateEvidenceCitation("package.json:20-10", REPO);
  assert.ok(errInverted, "should fail on inverted range");
  assert.match(errInverted, /exceeds file length/);
});

test("R6.1.10: refuse evidence citation to nonexistent file", () => {
  const err = validateEvidenceCitation("nonexistent_file_xyz_123.js:1", REPO);
  assert.ok(err, "should fail on nonexistent file");
  assert.match(err, /cites file that does not exist/);
});

test("R6.1.10: accept valid file and line citation", () => {
  const errSingle = validateEvidenceCitation("package.json:1", REPO);
  assert.equal(errSingle, null, "valid single line citation should pass");

  const errRange = validateEvidenceCitation("package.json:1-5", REPO);
  assert.equal(errRange, null, "valid range citation should pass");
});

test("R6.1.10: resolve pinned commit citation (@ref) via git show", () => {
  const err = validateEvidenceCitation("package.json:1@HEAD", REPO);
  assert.equal(err, null, "valid pinned citation at HEAD should pass");
});

test("R6.1.10: refuse pinned commit citation when line exceeds commit file length", () => {
  const err = validateEvidenceCitation("package.json:999999@HEAD", REPO);
  assert.ok(err, "should fail when pinned line exceeds length");
  assert.match(err, /exceeds file length/);
});

test("R6.1.10 TEETH: orchestrate.mjs submit CLI refuses citation past file length by name", () => {
  const tmpDir = path.join(REPO, "tmp_test_ledger_" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const testLedgerPath = path.join(tmpDir, "tasks.json");

  try {
    const testLedger = {
      $schema: "./schema.md",
      version: 1,
      source: { plan: "test", companion: "test", baseline_commit: "test", tracker: "test" },
      block_reasons: {},
      lanes: {},
      phases: [{ id: "T0", title: "Test Phase", estimate: "1 day", why: "testing" }],
      standing_rules: [],
      tasks: [
        {
          id: "T0.1.1",
          subphase: "T0.1",
          lane: "test",
          phase: "T0",
          title: "Test Task",
          detail: "testing submit",
          accept: "testing",
          deps: [],
          anchors: [],
          findings: [],
          tags: [],
          status: "in_progress",
          owner: "test-agent",
          evidence: [],
          notes: [],
          verification: null,
        },
      ],
    };
    fs.writeFileSync(testLedgerPath, JSON.stringify(testLedger, null, 2) + "\n");

    // Submitting a citation past the end of the file must exit non-zero and name the citation
    assert.throws(
      () => {
        execFileSync(
          process.execPath,
          [ORCHESTRATE_CLI, "submit", "T0.1.1", "--evidence", "package.json:999999"],
          {
            env: { ...process.env, ORCHESTRATION_LEDGER: testLedgerPath },
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
      },
      (err) => {
        const output = String(err.stderr || "") + String(err.stdout || "");
        assert.match(output, /package\.json:999999/);
        assert.match(output, /exceeds file length/);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("R6.1.10 TEETH: orchestrate.mjs submit CLI refuses citation to blank line by name", () => {
  const tmpDir = path.join(REPO, "tmp_test_ledger_" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const testLedgerPath = path.join(tmpDir, "tasks.json");

  try {
    const testLedger = {
      $schema: "./schema.md",
      version: 1,
      source: { plan: "test", companion: "test", baseline_commit: "test", tracker: "test" },
      block_reasons: {},
      lanes: {},
      phases: [{ id: "T0", title: "Test Phase", estimate: "1 day", why: "testing" }],
      standing_rules: [],
      tasks: [
        {
          id: "T0.1.1",
          subphase: "T0.1",
          lane: "test",
          phase: "T0",
          title: "Test Task",
          detail: "testing submit",
          accept: "testing",
          deps: [],
          anchors: [],
          findings: [],
          tags: [],
          status: "in_progress",
          owner: "test-agent",
          evidence: [],
          notes: [],
          verification: null,
        },
      ],
    };
    fs.writeFileSync(testLedgerPath, JSON.stringify(testLedger, null, 2) + "\n");

    // Submitting a citation to blank line must exit non-zero and name the citation
    assert.throws(
      () => {
        execFileSync(
          process.execPath,
          [ORCHESTRATE_CLI, "submit", "T0.1.1", "--evidence", ".claude/orchestration/orchestrate.mjs:163"],
          {
            env: { ...process.env, ORCHESTRATION_LEDGER: testLedgerPath },
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
      },
      (err) => {
        const output = String(err.stderr || "") + String(err.stdout || "");
        assert.match(output, /\.claude\/orchestration\/orchestrate\.mjs:163/);
        assert.match(output, /points to blank line 163/);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
