import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER = "scripts/setup-supabase.mjs";

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
