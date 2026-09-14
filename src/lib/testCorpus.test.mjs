/**
 * R6.4.17 — Drift guard for the shared assertCorpusIntact helper.
 *
 * Two claims:
 *   1. The shared helper catches the four defect shapes (floor, shape, uniqueness, required).
 *   2. No test file under src/ defines its own local copy of assertCorpusIntact,
 *      so the drift cannot restart.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertCorpusIntact } from "./testCorpus.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ---------------------------------------------------------------------------
// 1. The helper itself catches the four defect shapes
// ---------------------------------------------------------------------------

test("GUARD TEETH — shared assertCorpusIntact rejects under-floor corpora", () => {
  assert.throws(
    () => assertCorpusIntact([], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /under its floor of 1/
  );
});

test("GUARD TEETH — shared assertCorpusIntact rejects duplicate entries", () => {
  assert.throws(
    () => assertCorpusIntact(["a", "a"], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /repeats/
  );
});

test("GUARD TEETH — shared assertCorpusIntact rejects missing required members", () => {
  assert.throws(
    () => assertCorpusIntact(["a"], "TEST_CORPUS", { floor: 1, required: ["b"], isTuple: false }),
    /no longer contains/
  );
});

test("GUARD TEETH — shared assertCorpusIntact rejects non-string entries (when !allowRegExp)", () => {
  assert.throws(
    () => assertCorpusIntact([123], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /is not a string/
  );
});

test("GUARD TEETH — shared assertCorpusIntact rejects blank entries", () => {
  assert.throws(
    () => assertCorpusIntact([""], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /empty string/
  );
  assert.throws(
    () => assertCorpusIntact(["   "], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /empty string/
  );
});

test("GUARD TEETH — shared assertCorpusIntact rejects tuple with no reason", () => {
  assert.throws(
    () => assertCorpusIntact([["a", ""]], "TEST_CORPUS", { floor: 1, isTuple: true, rowLength: 2 }),
    /carries no reason/
  );
});

test("GUARD TEETH — shared assertCorpusIntact accepts RegExp when allowRegExp=true", () => {
  assert.doesNotThrow(
    () => assertCorpusIntact([/foo/], "TEST_CORPUS", { floor: 1, isTuple: false, allowRegExp: true })
  );
  // But rejects RegExp when allowRegExp is false
  assert.throws(
    () => assertCorpusIntact([/foo/], "TEST_CORPUS", { floor: 1, isTuple: false, allowRegExp: false }),
    /is not a string/
  );
});

test("GUARD TEETH — shared assertCorpusIntact substringMatch works both ways", () => {
  assert.doesNotThrow(
    () =>
      assertCorpusIntact(["/api/health/route.js"], "TEST_CORPUS", {
        floor: 1,
        required: ["health"],
        isTuple: false,
        substringMatch: true,
      })
  );
  assert.throws(
    () =>
      assertCorpusIntact(["/api/health/route.js"], "TEST_CORPUS", {
        floor: 1,
        required: ["nonexistent"],
        isTuple: false,
        substringMatch: true,
      }),
    /no longer contains/
  );
});

test("GUARD TEETH — shared assertCorpusIntact accepts valid tuples", () => {
  assert.doesNotThrow(
    () =>
      assertCorpusIntact(
        [["value", "reason"]],
        "TEST_CORPUS",
        { floor: 1, isTuple: true, rowLength: 2 }
      )
  );
});

test("GUARD TEETH — shared assertCorpusIntact accepts valid string arrays", () => {
  assert.doesNotThrow(
    () => assertCorpusIntact(["a", "b", "c"], "TEST_CORPUS", { floor: 3, isTuple: false })
  );
});

// ---------------------------------------------------------------------------
// 2. No test file defines its own local assertCorpusIntact
// ---------------------------------------------------------------------------

async function walkTestFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
      out.push(...(await walkTestFiles(full)));
    } else if (entry.name.endsWith(".test.mjs")) {
      out.push(full);
    }
  }
  return out;
}

test("GUARD — no test file defines its own local assertCorpusIntact", async () => {
  const allTestFiles = await walkTestFiles(path.join(REPO, "src"));
  const violations = [];

  for (const filePath of allTestFiles) {
    // Skip this test file itself
    if (filePath.endsWith("testCorpus.test.mjs")) continue;

    const content = await readFile(filePath, "utf8");
    // Look for a local function definition (not an import from testCorpus.mjs)
    const localDefMatch = content.match(/function\s+assertCorpusIntact\s*\(/);
    if (localDefMatch) {
      // Check if it's imported from testCorpus.mjs — if so, it's fine
      const importLine = content.match(
        /import\s+.*assertCorpusIntact.*from\s+["'].*testCorpus\.mjs["']/
      );
      if (!importLine) {
        const rel = path.relative(REPO, filePath).replace(/\\/g, "/");
        violations.push(rel);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `The following test files define their own local assertCorpusIntact instead of importing ` +
      `from src/lib/testCorpus.mjs: ${JSON.stringify(violations)}. ` +
      `This is how R6.4.17's drift restarts. Import from testCorpus.mjs instead.`
  );
});