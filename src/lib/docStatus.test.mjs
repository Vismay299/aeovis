import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R0.2.2 (findings S28/S30) — every doc declares its own authority.
 *
 * Four documents claimed design authority at once with no supersession markers,
 * so "what does the design say" had four answers. A status header is cheap; a
 * team implementing from a superseded document is not.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MARK = "<!-- doc-status -->";

function assertCorpusIntact(rows, name, { floor, required = [], isTuple = false }) {
  assert.ok(Array.isArray(rows), `${name} is not an array at all, so tests assert nothing`);
  assert.ok(
    rows.length >= floor,
    `${name} holds ${rows.length} rows, under its floor of ${floor}. Rows were removed from a corpus ` +
      `whose tests iterate over it, so assertions silently stopped running. If the removal ` +
      `was deliberate, lower the floor here in the same commit and state why.`
  );
  if (isTuple) {
    rows.forEach((row, i) => {
      assert.ok(
        Array.isArray(row) && row.length >= 2 && typeof row[0] === "string",
        `${name}[${i}] is not a valid tuple entry: ${JSON.stringify(row)}`
      );
      const reason = row[row.length - 1];
      assert.ok(
        typeof reason === "string" && reason.trim().length > 0,
        `${name}[${i}] (${JSON.stringify(row[0])}) carries no reason -- a row nobody can justify is a row ` +
          `the next editor deletes, and the floor above would then be met by padding`
      );
    });
  } else {
    rows.forEach((item, i) => {
      assert.ok(
        typeof item === "string",
        `${name}[${i}] is not a string: ${JSON.stringify(item)}`
      );
    });
  }
  const targets = rows.map((r) => (Array.isArray(r) ? r[0] : r));
  const dupes = [...new Set(targets.filter((t, i) => targets.indexOf(t) !== i))];
  assert.deepEqual(
    dupes,
    [],
    `${name} repeats ${JSON.stringify(dupes)}. A duplicated row holds the count up without adding ` +
      `coverage, which is how a corpus passes its floor while testing less than it did yesterday.`
  );
  const missing = required.filter((t) => !targets.includes(t));
  assert.deepEqual(
    missing,
    [],
    `${name} no longer contains ${JSON.stringify(missing)}. These rows are load-bearing ` +
      `targets: removing one is a decision to stop defending that target -- make it in the same commit as this list.`
  );
}

/** Every markdown doc that must carry a header. */
async function governedDocs() {
  const out = ["DESIGN.md", "PRODUCT.md"];
  async function walk(rel) {
    for (const entry of await readdir(path.join(REPO, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith(".md")) out.push(child);
    }
  }
  await walk("docs");
  return out;
}

test("GUARD TEETH — assertCorpusIntact rejects under-floor, duplicate, missing required, or untyped corpora", () => {
  assert.throws(() => assertCorpusIntact([], "TEST_CORPUS", { floor: 1, isTuple: false }), /under its floor of 1/);
  assert.throws(() => assertCorpusIntact(["a", "a"], "TEST_CORPUS", { floor: 1, isTuple: false }), /repeats/);
  assert.throws(() => assertCorpusIntact(["a"], "TEST_CORPUS", { floor: 1, required: ["b"], isTuple: false }), /no longer contains/);
  assert.throws(() => assertCorpusIntact([123], "TEST_CORPUS", { floor: 1, isTuple: false }), /is not a string/);
});

test("GUARD — every governed doc carries a status header", async () => {
  const docs = await governedDocs();
  assertCorpusIntact(docs, "governedDocs()", {
    floor: 35,
    required: [
      "DESIGN.md",
      "PRODUCT.md",
      "docs/OPERATOR_LEDGER.md",
      "docs/BUILD_JOURNAL.md",
      "docs/plans/2026-08-29-rebuild-roadmap.md",
    ],
    isTuple: false,
  });
  const missing = [];
  for (const rel of docs) {
    const src = await readFile(path.join(REPO, rel), "utf8");
    // The generated tracker declares its status in its own generator template.
    if (rel.endsWith("2026-08-29-rebuild-roadmap.md")) {
      assert.match(src, /> Status: \*\*LIVE\*\*/, `${rel} lost its generated header`);
      continue;
    }
    if (!src.includes(MARK)) missing.push(rel);
  }
  assert.deepEqual(missing, [], `these docs have no status header:\n  ${missing.join("\n  ")}`);
});

test("GUARD — every status header uses one of the three permitted values", async () => {
  const bad = [];
  for (const rel of await governedDocs()) {
    const src = await readFile(path.join(REPO, rel), "utf8");
    if (!src.includes(MARK)) continue;
    const header = src.slice(src.indexOf(MARK), src.indexOf(MARK) + 400);
    if (!/\*\*Status: (LIVE|HISTORICAL|SUPERSEDED-BY)/.test(header)) bad.push(rel);
  }
  assert.deepEqual(bad, [], `status must be LIVE, HISTORICAL or SUPERSEDED-BY: ${bad}`);
});

test("GUARD — a SUPERSEDED-BY header names where authority went", async () => {
  // "Superseded" with no forwarding address is worse than no marker: it tells
  // the reader to stop without telling them where to go.
  const bad = [];
  for (const rel of await governedDocs()) {
    const src = await readFile(path.join(REPO, rel), "utf8");
    const at = src.indexOf("**Status: SUPERSEDED-BY**");
    if (at === -1) continue;
    if (!/\[[^\]]+\]\([^)]+\)/.test(src.slice(at, at + 300))) bad.push(rel);
  }
  assert.deepEqual(bad, [], `SUPERSEDED-BY must link to the superseding doc: ${bad}`);
});

test("GUARD — exactly one design authority is LIVE", async () => {
  // The four-way conflict this task exists to resolve.
  const designDocs = ["DESIGN.md", "docs/design/DESIGN-SYSTEM.md", "docs/plans/2026-07-18-perceev-dark-redesign.md"];
  const live = [];
  for (const rel of designDocs) {
    const src = await readFile(path.join(REPO, rel), "utf8");
    if (/\*\*Status: LIVE\.\*\*/.test(src)) live.push(rel);
  }
  assert.deepEqual(live, ["DESIGN.md"], `exactly one design doc may be LIVE, found: ${live}`);
});

test("GUARD — the live design doc is the one the code actually implements", async () => {
  // Not a matter of taste: whichever document's tokens appear in the shipped
  // components IS the authority, and the header must agree.
  const chartMath = await readFile(path.join(REPO, "src/components/perceev/charts/chartMath.js"), "utf8");
  assert.match(chartMath, /--steel-1/, "the shipped ramp should use the Signal Box tokens");
  const design = await readFile(path.join(REPO, "DESIGN.md"), "utf8");
  assert.match(design, /\*\*Status: LIVE\.\*\*/);
  assert.match(design, /Signal Box/i);
});

test("GUARD — the close rule is written down where plans are read", async () => {
  const readme = await readFile(path.join(REPO, "docs/plans/README.md"), "utf8");
  assert.match(readme, /## Closing an item/);
  assert.match(readme, /in the same commit/i);
  assert.match(readme, /file:line/);
  assert.match(readme, /blocked with the reason/i, "the rule must name the alternative to closing");
});

// ---------------------------------------------------------------------------
// R0.2.3 (finding S19) — the ADR must describe the provider that actually ships.
// ---------------------------------------------------------------------------

test("GUARD — the SerpAPI ADR is superseded and points at the Bright Data one", async () => {
  const old = await readFile(path.join(REPO, "docs/decisions/serp-provider.md"), "utf8");
  assert.match(old, /\*\*Status: SUPERSEDED-BY\*\*/);
  assert.match(old, /2026-08-29-serp-provider-bright-data\.md/);
  const adr = await readFile(
    path.join(REPO, "docs/decisions/2026-08-29-serp-provider-bright-data.md"),
    "utf8"
  );
  assert.match(adr, /\*\*Status: LIVE\.\*\*/);
  assert.match(adr, /\*\*Date:\*\* 2026-08-29/, "an ADR must be dated");
  assert.match(adr, /Supersedes/);
});

test("GUARD — the live ADR names the provider the code actually calls", async () => {
  const adr = await readFile(
    path.join(REPO, "docs/decisions/2026-08-29-serp-provider-bright-data.md"),
    "utf8"
  );
  assert.match(adr, /BRIGHTDATA_API_KEY/);
  const engine = await readFile(path.join(REPO, "src/lib/engines/brightdata.js"), "utf8");
  assert.match(engine, /api\.brightdata\.com/, "the ADR's claim must match the integration");
});

test("GUARD — the ADR does not assert cost or coverage it never measured", async () => {
  // The superseded note was persuasive on numbers that describe nothing we run.
  // Its replacement must be explicit about what was and was not verified.
  const adr = await readFile(
    path.join(REPO, "docs/decisions/2026-08-29-serp-provider-bright-data.md"),
    "utf8"
  );
  assert.match(adr, /^## What is NOT verified$/m, "the ADR must carry an explicit not-verified section");
  assert.match(adr, /Cost per query, coverage rate, and latency/);
});

test("GUARD — the README migration table lists every migration on disk", async () => {
  const readme = await readFile(path.join(REPO, "README.md"), "utf8");
  const onDisk = (await readdir(path.join(REPO, "supabase/migrations")))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
  assertCorpusIntact(onDisk, "onDisk migrations", {
    floor: 12,
    required: ["001_initial_schema", "013_brand_metrics_sov_state"],
    isTuple: false,
  });
  const missing = onDisk.filter((m) => !readme.includes("`" + m + "`"));
  assert.deepEqual(
    missing,
    [],
    `these migrations exist but the README table does not list them: ${missing}`
  );
});

/**
 * R6.2.1 — the same guard over the operator ledger's migrations section.
 *
 * The README guard above existed and passed while OPERATOR_LEDGER.md § C said
 * "`001` … `012`" in the very commit that added `013` — the migration whose
 * absence hard-fails every scan finalize with PostgREST PGRST204. A range in
 * prose cannot be checked; an enumeration can, which is why § C names each file
 * individually. Scoped to § C so that a passing mention of a migration anywhere
 * else in the document cannot satisfy it.
 */
test("GUARD — OPERATOR_LEDGER § C lists every migration on disk", async () => {
  const ledger = await readFile(path.join(REPO, "docs/OPERATOR_LEDGER.md"), "utf8");
  const start = ledger.indexOf("\n## C. Migrations\n");
  assert.notEqual(start, -1, "OPERATOR_LEDGER.md must still have a '## C. Migrations' section");
  const rest = ledger.slice(start + 1);
  const end = rest.indexOf("\n## ");
  const section = end === -1 ? rest : rest.slice(0, end);

  const onDisk = (await readdir(path.join(REPO, "supabase/migrations")))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
  assertCorpusIntact(onDisk, "onDisk migrations", {
    floor: 12,
    required: ["001_initial_schema", "013_brand_metrics_sov_state"],
    isTuple: false,
  });
  const missing = onDisk.filter((m) => !section.includes("`" + m + "`"));
  assert.deepEqual(
    missing,
    [],
    `these migrations exist but OPERATOR_LEDGER.md § C does not name them: ${missing}`
  );
});

/**
 * R6.3.7 — PROD_MIGRATIONS.md is the fourth ledger of migration state.
 *
 * Three other places are already guarded (README table, OPERATOR_LEDGER § C,
 * setup-supabase verify list). PROD_MIGRATIONS.md was out of scope for R3.5.4
 * and stayed silent when 014 landed — the first three guards fired and this one
 * did not. The interesting part is not the missing row, which is a five-minute
 * edit; it is that three guards fired and this file stayed silent, so
 * PROD_MIGRATIONS.md can drift arbitrarily far behind the other three and the
 * suite stays green.
 */
test("GUARD — PROD_MIGRATIONS.md lists every migration on disk", async () => {
  const prod = await readFile(path.join(REPO, "docs/PROD_MIGRATIONS.md"), "utf8");
  const onDisk = (await readdir(path.join(REPO, "supabase/migrations")))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
  assertCorpusIntact(onDisk, "onDisk migrations", {
    floor: 12,
    required: ["001_initial_schema", "014_content_job_checkpoints"],
    isTuple: false,
  });
  const missing = onDisk.filter((m) => !prod.includes("`" + m + "`"));
  assert.deepEqual(
    missing,
    [],
    `these migrations exist but PROD_MIGRATIONS.md does not name them: ${missing}`
  );
});
