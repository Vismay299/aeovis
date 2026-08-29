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

test("GUARD — the journal does NOT claim to hold all 37 findings", async () => {
  // Three (B8, B9, B12) are unrecoverable from this repository. A register
  // that rounded 34 up to "all of them" would be the same lie it catalogues.
  const md = await journal();
  const count = journalFindingIds(md).length;
  assert.equal(count, 34, `the register holds ${count} findings`);
  assert.match(md, /B8.*B9.*B12|`B8`, `B9` and `B12`/s, "the gap must be named explicitly");
  assert.match(md, /not recoverable from this\s+repository/i, "the gap must say why");
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
