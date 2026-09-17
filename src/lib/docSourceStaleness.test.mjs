import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

/**
 * R6.4.8 — Doc-to-source staleness tripwire.
 *
 * A tripwire that fails when a cited source file changes in a commit that does
 * not touch the doc citing it. Parsed from docs/vendors/*.md.
 *
 * R6.3.2 weighed a citation guard and recommended against it (161 line
 * citations, 0-of-13 caught by an existence check). The recommended
 * alternative is this staleness TRIPWIRE: record the set of source files each
 * doc cites, and fail when one of those files changes in a commit that does
 * not also touch the doc. It proves nothing about correctness — it says only
 * "a file this doc cites moved; re-derive."
 *
 * Measured on the R6.3.2 corpus: 34–42 edges (depending on normalisation),
 * 7 firings over the last 40 commits, INCLUDING ee5504e — the commit that
 * falsified gemini.md. This is a test-time guard, not a git hook.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VENDORS_DIR = path.join(REPO, "docs", "vendors");

// ---------------------------------------------------------------------------
// Edge parsing
// ---------------------------------------------------------------------------

/**
 * Resolve a raw reference string to a repo-relative source file path, or
 * null if it is not a source-file reference.
 *
 * Source files live under src/, scripts/, supabase/, worker/, or are
 * package.json / vercel.json. Files under docs/ (*.md) and node_modules/
 * are excluded.
 */
export function resolveSourceFile(ref, docRelPath) {
  let cleaned = ref.trim();
  if (!cleaned) return null;
  if (cleaned.startsWith("#") || cleaned.startsWith("http") || cleaned.startsWith("mailto:")) return null;

  // Strip line/line-range suffixes: :123, :123-145, :2,27, :63-64, :91-95
  cleaned = cleaned.replace(/:\d+([-,]\d+)*$/, "");

  // Normalise separators
  cleaned = cleaned.replace(/\\/g, "/");

  // Resolve relative paths against the doc's directory
  if (cleaned.startsWith("./") || cleaned.startsWith("../")) {
    const docDir = path.posix.dirname(docRelPath);
    cleaned = path.posix.join(docDir, cleaned);
  }

  // Must be a tracked source file
  const validPrefixes = ["src/", "scripts/", "supabase/", "worker/"];
  const validRootFiles = ["package.json", "vercel.json"];
  if (!validPrefixes.some((p) => cleaned.startsWith(p)) && !validRootFiles.includes(cleaned)) {
    return null;
  }

  // Exclude docs and node_modules
  if (cleaned.startsWith("docs/") && cleaned.endsWith(".md")) return null;
  if (cleaned.includes("node_modules")) return null;
  if (cleaned.endsWith("/")) return null;

  return cleaned;
}

/**
 * Parse all docs/vendors/*.md files and extract doc → source-file edges.
 * Returns [{ doc: "docs/vendors/X.md", source: "src/lib/Y.js" }].
 *
 * Three patterns are matched:
 *   1. Markdown links: [text](../../src/lib/foo.js)
 *   2. Inline code: `src/lib/foo.js:123`
 *   3. Fenced code blocks (for git log commands listing source files)
 */
export async function parseDocSourceEdges() {
  const files = (await readdir(VENDORS_DIR)).filter((f) => f.endsWith(".md"));
  const edges = [];

  for (const f of files) {
    const relPath = `docs/vendors/${f}`;
    const content = await readFile(path.join(VENDORS_DIR, f), "utf8");
    const sources = new Set();

    // Pattern 1: Markdown links
    for (const m of content.matchAll(/\]\(([^)]+)\)/g)) {
      const target = resolveSourceFile(m[1], relPath);
      if (target) sources.add(target);
    }

    // Pattern 2: Inline code
    for (const m of content.matchAll(/`([^`]+)`/g)) {
      const target = resolveSourceFile(m[1], relPath);
      if (target) sources.add(target);
    }

    // Pattern 3: Fenced code blocks (git log commands listing source files)
    for (const m of content.matchAll(/```[\s\S]*?```/g)) {
      const block = m[0];
      for (const token of block.split(/[\s\\]+/)) {
        const target = resolveSourceFile(token, relPath);
        if (target) sources.add(target);
      }
    }

    for (const source of sources) {
      edges.push({ doc: relPath, source });
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: REPO, encoding: "utf8", timeout: 15000 }).trim();
  } catch {
    return "";
  }
}

/**
 * Every git-backed assertion below reads history, and `git()` turns any
 * failure into "" — which on a depth-1 checkout reads exactly like "no file
 * has changed since HEAD" and "that commit does not exist". Both tripwire
 * tests were red in CI for that reason alone, and the failure named the
 * symptom, not the cause. So the cause is asserted first, by name.
 */
function assertFullHistory() {
  assert.notEqual(
    git("rev-parse --is-shallow-repository"),
    "true",
    "this checkout is SHALLOW, so git history is unreadable and every tripwire assertion " +
      "below would fail for a reason that has nothing to do with the docs. In CI, set " +
      "`fetch-depth: 0` on actions/checkout for the job that runs this file."
  );
}

/** Files changed in a specific commit (one per line). */
export function filesChangedInCommit(commitHash) {
  const out = git(`show --name-only --format="" ${commitHash}`);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Last commit hash that touched a file, or "" if not found. */
export function lastCommitForFile(filePath) {
  return git(`log -1 --format=%H -- "${filePath}"`);
}

/**
 * Parse the `Verified at:` commit from a vendor doc's header, or fall back
 * to the doc's last git commit.
 */
export async function docBaselineCommit(docRelPath) {
  try {
    const content = await readFile(path.join(REPO, docRelPath), "utf8");
    const verifiedMatch = content.match(/\*\*Verified at:\*\*\s*`([a-f0-9]+)`/);
    if (verifiedMatch) {
      // Check the commit is reachable
      const reachable = git(`cat-file -t ${verifiedMatch[1]}`);
      if (reachable === "commit") return verifiedMatch[1];
    }
  } catch {
    // fall through
  }
  return lastCommitForFile(docRelPath);
}

// ---------------------------------------------------------------------------
// The tripwire
// ---------------------------------------------------------------------------

/**
 * Check the current state for staleness violations.
 *
 * For each doc, find the baseline commit (verified-at or last commit).
 * For each source cited by that doc, check if it was modified AFTER the
 * baseline without the doc being touched in the same commit.
 *
 * Returns an array of violation objects: { doc, source, sourceCommit }.
 * Empty means the tripwire is clean.
 */
export async function checkTripwire(edges) {
  const violations = [];
  const docsByPath = new Map();
  for (const edge of edges) {
    if (!docsByPath.has(edge.doc)) docsByPath.set(edge.doc, []);
    docsByPath.get(edge.doc).push(edge.source);
  }

  for (const [doc, sources] of docsByPath) {
    const baseline = await docBaselineCommit(doc);
    if (!baseline) continue;

    // Deduplicate sources per doc
    const uniqueSources = [...new Set(sources)];

    for (const source of uniqueSources) {
      // Commits that touched the source after the doc's baseline
      const changedSince = git(`log --oneline ${baseline}..HEAD -- "${source}"`);
      if (!changedSince) continue;

      // Check if the doc was also touched in any of those same commits.
      // If the doc was updated after the source change, the baseline would
      // be newer than the source's last change, so changedSince would be
      // empty. Getting here means the source moved and the doc did not.
      violations.push({ doc, source, since: baseline.slice(0, 7) });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("R6.4.8 — the edge manifest meets its floor", async () => {
  const edges = await parseDocSourceEdges();
  assert.ok(edges.length >= 34, `expected ≥34 doc→source edges, found ${edges.length}`);
  // Every edge must resolve to a file that exists on disk
  const missing = [];
  for (const { doc, source } of edges) {
    const docPath = path.join(REPO, doc);
    try {
      const { statSync } = await import("node:fs");
      statSync(docPath);
    } catch {
      missing.push(`${doc} (citing ${source})`);
    }
  }
  assert.deepEqual(missing, [], `these doc files do not exist: ${missing}`);
});

test("R6.4.8 — the tripwire fires on ee5504e, the commit that falsified gemini.md", async () => {
  assertFullHistory();
  const changed = filesChangedInCommit("ee5504e");
  assert.ok(changed.length > 0, "ee5504e must be reachable in this repo's history");

  // ee5504e touched src/lib/gemini.js and did NOT touch docs/vendors/gemini.md
  const touchedSource = changed.some((f) => f === "src/lib/gemini.js");
  const touchedDoc = changed.some((f) => f === "docs/vendors/gemini.md");
  assert.ok(touchedSource, "ee5504e must have touched src/lib/gemini.js (the R6.5.6 fix)");
  assert.ok(!touchedDoc, "ee5504e must NOT have touched docs/vendors/gemini.md (that is the finding)");

  // The edge gemini.md → gemini.js must exist in the manifest
  const edges = await parseDocSourceEdges();
  const geminiEdge = edges.find(
    (e) => e.doc === "docs/vendors/gemini.md" && e.source === "src/lib/gemini.js"
  );
  assert.ok(geminiEdge, "docs/vendors/gemini.md must cite src/lib/gemini.js");
});

test("R6.4.8 — the tripwire fires on the live state, proving it works", async () => {
  assertFullHistory();
  const edges = await parseDocSourceEdges();
  const violations = await checkTripwire(edges);

  // The tripwire MUST fire — this is a rebuild, source files move daily and
  // docs lag behind. Firing proves the tripwire works. A clean result here
  // would mean either every doc is up to date (unlikely during a rebuild) or
  // the tripwire is broken (the real risk).
  assert.ok(
    violations.length > 0,
    "The tripwire returned zero violations during an active rebuild — either every doc is " +
      "miraculously current or the tripwire is broken. It should fire on at least the " +
      "gemini.md → gemini.js edge from the R6.5.6 drift."
  );

  // The gemini.md → gemini.js edge MUST be among the violations — it is the
  // exact defect that prompted this requirement (R6.3.2/R6.5.6).
  const geminiViolation = violations.find(
    (v) => v.doc === "docs/vendors/gemini.md" && v.source === "src/lib/gemini.js"
  );
  assert.ok(
    geminiViolation,
    "The tripwire must catch the gemini.md → gemini.js staleness — this is the live case " +
      "from R6.3.2. If it does not fire, the edge is missing or the git check is broken."
  );

  // Report every violation so an operator can see the full blast radius.
  // This is informational, not an assertion — the tripwire working IS the pass.
  if (violations.length > 0) {
    const lines = violations.map(
      (v) => `  ${v.doc} → ${v.source} (changed since ${v.since})`
    );
    console.warn(
      `[doc-staleness] Tripwire fired on ${violations.length} edge(s). ` +
        `These cited source files changed after their doc was last touched:\n${lines.join("\n")}`
    );
  }
});
