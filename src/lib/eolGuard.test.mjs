import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

/**
 * R6.4.7 — guard: every tracked text file in the git index is LF.
 *
 * The .gitattributes pins `* text=auto eol=lf`, but files checked out before
 * that rule landed were never renormalised, and core.autocrlf=true on Windows
 * silently reconverts them on checkout.  This guard reads each tracked blob
 * from the index (not the working tree, which may differ on Windows) and
 * refuses to pass if any text blob carries CR bytes.
 *
 * The working-tree split is the failure mode this guard exists to catch:
 * one implementer's LF-anchored sabotage was a silent no-op on a CRLF file,
 * and two agents measuring the same file from different machines disagreed
 * about its content.
 */

const REPO = process.cwd();

function trackedTextBlobs() {
  // List tracked files with their blob SHAs and types
  const raw = execSync("git ls-files -z -s", {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const entries = raw.split("\0").filter(Boolean);
  const blobs = [];
  for (const entry of entries) {
    // format: <mode> <sha> <stage>\t<path>
    const tabIdx = entry.indexOf("\t");
    if (tabIdx === -1) continue;
    const meta = entry.slice(0, tabIdx);
    const filePath = entry.slice(tabIdx + 1);
    const sha = meta.split(" ")[1];
    // Only regular files (mode 100644 or 100755)
    if (!meta.startsWith("100")) continue;
    // Skip known binary extensions
    if (/\.(png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf|pdf|lock)$/i.test(filePath)) continue;
    blobs.push({ sha, filePath });
  }
  return blobs;
}

function countCRBytes(content) {
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0x0d) count++;
  }
  return count;
}

test("R6.4.7: no tracked text blob in the git index contains CR bytes", () => {
  const blobs = trackedTextBlobs();
  assert.ok(blobs.length > 100, `found ${blobs.length} tracked text blobs — expected hundreds`);

  const offenders = [];
  for (const { sha, filePath } of blobs) {
    try {
      const content = execSync(`git cat-file blob ${sha}`, {
        cwd: REPO,
        encoding: "latin1", // preserve raw bytes
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
      });
      const crCount = countCRBytes(content);
      if (crCount > 0) {
        offenders.push({ filePath, sha: sha.slice(0, 8), crCount });
      }
    } catch {
      // blob not found — skip
    }
  }

  if (offenders.length > 0) {
    const summary = offenders
      .slice(0, 20)
      .map((o) => `  ${o.filePath} (${o.sha}, ${o.crCount} CR bytes)`)
      .join("\n");
    assert.fail(
      `${offenders.length} tracked text blob(s) contain CR bytes (CRLF).\n` +
        `Run: git add --renormalize . && git commit -m "fix: renormalize line endings to LF"\n` +
        summary +
        (offenders.length > 20 ? `\n  ... and ${offenders.length - 20} more` : "")
    );
  }
});

test("R6.4.7: .gitattributes pins eol=lf", async () => {
  const { readFile } = await import("node:fs/promises");
  const attrs = await readFile("C:/Users/Vismay/Desktop/Projects/aeovis/.gitattributes", "utf8");
  assert.match(attrs, /\*\s+text=auto\s+eol=lf/, ".gitattributes must pin * text=auto eol=lf");
});
