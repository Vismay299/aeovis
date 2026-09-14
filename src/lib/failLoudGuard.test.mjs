import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R6.4.2 — Guard: fail-loud walker.
 *
 * Standing rule 2 — never fail-soft a create call — and the R2.2.3 finding
 * (S29) that killed the last round of silent-error patterns in the scan path.
 *
 * Two classes of defect this catches:
 *
 *   1. BARE CATCH — `catch {}` or `catch(e) { }` that swallows an error
 *      without logging, rethrowing, or assigning a skip reason. The
 *      scan worker counts `errors_recovered` and names every skip; a bare
 *      catch defeats both tallies.
 *
 *   2. FAIL-SOFT WRITE — `.catch(() => {})` on a promise that writes to the
 *      database, which silently drops a failed write and lets the caller
 *      report success. Standing rule 2 says: a write that stores less than
 *      it was asked to must say so; a `.catch(() => {})` is not saying so.
 *
 * Neither pattern may be reintroduced in `src/lib/`. The test walks every
 * non-test JS/MJS file under that directory and fails on a match.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN_ROOT = path.join(REPO, "src", "lib");

/**
 * Collect every .js and .mjs file under src/lib/, excluding test files,
 * this guard itself, and node_modules.
 */
async function scanFiles() {
  const out = [];
  async function walk(dir, rel) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        await walk(path.join(dir, entry.name), childRel);
      } else if (/\.(m?js)$/.test(entry.name) && !entry.name.includes(".test.")) {
        if (entry.name === "failLoudGuard.test.mjs") continue;
        out.push(childRel);
      }
    }
  }
  await walk(SCAN_ROOT, "src/lib");
  return out.sort();
}

/**
 * Find bare catch blocks: `catch {}` or `catch(e) { }` with empty body.
 * A bare catch is a `catch` keyword followed by optional parens, then
 * either `{}` directly or `{` with only whitespace/newlines before `}`.
 */
function findBareCatches(src, filePath) {
  const results = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Pattern 1: catch {} — no parameter, empty body (single line)
    if (/\bcatch\s*\{\s*\}/.test(line)) {
      results.push({ file: filePath, line: i + 1, text: line.trim() });
    }
    // Pattern 2: catch (var) { } — parameter but empty body (single line)
    if (/\bcatch\s*\(\s*\w+\s*\)\s*\{\s*\}/.test(line)) {
      results.push({ file: filePath, line: i + 1, text: line.trim(), note: "catch with variable but empty body" });
    }
    // Pattern 3: catch { — multi-line, body is just whitespace then }
    if (/\bcatch\s*\{\s*$/.test(line)) {
      // Look ahead for the closing } with nothing in between
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && /^\s*\}\s*$/.test(lines[j])) {
        results.push({ file: filePath, line: i + 1, text: lines.slice(i, j + 1).join(" / ").trim(), note: "multi-line bare catch" });
      }
    }
    // Pattern 4: catch (var) { — multi-line, body is just whitespace then }
    if (/\bcatch\s*\(\s*\w+\s*\)\s*\{\s*$/.test(line)) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && /^\s*\}\s*$/.test(lines[j])) {
        results.push({ file: filePath, line: i + 1, text: lines.slice(i, j + 1).join(" / ").trim(), note: "multi-line catch with variable but empty body" });
      }
    }
  }
  return results;
}

/**
 * Find fail-soft promise catches: `.catch(() => {})` or `.catch(function() {})`.
 * These silently drop errors from promise-based writes.
 *
 * Comment lines are skipped — a mention of the anti-pattern in a comment
 * explaining the guard is not a violation.
 */
function findFailSoftPromiseCatches(src, filePath) {
  const results = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // Skip comment lines (// or * at start of trimmed line)
    if (/^\/[/*]/.test(trimmed) || /^\*/.test(trimmed)) continue;
    if (/\.catch\s*\(\s*(\(\s*\)\s*=>\s*\{\s*\}|function\s*\(\s*\)\s*\{\s*\})\s*\)/.test(line)) {
      results.push({ file: filePath, line: i + 1, text: trimmed, note: "silent promise catch" });
    }
  }
  return results;
}

test("GUARD — no bare catch {} in the scan path", async () => {
  const files = await scanFiles();
  const violations = [];
  for (const rel of files) {
    const src = await readFile(path.join(REPO, rel), "utf8");
    violations.push(...findBareCatches(src, rel));
  }
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line}`),
    [],
    `bare catch blocks found in the scan path — these swallow errors silently and ` +
      `defeat the error tallies the scan worker maintains:\n` +
      violations.map((v) => `  ${v.file}:${v.line} (${v.note || "bare catch"}): ${v.text}`).join("\n")
  );
});

test("GUARD — no silent .catch(() => {}) in the scan path", async () => {
  const files = await scanFiles();
  const violations = [];
  for (const rel of files) {
    const src = await readFile(path.join(REPO, rel), "utf8");
    violations.push(...findFailSoftPromiseCatches(src, rel));
  }
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line}`),
    [],
    `silent promise catches found in the scan path — standing rule 2 says a ` +
      `write that fails must say so:\n` +
      violations.map((v) => `  ${v.file}:${v.line} (${v.note}): ${v.text}`).join("\n")
  );
});

test("GUARD TEETH — a bare catch in a scan-path file is caught", async () => {
  // Prove the guard has teeth by verifying it would catch a bare catch
  // in a file that is known to be in the scan path.
  const src = "try { doSomething(); } catch {}\n";
  const violations = findBareCatches(src, "test/file.js");
  assert.equal(violations.length, 1, "the pattern detector must catch a single-line bare catch");

  const src2 = "try {\n  doSomething();\n} catch (e) {\n}\n";
  const violations2 = findBareCatches(src2, "test/file.js");
  assert.ok(violations2.length >= 1, "the pattern detector must catch an empty catch with a variable");

  const src3 = 'somePromise.catch(() => {})\n';
  const violations3 = findFailSoftPromiseCatches(src3, "test/file.js");
  assert.equal(violations3.length, 1, "the pattern detector must catch silent promise catches");
});

test("GUARD TEETH — a normal catch (with body) is NOT flagged", async () => {
  const src = "try { doSomething(); } catch (e) { console.error(e); throw e; }\n";
  const violations = findBareCatches(src, "test/file.js");
  assert.equal(violations.length, 0, "a catch with a non-empty body must not be flagged");

  const src2 = 'somePromise.catch((err) => { report(err); })\n';
  const violations2 = findFailSoftPromiseCatches(src2, "test/file.js");
  assert.equal(violations2.length, 0, "a catch with a handler must not be flagged");
});
