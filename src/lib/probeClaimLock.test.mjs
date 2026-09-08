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
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS = path.join(REPO, "supabase/migrations");
const CLAIM_FN = "claim_probe_tasks";

/**
 * Remove SQL comments, preserving string literals.
 *
 * `--` to end of line and block comments go; anything inside a single-quoted
 * literal is copied verbatim, so an error message that happens to contain `--`
 * is not mistaken for a comment. Dollar-quoted function bodies are deliberately
 * treated as ordinary text: the comments INSIDE `$fn$ ... $fn$` are exactly the
 * ones that fooled the old whole-file regex.
 */
export function stripSqlComments(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl; // keep the newline itself
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/** Normalise whitespace so a reformatted clause still matches. */
const flatten = (s) => s.replace(/\s+/g, " ").trim();

/**
 * Every `CREATE [OR REPLACE] FUNCTION claim_probe_tasks(...)` body found in
 * `sql`, comments already stripped. Returns [] when the file defines none.
 */
export function claimFunctionBodies(sql) {
  const code = stripSqlComments(sql);
  const bodies = [];
  const opener = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${CLAIM_FN}\\b`, "gi");
  for (const m of code.matchAll(opener)) {
    const rest = code.slice(m.index);
    // The body runs to the end of the dollar-quoted block that closes it.
    const tag = rest.match(/\$([a-z_]*)\$/i);
    if (!tag) {
      bodies.push(rest);
      continue;
    }
    const close = rest.indexOf(tag[0], tag.index + tag[0].length);
    bodies.push(rest.slice(0, close === -1 ? rest.length : close + tag[0].length));
  }
  return bodies;
}

/**
 * The row-CHOOSING select inside a claim body: the `candidate` CTE. Scoped
 * deliberately — a lock clause anywhere else in the function would not settle
 * which rows this worker takes, which is the only thing under test.
 */
export function candidateCte(body) {
  const start = body.search(/WITH\s+candidate\s+AS/i);
  if (start < 0) return null;
  const end = body.search(/\bclaimed\s+AS\b/i);
  return body.slice(start, end > start ? end : body.length);
}

/**
 * The guard itself, as a function so the fixture below can point it at
 * deliberately broken SQL. Throws with the reason; returns the CTE on success.
 */
export function assertLockedSelection(sql, label) {
  const bodies = claimFunctionBodies(sql);
  assert.ok(bodies.length > 0, `${label}: no ${CLAIM_FN} definition found`);
  let last = null;
  for (const body of bodies) {
    const cte = candidateCte(body);
    assert.ok(cte, `${label}: ${CLAIM_FN} has no candidate CTE — the row-choosing SELECT is gone`);
    const flat = flatten(cte);
    // Checked FIRST, because it is the more specific diagnosis. FOR UPDATE
    // alone is a DIFFERENT bug with a different symptom: the second worker
    // BLOCKS on the lock instead of skipping past it, so a busy queue stalls
    // its whole fleet rather than spreading. Named separately so the failure
    // message tells you which of the two you shipped.
    assert.ok(
      !/FOR UPDATE(?!\s+SKIP LOCKED)/i.test(flat),
      `${label}: ${CLAIM_FN} locks without SKIP LOCKED. A contending worker would ` +
        `block on the lock until the holder commits instead of taking the next task.`
    );
    assert.ok(
      /FOR UPDATE SKIP LOCKED/i.test(flat),
      `${label}: the candidate CTE of ${CLAIM_FN} does not take a row lock. ` +
        `Without FOR UPDATE SKIP LOCKED, choosing a row and claiming it are two ` +
        `steps and two workers can both pass step one. The prose in the migration ` +
        `does not count — this is the executable SQL.`
    );
    last = cte;
  }
  return last;
}

// ---------------------------------------------------------------------------
// TEETH — the guard is run against SQL that is wrong in exactly the way the
// finding describes, so it can never again pass on prose alone.
// ---------------------------------------------------------------------------

/**
 * FIXTURE: migration 010's claim function with the executable
 * `FOR UPDATE SKIP LOCKED` deleted and BOTH prose mentions left in place.
 * This is byte-for-byte the shape the R1.2.2 verifier's sabotage produced, and
 * it is what `/FOR UPDATE SKIP LOCKED/` against the whole file happily accepts.
 */
const SABOTAGED_010 = `
-- The candidate CTE takes a row lock with FOR UPDATE SKIP LOCKED. Two workers
-- racing for the same row: the first locks it; the second skips.
CREATE OR REPLACE FUNCTION claim_probe_tasks(p_owner text, p_limit integer DEFAULT 5)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
BEGIN
  WITH candidate AS (
    SELECT t.id
      FROM probe_tasks t
     WHERE t.status IN ('pending', 'claimed')
     ORDER BY t.priority DESC, t.created_at
     LIMIT p_limit
     -- That selection needs FOR UPDATE SKIP LOCKED.
  ),
  claimed AS (
    UPDATE probe_tasks t SET status = 'claimed' FROM candidate c WHERE t.id = c.id
    RETURNING t.*
  )
  SELECT 1;
END;
$fn$;
`;

/** FIXTURE: the blocking variant — locked, but without SKIP LOCKED. */
const BLOCKING_010 = SABOTAGED_010.replace("     LIMIT p_limit", "     LIMIT p_limit\n     FOR UPDATE");

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
