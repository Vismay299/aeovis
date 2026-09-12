import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
 *
 * R1.2.15 UPDATE — the scoping, and what it scopes TO, both pinned.
 *
 * THE GAP. The comment-stripping half of this guard had a fixture. The SCOPING
 * half — `candidateCte`, which is what makes "the match is scoped to the
 * candidate CTE" true — had nothing. R1.2.8's verifier confirmed the scoping
 * WORKS (relocating the clause in the live migration turned two tests red) and
 * also that nothing PINS it. Reproduced here before anything was written:
 * replacing `candidateCte`'s body with `return body` left probeClaimLock.test.mjs
 * and probeQueue.test.mjs at 32/32 PASS. A refactor could retire the scoping in
 * silence, after which the clause could sit anywhere in the function.
 *
 * THE WIDER GAP UNDERNEATH IT. Every check in the lineage above is about the
 * LOCK. Not one was about what the candidate CTE scopes TO. The predicate that
 * actually stops one worker claiming another worker's probe —
 *
 *     AND (t.lease_owner IS NULL
 *          OR t.lease_expires_at IS NULL
 *          OR t.lease_expires_at < v_now)
 *
 * — could be deleted from migration 010 and every test in this repo stayed
 * green, because the lock clause would still be exactly where the regex wanted
 * it. A perfect lock over a window that admits another worker's in-flight task
 * hands the same probe out twice.
 *
 * WHAT WAS ADDED, IN TWO ARMS.
 *   1. A committed fixture CORPUS, `src/lib/fixtures/probeClaimLock/`: one
 *      positive control whose candidate CTE is asserted byte-identical to
 *      migration 010's, and four sabotages one edit away from it — the lock
 *      moved, the lock downgraded, the window widened, the window unordered,
 *      plus the narrowing regression 010's own comment records. Each declares
 *      the cheaper checks it DEFEATS and the rejection it must provoke, and the
 *      walker verifies both claims.
 *   2. `assertCandidateScope` and `claimWindow` in ./probeClaimLock.guard.mjs,
 *      which compile the candidate SELECT's WHERE, ORDER BY, LIMIT and the
 *      `claimed` CTE's SET list into something EXECUTABLE, so the window is
 *      asserted by running rows and claimants through the migration's own SQL
 *      rather than by matching its text. `simulateClaimRace` is serial by
 *      construction and says so: it models the WINDOW, never Postgres's lock
 *      manager. The lock's real behaviour stays where it belongs — a real
 *      database, in probeTasksRace.test.mjs, loudly skipped without one.
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
  // R1.2.15 — the scope guard and the executable claim-window model.
  assertCandidateScope,
  claimWindow,
  simulateClaimRace,
  probeTaskRow,
  MODEL_NOW_MS,
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

// ---------------------------------------------------------------------------
// R1.2.15 — THE CLAIM WINDOW: the fixture corpus, and the window executed
// ---------------------------------------------------------------------------

const FIXTURES = path.join(REPO, "src/lib/fixtures/probeClaimLock");
const MIGRATION_010 = path.join(MIGRATIONS, "010_probe_tasks.sql");

/**
 * The corpus, named here on purpose. A fixture that is deleted, renamed or
 * added makes this list wrong and the walk below fails: the set of attacks this
 * guard is pinned against is a deliberate decision, not whatever happens to be
 * in the directory. Each file explains itself in its own header.
 */
const REQUIRED_FIXTURES = [
  // The positive control. Its candidate CTE is asserted identical to 010's.
  "base-as-in-migration-010.sql.txt",
  // ORDERING: LIMIT over an unordered set, lock intact and in place.
  "candidate-select-unordered.sql.txt",
  // LOCK SEMANTICS: bare blocking FOR UPDATE on the full 010 shape.
  "lock-downgraded-to-bare-for-update.sql.txt",
  // SCOPING: the clause relocated into the `claimed` CTE — R1.2.8's attack.
  "lock-parked-in-the-claimed-cte.sql.txt",
  // NARROWED window: pending-only, the regression 010's own comment records.
  "scope-narrowed-to-pending-only.sql.txt",
  // WIDENED window: the lease-freedom predicate deleted, lock untouched.
  "scope-widened-any-live-lease-claimable.sql.txt",
];

/**
 * The cheaper checks each sabotage is measured against — this guard's own
 * ancestry, kept runnable. A fixture declares which of these it DEFEATS, and
 * the walk asserts the declaration exactly: every named check must pass on it
 * (it really is a false success for that check) and every unnamed one must
 * fail. Metadata that could drift from the file it describes would be one more
 * comment certifying itself.
 */
const CHEAPER_CHECKS = {
  // The original, pre-R1.2.8 assertion: /FOR UPDATE SKIP LOCKED/ over the RAW
  // file, prose included. `src/lib/probeQueue.test.mjs:463` was this until R1.2.13.
  "whole-file-regex": (raw) => /FOR UPDATE SKIP LOCKED/.test(raw),
  // R1.2.8's improvement — strip comments first, then match anywhere at all.
  "comment-stripped-regex": (raw) => /FOR UPDATE SKIP LOCKED/.test(stripSqlComments(raw)),
  // The counting guard above, which is deliberately GLOBAL rather than scoped:
  // its job is to notice a SECOND stray clause, not a relocated one.
  "single-executable-clause": (raw) =>
    [...stripSqlComments(raw).matchAll(/FOR UPDATE SKIP LOCKED/gi)].length === 1,
};

/** `-- R1215-KEY: value` out of a fixture header, or null. */
function marker(sql, key) {
  const m = new RegExp(`--\\s*R1215-${key}:\\s*(.+)`).exec(sql);
  return m ? m[1].trim() : null;
}

/**
 * Walk a corpus directory and assert every file in it. Returns the number of
 * fixtures actually asserted, so the caller can prove the walk did work rather
 * than trusting a green tick over an empty loop.
 *
 * It REFUSES an empty directory and a fixture with no expectation, because a
 * corpus guard that quietly asserts nothing is the exact false success this
 * whole file exists to remove. "NON-VACUITY", below, forces both cases.
 */
async function walkCorpus(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql.txt")).sort();
  assert.ok(
    files.length > 0,
    `${dir}: no *.sql.txt fixtures found. An empty corpus makes every assertion below ` +
      `vacuous — the walk would pass having checked nothing at all.`
  );
  let asserted = 0;
  for (const file of files) {
    const raw = await readFile(path.join(dir, file), "utf8");
    const expect = marker(raw, "EXPECT");
    const defeats = marker(raw, "DEFEATS");
    assert.ok(
      expect,
      `${file}: no \`-- R1215-EXPECT:\` marker. A fixture that does not say what it must ` +
        `provoke cannot be asserted, and a silently unasserted fixture is dead weight ` +
        `that reads like coverage.`
    );
    assert.ok(defeats, `${file}: no \`-- R1215-DEFEATS:\` marker`);

    if (expect === "accept") {
      // The positive control. A correct claim function satisfies every cheaper
      // check too — those checks are not wrong, only insufficient.
      assert.equal(defeats, "n/a", `${file}: an accept-fixture defeats nothing; say \`n/a\``);
      for (const [name, check] of Object.entries(CHEAPER_CHECKS)) {
        assert.ok(check(raw), `${file}: the positive control must satisfy ${name}`);
      }
      assertCandidateScope(raw, file);
      asserted += 1;
      continue;
    }

    const wanted = /^reject\s+\/(.+)\/$/.exec(expect);
    assert.ok(wanted, `${file}: R1215-EXPECT must read \`accept\` or \`reject /pattern/\``);
    assert.ok(
      marker(raw, "DERIVED-FROM") === "base-as-in-migration-010.sql.txt",
      `${file}: every sabotage must name the positive control it is one edit from`
    );

    const declared = defeats.split(",").map((s) => s.trim()).filter(Boolean);
    assert.ok(declared.length > 0, `${file}: a sabotage that defeats no cheaper check is not one`);
    for (const [name, check] of Object.entries(CHEAPER_CHECKS)) {
      const claimsIt = declared.includes(name);
      assert.equal(
        check(raw),
        claimsIt,
        claimsIt
          ? `${file} claims to defeat ${name}, but that check REJECTS it — the fixture has ` +
            `been edited into something the old check already catches, so it no longer ` +
            `reproduces the finding`
          : `${file} does NOT claim to defeat ${name}, but that check ACCEPTS it — the ` +
            `header understates what this fixture proves; say so on the DEFEATS line`
      );
    }
    for (const name of declared) {
      assert.ok(name in CHEAPER_CHECKS, `${file}: unknown cheaper check \`${name}\` on DEFEATS`);
    }

    assert.throws(
      () => assertCandidateScope(raw, file),
      new RegExp(wanted[1]),
      `${file}: the scope guard must reject this fixture, naming ${expect}`
    );
    asserted += 1;
  }
  return { asserted, files };
}

test("GUARD — the pinned claim window IS migration 010's, character for character", async () => {
  // The corpus is only worth anything if the shape it pins is the shape that
  // ships. Comments stripped and whitespace flattened, so a reformat or a new
  // comment is free — and any change to the predicate, the ordering, the limit
  // or the lock lands here first and has to be made on purpose.
  const live = await readFile(MIGRATION_010, "utf8");
  const base = await readFile(path.join(FIXTURES, "base-as-in-migration-010.sql.txt"), "utf8");
  assert.equal(
    flatten(candidateCte(claimFunctionBodies(base)[0])),
    flatten(candidateCte(claimFunctionBodies(live)[0])),
    "the positive-control fixture's candidate CTE has drifted from migration 010's. " +
      "Either 010's claim window changed — in which case say why, and update the four " +
      "sabotages beside it — or the fixture was edited and now pins nothing real."
  );
  assertCandidateScope(live, "supabase/migrations/010_probe_tasks.sql");
});

test("GUARD — the scoping NARROWS: candidateCte is not the whole function body", async () => {
  // The finding, stated as directly as it can be stated. Everything else in
  // this file detects an un-scoped `candidateCte` as a side effect — the window
  // stops parsing, the corpus stops being rejected — and those reds are real
  // but they name a symptom. This one names the cause, so the next person to
  // "simplify" the helper reads what they broke instead of guessing.
  const raw = await readFile(MIGRATION_010, "utf8");
  const body = claimFunctionBodies(raw)[0];
  const cte = candidateCte(body);
  assert.ok(cte, "the candidate CTE must be found at all");
  assert.ok(
    cte.length < body.length,
    "candidateCte returned the WHOLE function body. The guard's one structural claim — " +
      "'the match is scoped to the candidate CTE' — is then false, and FOR UPDATE SKIP " +
      "LOCKED could sit anywhere in claim_probe_tasks and still satisfy every check."
  );
  assert.ok(
    !/UPDATE\s+probe_tasks/i.test(cte),
    "the scope must stop before the `claimed` CTE's UPDATE: a lock on rows already " +
      "chosen is not a lock on the choosing"
  );
  assert.ok(
    /WITH\s+candidate\s+AS/i.test(cte) && !/\bclaimed\s+AS\b/i.test(cte),
    "the scope must start at the candidate CTE and end where `claimed` begins"
  );
});

test("BEHAVIOURAL — two claimants, one task: exactly one wins", async () => {
  // Not a string diff. The predicate, the ORDER BY, the LIMIT and the SET list
  // are compiled out of migration 010 and RUN. The claimants are serialized by
  // construction, which is what a correct FOR UPDATE SKIP LOCKED guarantees and
  // is asserted separately (statically above, and against a real Postgres in
  // src/lib/probeTasksRace.test.mjs). The question here is the one a lock cannot
  // answer: given serialization, does the WINDOW stop the second claimant?
  const sql = await readFile(MIGRATION_010, "utf8");
  const { rounds, rows } = simulateClaimRace(sql, {
    rows: [probeTaskRow({ id: "t1" })],
    owners: ["worker-a", "worker-b"],
  });
  assert.deepEqual(
    rounds,
    [
      { owner: "worker-a", claimed: ["t1"] },
      { owner: "worker-b", claimed: [] },
    ],
    "one task and two claimants must produce exactly one claim; a second claim here is " +
      "the same probe run twice, billed twice, with the first worker's outcome overwritten"
  );
  assert.equal(rows[0].lease_owner, "worker-a", "the winner must hold the lease it took");
  assert.equal(rows[0].status, "claimed");
  assert.equal(rows[0].attempts, 1, "one claim, one attempt");

  // Six claimants, one task — the shape probeTasksRace.test.mjs runs live.
  const many = simulateClaimRace(sql, {
    rows: [probeTaskRow({ id: "t1" })],
    owners: ["w1", "w2", "w3", "w4", "w5", "w6"],
  });
  assert.equal(
    many.rounds.filter((r) => r.claimed.length > 0).length,
    1,
    "six claimants, one task, exactly one winner"
  );
});

test("BEHAVIOURAL — the window is what stops one worker claiming another's probe", async () => {
  const sql = await readFile(MIGRATION_010, "utf8");
  const win = claimWindow(sql, "010");
  const env = { nowMs: MODEL_NOW_MS, params: { p_owner: "worker-a" } };

  assert.equal(
    win.admits(
      probeTaskRow({ status: "claimed", lease_owner: "worker-b", lease_expires_at: MODEL_NOW_MS + 60_000 }),
      env
    ),
    false,
    "another worker's LIVE lease must be outside the window"
  );
  assert.equal(
    win.admits(
      probeTaskRow({ status: "claimed", lease_owner: "worker-b", lease_expires_at: MODEL_NOW_MS - 1 }),
      env
    ),
    true,
    "a LAPSED lease must be inside it, or a worker that died strands its task forever"
  );
  assert.equal(
    win.admits(probeTaskRow({ status: "done" }), env),
    false,
    "a terminal task must be outside it"
  );

  // The reclaim path, end to end: a dead worker's task is taken by the next
  // poller and by exactly one of them.
  const stranded = probeTaskRow({
    id: "t9",
    status: "claimed",
    lease_owner: "worker-dead",
    lease_expires_at: MODEL_NOW_MS - 1,
    attempts: 1,
  });
  const { rounds, rows } = simulateClaimRace(sql, { rows: [stranded], owners: ["worker-a", "worker-b"] });
  assert.deepEqual(rounds.map((r) => r.claimed), [["t9"], []]);
  assert.equal(rows[0].lease_owner, "worker-a");
  assert.equal(rows[0].attempts, 2, "a reclaim counts as another attempt, or max_attempts never bites");
});

test("TEETH — the committed corpus: each sabotage passes a cheaper check and is rejected here", async () => {
  const { asserted, files } = await walkCorpus(FIXTURES);
  assert.deepEqual(
    files,
    REQUIRED_FIXTURES,
    "the fixture corpus is not the one this guard is pinned against. Adding or removing " +
      "an attack is a deliberate act: update REQUIRED_FIXTURES and say what changed."
  );
  assert.equal(
    asserted,
    files.length,
    `the walk asserted ${asserted} of ${files.length} fixtures — a fixture that was skipped ` +
      `is a fixture proving nothing`
  );
});

test("TEETH — un-scoping the match accepts the lock parked in the wrong CTE", async () => {
  // The finding, reproduced as a test rather than as a claim. Both checks below
  // run against the SAME text; only the scoped one rejects it.
  const raw = await readFile(path.join(FIXTURES, "lock-parked-in-the-claimed-cte.sql.txt"), "utf8");

  // The un-scoped check, spelled out: "is the executable clause anywhere in the
  // claim function?" This is exactly what `candidateCte` degrades to if it is
  // ever replaced by a passthrough, and it accepts the relocation.
  const body = claimFunctionBodies(raw)[0];
  assert.match(
    flatten(body),
    /FOR UPDATE SKIP LOCKED/,
    "the fixture must keep an EXECUTABLE clause in the function body, or it is not " +
      "reproducing the finding — this is what an un-scoped guard sees and approves"
  );

  // The scoped guard, same text.
  assert.throws(
    () => assertCandidateScope(raw, "fixture"),
    /OUTSIDE the candidate CTE/,
    "a lock on rows the UPDATE has already chosen does not decide which rows this " +
      "worker takes, and must not satisfy the guard"
  );
});

test("TEETH — widening the window hands one task to two claimants", async () => {
  const raw = await readFile(
    path.join(FIXTURES, "scope-widened-any-live-lease-claimable.sql.txt"),
    "utf8"
  );
  // The lock is untouched in this fixture, so the whole pre-R1.2.15 lineage
  // accepts it. Its damage is only visible by RUNNING the window.
  assert.ok(CHEAPER_CHECKS["single-executable-clause"](raw));
  const held = probeTaskRow({
    id: "t1",
    status: "claimed",
    lease_owner: "worker-a",
    lease_expires_at: MODEL_NOW_MS + 120_000,
  });
  const { rounds } = simulateClaimRace(raw, { rows: [held], owners: ["worker-a", "worker-b"] });
  assert.deepEqual(
    rounds.map((r) => r.claimed),
    [["t1"], ["t1"]],
    "the widened fixture must demonstrably double-claim; if it stopped doing so it " +
      "would no longer be the attack its header describes"
  );
  assert.throws(() => assertCandidateScope(raw, "fixture"), /LIVE lease/);
});

test("TEETH — narrowing the window strands a task whose worker died", async () => {
  const raw = await readFile(path.join(FIXTURES, "scope-narrowed-to-pending-only.sql.txt"), "utf8");
  const stranded = probeTaskRow({
    id: "t1",
    status: "claimed",
    lease_owner: "worker-dead",
    lease_expires_at: MODEL_NOW_MS - 1,
  });
  const { rounds } = simulateClaimRace(raw, { rows: [stranded], owners: ["worker-a", "worker-b"] });
  assert.deepEqual(
    rounds.map((r) => r.claimed),
    [[], []],
    "the narrowed fixture must demonstrably strand the reclaimable task — no claimant, " +
      "ever, and no error either: the scan just finishes short"
  );
  assert.throws(() => assertCandidateScope(raw, "fixture"), /LAPSED/);
});

test("NON-VACUITY — an empty corpus REFUSES; it does not pass having checked nothing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "probeclaim-empty-"));
  try {
    await assert.rejects(
      () => walkCorpus(dir),
      /no \*\.sql\.txt fixtures found/,
      "a corpus walk over an empty directory must fail. Delete the fixtures and this " +
        "guard has to say so, not go green."
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NON-VACUITY — a fixture with no stated expectation REFUSES", async () => {
  // The other way the walk could quietly assert nothing: a file it reads but
  // has no instruction for. Forced here with a real fixture stripped of its
  // marker, so the refusal is proven rather than promised.
  const dir = mkdtempSync(path.join(tmpdir(), "probeclaim-unmarked-"));
  try {
    const raw = await readFile(
      path.join(FIXTURES, "scope-widened-any-live-lease-claimable.sql.txt"),
      "utf8"
    );
    writeFileSync(path.join(dir, "unmarked.sql.txt"), raw.replace(/--\s*R1215-EXPECT:.*\n/, ""));
    await assert.rejects(() => walkCorpus(dir), /no `-- R1215-EXPECT:` marker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NON-VACUITY — a predicate the model does not recognise REFUSES rather than being ignored", async () => {
  // The model's own false-success mode. If an unrecognised conjunct were
  // skipped, a refactor could add `AND t.lease_owner IS NULL OR true` — or
  // anything else the parser had no case for — and the window assertions would
  // keep passing over a predicate nobody checked.
  const base = await readFile(path.join(FIXTURES, "base-as-in-migration-010.sql.txt"), "utf8");
  const exotic = base.replace(
    "     WHERE t.status IN ('pending', 'claimed')",
    "     WHERE t.status IN ('pending', 'claimed')\n       AND t.engine ~ '^chat'"
  );
  assert.notEqual(exotic, base, "the sabotage must have applied");
  assert.throws(
    () => claimWindow(exotic, "exotic"),
    /unmodelled SQL — predicate/,
    "an unrecognised conjunct must stop the model, not be quietly dropped from it"
  );

  // And the same refusal through the guard the suite actually calls.
  assert.throws(() => assertCandidateScope(exotic, "exotic"), /unmodelled SQL/);
});

test("NON-VACUITY — the model reads the SET list, so a claim that stops leasing is caught", async () => {
  // `simulateClaimRace` only reports one winner because the SET list takes the
  // row out of the window. Prove that is READ and not assumed: a claim that
  // forgets to write the lease hands the same task to the next claimant.
  const base = await readFile(path.join(FIXTURES, "base-as-in-migration-010.sql.txt"), "utf8");
  const noLease = base.replace("           lease_owner      = p_owner,\n", "");
  assert.notEqual(noLease, base, "the sabotage must have applied");
  const { rounds } = simulateClaimRace(noLease, {
    rows: [probeTaskRow({ id: "t1" })],
    owners: ["worker-a", "worker-b"],
  });
  assert.deepEqual(
    rounds.map((r) => r.claimed),
    [["t1"], ["t1"]],
    "a SET list that does not record the owner leaves the row claimable by the next " +
      "worker, and the model must show that rather than assuming the claim sticks"
  );
});
