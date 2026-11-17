import assert from "node:assert/strict";

/**
 * R1.2.13 — the claim-lock guard, extracted so more than one suite can call it.
 *
 * WHY THIS FILE EXISTS.
 * R1.2.8 shipped this logic inside `src/server/probeClaimLock.test.mjs`. R1.2.13
 * needed `src/server/probeQueue.test.mjs` to call the same check, and a test file
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
 * behavioural proof is `src/server/probeTasksRace.test.mjs`, which requires a real
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
 * `src/server/probeClaimLock.test.mjs`.
 *
 * R1.2.15 — THE SECOND HALF OF THIS FILE IS NOT A STRING CHECK. Everything
 * described above stops at the LOCK. `assertCandidateScope` and `claimWindow`,
 * below the divider, compile the candidate SELECT's WHERE, ORDER BY and LIMIT
 * and the `claimed` CTE's SET list out of the migration and RUN them, because
 * the predicate that decides whose probe a worker may claim is not something a
 * regex over the lock clause can see. They still do not model Postgres's lock
 * manager and say so at length where they are defined.
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

// ===========================================================================
// R1.2.15 — THE CLAIM WINDOW, COMPILED OUT OF THE SQL AND EXECUTED
//
// WHY THIS EXISTS. Everything above is a string check. R1.2.8's verifier showed
// that the one structural claim those string checks make — "the match is scoped
// to the candidate CTE" — was pinned by nothing: replace `candidateCte` with a
// passthrough returning the whole function body and both suites stayed green
// (32/32), after which the lock clause could sit anywhere in the function and
// the guard would still pass. Worse, NOTHING at all pinned what the candidate
// CTE scopes *to*. The predicate that stops one worker claiming another
// worker's probe —
//
//     AND (t.lease_owner IS NULL
//          OR t.lease_expires_at IS NULL
//          OR t.lease_expires_at < v_now)
//
// — could be deleted from migration 010 and no test in this repo would notice,
// because the lock clause would still be exactly where the regex wanted it.
// A row lock decides WHICH of the eligible rows a worker takes; the predicate
// decides which rows are eligible at all. Widen it and the lock is irrelevant,
// because both workers are then entitled to the same live-leased row.
//
// SO THIS HALF IS BEHAVIOURAL. `claimWindow` parses the candidate SELECT's
// WHERE into an expression tree and returns a predicate you can run rows
// through; `simulateClaimRace` runs two claimants over one row and reports who
// won. The rows are data, the predicate is the migration's own SQL, and the
// assertions are about outcomes ("a live lease held by another worker is not
// claimable") rather than about text.
//
// WHAT IT MODELS AND WHAT IT DOES NOT — read this before citing it.
//   * It models the claim WINDOW: the eligibility predicate, the ORDER BY, the
//     LIMIT, and the SET list the `claimed` CTE writes. All four are read out of
//     the SQL, never restated here.
//   * It does NOT model Postgres's lock manager, and `simulateClaimRace`
//     therefore runs its claimants SERIALLY. That is not a claim that the
//     transactions serialize — it is an assumption, and it is exactly the
//     assumption `FOR UPDATE SKIP LOCKED` exists to make true. The clause's
//     presence and position are checked statically above and behaviourally
//     against a REAL database in `src/server/probeTasksRace.test.mjs`, which skips
//     loudly and countably when no database is configured. Neither arm
//     substitutes for the other, and a race simulation with no lock manager
//     would agree with a broken migration, so it is not offered as one.
//   * It REFUSES what it does not recognise. Every predicate atom, ORDER BY
//     term and SET assignment must match one of the closed set of forms below;
//     anything else throws `unmodelled SQL`. An ignored conjunct would be a
//     claim window this guard pretended to have checked, which is the same
//     false success in a new costume.
// ===========================================================================

/** A fixed instant, so nothing here depends on the wall clock. 2026-01-01Z. */
export const MODEL_NOW_MS = Date.UTC(2026, 0, 1);

/** The parameter defaults migration 010 declares, as the model's env. */
export const MODEL_PARAMS = Object.freeze({
  p_owner: "worker-a",
  p_engines: null,
  p_batch_id: null,
  p_limit: 5,
  p_lease_ms: 180000,
});

function unmodelled(label, what) {
  return new Error(
    `${label}: unmodelled SQL — ${what}. The claim window is compiled from a closed ` +
      `set of recognised forms and REFUSES anything outside it, because a conjunct ` +
      `this model quietly skipped would be a claim window it only pretended to check. ` +
      `Extend the model deliberately, in probeClaimLock.guard.mjs, and say what the ` +
      `new form means for who may claim whose probe.`
  );
}

const isWordChar = (c) => !!c && /[A-Za-z0-9_]/.test(c);

/** Case-insensitive whole-word keyword match at `i` (operates on flattened SQL). */
function kwAt(s, i, kw) {
  if (s.slice(i, i + kw.length).toUpperCase() !== kw) return false;
  if (isWordChar(s[i - 1])) return false;
  return !isWordChar(s[i + kw.length]);
}

/**
 * Index of the first depth-0 occurrence of any keyword in `kws`, or -1. A `)`
 * that closes past our starting depth ends the scan: that is the paren closing
 * the CTE itself, and nothing after it belongs to the candidate SELECT.
 */
function topKwIndex(s, kws, from = 0) {
  let depth = 0;
  let quoted = false;
  for (let i = from; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") {
      quoted = true;
      continue;
    }
    if (c === "(") {
      depth += 1;
      continue;
    }
    if (c === ")") {
      if (depth === 0) return i;
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    for (const kw of kws) if (kwAt(s, i, kw)) return i;
  }
  return -1;
}

/** Split on a depth-0 keyword (AND/OR). Quote- and paren-aware. */
function splitTopKw(s, kw) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") {
      quoted = true;
      continue;
    }
    if (c === "(") {
      depth += 1;
      continue;
    }
    if (c === ")") {
      depth -= 1;
      continue;
    }
    if (depth === 0 && kwAt(s, i, kw)) {
      parts.push(s.slice(start, i));
      i += kw.length - 1;
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Split a comma list at depth 0 — `IN (...)` items, ORDER BY terms, SET pairs. */
function splitTopComma(s) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") {
      quoted = true;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Drop parens that wrap the WHOLE expression, however many layers deep. */
function unwrap(src) {
  let t = src.trim();
  for (;;) {
    if (!t.startsWith("(")) return t;
    let depth = 0;
    let quoted = false;
    let i = 0;
    for (; i < t.length; i += 1) {
      const c = t[i];
      if (quoted) {
        if (c === "'") quoted = false;
        continue;
      }
      if (c === "'") {
        quoted = true;
        continue;
      }
      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (i !== t.length - 1) return t;
    t = t.slice(1, -1).trim();
  }
}

/**
 * The SELECT *inside* `WITH candidate AS ( ... )`, flattened. The parsers below
 * scan at paren depth 0, and `candidateCte` hands back the CTE including its own
 * wrapping parens, so without this every clause would sit one level down and be
 * read as absent — a null that would look like "there is no WHERE clause".
 */
function insideFirstParens(flat) {
  const open = flat.indexOf("(");
  if (open < 0) return flat;
  let depth = 0;
  let quoted = false;
  for (let i = open; i < flat.length; i += 1) {
    const c = flat[i];
    if (quoted) {
      if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") {
      quoted = true;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return flat.slice(open + 1, i).trim();
    }
  }
  return flat.slice(open + 1).trim();
}

export const candidateSelect = (cte) => insideFirstParens(flatten(cte));

/**
 * The candidate SELECT's WHERE text — the claim window's predicate, as written.
 * `null` when the SELECT has no WHERE at all, which is its own finding.
 */
export function candidateWhere(cte) {
  const flat = candidateSelect(cte);
  const w = topKwIndex(flat, ["WHERE"]);
  if (w < 0) return null;
  const end = topKwIndex(flat, ["ORDER BY", "LIMIT", "FOR UPDATE", "GROUP BY", "HAVING"], w + 5);
  return flat.slice(w + 5, end < 0 ? flat.length : end).trim() || null;
}

/** AND/OR/atom tree. OR is split first, so AND binds tighter, as in SQL. */
export function parseBoolExpr(src) {
  const s = unwrap(src);
  const ors = splitTopKw(s, "OR");
  if (ors.length > 1) return { op: "or", parts: ors.map(parseBoolExpr) };
  const ands = splitTopKw(s, "AND");
  if (ands.length > 1) return { op: "and", parts: ands.map(parseBoolExpr) };
  return { op: "atom", text: s };
}

/**
 * Resolve one term. Recognised: a quoted literal, an integer, NULL, `t.column`,
 * `p_param`, `v_now`/`v_expires`, `now()`. A column the caller's row does not
 * define is unmodelled rather than undefined, so a predicate that starts reading
 * a new column cannot pass by reading `undefined`.
 */
function resolveTerm(tok, ctx) {
  const t = tok.trim();
  if (/^'(?:[^']|'')*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^NULL$/i.test(t)) return null;
  if (/^now\(\)$/i.test(t)) return ctx.vars.v_now;
  const col = /^[a-z_]+\.([a-z_]+)$/i.exec(t);
  if (col) {
    if (!Object.hasOwn(ctx.row, col[1])) throw unmodelled(ctx.label, `column \`${t}\``);
    return ctx.row[col[1]];
  }
  if (/^p_[a-z_]+$/i.test(t)) {
    if (!Object.hasOwn(ctx.params, t)) throw unmodelled(ctx.label, `parameter \`${t}\``);
    return ctx.params[t];
  }
  if (/^v_[a-z_]+$/i.test(t)) {
    if (!Object.hasOwn(ctx.vars, t)) throw unmodelled(ctx.label, `variable \`${t}\``);
    return ctx.vars[t];
  }
  throw unmodelled(ctx.label, `term \`${t}\``);
}

/** SQL three-valued comparison: NULL on either side is unknown, not false. */
function compareTerms(op, a, b, ctx) {
  if (a === null || b === null) return null;
  if (typeof a !== typeof b) {
    throw unmodelled(ctx.label, `a comparison between ${typeof a} and ${typeof b}`);
  }
  switch (op) {
    case "=":
      return a === b;
    case "<>":
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    default:
      throw unmodelled(ctx.label, `operator \`${op}\``);
  }
}

/**
 * One predicate atom → true / false / null (unknown). The recognised forms are
 * exactly the ones migration 010 uses; each is listed so the next reader can see
 * what the model covers without reading the implementation.
 */
function evalAtom(text, ctx) {
  const s = unwrap(text);
  let m;
  // `x IS NOT NULL`
  if ((m = /^(.+?)\s+IS\s+NOT\s+NULL$/i.exec(s))) return resolveTerm(m[1], ctx) !== null;
  // `x IS NULL`
  if ((m = /^(.+?)\s+IS\s+NULL$/i.exec(s))) return resolveTerm(m[1], ctx) === null;
  // `x = ANY (y)` — the engine filter's membership test
  if ((m = /^(.+?)\s*=\s*ANY\s*\((.*)\)$/i.exec(s))) {
    const left = resolveTerm(m[1], ctx);
    const right = resolveTerm(m[2], ctx);
    if (left === null || right === null) return null;
    if (!Array.isArray(right)) throw unmodelled(ctx.label, `ANY over a non-array \`${m[2]}\``);
    return right.includes(left);
  }
  // `x IN ('a', 'b')` — the status vocabulary
  if ((m = /^(.+?)\s+IN\s*\((.*)\)$/i.exec(s))) {
    const left = resolveTerm(m[1], ctx);
    const items = splitTopComma(m[2]).map((it) => resolveTerm(it, ctx));
    if (left === null) return null;
    if (items.includes(left)) return true;
    return items.includes(null) ? null : false;
  }
  // a binary comparison
  if ((m = /^(.+?)\s*(<=|>=|<>|!=|<|>|=)\s*(.+)$/.exec(s))) {
    return compareTerms(m[2], resolveTerm(m[1], ctx), resolveTerm(m[3], ctx), ctx);
  }
  throw unmodelled(ctx.label, `predicate \`${s}\``);
}

/** Three-valued AND/OR over the tree. A WHERE admits only `true`. */
function evalNode(node, ctx) {
  if (node.op === "atom") return evalAtom(node.text, ctx);
  const vals = node.parts.map((p) => evalNode(p, ctx));
  if (node.op === "and") {
    if (vals.includes(false)) return false;
    return vals.includes(null) ? null : true;
  }
  if (vals.includes(true)) return true;
  return vals.includes(null) ? null : false;
}

/** ORDER BY terms of the candidate SELECT. `null` when there is no ORDER BY. */
export function candidateOrderBy(cte, label = "sql") {
  const flat = candidateSelect(cte);
  const at = topKwIndex(flat, ["ORDER BY"]);
  if (at < 0) return null;
  const end = topKwIndex(flat, ["LIMIT", "FOR UPDATE"], at + 8);
  const text = flat.slice(at + 8, end < 0 ? flat.length : end).trim();
  return splitTopComma(text).map((term) => {
    const m = /^([a-z_]+\.)?([a-z_]+)(?:\s+(ASC|DESC))?$/i.exec(term);
    if (!m) throw unmodelled(label, `ORDER BY term \`${term}\``);
    return { column: m[2], desc: /desc/i.test(m[3] || "") };
  });
}

/** The LIMIT term, as written (`p_limit`, or an integer). */
export function candidateLimit(cte, label = "sql") {
  const flat = candidateSelect(cte);
  const at = topKwIndex(flat, ["LIMIT"]);
  if (at < 0) return null;
  const rest = flat.slice(at + 5).trim();
  const m = /^([a-z_]+|\d+)\b/i.exec(rest);
  if (!m) throw unmodelled(label, `LIMIT term \`${rest.slice(0, 24)}\``);
  return m[1];
}

/** The `claimed` CTE's text, from its name to the paren that closes it. */
export function claimedCte(body) {
  const at = body.search(/\bclaimed\s+AS\s*\(/i);
  if (at < 0) return null;
  const open = body.indexOf("(", at);
  let depth = 0;
  let quoted = false;
  for (let i = open; i < body.length; i += 1) {
    const c = body[i];
    if (quoted) {
      if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") {
      quoted = true;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return body.slice(at, i + 1);
    }
  }
  return body.slice(at);
}

/**
 * What the claim WRITES, read out of the `claimed` CTE's SET list. The model
 * needs this and cannot invent it: whether a claimed row leaves the window
 * depends on the values the UPDATE actually puts in `status`, `lease_owner` and
 * `lease_expires_at`, and a SET list that stopped writing the lease would let
 * the next poll re-hand the same task.
 */
export function parseClaimUpdate(body, label = "sql") {
  const cte = claimedCte(body);
  if (!cte) throw unmodelled(label, "no `claimed` CTE — nothing applies the claim");
  const flat = flatten(cte);
  if (!/UPDATE\s+probe_tasks\s+t\b/i.test(flat)) {
    throw unmodelled(label, "a `claimed` CTE that does not UPDATE probe_tasks as `t`");
  }
  if (!/\bcandidate\b/i.test(flat)) {
    throw unmodelled(label, "a `claimed` CTE that does not take its rows from `candidate`");
  }
  if (!/WHERE\s+t\.id\s*=\s*[a-z_]+\.id\b/i.test(flat)) {
    throw unmodelled(label, "a `claimed` CTE whose UPDATE does not join on the candidate id");
  }
  // Inside the CTE's own parens, for the same reason `candidateSelect` exists:
  // the scanners work at depth 0 and would otherwise see no SET at all.
  const inner = insideFirstParens(flat);
  const setAt = topKwIndex(inner, ["SET"]);
  if (setAt < 0) throw unmodelled(label, "a `claimed` CTE with no SET list");
  const end = topKwIndex(inner, ["FROM", "WHERE", "RETURNING"], setAt + 3);
  const setText = inner.slice(setAt + 3, end < 0 ? inner.length : end).trim();
  return splitTopComma(setText).map((pair) => {
    const m = /^([a-z_]+)\s*=\s*(.+)$/i.exec(pair);
    if (!m) throw unmodelled(label, `SET item \`${pair}\``);
    const [column, rhs] = [m[1], m[2].trim()];
    const inc = /^[a-z_]+\.([a-z_]+)\s*\+\s*(\d+)$/i.exec(rhs);
    if (inc) return { column, kind: "increment", from: inc[1], by: Number(inc[2]) };
    return { column, kind: "value", term: rhs };
  });
}

/**
 * A probe_tasks row as the model sees one. Timestamps are epoch MILLISECONDS,
 * not ISO strings, so `lease_expires_at < v_now` is a numeric comparison the
 * model can make honestly instead of a lexical one that happens to agree.
 */
export function probeTaskRow(over = {}) {
  return {
    id: "task-1",
    batch_id: "batch-1",
    scan_job_id: "scan-1",
    engine: "chatgpt",
    query: "who are the best crm vendors",
    status: "pending",
    priority: 0,
    attempts: 0,
    max_attempts: 3,
    lease_owner: null,
    lease_expires_at: null,
    claimed_at: null,
    outcome: null,
    outcome_detail: null,
    completed_at: null,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

/**
 * Compile `claim_probe_tasks`'s candidate CTE into something executable.
 * Throws (never returns a permissive default) when the SQL is outside the
 * modelled set.
 */
export function claimWindow(sql, label = "sql") {
  const bodies = claimFunctionBodies(sql);
  assert.equal(
    bodies.length,
    1,
    `${label}: expected exactly one ${CLAIM_FN} definition to model, found ${bodies.length}`
  );
  const body = bodies[0];
  const cte = candidateCte(body);
  assert.ok(cte, `${label}: ${CLAIM_FN} has no candidate CTE — there is no claim window to model`);
  const whereText = candidateWhere(cte);
  assert.ok(
    whereText,
    `${label}: the candidate SELECT has no WHERE clause. An unfiltered claim window ` +
      `takes any row at all — terminal, or live-leased by another worker.`
  );
  const ast = parseBoolExpr(whereText);
  const orderBy = candidateOrderBy(cte, label);
  const limit = candidateLimit(cte, label);
  const update = parseClaimUpdate(body, label);

  const envOf = (env = {}) => {
    const params = { ...MODEL_PARAMS, ...(env.params || {}) };
    const nowMs = env.nowMs ?? MODEL_NOW_MS;
    return { params, vars: { v_now: nowMs, v_expires: nowMs + params.p_lease_ms }, nowMs };
  };

  // DRY RUN, at compile time and not on first use. Every atom of the predicate
  // and every item of the SET list is resolved once against a canonical row, so
  // a form the model does not recognise refuses HERE — at the moment the window
  // is compiled — rather than at whatever moment a caller happens to hit it, or
  // never, if no caller happens to. `evalNode` visits every branch (there is no
  // short-circuit), so this reaches the whole tree.
  const dry = envOf();
  evalNode(ast, { row: probeTaskRow(), params: dry.params, vars: dry.vars, label });
  for (const a of update) {
    if (a.kind === "increment") continue;
    resolveTerm(a.term, { row: probeTaskRow(), params: dry.params, vars: dry.vars, label });
  }

  return {
    body,
    cte,
    whereText,
    ast,
    orderBy,
    limit,
    update,
    /** Is this row inside the claim window right now? */
    admits(row, env) {
      const e = envOf(env);
      return evalNode(ast, { row, params: e.params, vars: e.vars, label }) === true;
    },
    /** The candidate SELECT's own ordering, so LIMIT means what the queue means. */
    order(rows) {
      // No ORDER BY means the queue has no defined order, so neither has this
      // model. Returning the rows in the order they were handed over would be
      // inventing a winner the database does not promise.
      if (!orderBy || orderBy.length === 0) {
        throw unmodelled(label, "a candidate SELECT with no ORDER BY — which row wins is undefined");
      }
      return [...rows].sort((a, b) => {
        for (const key of orderBy) {
          const [x, y] = [a[key.column], b[key.column]];
          if (x === undefined || y === undefined) {
            throw unmodelled(label, `ORDER BY column \`${key.column}\` missing from the row`);
          }
          if (x === y) continue;
          const cmp = x < y ? -1 : 1;
          return key.desc ? -cmp : cmp;
        }
        return 0;
      });
    },
    limitValue(env) {
      const e = envOf(env);
      if (/^\d+$/.test(limit)) return Number(limit);
      if (!Object.hasOwn(e.params, limit)) throw unmodelled(label, `LIMIT term \`${limit}\``);
      return e.params[limit];
    },
    /** Apply the `claimed` CTE's SET list to a row, in place. */
    applyClaim(row, env) {
      const e = envOf(env);
      for (const a of update) {
        if (a.kind === "increment") {
          row[a.column] = (row[a.from] ?? 0) + a.by;
          continue;
        }
        row[a.column] = resolveTerm(a.term, { row, params: e.params, vars: e.vars, label });
      }
      return row;
    },
  };
}

/**
 * Run claimants over one set of rows and report who got what.
 *
 * SERIAL BY CONSTRUCTION, and that is the point: each claimant sees the rows the
 * previous claimant left behind, which is what a correct `FOR UPDATE SKIP
 * LOCKED` claim guarantees. The question this answers is therefore not "does
 * Postgres lock?" but "given serialization, does the WINDOW stop the second
 * claimant?" — and a window that hands the same row out twice here hands it out
 * twice in production too, lock or no lock.
 */
export function simulateClaimRace(sql, { rows, owners, nowMs = MODEL_NOW_MS, params = {}, label = "sql" }) {
  const win = claimWindow(sql, label);
  const state = rows.map((r) => ({ ...r }));
  const rounds = [];
  for (const owner of owners) {
    const env = { nowMs, params: { ...params, p_owner: owner } };
    const eligible = win.order(state.filter((r) => win.admits(r, env)));
    const taken = eligible.slice(0, win.limitValue(env));
    for (const row of taken) win.applyClaim(row, env);
    rounds.push({ owner, claimed: taken.map((r) => r.id) });
  }
  return { rounds, rows: state };
}

/**
 * THE SCOPE GUARD. Everything `assertLockedSelection` asserts, plus the two
 * things it cannot: WHERE in the function the lock sits, and WHAT the candidate
 * CTE scopes to. Returns the compiled window on success; throws naming the
 * failure otherwise.
 */
export function assertCandidateScope(sql, label) {
  const bodies = claimFunctionBodies(sql);
  assert.ok(bodies.length > 0, `${label}: no ${CLAIM_FN} definition found`);

  // 1. POSITION — checked before presence, because "the lock moved" is a more
  //    useful diagnosis than "there is no lock in the candidate CTE", and it is
  //    the attack R1.2.8's verifier used.
  for (const body of bodies) {
    const cte = candidateCte(body);
    assert.ok(
      cte,
      `${label}: ${CLAIM_FN} has no candidate CTE — the row-choosing SELECT is gone`
    );
    const inBody = [...flatten(body).matchAll(/FOR UPDATE SKIP LOCKED/gi)].length;
    const inCte = [...flatten(cte).matchAll(/FOR UPDATE SKIP LOCKED/gi)].length;
    assert.ok(
      !(inBody > 0 && inCte === 0),
      `${label}: ${CLAIM_FN} takes FOR UPDATE SKIP LOCKED OUTSIDE the candidate CTE ` +
        `(${inBody} in the function body, 0 in the row-choosing SELECT). Locking rows the ` +
        `UPDATE has already chosen does not decide WHICH rows this worker takes: two ` +
        `workers evaluate the same unlocked candidate SELECT, come away with the same ` +
        `task id, and the second overwrites the first's lease.`
    );
    assert.equal(
      inBody - inCte,
      0,
      `${label}: ${inBody - inCte} stray FOR UPDATE SKIP LOCKED outside the candidate CTE ` +
        `of ${CLAIM_FN}. Exactly one lock, on the row-choosing SELECT, or "choosing IS ` +
        `locking" stops being migration 010's atomicity argument.`
    );
  }

  // 2. PRESENCE and the blocking diagnosis — delegated, so there is ONE
  //    implementation of those two messages and the suites cannot disagree.
  //    Deliberately ahead of the "exactly one clause in the CTE" count below: a
  //    bare blocking `FOR UPDATE` has zero SKIP LOCKED clauses, and "expected 1,
  //    found 0" would bury the diagnosis that actually names the bug.
  assertLockedSelection(sql, label);

  // 3. THE LOCK CLOSES THE SELECT, ONCE. Postgres requires the locking clause
  //    last, and the order matters to the guard too: a clause ahead of
  //    ORDER BY/LIMIT is not the same statement, and one parked in a nested
  //    sub-SELECT locks a row set other than the one being chosen.
  for (const body of bodies) {
    const cte = candidateCte(body);
    const flat = flatten(cte);
    assert.equal(
      [...flat.matchAll(/FOR UPDATE SKIP LOCKED/gi)].length,
      1,
      `${label}: the candidate CTE of ${CLAIM_FN} must carry exactly one ` +
        `FOR UPDATE SKIP LOCKED`
    );
    assert.ok(
      (candidateOrderBy(cte, label) || []).length > 0,
      `${label}: the candidate SELECT of ${CLAIM_FN} has no ORDER BY. Which task a worker ` +
        `is handed then depends on the plan, so the queue has no order and a low-priority ` +
        `task can starve while the guard still sees a lock.`
    );
    const order = flat.search(/ORDER BY/i);
    const limit = flat.search(/\bLIMIT\b/i);
    const lock = flat.search(/FOR UPDATE SKIP LOCKED/i);
    assert.ok(
      limit >= 0 && order < limit && limit < lock,
      `${label}: the candidate SELECT of ${CLAIM_FN} must read ORDER BY, then LIMIT, then ` +
        `FOR UPDATE SKIP LOCKED (found ORDER BY@${order}, LIMIT@${limit}, lock@${lock})`
    );
    assert.match(
      flat,
      /FOR UPDATE SKIP LOCKED\s*\)\s*,?$/i,
      `${label}: FOR UPDATE SKIP LOCKED must be the LAST clause of the candidate SELECT. ` +
        `Anywhere else it locks a row set other than the one this worker is choosing.`
    );
  }

  // 4. THE WINDOW ITSELF, EXECUTED. Not a regex over the predicate — rows run
  //    through the predicate the migration actually wrote. Each case below is a
  //    row the queue really produces.
  const win = claimWindow(sql, label);
  const NOW = MODEL_NOW_MS;
  const live = { lease_owner: "worker-b", lease_expires_at: NOW + 60_000 };
  const lapsed = { lease_owner: "worker-b", lease_expires_at: NOW - 1 };
  const env = { nowMs: NOW, params: { p_owner: "worker-a" } };

  assert.ok(
    win.admits(probeTaskRow(), env),
    `${label}: a pending, unleased task is not in the claim window — the queue can hand ` +
      `out nothing at all`
  );
  assert.ok(
    !win.admits(probeTaskRow({ status: "done" }), env),
    `${label}: a terminal task is inside the claim window. A finished probe would be ` +
      `re-run and its outcome overwritten.`
  );
  assert.ok(
    !win.admits(probeTaskRow({ status: "claimed", ...live }), env),
    `${label}: a task another worker holds a LIVE lease on is inside the claim window. ` +
      `This is the predicate that stops one worker claiming another worker's probe; ` +
      `without it both workers probe the same task and the second overwrites the first's ` +
      `lease, so two live API calls are billed and one result is lost.`
  );
  assert.ok(
    win.admits(probeTaskRow({ status: "claimed", ...lapsed }), env),
    `${label}: a task whose lease has LAPSED is NOT in the claim window. A worker that ` +
      `died mid-probe would strand its task forever and LEASE_TTL_MS would mean nothing ` +
      `— the reclaim path is the whole reason the window covers 'claimed' as well as ` +
      `'pending'.`
  );
  assert.ok(
    !win.admits(probeTaskRow({ status: "claimed", lease_owner: "worker-a", lease_expires_at: NOW + 60_000 }), env),
    `${label}: a worker's OWN live lease is inside its claim window. 010 diverges from ` +
      `jobLease here deliberately: the next poll would be re-handed the batch this worker ` +
      `is still probing, re-running live work and inflating attempts.`
  );
  assert.ok(
    win.admits(probeTaskRow(), { nowMs: NOW, params: { p_engines: ["chatgpt"] } }) &&
      !win.admits(probeTaskRow(), { nowMs: NOW, params: { p_engines: ["perplexity"] } }),
    `${label}: the engine filter does not select — a worker asking for one engine's tasks ` +
      `would be handed another engine's`
  );
  assert.ok(
    win.admits(probeTaskRow(), { nowMs: NOW, params: { p_batch_id: "batch-1" } }) &&
      !win.admits(probeTaskRow(), { nowMs: NOW, params: { p_batch_id: "batch-2" } }),
    `${label}: the batch filter does not select`
  );

  return win;
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
