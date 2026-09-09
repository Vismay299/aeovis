import assert from "node:assert/strict";

/**
 * R1.2.13 — the claim-lock guard, extracted so more than one suite can call it.
 *
 * WHY THIS FILE EXISTS.
 * R1.2.8 shipped this logic inside `src/lib/probeClaimLock.test.mjs`. R1.2.13
 * needed `src/lib/probeQueue.test.mjs` to call the same check, and a test file
 * must never import another test file: under `node --test` the imported file's
 * `test()` calls register inside the importing file's run, and every one of them
 * was reported as "test did not finish before its parent and was cancelled" —
 * four phantom failures and a test count inflated from 25 to 31. So the pure
 * helpers live here, in a module the `src/**\/*.test.mjs` glob does not collect,
 * and both suites import them. ONE implementation, so two green checks cannot
 * disagree about what they proved.
 *
 * WHAT THESE FUNCTIONS PROVE, AND WHAT THEY DO NOT.
 * They are STATIC assertions on SQL TEXT. They prove that the migration's
 * executable SQL — comments stripped — says `FOR UPDATE SKIP LOCKED` on the
 * row-choosing SELECT of `claim_probe_tasks`. They prove NOTHING about
 * Postgres's behaviour, because nothing here talks to Postgres: this
 * environment has no database, and a JavaScript simulation of a lock manager
 * would agree with a broken migration as readily as a correct one. The
 * behavioural proof is `src/lib/probeTasksRace.test.mjs`, which requires a real
 * database and skips LOUDLY and countably when it has none. A skip there is an
 * admission, not a pass.
 *
 * WHY THE TEXT CHECK IS WORTH HAVING ANYWAY.
 * R1.2.2's verifier deleted `FOR UPDATE SKIP LOCKED` from the claim function and
 * the whole suite stayed green. The only static assertion that existed matched
 * `/FOR UPDATE SKIP LOCKED/` against the WHOLE migration file, and migration 010
 * names the clause twice in PROSE (its header at line 28, the comment above the
 * function at line 111). The comments alone satisfied it. Hence, here: comments
 * are stripped BEFORE matching, the match is scoped to the candidate CTE, every
 * migration defining the function is walked so a later CREATE OR REPLACE cannot
 * quietly drop the clause, and a bare blocking `FOR UPDATE` is rejected with its
 * own message because it is a different bug.
 *
 * The teeth are proved against deliberately broken fixtures in
 * `src/lib/probeClaimLock.test.mjs`.
 */

export const CLAIM_FN = "claim_probe_tasks";

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
export const flatten = (s) => s.replace(/\s+/g, " ").trim();

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
 * The guard itself, as a function so fixtures can point it at deliberately
 * broken SQL. Throws with the reason; returns the CTE on success.
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

/**
 * FIXTURE: migration 010's claim function with the executable
 * `FOR UPDATE SKIP LOCKED` deleted and BOTH prose mentions left in place.
 * This is the shape the R1.2.2 verifier's sabotage produced, and it is what
 * `/FOR UPDATE SKIP LOCKED/` against the whole file happily accepts. Exported
 * so any suite that CALLS `assertLockedSelection` can prove, in its own file,
 * that the function it is calling is not a no-op.
 */
export const SABOTAGED_CLAIM_SQL = `
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
export const BLOCKING_CLAIM_SQL = SABOTAGED_CLAIM_SQL.replace(
  "     LIMIT p_limit",
  "     LIMIT p_limit\n     FOR UPDATE"
);
