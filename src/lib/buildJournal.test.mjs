import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R0.2.1 — the build journal's register must stay in step with the ledger.
 *
 * The register is only useful if it is complete against what the repository
 * still knows. `.claude/orchestration/tasks.json` is the last surviving record
 * of which audit findings exist (the companion artifact is not committed), so
 * a finding a task references and the journal omits is a finding that has
 * silently fallen out of the record.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFile(path.join(REPO, rel), "utf8");

async function journal() {
  return read("docs/BUILD_JOURNAL.md");
}

/** Finding ids the ledger still references (S-numbers are suggestions, not findings). */
async function ledgerFindingIds() {
  const g = JSON.parse(await read(".claude/orchestration/tasks.json"));
  const ids = new Set();
  for (const t of g.tasks) for (const f of t.findings || []) if (!/^S/.test(f)) ids.add(f);
  return [...ids];
}

/** Finding ids the journal's register rows carry. */
function journalFindingIds(md) {
  return [...new Set([...md.matchAll(/^\| ([ABC]\d+) \|/gm)].map((m) => m[1]))];
}

test("GUARD — every finding the ledger references has a row in the journal", async () => {
  const md = await journal();
  const inJournal = new Set(journalFindingIds(md));
  const missing = (await ledgerFindingIds()).filter((id) => !inJournal.has(id));
  assert.deepEqual(
    missing.sort(),
    [],
    `these findings are referenced by a rebuild task but absent from docs/BUILD_JOURNAL.md: ${missing}`
  );
});

test("GUARD — every register row carries an anchor and a mechanism", async () => {
  const md = await journal();
  const rows = [...md.matchAll(/^\| ([ABC]\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)];
  assert.ok(rows.length >= 30, `expected the full register, parsed ${rows.length} rows`);
  for (const [, id, mechanism, anchor] of rows) {
    assert.ok(mechanism.trim().length > 30, `${id} has no real mechanism: "${mechanism.trim()}"`);
    assert.match(
      anchor,
      /`[^`]+\.(js|jsx|mjs|json)(:\d+(-\d+)?)?`|`vercel\.json`|file deleted/,
      `${id} has no file:line anchor: "${anchor.trim()}"`
    );
  }
});

test("GUARD — the register holds all 37 findings and says how it got the last three", async () => {
  // 2026-08-29..30 the register held 34 and said so: B8, B9 and B12 were not
  // recoverable from this repository. They were then pasted in from the
  // companion artifact and their anchors re-verified at HEAD. Both halves are
  // guarded: the count must be 37, AND the file must still explain the
  // provenance — a register that grew three rows without saying where they
  // came from is back to being unverifiable.
  const md = await journal();
  const ids = journalFindingIds(md);
  assert.equal(ids.length, 37, `the register holds ${ids.length} findings`);
  for (const id of ["B8", "B9", "B12"]) {
    assert.ok(ids.includes(id), `${id} must have a register row`);
  }
  assert.match(md, /companion artifact/i, "the three pasted rows must name their source");
  assert.match(md, /re-?verified|re-?read/i, "the paste must record that anchors were re-checked at HEAD");
});

test("GUARD — the closed gap does not silently reopen as a stale claim", async () => {
  // The opposite failure to the one above: the register must not still assert
  // the three are unrecoverable now that they are sitting in it.
  const md = await journal();
  const gaps = md.slice(md.indexOf("## Gaps"));
  assert.ok(gaps.length > 0, "the Gaps section must survive; it carries the trap warning");
  assert.doesNotMatch(
    gaps,
    /^\*\*`B8`, `B9` and `B12` are missing/m,
    "the gap is closed; this claim is stale"
  );
  // The renumbering trap is NOT closed: production-plan.md still has its own
  // unrelated B8/B9 sections, and mistaking them for findings is exactly how
  // three wrong rows get in.
  assert.match(gaps, /production-plan\.md/, "the production-plan.md B8/B9 trap must stay documented");
  assert.match(gaps, /unrelated/i, "the trap warning must say the sections are unrelated");
});

test("GUARD — B9's row carries the corrected anchor, not the audit's stale one", async () => {
  // B9 is the cautionary case: the audit's scanWorker.js:432-439 STILL
  // RESOLVES at HEAD, to unrelated code. A row that quietly reverted to it
  // would look correct and describe the wrong function.
  const md = await journal();
  const row = md.split("\n").find((l) => l.startsWith("| B9 |"));
  assert.ok(row, "B9 must have a register row");
  assert.match(row, /scanWorker\.js:472-479/, "B9 must cite the anchor verified at HEAD");
  assert.match(row, /\*\*moved\*\*/, "B9's anchor moved and the row must say so");
});

test("GUARD — entry #1 is the July postmortem and links to it", async () => {
  const md = await journal();
  assert.match(md, /# Entry #1 — 2026-07-29/, "entry #1 must be the July postmortem");
  assert.match(md, /docs\/plans\/2026-07-29-visibility-score-fix\.md/);
  const postmortem = await read("docs/plans/2026-07-29-visibility-score-fix.md");
  assert.ok(postmortem.length > 0, "the linked postmortem must exist");
  // The number that makes the entry worth keeping.
  assert.match(md, /16 \(28\.6%\)/, "entry #1 must carry the measurement, not just the story");
});

test("GUARD — the journal declares its own status header", async () => {
  const md = await journal();
  assert.match(md, /\*\*Status: LIVE\.\*\*/);
});
