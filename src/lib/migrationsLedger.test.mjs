import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER = "scripts/setup-supabase.mjs";
const MIGRATIONS_DIR = path.join(REPO, "supabase/migrations");

/**
 * R6.1.1 (finding C10) — the migration runner must not report success on an
 * incomplete database.
 *
 * On 2026-08-30 the live database was missing 007, 008 AND 009 while
 * `npm run setup:db` would have printed "Migrations applied successfully" and
 * a wall of ticks, because its verify list stopped at 005 and it kept no record
 * of its own runs. The failure was not that a migration broke; it was that the
 * tool could not tell you which ones had run.
 *
 * The list going stale is the recurring failure, so the guard is that EVERY
 * migration file on disk has an entry — not that today's list looks right.
 */

const read = (rel) => readFile(path.join(REPO, rel), "utf8");

/** The EXPECTED_OBJECTS keys, read out of the runner source. */
async function expectedKeys() {
  const src = await read(RUNNER);
  const start = src.indexOf("const EXPECTED_OBJECTS = {");
  assert.ok(start > 0, "EXPECTED_OBJECTS must exist in the runner");
  const end = src.indexOf("\n};", start);
  const block = src.slice(start, end);
  return [...block.matchAll(/"(\d{3}_[a-z0-9_]+\.sql)":/g)].map((m) => m[1]);
}

test("GUARD — every migration on disk is covered by the verify list", async () => {
  const onDisk = (await readdir(path.join(REPO, "supabase/migrations")))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const covered = (await expectedKeys()).sort();

  assert.ok(onDisk.length >= 9, `expected the full migration set, found ${onDisk.length}`);

  const uncovered = onDisk.filter((f) => !covered.includes(f));
  assert.deepEqual(
    uncovered,
    [],
    `these migrations would be applied but never verified, so a database missing ` +
      `them still reports success:\n  ${uncovered.join("\n  ")}`
  );

  // And nothing verified that no longer exists — a stale entry fails every run
  // for a file that was legitimately deleted.
  const orphaned = covered.filter((f) => !onDisk.includes(f));
  assert.deepEqual(orphaned, [], `the verify list names migrations that no longer exist`);
});

test("GUARD — 006 specifically is verified, which is the finding", async () => {
  const covered = await expectedKeys();
  assert.ok(
    covered.includes("006_agent_control_plane.sql"),
    "C10 is precisely that a DB missing 006 reported success"
  );
});

test("GUARD — the runner records what it applied", async () => {
  const src = await read(RUNNER);
  assert.match(src, /CREATE TABLE IF NOT EXISTS schema_migrations/, "there must be a ledger table");
  assert.match(src, /INSERT INTO schema_migrations/, "each applied file must be recorded");
  assert.match(src, /checksum/, "the ledger must record a checksum, not just a filename");
});

test("GUARD — each migration runs in its own transaction", async () => {
  const src = await read(RUNNER);
  assert.match(src, /await client\.query\("BEGIN"\)/);
  assert.match(src, /await client\.query\("COMMIT"\)/);
  assert.match(src, /ROLLBACK/, "a failed migration must roll back, not leave a half-applied schema");
});

test("GUARD — a missing object sets a non-zero exit, and says so", async () => {
  const src = await read(RUNNER);
  assert.match(src, /INCOMPLETE/, "the operator must be told the database is incomplete");
  assert.match(src, /process\.exitCode = 1/, "and the process must fail");

  // The old runner announced success before verifying, which is the sentence
  // that made a broken run look fine. This scans `console.log`/`console.warn`
  // ARGUMENTS IN THE SOURCE — not what the script prints, and not comments, so
  // a comment explaining the ban is not a violation of it. What the script
  // actually prints is asserted in src/lib/migrationsRunner.test.mjs, which
  // runs it.
  const consoleArgs = [...src.matchAll(/console\.(log|warn)\(([^;]*)\);/g)].map((m) => m[2]).join("\n");
  assert.ok(
    !/applied successfully/i.test(consoleArgs),
    "no console call may carry the old pre-verification success sentence"
  );
});

test("GUARD — four banned literals do not appear in a console call before the verify loop", async () => {
  // WHAT THIS IS, EXACTLY, so nobody mistakes it for more: a regex over the
  // runner's SOURCE TEXT that bans four literals inside `console.log`/
  // `console.warn` call sites appearing before the verify section. That is a
  // cheap lint, not an ordering proof, and a verifier evaded it twice — with a
  // different sentence, and with the original banned sentence moved into a
  // `process.stdout.write`, which this regex does not look at.
  //
  // THE REAL ORDERING TEETH ARE IN src/lib/migrationsRunner.test.mjs, in the
  // "ORDERING — no verdict reaches stdout before the catalog check" cases:
  // those run the script and read its actual stdout, so the call used to print
  // is irrelevant. Both evasions above fail there. This test is kept because it
  // localises the failure to a source line, and it is free.
  const src = await read(RUNNER);
  const verifyAt = src.indexOf('Verifying schema against the catalog');
  assert.ok(verifyAt > 0, "the verification section must exist");

  const beforeVerify = src.slice(0, verifyAt);
  // Comment prose is excluded deliberately — a comment explaining why success
  // must not be claimed early is not itself a claim, and the first version of
  // this guard failed on exactly that, because its own explanation quoted the
  // banned string.
  const consoleArgs = [...beforeVerify.matchAll(/console\.(log|warn)\(([^;]*)\);/g)]
    .map((m) => m[2])
    .join("\n");
  assert.ok(
    !/successfully|✓ done|all good|migrations complete/i.test(consoleArgs),
    `a console call before the catalog check carries a banned success literal:\n${consoleArgs.slice(0, 300)}`
  );

  // And the one real success sentence must sit after it.
  assert.ok(
    src.indexOf("All expected objects present") > verifyAt,
    "the success line must follow the verification, not precede it"
  );
});

test("GUARD — functions are checked via pg_proc, not to_regclass", async () => {
  const src = await read(RUNNER);
  // 009 was found with its table present and its function absent. to_regclass
  // does not see functions, so a table-only check would have passed.
  assert.match(src, /pg_proc/, "a function check needs pg_proc");
  assert.match(src, /increment_scan_rate_limit/, "009's function must be verified by name");
});

// ---------------------------------------------------------------------------
// R6.1.14 — the names in EXPECTED_OBJECTS must match the SQL on disk.
//
// A rename inside a migration file (an index, constraint, or column) must turn
// a test red. The existing guard checks that every migration FILE is covered;
// this checks that every object NAME inside those entries actually appears in
// the SQL. Without it, renaming `foo_idx` to `bar_idx` in the SQL while
// leaving EXPECTED_OBJECTS as `foo_idx` would report green — the runner
// probes for a name that does not exist and the test still passes.
// ---------------------------------------------------------------------------

/**
 * Parse a migration SQL file and extract the objects it creates, organised by
 * kind. Handles: CREATE TABLE, CREATE [UNIQUE] INDEX, CREATE OR REPLACE FUNCTION,
 * ALTER TABLE ADD COLUMN, ALTER TABLE ADD CONSTRAINT, and inline CONSTRAINT
 * inside CREATE TABLE blocks.
 *
 * This is deliberately a conservative regex parser, not a full SQL AST. It
 * covers every pattern the existing migration set uses.
 */
function extractObjectsFromSql(sql) {
  const objects = { table: [], index: [], function: [], column: [], constraint: [], bucket: [] };
  const seen = new Set();

  const add = (kind, name) => {
    const key = `${kind}:${name}`;
    if (!seen.has(key)) {
      seen.add(key);
      objects[kind].push(name);
    }
  };

  // Strip block comments but preserve newlines (for line-based patterns)
  const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, " ");

  // Join continuation lines: collapse lines that are part of a multi-line
  // statement (indented, or starting with keywords that continue a DDL).
  // This handles: ALTER TABLE x\n  ADD CONSTRAINT y ...
  const joined = stripped
    .split("\n")
    .map((l) => l.replace(/--.*$/, "").trim())
    .filter(Boolean)
    .reduce((acc, line) => {
      // If the line is a continuation (indented, starts with ADD, UNIQUE, ON,
      // WHERE, CHECK, REFERENCES, etc.) append to previous.
      if (
        acc.length > 0 &&
        /^\s*(ADD|UNIQUE|ON|WHERE|CHECK|REFERENCES|FOREIGN|PRIMARY|CONSTRAINT\b|IF\b)/i.test(
          line
        ) &&
        !/^\s*CREATE\b/i.test(line) &&
        !/^\s*ALTER\b/i.test(line)
      ) {
        acc[acc.length - 1] += " " + line;
      } else {
        acc.push(line);
      }
      return acc;
    }, []);

  let pendingBucket = false;
  for (const line of joined) {
    // CREATE TABLE [IF NOT EXISTS] <name>
    const tableMatch = line.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
    if (tableMatch) {
      add("table", tableMatch[1].toLowerCase());
    }

    // CREATE [UNIQUE] INDEX [IF NOT EXISTS] <name>
    const indexMatch = line.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
    if (indexMatch) {
      add("index", indexMatch[1].toLowerCase());
    }

    // CREATE OR REPLACE FUNCTION <name>
    const funcMatch = line.match(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)/i);
    if (funcMatch) {
      add("function", funcMatch[1].toLowerCase());
    }

    // ALTER TABLE <table> ADD COLUMN [IF NOT EXISTS] <column>
    // Use matchAll to handle multiple ADD COLUMN clauses on the same joined
    // line (e.g. 013_brand_metrics_sov_state.sql has sov_state and
    // sov_state_reason as two ADD COLUMN clauses separated by a comma).
    const tableForCol = line.match(/ALTER\s+TABLE\s+(\w+)/i);
    if (tableForCol) {
      const tableName = tableForCol[1].toLowerCase();
      const colRe = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
      for (let cm = colRe.exec(line); cm; cm = colRe.exec(line)) {
        add("column", `${tableName}.${cm[1].toLowerCase()}`);
      }
    }

    // ALTER TABLE <table> ADD CONSTRAINT <name>
    const alterConstraintMatch = line.match(
      /ALTER\s+TABLE\s+\w+\s+ADD\s+CONSTRAINT\s+(\w+)/i
    );
    if (alterConstraintMatch) {
      add("constraint", alterConstraintMatch[1].toLowerCase());
    }

    // INSERT INTO storage.buckets (...) VALUES ('<id>', ... — R1.5.1. The id is
    // the first value, which the migration puts on the line after VALUES (.
    if (/INSERT\s+INTO\s+storage\.buckets/i.test(line)) pendingBucket = true;
    if (pendingBucket) {
      const bucketMatch = line.match(/^\s*(?:VALUES\s*\(\s*)?'([a-z0-9._-]+)'/i);
      if (bucketMatch) {
        add("bucket", bucketMatch[1].toLowerCase());
        pendingBucket = false;
      }
    }

    // Inline CONSTRAINT <name> (inside CREATE TABLE blocks)
    const inlineConstraintMatch = line.match(/\bCONSTRAINT\s+(\w+)\s+(?:CHECK|UNIQUE|FOREIGN|PRIMARY)/i);
    if (inlineConstraintMatch && !alterConstraintMatch) {
      add("constraint", inlineConstraintMatch[1].toLowerCase());
    }
  }

  return objects;
}

/**
 * Parse EXPECTED_OBJECTS out of the runner source (same method as
 * expectedKeys(), extended to return the full {kind, name} entries).
 */
async function expectedEntries() {
  const src = await read(RUNNER);
  const start = src.indexOf("const EXPECTED_OBJECTS = {");
  assert.ok(start > 0, "EXPECTED_OBJECTS must exist in the runner");
  const end = src.indexOf("\n};", start);
  const block = src.slice(start, end);

  const entries = {};
  let currentMigration = null;

  for (const rawLine of block.split("\n")) {
    // Strip JavaScript line comments — the source uses // for comments that
    // may contain { kind: "table", name: "..." } as explanatory prose, and
    // those must not be picked up as object entries.
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;

    // Match migration key lines. The entry may be single-line with inline
    // objects, e.g.:  "003_content_agents.sql": [{ kind: "table", name: "content_agents" }],
    const keyMatch = line.match(/^"(\d{3}_[a-z0-9_]+\.sql)":\s*(\[.*)?/);
    if (keyMatch) {
      currentMigration = keyMatch[1];
      entries[currentMigration] = [];
      // Check for inline objects on the same line
      const inlineRe = /\{\s*kind:\s*"(\w+)",\s*name:\s*"([^"]+)"\s*\}/g;
      for (let m = inlineRe.exec(line); m; m = inlineRe.exec(line)) {
        entries[currentMigration].push({ kind: m[1], name: m[2] });
      }
      continue;
    }

    // Match object entries on separate lines within a migration block
    if (currentMigration) {
      const objMatch = line.match(/\{\s*kind:\s*"(\w+)",\s*name:\s*"([^"]+)"\s*\}/);
      if (objMatch) {
        entries[currentMigration].push({ kind: objMatch[1], name: objMatch[2] });
      }
    }
  }
  return entries;
}

test("R6.1.14 — every name in EXPECTED_OBJECTS appears in the corresponding SQL file", async () => {
  const entries = await expectedEntries();
  const problems = [];

  for (const [migration, expectedObjects] of Object.entries(entries)) {
    if (expectedObjects.length === 0) continue; // deliberately empty (e.g. 014)

    const sqlPath = path.join(MIGRATIONS_DIR, migration);
    let sql;
    try {
      sql = await readFile(sqlPath, "utf8");
    } catch {
      problems.push(`${migration}: EXPECTED_OBJECTS references this file but it does not exist on disk`);
      continue;
    }
    const actual = extractObjectsFromSql(sql);

    for (const { kind, name } of expectedObjects) {
      const names = actual[kind] || [];
      if (!names.includes(name.toLowerCase())) {
        problems.push(
          `${migration}: EXPECTED_OBJECTS claims ${kind} "${name}" but the SQL does not create it. ` +
            `Found ${kind}s: ${names.join(", ") || "(none)"}`
        );
      }
    }
  }

  assert.deepEqual(
    problems,
    [],
    `EXPECTED_OBJECTS names that do not match the SQL (renamed objects not caught):\n  ${problems.join("\n  ")}`
  );
});

test("R6.1.14 — a renamed index in SQL but not in EXPECTED_OBJECTS turns the test red", async () => {
  const entries = await expectedEntries();
  // 009 has an index entry: scan_rate_limits_window_idx
  const target = "009_scan_rate_limit.sql";
  const idxEntry = entries[target]?.find((e) => e.kind === "index");
  assert.ok(idxEntry, `need an index entry in ${target} to tamper with`);

  const sqlPath = path.join(MIGRATIONS_DIR, target);
  const sql = await readFile(sqlPath, "utf8");
  const actual = extractObjectsFromSql(sql);
  const realIndex = actual.index.find((n) => n === idxEntry.name.toLowerCase());
  assert.ok(realIndex, `the index ${idxEntry.name} must exist in the SQL`);

  // Simulate renaming the index in SQL but not in EXPECTED_OBJECTS
  const tampered = { ...actual, index: actual.index.map((n) => n === realIndex ? "renamed_index_xyz" : n) };
  const problems = [];
  for (const { kind, name } of entries[target]) {
    if (kind !== "index") continue;
    if (!tampered[kind]?.includes(name.toLowerCase())) {
      problems.push(`${target}: ${kind} "${name}" not found after rename`);
    }
  }
  assert.ok(
    problems.length > 0,
    "a renamed index must be caught — the test must turn red"
  );
});

test("R6.1.14 — a renamed constraint in SQL but not in EXPECTED_OBJECTS turns the test red", async () => {
  const entries = await expectedEntries();
  // 016_content_items has a constraint entry: content_items_job_id_cycle_key
  const target = "016_content_items_natural_key.sql";
  const constraintEntry = entries[target]?.find((e) => e.kind === "constraint");
  assert.ok(constraintEntry, `need a constraint entry in ${target} to tamper with`);

  const sqlPath = path.join(MIGRATIONS_DIR, target);
  const sql = await readFile(sqlPath, "utf8");
  const actual = extractObjectsFromSql(sql);
  const realConstraint = actual.constraint.find(
    (n) => n === constraintEntry.name.toLowerCase()
  );
  assert.ok(realConstraint, `constraint ${constraintEntry.name} must exist in SQL`);

  // Rename the constraint in the extracted SQL objects
  const tampered = {
    ...actual,
    constraint: actual.constraint.map((n) =>
      n === realConstraint ? "renamed_constraint_xyz" : n
    ),
  };
  const problems = [];
  for (const { kind, name } of entries[target]) {
    if (kind !== "constraint") continue;
    if (!tampered[kind]?.includes(name.toLowerCase())) {
      problems.push(`${target}: ${kind} "${name}" not found after rename`);
    }
  }
  assert.ok(problems.length > 0, "a renamed constraint must be caught");
});

test("R6.1.14 — a column entry in EXPECTED_OBJECTS that doesn't match SQL turns red", async () => {
  // EXPECTED_OBJECTS currently has no column entries, but the guard must work
  // if one is ever added. Test by injecting a phantom column entry and
  // verifying it is caught.
  const entries = await expectedEntries();
  const target = "001_initial_schema.sql";
  const sqlPath = path.join(MIGRATIONS_DIR, target);
  const sql = await readFile(sqlPath, "utf8");
  const actual = extractObjectsFromSql(sql);

  // Fabricate a column entry that does NOT exist in the SQL
  const phantomEntries = [
    ...entries[target],
    { kind: "column", name: "scans.nonexistent_column" },
  ];
  const problems = [];
  for (const { kind, name } of phantomEntries) {
    const names = actual[kind] || [];
    if (!names.includes(name.toLowerCase())) {
      problems.push(`${target}: ${kind} "${name}" not found in SQL`);
    }
  }
  assert.ok(
    problems.length > 0,
    "a phantom column entry must be caught by the name-matching guard"
  );
  assert.ok(
    problems.some((p) => p.includes("nonexistent_column")),
    "the specific phantom must be named in the failure"
  );
});

test("R6.1.14 — a migration directory that matches nothing is caught, not reported green", async () => {
  const entries = await expectedEntries();
  const onDisk = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  // Every file on disk should have either an entry in EXPECTED_OBJECTS or
  // a documented empty list (like 014).
  const missing = onDisk.filter((f) => !(f in entries));
  assert.deepEqual(
    missing,
    [],
    `these migration files exist on disk but have no EXPECTED_OBJECTS entry at all — ` +
      `the runner would skip verifying them and a missing object would not be caught:\n  ${missing.join("\n  ")}`
  );
});

test("R6.1.14 — EXPECTED_OBJECTS entries with empty arrays are flagged in a comment", async () => {
  const entries = await expectedEntries();
  const emptyMigrations = Object.entries(entries)
    .filter(([, objs]) => objs.length === 0)
    .map(([file]) => file);

  if (emptyMigrations.length === 0) return; // no empty entries, guard is vacuous

  const src = await read(RUNNER);
  for (const migration of emptyMigrations) {
    // The comment explaining WHY the list is empty must exist near the entry.
    // Search for the filename in the source and check that a comment block
    // explains the empty list within 30 lines before it.
    const idx = src.indexOf(`"${migration}": []`);
    assert.ok(idx > 0, `${migration} has an empty list but no visible entry in source`);
    const preceding = src.slice(Math.max(0, idx - 2000), idx);
    assert.ok(
      /\/\/.*\bempty\b|\/\/.*\bdeliberately\b|\/\/.*\bfinding\b|\/\/.*\bcolumn\b|\/\/.*\bR\d+\.\d+/i.test(preceding),
      `${migration} has an empty EXPECTED_OBJECTS list but no comment explaining why. ` +
        `An undocumented empty list is indistinguishable from an oversight.`
    );
  }
});
