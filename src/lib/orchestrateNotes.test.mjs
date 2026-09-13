import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveNote } from "../../.claude/orchestration/orchestrate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const ORCHESTRATE_CLI = path.join(REPO, ".claude/orchestration/orchestrate.mjs");

// ---------------------------------------------------------------------------
// resolveNote — unit tests on the helper
// ---------------------------------------------------------------------------

test("resolveNote: --note-file reads a file verbatim", () => {
  const dir = fs.mkdtempSync(path.join(HERE, "..", "..", "tmp_r6113_"));
  try {
    const filePath = path.join(dir, "note.txt");
    const payload = "backticks `like this` and $(whoami) and newline\nsecond line";
    fs.writeFileSync(filePath, payload, "utf8");

    const result = resolveNote({ "note-file": filePath });
    assert.deepEqual(result, { text: payload, source: filePath });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveNote: --note-file non-existent path dies", () => {
  assert.throws(
    () => resolveNote({ "note-file": "/nonexistent/path/note.txt" }),
    /file not found/
  );
});

test("resolveNote: --note arg returns the string as-is", () => {
  const result = resolveNote({ note: "simple text" });
  assert.deepEqual(result, { text: "simple text", source: "arg" });
});

test("resolveNote: --note boolean (no value) returns null", () => {
  const result = resolveNote({ note: true });
  assert.equal(result, null);
});

test("resolveNote: no note flags returns null", () => {
  const result = resolveNote({});
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// resolveNote — byte-identical round-trip through --note-file
//
// R6.1.13 acceptance: "A test feeds a note containing backticks, a
// dollar-parenthesis substitution and a newline, and asserts the stored note
// is byte-identical to the input."
// ---------------------------------------------------------------------------

test("R6.1.13 — note with backticks, $(), and newlines reaches ledger byte-identical via --note-file", () => {
  const tmpDir = path.join(REPO, "tmp_test_ledger_" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const testLedgerPath = path.join(tmpDir, "tasks.json");
  const notePath = path.join(tmpDir, "note.txt");

  // The adversarial payload — every one of these is expanded by most shells
  // when passed as a --note argument.
  const payload =
    "line one with `backtick expansion` here\n" +
    "line two with $(whoami) dollar-paren\n" +
    "line three with ${HOME} brace expansion\n" +
    "line four with just a tab\there\n" +
    "line five ends with bare backtick `";

  try {
    fs.writeFileSync(notePath, payload, "utf8");

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
          detail: "testing submit note",
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

    // submit via --note-file, not --note
    execFileSync(
      process.execPath,
      [ORCHESTRATE_CLI, "submit", "T0.1.1", "--evidence", "package.json:1", "--note-file", notePath],
      {
        env: { ...process.env, ORCHESTRATION_LEDGER: testLedgerPath },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Read the ledger back and verify byte-identical note content
    const written = JSON.parse(fs.readFileSync(testLedgerPath, "utf8"));
    const task = written.tasks.find((t) => t.id === "T0.1.1");
    assert.equal(task.status, "in_verification", "task must be in_verification after submit");
    assert.equal(task.notes.length, 1, "exactly one note");
    assert.equal(task.notes[0].text, payload, "note text must be byte-identical to file content");
    assert.equal(task.notes[0].by, "test-agent");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// amend — --correction adds a note WITHOUT touching detail
// ---------------------------------------------------------------------------

test("R6.1.13 — amend --correction adds a note entry but does NOT append to detail", () => {
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
          detail: "original detail text",
          accept: "testing",
          deps: [],
          anchors: [],
          findings: [],
          tags: [],
          status: "todo",
          owner: "test-agent",
          evidence: [],
          notes: [],
          verification: null,
        },
      ],
    };
    fs.writeFileSync(testLedgerPath, JSON.stringify(testLedger, null, 2) + "\n");

    // amend --correction only
    execFileSync(
      process.execPath,
      [
        ORCHESTRATE_CLI,
        "amend",
        "T0.1.1",
        "--correction",
        "the earlier note was wrong, fix it",
      ],
      {
        env: { ...process.env, ORCHESTRATION_LEDGER: testLedgerPath },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    const written = JSON.parse(fs.readFileSync(testLedgerPath, "utf8"));
    const task = written.tasks.find((t) => t.id === "T0.1.1");

    // detail must be untouched
    assert.equal(task.detail, "original detail text", "correction must NOT append to detail");

    // a note entry must have been added
    assert.equal(task.notes.length, 1, "one note entry");
    assert.match(task.notes[0].text, /correction:/);
    assert.match(task.notes[0].text, /the earlier note was wrong, fix it/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// amend — --note-file reads from file and appends to detail
// ---------------------------------------------------------------------------

test("R6.1.13 — amend --note-file reads from file and appends to detail", () => {
  const tmpDir = path.join(REPO, "tmp_test_ledger_" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const testLedgerPath = path.join(tmpDir, "tasks.json");
  const notePath = path.join(tmpDir, "note.txt");

  const noteText = "additional context with `code` and $(date)";
  try {
    fs.writeFileSync(notePath, noteText, "utf8");

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
          detail: "original",
          accept: "testing",
          deps: [],
          anchors: [],
          findings: [],
          tags: [],
          status: "todo",
          owner: "test-agent",
          evidence: [],
          notes: [],
          verification: null,
        },
      ],
    };
    fs.writeFileSync(testLedgerPath, JSON.stringify(testLedger, null, 2) + "\n");

    execFileSync(
      process.execPath,
      [ORCHESTRATE_CLI, "amend", "T0.1.1", "--note-file", notePath],
      {
        env: { ...process.env, ORCHESTRATION_LEDGER: testLedgerPath },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    const written = JSON.parse(fs.readFileSync(testLedgerPath, "utf8"));
    const task = written.tasks.find((t) => t.id === "T0.1.1");

    // detail should contain the note text verbatim
    assert.ok(task.detail.includes(noteText), "detail must contain note text from file");
    assert.ok(
      task.detail.includes("`code`"),
      "backticks in the note must survive file-based reading"
    );

    // note entry added
    assert.equal(task.notes.length, 1, "one note entry");
    assert.ok(task.notes[0].text.includes(noteText));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// amend — dies when neither --note, --note-file, nor --correction is given
// ---------------------------------------------------------------------------

test("R6.1.13 — amend without --note, --note-file, or --correction dies", () => {
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
          detail: "original",
          accept: "testing",
          deps: [],
          anchors: [],
          findings: [],
          tags: [],
          status: "todo",
          owner: "test-agent",
          evidence: [],
          notes: [],
          verification: null,
        },
      ],
    };
    fs.writeFileSync(testLedgerPath, JSON.stringify(testLedger, null, 2) + "\n");

    // amend with no flags at all must die
    assert.throws(
      () => {
        execFileSync(
          process.execPath,
          [ORCHESTRATE_CLI, "amend", "T0.1.1"],
          {
            env: { ...process.env, ORCHESTRATION_LEDGER: testLedgerPath },
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
      },
      (err) => {
        const output = String(err.stderr || "") + String(err.stdout || "");
        assert.match(output, /--note.*--correction.*--anchors|required/);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
