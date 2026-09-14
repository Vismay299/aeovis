import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  resolveNote,
  parseArgs,
  validateEvidenceCitation,
} from "../../.claude/orchestration/orchestrate.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ===========================================================================
// R6.1.11 — parseArgs accumulates repeated flags into arrays.
//
// The old parseArgs silently overwrote `--evidence a --evidence b` to just `b`.
// Now a second occurrence promotes the value to an array so submit can
// concatenate them.
// ===========================================================================

test("R6.1.11 — parseArgs: single flag stays scalar", () => {
  const { flags } = parseArgs(["--evidence", "src/foo.js:10"]);
  assert.equal(flags.evidence, "src/foo.js:10");
});

test("R6.1.11 — parseArgs: two repeated flags become an array", () => {
  const { flags } = parseArgs(["--evidence", "src/foo.js:10", "--evidence", "src/bar.js:20"]);
  assert.deepEqual(flags.evidence, ["src/foo.js:10", "src/bar.js:20"]);
});

test("R6.1.11 — parseArgs: three repeated flags become a three-element array", () => {
  const { flags } = parseArgs([
    "--evidence", "a.js:1",
    "--evidence", "b.js:2",
    "--evidence", "c.js:3",
  ]);
  assert.deepEqual(flags.evidence, ["a.js:1", "b.js:2", "c.js:3"]);
});

test("R6.1.11 — parseArgs: non-repeated flags stay scalar", () => {
  const { flags } = parseArgs(["--verdict", "pass"]);
  assert.equal(flags.verdict, "pass");
});

test("R6.1.11 — parseArgs: positional args are preserved", () => {
  const { positional } = parseArgs(["R6.1.8", "--evidence", "foo.js:1"]);
  assert.deepEqual(positional, ["R6.1.8"]);
});

// ===========================================================================
// R6.1.11 — evidence accumulation: the evidence-parsing logic inside submit.
//
// submit splits each --evidence value on commas and concatenates all of them.
// --evidence a,b --evidence c produces [a, b, c].
// We test this through parseArgs + manual splitting to avoid calling submit()
// which writes to the real tasks.json ledger.
// ===========================================================================

test("R6.1.11 — evidence accumulation: comma-split within a single flag", () => {
  const { flags } = parseArgs(["--evidence", "src/lib/health.js:1,src/lib/health.js:3"]);
  // Reproduce submit's evidence-parsing logic
  const rawEvidence = flags.evidence;
  const evidence = Array.isArray(rawEvidence)
    ? rawEvidence.flatMap((v) => String(v).split(",")).map((s) => s.trim()).filter(Boolean)
    : String(rawEvidence).split(",").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(evidence, ["src/lib/health.js:1", "src/lib/health.js:3"]);
});

test("R6.1.11 — evidence accumulation: repeated flags are concatenated", () => {
  const { flags } = parseArgs([
    "--evidence", "src/lib/health.js:1",
    "--evidence", "src/lib/health.js:3,src/lib/health.js:5",
  ]);
  const rawEvidence = flags.evidence;
  const evidence = Array.isArray(rawEvidence)
    ? rawEvidence.flatMap((v) => String(v).split(",")).map((s) => s.trim()).filter(Boolean)
    : String(rawEvidence).split(",").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(evidence, [
    "src/lib/health.js:1",
    "src/lib/health.js:3",
    "src/lib/health.js:5",
  ]);
});

test("R6.1.11 — evidence accumulation: six citations from three flags", () => {
  const { flags } = parseArgs([
    "--evidence", "src/a.js:1,src/b.js:2",
    "--evidence", "src/c.js:3",
    "--evidence", "src/d.js:4,src/e.js:5,src/f.js:6",
  ]);
  const rawEvidence = flags.evidence;
  const evidence = Array.isArray(rawEvidence)
    ? rawEvidence.flatMap((v) => String(v).split(",")).map((s) => s.trim()).filter(Boolean)
    : String(rawEvidence).split(",").map((s) => s.trim()).filter(Boolean);
  assert.equal(evidence.length, 6, "must accumulate all six citations");
  assert.deepEqual(evidence, [
    "src/a.js:1", "src/b.js:2", "src/c.js:3",
    "src/d.js:4", "src/e.js:5", "src/f.js:6",
  ]);
});

// ===========================================================================
// R6.1.11 — validateEvidenceCitation rejects invalid citations.
// ===========================================================================

test("R6.1.11 — validateEvidenceCitation rejects a non-existent file", () => {
  const err = validateEvidenceCitation("not-a-real-file.js:1");
  assert.ok(err, "should return an error for non-existent file");
  assert.match(err, /does not exist/);
});

test("R6.1.11 — validateEvidenceCitation accepts a valid file:line", () => {
  const err = validateEvidenceCitation("src/lib/health.js:1");
  assert.equal(err, null, "should accept a valid citation");
});

// ===========================================================================
// R6.1.8 — resolveNote: --note-file reads notes of any length.
//
// The old --note path was subject to shell argument length limits and shell
// metacharacter expansion.  --note-file reads directly from disk (or stdin
// via "-"), bypassing both problems.
// ===========================================================================

test("R6.1.8 — resolveNote: --note-file reads from a temp file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrate-test-"));
  const noteFile = path.join(tmpDir, "note.txt");
  const longNote = "A".repeat(5000);
  fs.writeFileSync(noteFile, longNote, "utf8");

  const result = resolveNote({ "note-file": noteFile });
  assert.equal(result.text, longNote);
  assert.equal(result.source, noteFile);

  fs.rmSync(tmpDir, { recursive: true });
});

test("R6.1.8 — resolveNote: --note-file preserves shell metacharacters byte-identical", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrate-test-"));
  const noteFile = path.join(tmpDir, "note.txt");
  // Characters that the shell would mangle: backticks, dollar-parens, newlines
  const trickyNote = 'Evidence at `src/foo.js:10` shows $(whoami) output\nand "double quotes" and \\backslash';
  fs.writeFileSync(noteFile, trickyNote, "utf8");

  const result = resolveNote({ "note-file": noteFile });
  assert.equal(result.text, trickyNote, "note must be byte-identical to the file contents");
  assert.equal(result.source, noteFile);

  fs.rmSync(tmpDir, { recursive: true });
});

test("R6.1.8 — resolveNote: --note-file fails loudly on missing file", () => {
  assert.throws(
    () => resolveNote({ "note-file": "/nonexistent/path/note.txt" }),
    /not found/,
    "missing file must throw, not silently ignore"
  );
});

test("R6.1.8 — resolveNote: --note (shell arg) still works for short notes", () => {
  const result = resolveNote({ note: "short note" });
  assert.equal(result.text, "short note");
  assert.equal(result.source, "arg");
});

test("R6.1.8 — resolveNote: no note returns null", () => {
  const result = resolveNote({});
  assert.equal(result, null);
});

// ===========================================================================
// R6.1.8 — long notes reach the ledger through --note-file.
//
// Integration test: a 10000-character note written to a temp file, read via
// resolveNote, and verified byte-identical.  This is the scenario that hung
// orchestrate.mjs past 120s when the note was passed as a shell argument.
// ===========================================================================

test("R6.1.8 — resolveNote: a very long note is read intact via --note-file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrate-test-"));
  const noteFile = path.join(tmpDir, "long-note.txt");

  // Build a note with multiple paragraphs, backticks, dollar signs, and
  // newlines — the kind of substantive note a submit produces.
  const lines = [];
  for (let i = 0; i < 200; i++) {
    lines.push(`Paragraph ${i}: \`src/module_${i}.js:${i * 10}\` — $(echo "evidence ${i}")`);
  }
  const longNote = lines.join("\n\n");
  assert.ok(longNote.length > 5000, "note must be longer than shell arg limits");

  fs.writeFileSync(noteFile, longNote, "utf8");

  const result = resolveNote({ "note-file": noteFile });
  assert.equal(result.text, longNote);
  assert.equal(result.text.length, longNote.length);

  fs.rmSync(tmpDir, { recursive: true });
});

test("R6.1.8 — resolveNote: a note with backticks, dollar signs, and newlines is preserved", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrate-test-"));
  const noteFile = path.join(tmpDir, "tricky-note.txt");

  const noteText = [
    "EXERCISED OVER HTTP against next start.",
    "Evidence at `src/lib/cronAuth.js:43` — the fail-closed flip.",
    "Cost: $0.00 (no budget spent).",
    "Line with `backticks` and $(command substitution).",
    "Empty line above this.",
    "",
    "Final paragraph with \"quotes\" and 'apostrophes'.",
  ].join("\n");
  fs.writeFileSync(noteFile, noteText, "utf8");

  const result = resolveNote({ "note-file": noteFile });
  assert.equal(result.text, noteText, "complex note must be byte-identical");

  fs.rmSync(tmpDir, { recursive: true });
});

// ===========================================================================
// validateEvidenceCitation — edge cases.
// ===========================================================================

test("validateEvidenceCitation — valid file:line", () => {
  const err = validateEvidenceCitation("src/lib/health.js:61");
  assert.equal(err, null);
});

test("validateEvidenceCitation — file does not exist", () => {
  const err = validateEvidenceCitation("nonexistent/file.js:1");
  assert.match(err, /does not exist/);
});

test("validateEvidenceCitation — line exceeds file length", () => {
  const err = validateEvidenceCitation("src/lib/health.js:99999");
  assert.match(err, /exceeds file length/);
});

test("validateEvidenceCitation — blank line rejected", () => {
  // health.js line 16 is blank
  const err = validateEvidenceCitation("src/lib/health.js:16");
  assert.match(err, /blank line/);
});

test("validateEvidenceCitation — file-only (no line) is valid", () => {
  const err = validateEvidenceCitation("src/lib/health.js");
  assert.equal(err, null);
});

test("validateEvidenceCitation — line range where end is blank is rejected", () => {
  const err = validateEvidenceCitation("src/lib/health.js:16-17");
  assert.match(err, /blank line/);
});
