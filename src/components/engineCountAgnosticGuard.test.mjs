/**
 * R6.4.4 — Guard: engine-count-agnostic UI.
 *
 * No surface may assume a fixed number of engines. The number of enabled
 * engines is determined at runtime by credential presence (types.js
 * getEnabledEngines), so any hard-coded count in a UI component will silently
 * break when an engine is added or removed.
 *
 * This guard scans every component source file for patterns that fix the
 * engine count: literal comparisons, destructuring assumptions, and template
 * literals with embedded counts.  It fails when any such pattern is found.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPONENTS = path.join(HERE, "..");
const ENGINES_DIR = path.join(COMPONENTS, "..", "shared", "engines");

// ---------------------------------------------------------------------------
// Patterns that indicate a hard-coded engine count in a UI surface.
//
// Each regex is paired with a human-readable description.  The guard scans
// .jsx and .js files under src/components/ only — backend files that
// enumerate engine names for API purposes (types.js, enginePipeline.js) are
// allowed to be explicit.
// ---------------------------------------------------------------------------

const ENGINE_COUNT_PATTERNS = [
  {
    // engines.length === 3  or  engines.length !== 3  etc.
    // Excludes === 0 / !== 0 which are null/empty guards, not fixed counts.
    re: /engines\.length\s*(?:===|!==)\s*[1-9]/,
    desc: "comparing engines.length to a non-zero literal",
  },
  {
    // engines.length <= 1  or  engines.length > 3  etc. (excluding 0 comparisons)
    re: /engines\.length\s*[<>]=?\s*[1-9]/,
    desc: "comparing engines.length to a non-zero literal with inequality",
  },
  {
    // .engines.length === <non-zero literal>
    re: /\.engines\.length\s*(?:===|!==)\s*[1-9]/,
    desc: "comparing .engines.length to a non-zero literal",
  },
  {
    // Template literal: `${...} engines` where the interpolating value is
    // a literal number, e.g. "3 engines" or `${3} engines`.
    re: /["'`]\d+\s+engines(?:\s+counted)?["'`]/,
    desc: "string literal embedding a hard-coded engine count",
  },
  {
    // Destructuring exactly N engines from an array, e.g.
    // const [a, b, c] = engines;  (three elements assumed)
    // This only matches simple destructuring where the array is named
    // "engines".
    re: /(?:const|let|var)\s*\[(?:\w+\s*,\s*){2,}\w+\]\s*=\s*engines\b/,
    desc: "destructuring a fixed number of engines from an array",
  },
  {
    // engines.filter(...).length === 3  (filtering then comparing to fixed count)
    re: /engines\.filter\([^)]*\)\.length\s*(?:===|!==|<=?|>=?)\s*\d/,
    desc: "filtering engines and comparing to a literal count",
  },
];

// ---------------------------------------------------------------------------
// Files to exclude from the scan:
//   - types.js: the engine registry itself — it IS the source of truth.
//   - Test files: they test the guard's own patterns and may contain them.
//   - node_modules: obviously.
// ---------------------------------------------------------------------------

const EXCLUDE_RE = /(?:types\.test\.|\.test\.mjs?$|node_modules)/;

/**
 * Recursively collect all .js and .jsx files under a directory.
 */
function collectFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__stub__") continue;
      results.push(...collectFiles(full));
    } else if (/\.(jsx?|tsx?)$/.test(entry.name) && !EXCLUDE_RE.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Scan a single file's source for hard-coded engine count patterns.
 * Returns an array of { pattern, desc, line, matched } objects.
 */
function scanFile(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.split(/\r?\n/);
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments — lines starting with // or inside /* */
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    for (const { re, desc } of ENGINE_COUNT_PATTERNS) {
      re.lastIndex = 0;
      const match = re.exec(line);
      if (match) {
        violations.push({
          file: path.relative(COMPONENTS, filePath),
          line: i + 1,
          desc,
          matched: match[0],
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("R6.4.4 GUARD — no component source file hard-codes an engine count", () => {
  const files = collectFiles(COMPONENTS);
  assert.ok(files.length > 10, `only ${files.length} component files found — the guard is not scanning`);

  const allViolations = [];
  for (const f of files) {
    allViolations.push(...scanFile(f));
  }

  assert.deepEqual(
    allViolations.map((v) => `${v.file}:${v.line} — ${v.desc} (${v.matched})`),
    [],
    allViolations.length
      ? `${allViolations.length} hard-coded engine count(s) found in component source:\n` +
          allViolations.map((v) => `  ${v.file}:${v.line}: ${v.desc} → "${v.matched}"`).join("\n")
      : "no violations"
  );
});

test("R6.4.4 GUARD — the engines directory is scanned (types.js excluded)", () => {
  // The guard must exclude types.js (the registry) but still scan other
  // engine-related files under src/components/.
  const engineFiles = collectFiles(COMPONENTS).filter((f) =>
    f.includes("engine") || f.includes("Engine")
  );
  assert.ok(
    engineFiles.length >= 3,
    `only ${engineFiles.length} engine-related component files found — the scan is too narrow`
  );
});

test("R6.4.4 GUARD TEETH — a hard-coded count IS detected", () => {
  // Simulate a component with a hard-coded engine count.
  const fakeContent = `const engines = getEngines();
if (engines.length === 3) {
  return <div>Exactly 3 engines</div>;
}`;
  const violations = [];
  for (const { re, desc } of ENGINE_COUNT_PATTERNS) {
    re.lastIndex = 0;
    const match = re.exec(fakeContent);
    if (match) {
      violations.push({ desc, matched: match[0] });
    }
  }
  assert.ok(
    violations.length >= 1,
    "the guard must detect a hard-coded engines.length === 3 pattern"
  );
});

test("R6.4.4 GUARD TEETH — a null/empty guard (=== 0) is NOT flagged", () => {
  const fakeContent = `const engines = getEngines();
if (engines.length === 0) return null;
return <div>{engines.length} engines</div>;`;
  const violations = [];
  for (const { re, desc } of ENGINE_COUNT_PATTERNS) {
    re.lastIndex = 0;
    const match = re.exec(fakeContent);
    if (match) {
      violations.push({ desc, matched: match[0] });
    }
  }
  assert.equal(violations.length, 0, "engines.length === 0 must not be flagged (null/empty guard)");
});

test("R6.4.4 GUARD TEETH — a dynamic count is NOT flagged", () => {
  const fakeContent = `const engines = getEngines();
return <div>{engines.length} engines counted</div>;
return <div>{engines.filter(e => e.answered).length} reporting</div>;`;
  const violations = [];
  for (const { re, desc } of ENGINE_COUNT_PATTERNS) {
    re.lastIndex = 0;
    const match = re.exec(fakeContent);
    if (match) {
      violations.push({ desc, matched: match[0] });
    }
  }
  assert.equal(violations.length, 0, "dynamic engine counts must not be flagged");
});
