import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
 * Read every tracked text file from the git INDEX and check for CR bytes.
 * One `git ls-files -s -z` plus one `git cat-file --batch` for all blobs:
 * no shell, so paths with spaces work, and no per-file subprocess, which
 * made the suite hang on Windows (one spawn per tracked file).
 */
function checkIndexForCRLF() {
  const listing = execFileSync("git", ["ls-files", "-s", "-z"], {
    cwd: REPO,
    maxBuffer: 32 * 1024 * 1024,
  }).toString("utf8");
  const entries = [];
  for (const record of listing.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, sha] = record.slice(0, tab).split(" ");
    const rel = record.slice(tab + 1);
    if (mode === "160000" || mode === "120000") continue; // submodule, symlink
    if (BINARY_RE.test(rel)) continue;
    entries.push({ rel, sha });
  }

  const blobs = execFileSync("git", ["cat-file", "--batch"], {
    cwd: REPO,
    input: entries.map((e) => e.sha).join("\n") + "\n",
    maxBuffer: 512 * 1024 * 1024,
  });

  const crlfFiles = [];
  let checked = 0;
  let offset = 0;
  for (const { rel } of entries) {
    const headerEnd = blobs.indexOf(0x0a, offset);
    const header = blobs.toString("utf8", offset, headerEnd);
    const size = Number(header.split(" ")[2]);
    offset = headerEnd + 1;
    if (!Number.isFinite(size)) continue; // "<sha> missing"
    const content = blobs.toString("utf8", offset, offset + size);
    offset += size + 1; // content plus trailing LF
    const crCount = countCR(content);
    if (crCount > 0) crlfFiles.push({ file: rel, crCount });
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
