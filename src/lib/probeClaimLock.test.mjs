import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R1.2.8 (finding S29) — the claim's row lock, asserted where it can be
 * asserted without a database.
 *
 * WHAT THIS FILE IS, AND WHAT IT IS NOT.
 * This is OPTION (b): a STATIC assertion on the SQL TEXT of `claim_probe_tasks`.
 * It tests that the migration says `FOR UPDATE SKIP LOCKED` in the row-choosing
 * SELECT. It does NOT test that Postgres behaves correctly, because it never
 * talks to Postgres. It cannot: this environment has no database, and a
 * JavaScript simulation of row locking would prove nothing about a lock manager
 * it does not have. The behavioural proof lives in
 * `src/lib/probeTasksRace.test.mjs` ("SKIP LOCKED — a claim held in an open
 * transaction is not handed to a second worker"), which runs against real
 * Postgres and is LOUDLY skipped, with a stderr banner and a counted skip, when
 * no database is configured. A skip there is not a pass; it is an admission.
 *
 * WHY IT EXISTS ANYWAY.
 * R1.2.2's verifier stripped `FOR UPDATE SKIP LOCKED` out of the claim function
 * and the whole suite stayed green — the six-way race cases in
 * probeTasksRace.test.mjs serialize on a small local pool and pass either way,
 * and the one static assertion that existed
 * (`src/lib/probeQueue.test.mjs`, "GUARD — the claim is settled by the database")
 * matched `/FOR UPDATE SKIP LOCKED/` against the WHOLE FILE. Migration 010
 * mentions the clause twice in its PROSE (its header, and the comment above the
 * function). So that regex is satisfied by the comments alone: delete the
 * executable clause on line 183 and the guard still passes, describing an
 * atomicity the database no longer has. Documentation certifying itself is the
 * exact false success this rebuild exists to remove.
 *
 * Hence: comments are stripped BEFORE matching, the match is scoped to the
 * candidate CTE of the claim function, and every migration that defines
 * `claim_probe_tasks` is checked — not just 010 — so a later
 * CREATE OR REPLACE cannot quietly drop the clause.
 *
 * The teeth are proved in-file by "TEETH", below, which runs the guard against
 * a fixture whose prose still boasts of the lock while its SQL has lost it.
 *
 * R1.2.13 UPDATE. The toothless assertion described above, at
 * `src/lib/probeQueue.test.mjs:459`, was outside R1.2.8's file set and so
 * survived. It has now been given teeth: it calls `assertLockedSelection` — the
 * function below — instead of matching the raw file, and proves in its own file
 * that what it calls is not a no-op. The helper implementations moved to
 * `./probeClaimLock.guard.mjs` so both suites share ONE implementation; see the
 * note at the import.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS = path.join(REPO, "supabase/migrations");

// ---------------------------------------------------------------------------
// R1.2.13 — the helpers and fixtures that used to be defined here now live in
// ./probeClaimLock.guard.mjs, unchanged. They moved because probeQueue.test.mjs
// had to call THE SAME guard (its own whole-file regex was the toothless one),
// and a test file must never import another test file: under `node --test` the
// imported file's `test()` calls register inside the importer's run and are
// reported as "test did not finish before its parent and was cancelled".
//
// This file remains the documented home of the guard: it re-exports the helpers
// so an existing importer keeps working, and it owns the TEETH below.
// ---------------------------------------------------------------------------
import {
  CLAIM_FN,
  stripSqlComments,
  flatten,
  claimFunctionBodies,
  candidateCte,
  assertLockedSelection,
  SABOTAGED_CLAIM_SQL,
  BLOCKING_CLAIM_SQL,
} from "./probeClaimLock.guard.mjs";

export {
  CLAIM_FN,
  stripSqlComments,
  flatten,
  claimFunctionBodies,
  candidateCte,
  assertLockedSelection,
};

// ---------------------------------------------------------------------------
// TEETH — the guard is run against SQL that is wrong in exactly the way the
// finding describes, so it can never again pass on prose alone.
// ---------------------------------------------------------------------------

/**
 * FIXTURE: migration 010's claim function with the executable
 * `FOR UPDATE SKIP LOCKED` deleted and BOTH prose mentions left in place.
 * This is the shape the R1.2.2 verifier's sabotage produced, and it is what
 * `/FOR UPDATE SKIP LOCKED/` against the whole file happily accepts.
 */
const SABOTAGED_010 = SABOTAGED_CLAIM_SQL;

/** FIXTURE: the blocking variant — locked, but without SKIP LOCKED. */
const BLOCKING_010 = BLOCKING_CLAIM_SQL;

test("TEETH — the fixtures are wrong in the two ways the finding names", () => {
  // The fixtures now live in the guard module so every caller shares them.
  // If one is edited into harmlessness the assert.throws cases below would
  // start passing for the wrong reason, so their defects are pinned here.
  assert.ok(
    /FOR UPDATE SKIP LOCKED/.test(SABOTAGED_010),
    "the sabotaged fixture must still BOAST of the clause in prose"
  );
  assert.ok(
    !/FOR UPDATE SKIP LOCKED/.test(stripSqlComments(SABOTAGED_010)),
    "the sabotaged fixture must have no EXECUTABLE clause left"
  );
  assert.ok(
    /FOR UPDATE(?!\s+SKIP LOCKED)/.test(flatten(stripSqlComments(BLOCKING_010))),
    "the blocking fixture must carry an executable bare FOR UPDATE"
  );
});

test("TEETH — a whole-file regex passes the sabotaged migration; this guard does not", () => {
  // The old assertion, reproduced. It is satisfied by the comments alone.
  assert.match(
    SABOTAGED_010,
    /FOR UPDATE SKIP LOCKED/,
    "the fixture must keep the prose, or it is not reproducing the finding"
  );
  // The guard, on the same text.
  assert.throws(
    () => assertLockedSelection(SABOTAGED_010, "fixture"),
    /does not take a row lock/,
    "a claim function that only TALKS about SKIP LOCKED must fail this guard"
  );
});

test("TEETH — FOR UPDATE without SKIP LOCKED is rejected as its own failure mode", () => {
  assert.throws(
    () => assertLockedSelection(BLOCKING_010, "fixture"),
    /locks without SKIP LOCKED/,
    "a blocking claim stalls the fleet and must not be mistaken for the correct clause"
  );
});

test("TEETH — comments are stripped, string literals are not", () => {
  const stripped = stripSqlComments(
    "SELECT 1 -- FOR UPDATE SKIP LOCKED\nFROM t;\nRAISE EXCEPTION 'a -- b';\n/* FOR UPDATE SKIP LOCKED */\n"
  );
  assert.ok(!/FOR UPDATE/i.test(stripped), "a commented clause must not survive stripping");
  assert.ok(stripped.includes("'a -- b'"), "a literal containing -- is not a comment");
  assert.ok(stripped.includes("FROM t;"), "stripping must not eat the statement after a comment");
});

// ---------------------------------------------------------------------------
// The real migrations
// ---------------------------------------------------------------------------

test("GUARD — every claim_probe_tasks definition on disk locks its candidate rows", async () => {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  const defining = [];
  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS, file), "utf8");
    if (claimFunctionBodies(sql).length === 0) continue;
    defining.push(file);
    assertLockedSelection(sql, `supabase/migrations/${file}`);
  }
  // Not "010 exists" — "the definition is found at all". If the function is
  // renamed or moved, this guard silently covering nothing is the next false
  // success, so it fails instead.
  assert.deepEqual(
    defining,
    ["010_probe_tasks.sql"],
    `expected exactly migration 010 to define ${CLAIM_FN}; a definition that moved ` +
      `or was added must be locked too, and this list updated deliberately`
  );
});

test("GUARD — the clause is executable SQL in 010, not only documentation", async () => {
  const raw = await readFile(path.join(MIGRATIONS, "010_probe_tasks.sql"), "utf8");
  const code = stripSqlComments(raw);
  const inCode = [...code.matchAll(/FOR UPDATE SKIP LOCKED/gi)].length;
  assert.equal(
    inCode,
    1,
    `010 must contain exactly one EXECUTABLE FOR UPDATE SKIP LOCKED (found ${inCode}). ` +
      `Mentions in comments do not count and are stripped before this check.`
  );
});

test("GUARD — the lock is on the row-choosing SELECT, ahead of the UPDATE", async () => {
  const raw = await readFile(path.join(MIGRATIONS, "010_probe_tasks.sql"), "utf8");
  const cte = assertLockedSelection(raw, "supabase/migrations/010_probe_tasks.sql");
  const flat = flatten(cte);
  // Order matters: LIMIT then the lock. A lock clause that preceded the LIMIT
  // would not be the same statement Postgres plans, and "choosing IS locking"
  // — migration 010's own atomicity argument — would stop being true.
  assert.ok(
    flat.indexOf("LIMIT") < flat.search(/FOR UPDATE SKIP LOCKED/i),
    "the row lock must close the candidate SELECT, after ORDER BY and LIMIT"
  );
  assert.ok(
    /ORDER BY/i.test(flat),
    "an unordered candidate set makes the queue's fairness undefined"
  );
});
