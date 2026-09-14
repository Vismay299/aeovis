import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R6.4.7 — Guard: every tracked text file is LF.
 *
 * .gitattributes:5 pins `* text=auto eol=lf`. Before R6.4.7, 174 of 560
 * tracked text files were CRLF in the main working tree because they were
 * checked out before .gitattributes landed and core.autocrlf=true is set
 * globally. This has cost real time: one implementer's LF-anchored sabotage
 * was a silent no-op on a CRLF file, and a verifier measured LF in a worktree
 * while the implementer measured CRLF in the main tree.
 *
 * This guard reads every tracked text file's content from the git INDEX
 * (staged blobs, which are the committed content) and counts CR bytes
 * using Node — not grep, which has produced both false positives and
 * correct answers in the same session on this codebase.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Binary extensions that should never be checked for CR bytes.
const BINARY_RE = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|svg|map|min\.\w+|lock|db|sqlite)$/i;

/**
 * Count CR (\r) bytes in a string using Node, not grep.
 */
function countCR(str) {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 0x0d) count++;
  }
  return count;
}

/**
 * Read every tracked text file from the git index and check for CR bytes.
 * Uses `git show :<path>` for each file — one subprocess per file, but
 * only for files that pass the binary-extension filter.
 */
function checkIndexForCRLF() {
  const raw = execSync("git ls-files", { encoding: "utf8", cwd: REPO });
  const files = raw.trim().split("\n").filter(Boolean);

  const crlfFiles = [];
  let checked = 0;

  for (const rel of files) {
    // Skip known binary extensions.
    if (BINARY_RE.test(rel)) continue;

    let content;
    try {
      content = execSync(`git show :${rel}`, { encoding: "utf8", cwd: REPO });
    } catch {
      continue; // newly added, not in index yet
    }

    const crCount = countCR(content);
    if (crCount > 0) {
      crlfFiles.push({ file: rel, crCount });
    }
    checked++;
  }

  return { checked, crlfFiles };
}

test("GUARD — every tracked text file in the index is LF (no CRLF)", () => {
  const { checked, crlfFiles } = checkIndexForCRLF();
  assert.ok(checked > 100, `only ${checked} files checked — the guard is not running`);
  assert.deepEqual(
    crlfFiles.map((f) => f.file),
    [],
    `${crlfFiles.length} tracked text file(s) still carry CRLF in the index. ` +
      `Run \`git add --renormalize .\` to fix. Files:\n` +
      crlfFiles.map((f) => `  ${f.file} (${f.crCount} CR bytes)`).join("\n")
  );
});

test("GUARD TEETH — a CRLF string is detected", () => {
  assert.equal(countCR("hello\r\nworld\r\n"), 2, "must count two CR bytes in CRLF content");
  assert.equal(countCR("hello\nworld\n"), 0, "must count zero CR bytes in LF content");
  assert.equal(countCR("hello\r\nworld\nfoo\r\n"), 2, "must count two CR bytes in mixed content");
});
