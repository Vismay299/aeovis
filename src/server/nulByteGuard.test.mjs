import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R6.4.10 — a NUL byte anywhere in a tracked text source file must fail a
 * test, naming the file.
 *
 * A NUL makes a file read as binary to file(1) and to ripgrep, which SILENTLY
 * SKIPS binary files rather than erroring. Every grep-based guard in this repo
 * (the route-perimeter walker, the engine-name walker, the doc-to-source
 * staleness tripwire, checkSecrets' vendor-set comparison, the types.test.mjs
 * env-var scan) proves a property by finding or not finding text. A file
 * containing a NUL is skipped without a message, so a guard that scans for a
 * forbidden pattern reports a clean pass over a file it never opened.
 *
 * This guard uses readFileSync (not grep) because grep is the tool being
 * defeated.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = path.join(ROOT, "src");
const DOCS = path.join(ROOT, "docs");

/** Recursively collect files matching the given extensions. */
function collectFiles(dir, extensions) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", ".next", "test_reports"].includes(entry.name)) continue;
      results.push(...collectFiles(full, extensions));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.includes(ext)) {
        results.push(full);
      }
    }
  }
  return results;
}

const TRACKED_EXTENSIONS = [".mjs", ".js", ".jsx", ".md"];

test("R6.4.10 — no tracked text source file contains a NUL byte", () => {
  const files = [
    ...collectFiles(SRC, TRACKED_EXTENSIONS),
    ...collectFiles(DOCS, TRACKED_EXTENSIONS),
  ];
  assert.ok(files.length > 100, `expected the full source tree, found ${files.length} files`);

  const contaminated = [];
  for (const file of files) {
    const buf = readFileSync(file);
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x00) {
        contaminated.push(path.relative(ROOT, file));
        break;
      }
    }
  }

  assert.deepEqual(
    contaminated,
    [],
    `NUL byte(s) found in the file(s) above. A NUL makes the file invisible to ` +
      `every grep-based guard (ripgrep silently skips binary files). Remove the ` +
      `NUL byte(s) from the named file(s).`
  );
});
