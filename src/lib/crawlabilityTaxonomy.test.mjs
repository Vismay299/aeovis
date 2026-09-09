/**
 * R6.4.12 — the crawl-failure taxonomy has ONE implementation, and the two
 * surfaces that render it cannot disagree about a payload.
 *
 * THE FINDING, AND THAT IT REPRODUCED.
 *
 * describeRivalCrawlOutcome (R3.7.7) and describePrimaryCrawlOutcome (R3.7.8)
 * each decoded `{ fetched_ok, blocked, fetch_error }` with their own `if`
 * cascade and their own `/^http_(\d{3})$/`. One concept, two spellings, and no
 * test comparing them — so they had ALREADY drifted, in two ways that the
 * fourteen tests in crawlabilityRivalOutcome.test.mjs were all green against:
 *
 *   1. `fetch_error: null` — a failure the route reported without naming a
 *      reason. The primary said `unknown_error` and told the customer outright
 *      that the cause was missing. The rival GUESSED `network_error` and told
 *      them "Couldn't reach it — network error", a cause nobody observed. That
 *      is the confident-wrong-answer the primary's own code comment forbids in
 *      so many words.
 *   2. `{ fetched_ok: true, blocked: true }` — contradictory, and the two read
 *      the fields in opposite order. The rival checked the refusal first and
 *      said `refused`. The primary checked `fetched_ok` first and returned
 *      null: a domain WE refused to fetch rendered as a clean audit with no
 *      banner at all. Absent measurement, rendered as a good one.
 *
 * A third divergence needed only a one-character edit to open: widening the
 * primary's status regex to `\d+` while the rival kept `\d{3}` made `http_5`
 * classify as `http_error` on one surface and `network_error` on the other,
 * with all fourteen existing tests still passing. That is the "a third caller
 * makes the drift real" the task predicts, reachable by an ordinary typo.
 *
 * WHAT THIS FILE PROVES.
 *
 *   1. AGREEMENT, over a payload matrix that includes every shape the real
 *      route emits plus the hostile ones no fixture covered. The two surfaces
 *      must classify every payload identically. Both historical divergences
 *      fail this, and so does the regex-widening mutation.
 *   2. EXHAUSTIVENESS, behaviourally rather than by peeking at the copy tables:
 *      every kind in CRAWL_FAILURE_KINDS must be reachable from a payload AND
 *      must produce real words on BOTH surfaces. A kind added to the enum and
 *      to one table only throws here.
 *   3. NO SECOND DECODER, by walking the source tree. `fetch_error` may be
 *      PRODUCED by the route and DECODED by classifyCrawlFailure, and nowhere
 *      else. This is the guard against the finding coming back.
 *   4. That sharing the classification did not collapse the WORDS, which
 *      legitimately differ per surface and were the point of R3.7.7/R3.7.8.
 *
 * WHAT IT DOES NOT PROVE: nothing here mounts React. That the components defer
 * to these functions is covered by the source guards in
 * ../components/dashboard/crawlabilityRivalOutcome.test.mjs, and the rendered
 * proof lives in that task's verification record.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CRAWL_FAILURE_KINDS,
  classifyCrawlFailure,
  describePrimaryCrawlOutcome,
  describeRivalCrawlOutcome,
} from "./crawlabilityOutcome.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");

// ---------------------------------------------------------------------------
// The payload matrix.
//
// Every shape the route can emit (route.js:144/161/174/187/439 and
// fetchRobotsTxt's `http_${status}`), plus the shapes no fixture ever covered:
// a failure with no reason, a slug this build does not know, a malformed http_
// token, and the contradictory both-refused-and-fetched row. The last four are
// where the two implementations disagreed.
// ---------------------------------------------------------------------------
const PAYLOADS = [
  ["read fine", { fetched_ok: true, blocked: false, fetch_error: null }],
  ["policy refusal (flag)", { fetched_ok: false, blocked: true, fetch_error: "blocked" }],
  ["policy refusal (slug only)", { fetched_ok: false, blocked: false, fetch_error: "blocked" }],
  ["policy refusal (flag only)", { fetched_ok: false, blocked: true, fetch_error: null }],
  ["unresolved", { fetched_ok: false, blocked: false, fetch_error: "unresolved" }],
  ["timeout", { fetched_ok: false, blocked: false, fetch_error: "timeout" }],
  ["network error", { fetched_ok: false, blocked: false, fetch_error: "network_error" }],
  ["http 503", { fetched_ok: false, blocked: false, fetch_error: "http_503" }],
  ["http 404", { fetched_ok: false, blocked: false, fetch_error: "http_404" }],
  // --- the shapes the drift lived in ---
  ["no reason given", { fetched_ok: false, blocked: false, fetch_error: null }],
  ["reason absent entirely", { fetched_ok: false, blocked: false }],
  ["unknown slug", { fetched_ok: false, blocked: false, fetch_error: "dns_servfail" }],
  ["malformed http token", { fetched_ok: false, blocked: false, fetch_error: "http_5" }],
  ["over-long http token", { fetched_ok: false, blocked: false, fetch_error: "http_5031" }],
  ["contradictory: refused AND fetched", { fetched_ok: true, blocked: true, fetch_error: "blocked" }],
  ["fetched_ok missing", { fetch_error: "timeout" }],
  ["fetch_error not a string", { fetched_ok: false, fetch_error: 503 }],
];

/** The primary needs a domain to name; the classification must not depend on it. */
const withDomain = (payload) => ({ domain: "acme.example", ...payload });

// ---------------------------------------------------------------------------
// 1. The two surfaces agree about every payload.
// ---------------------------------------------------------------------------

test("R6.4.12 — the rival row and the primary banner classify every payload identically", () => {
  // VACUITY FLOOR. `compared === PAYLOADS.length - 1` below is satisfied by
  // 0 === 0 if the matrix is trimmed to the one healthy payload, which is
  // exactly how a guard in this repo ends up certifying the bug it guards.
  assert.ok(PAYLOADS.length >= 15, `the payload matrix has shrunk to ${PAYLOADS.length} — it must exercise the drift cases`);

  let compared = 0;

  for (const [name, payload] of PAYLOADS) {
    const rival = describeRivalCrawlOutcome(payload);
    const primary = describePrimaryCrawlOutcome(withDomain(payload));

    // Teeth against a vacuous pass: "both null" is a legitimate agreement only
    // for the one payload that really was read.
    if (rival === null || primary === null) {
      assert.equal(
        rival,
        null,
        `${name}: the primary raised no banner but the rival row did (${rival?.kind}) — ` +
          "one surface is calling this a clean audit and the other is not"
      );
      assert.equal(
        primary,
        null,
        `${name}: the rival row was silent but the primary raised ${primary?.kind}`
      );
      assert.equal(name, "read fine", `${name}: only a successful read may produce no outcome at all`);
      continue;
    }

    compared += 1;
    assert.equal(
      primary.kind,
      rival.kind,
      `${name}: the same payload is a "${primary.kind}" on the brand's own banner and a "${rival.kind}" ` +
        "on a rival row — the taxonomy has drifted again"
    );
  }

  // NON-VACUITY: the loop above is worthless if it compared nothing. Every
  // payload but the healthy one must have produced a real outcome on both.
  assert.equal(
    compared,
    PAYLOADS.length - 1,
    "every failing payload must yield an outcome on both surfaces, or this comparison proved nothing"
  );
});

test("R6.4.12 — a failure with no stated reason is never dressed as a network error", () => {
  // The exact live divergence. route.js:439 always names a reason, so a payload
  // without one is a shape we do not understand; naming a cause for it is the
  // finding this whole module exists to delete, and the rival row was doing it.
  for (const unexplained of [
    { fetched_ok: false, blocked: false, fetch_error: null },
    { fetched_ok: false, blocked: false },
    { fetched_ok: false, blocked: false, fetch_error: "dns_servfail" },
    { fetched_ok: false, blocked: false, fetch_error: "http_5" },
  ]) {
    const rival = describeRivalCrawlOutcome(unexplained);
    const primary = describePrimaryCrawlOutcome(withDomain(unexplained));

    assert.equal(rival.kind, "unknown_error", `rival: ${JSON.stringify(unexplained)}`);
    assert.equal(primary.kind, "unknown_error", `primary: ${JSON.stringify(unexplained)}`);

    for (const [surface, outcome] of [["rival", rival], ["primary", primary]]) {
      const line = `${outcome.label} ${outcome.detail}`.toLowerCase();
      assert.ok(
        !/network error|timed out|didn't resolve|does not resolve|check the spelling/.test(line),
        `${surface}: a failure we cannot attribute must not borrow another kind's words: ${line}`
      );
      assert.match(
        line,
        /can't tell you|cannot tell you|no reason|without saying why|without a reason/,
        `${surface}: it must say outright that the reason is missing`
      );
    }
  }
});

test("R6.4.12 — a refusal outranks a fetched_ok flag on BOTH surfaces", () => {
  // The second live divergence. A payload claiming both is contradictory; the
  // primary used to resolve it by rendering nothing, so a domain WE declined to
  // fetch appeared as a clean audit. Precedence is part of the classification,
  // so it now lives in one place.
  const contradictory = { fetched_ok: true, blocked: true, fetch_error: "blocked" };

  const rival = describeRivalCrawlOutcome(contradictory);
  const primary = describePrimaryCrawlOutcome(withDomain(contradictory));

  assert.equal(rival.kind, "refused");
  assert.ok(primary, "a refused domain must never render as a clean audit with no banner at all");
  assert.equal(primary.kind, "refused");

  // ...and the healthy control still produces nothing, so the assertion above
  // is not just "the primary always warns".
  assert.equal(
    describePrimaryCrawlOutcome(withDomain({ fetched_ok: true, blocked: false, fetch_error: null })),
    null,
    "a genuinely successful read raises no banner"
  );
});

// ---------------------------------------------------------------------------
// 2. Exhaustiveness — every declared kind is reachable and rendered on both.
// ---------------------------------------------------------------------------

/** One payload per kind, chosen to classify to exactly that kind. */
const KIND_FIXTURES = {
  refused: { fetched_ok: false, blocked: true, fetch_error: "blocked" },
  unresolved: { fetched_ok: false, blocked: false, fetch_error: "unresolved" },
  http_error: { fetched_ok: false, blocked: false, fetch_error: "http_503" },
  timeout: { fetched_ok: false, blocked: false, fetch_error: "timeout" },
  network_error: { fetched_ok: false, blocked: false, fetch_error: "network_error" },
  unknown_error: { fetched_ok: false, blocked: false, fetch_error: null },
};

test("R6.4.12 — every declared kind is reachable, and carries real words on both surfaces", () => {
  assert.ok(CRAWL_FAILURE_KINDS.length > 0, "the taxonomy must not be empty");
  assert.deepEqual(
    Object.keys(KIND_FIXTURES).sort(),
    [...CRAWL_FAILURE_KINDS].sort(),
    "a kind was added to (or removed from) the taxonomy without a fixture proving it is reachable"
  );

  for (const kind of CRAWL_FAILURE_KINDS) {
    const payload = KIND_FIXTURES[kind];
    assert.equal(classifyCrawlFailure(payload).kind, kind, `${kind}: the fixture must classify to its own kind`);

    // A missing copy entry throws here rather than rendering an empty banner.
    for (const [surface, outcome] of [
      ["rival", describeRivalCrawlOutcome(payload)],
      ["primary", describePrimaryCrawlOutcome(withDomain(payload))],
    ]) {
      assert.ok(outcome, `${surface}/${kind}: produced no outcome at all`);
      assert.equal(outcome.kind, kind, `${surface}/${kind}: the rendered kind must be the classified kind`);
      assert.ok(
        typeof outcome.label === "string" && outcome.label.trim().length > 3,
        `${surface}/${kind}: an empty label is an empty state dressed as a clean one`
      );
      assert.ok(
        typeof outcome.detail === "string" && outcome.detail.trim().length > 20,
        `${surface}/${kind}: an empty detail is the same`
      );
      assert.ok(["crit", "warn", "muted"].includes(outcome.tone), `${surface}/${kind}: unknown tone`);
      // No machine slug leaking through as written copy — the R3.7.8 rule,
      // now enforced on the rival surface too.
      assert.ok(
        !outcome.label.includes(String(payload.fetch_error)),
        `${surface}/${kind}: the raw slug is showing through the label: ${outcome.label}`
      );
    }
  }
});

test("R6.4.12 — the classifier never invents a kind outside the declared set", () => {
  const seen = new Set();
  for (const [, payload] of PAYLOADS) {
    const failure = classifyCrawlFailure(payload);
    if (!failure) continue;
    assert.ok(
      CRAWL_FAILURE_KINDS.includes(failure.kind),
      `classifyCrawlFailure produced "${failure.kind}", which no copy table is required to cover`
    );
    seen.add(failure.kind);
  }
  // The matrix must exercise the whole taxonomy, or "never invents a kind" is
  // a claim about three of six branches.
  assert.deepEqual(
    [...seen].sort(),
    [...CRAWL_FAILURE_KINDS].sort(),
    "the payload matrix no longer reaches every kind, so this guard has gone partly blind"
  );

  // The http status is carried as data, not re-parsed by each surface.
  assert.deepEqual(classifyCrawlFailure(KIND_FIXTURES.http_error), { kind: "http_error", status: 503 });
  assert.equal(classifyCrawlFailure(KIND_FIXTURES.timeout).status, null);
});

// ---------------------------------------------------------------------------
// 3. Sharing the classification did not collapse the words.
//
// R3.7.7 and R3.7.8 exist because the two audiences need different copy. If
// de-duplicating the taxonomy had also de-duplicated the prose, this task would
// have traded one honesty bug for another.
// ---------------------------------------------------------------------------

test("R6.4.12 — the two surfaces still speak to their own audience", () => {
  // VACUITY FLOOR: every loop and every set-size check below is 0 === 0 on an
  // empty taxonomy.
  assert.ok(CRAWL_FAILURE_KINDS.length >= 6, `the taxonomy has shrunk to ${CRAWL_FAILURE_KINDS.length} kinds`);

  for (const kind of CRAWL_FAILURE_KINDS) {
    const payload = KIND_FIXTURES[kind];
    const rival = describeRivalCrawlOutcome(payload);
    const primary = describePrimaryCrawlOutcome(withDomain(payload));

    assert.notEqual(
      rival.label,
      primary.label,
      `${kind}: a rival's failure and the customer's OWN failure must not read identically`
    );
    assert.notEqual(rival.detail, primary.detail, `${kind}: nor the explanation under it`);
  }

  // Within each surface, every kind still reads differently — the R3.7.7/R3.7.8
  // criterion, re-asserted across the WHOLE taxonomy rather than the four
  // fixtures those tasks happened to build.
  for (const [surface, describe, arg] of [
    ["rival", describeRivalCrawlOutcome, (p) => p],
    ["primary", describePrimaryCrawlOutcome, withDomain],
  ]) {
    for (const field of ["label", "detail"]) {
      const values = CRAWL_FAILURE_KINDS.map((k) => describe(arg(KIND_FIXTURES[k]))[field]);
      assert.equal(
        new Set(values).size,
        CRAWL_FAILURE_KINDS.length,
        `${surface}: two kinds share a ${field}, so a reader cannot tell them apart: ${JSON.stringify(values)}`
      );
    }
  }

  // The primary keeps the caveat on EVERY kind, including the one the rival
  // surface gained in this task. Losing it while consolidating would trade the
  // duplication bug for the silent-degradation bug R3.7.8 closed.
  for (const kind of CRAWL_FAILURE_KINDS) {
    assert.match(
      describePrimaryCrawlOutcome(withDomain(KIND_FIXTURES[kind])).detail,
      /shown as default-open because your robots\.txt was never read/,
      `${kind}: the unverified default-open caveat must survive on every kind`
    );
  }
});

test("R6.4.12 — a compare row that never arrived is still not a crawl failure", () => {
  // `missing` describes the RESPONSE, not the fetch, so it is deliberately not
  // in CRAWL_FAILURE_KINDS. It must still be said out loud rather than dropped.
  const missing = describeRivalCrawlOutcome(undefined);
  assert.equal(missing.kind, "missing");
  assert.ok(!CRAWL_FAILURE_KINDS.includes("missing"), "it is not one of the fetch outcomes");
  assert.match(missing.label, /no result/i);

  // The primary's junk case belongs to the fatal-error path, and stays there.
  assert.equal(describePrimaryCrawlOutcome(null), null);
  assert.equal(describePrimaryCrawlOutcome("acme.com"), null);
  assert.equal(classifyCrawlFailure(null), null, "the classifier requires a payload; callers answer junk");
});

// ---------------------------------------------------------------------------
// 4. THE GUARD — a second implementation cannot reappear.
// ---------------------------------------------------------------------------

/**
 * Files allowed to touch the raw `fetch_error` vocabulary, each for a stated
 * reason. Anything else that decodes it is the duplication coming back.
 *
 *   - crawlabilityOutcome.js   the ONE decoder (classifyCrawlFailure).
 *   - crawlability/route.js    the PRODUCER. It emits the slugs; it does not
 *                              render them, and no copy is decided there.
 *
 * Test files are excluded wholesale: a test that asserts on a slug is doing its
 * job. If you add a name here, say why in this comment — an unexplained entry
 * is indistinguishable from an oversight.
 */
const DECODER_ALLOWLIST = new Set([
  path.join(SRC, "lib", "crawlabilityOutcome.js"),
  path.join(SRC, "app", "api", "brands", "[brand]", "crawlability", "route.js"),
]);

/** Every .js/.jsx/.mjs under src/, excluding tests. */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!/\.(js|jsx|mjs)$/.test(entry)) continue;
    if (/\.test\.mjs$/.test(entry) || /\.test\.js$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Comments removed so the guard reads CODE, not prose. Several files discuss
 * the taxonomy at length in doc comments — CrawlabilityView.jsx names
 * `fetch_error` in one — and flagging those would make the guard so noisy it
 * would be deleted. Crude on purpose: block comments, then line comments whose
 * `//` is not a URL scheme. It can under-strip (a `//` inside a string), which
 * only ever makes the guard stricter, never blinder.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

test("R6.4.12 GUARD — nothing outside classifyCrawlFailure decodes a crawl fetch_error", () => {
  const files = sourceFiles(SRC);
  assert.ok(files.length > 100, `the walker found only ${files.length} source files — it is not walking the tree`);

  // Sanity: the allowlist names files that exist. A stale path would silently
  // widen the guard's blind spot into a file nobody is checking.
  for (const allowed of DECODER_ALLOWLIST) {
    assert.ok(files.includes(allowed), `allowlisted file no longer exists: ${allowed}`);
  }

  /* Each pattern is a way the taxonomy gets re-implemented, taken from what the
     two duplicated cascades actually looked like. */
  const DECODERS = [
    [/\/\^?http_\\?\(?\\d/, "an http_<status> regex — the status is on the classifier's result as `status`"],
    [
      /(fetch_error|fetchError)\s*[=!]==?\s*["'`]/,
      "a direct comparison of fetch_error against a literal — call classifyCrawlFailure()",
    ],
    [
      /case\s+["'`](blocked|unresolved|timeout|network_error)["'`]/,
      "a switch over the raw fetch_error vocabulary",
    ],
    [
      /startsWith\(\s*["'`]http_["'`]/,
      "a prefix test for the http_ slug",
    ],
  ];

  const violations = [];
  for (const file of files) {
    if (DECODER_ALLOWLIST.has(file)) continue;
    const code = stripComments(readFileSync(file, "utf8"));
    for (const [pattern, why] of DECODERS) {
      const hit = pattern.exec(code);
      if (hit) violations.push(`${path.relative(SRC, file)}: ${JSON.stringify(hit[0])} — ${why}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    "a second crawl-failure taxonomy has appeared:\n  " + violations.join("\n  ")
  );
});

test("R6.4.12 GUARD — the guard's patterns actually match the code they forbid", () => {
  // TEETH FOR THE GUARD ITSELF. A source walker whose regexes match nothing is
  // a test that passes on an empty set, and this repo has shipped a few. These
  // are the literal shapes that were in the two cascades before this task; if a
  // pattern stops matching them it has stopped guarding anything.
  const WAS_DUPLICATED = [
    'const httpStatus = fetchError && /^http_(\\d{3})$/.exec(fetchError);',
    'if (fetchError === "timeout") {',
    'switch (row.fetch_error) { case "unresolved": break; }',
    'if (row.fetch_error.startsWith("http_")) {',
  ];
  const DECODERS = [
    /\/\^?http_\\?\(?\\d/,
    /(fetch_error|fetchError)\s*[=!]==?\s*["'`]/,
    /case\s+["'`](blocked|unresolved|timeout|network_error)["'`]/,
    /startsWith\(\s*["'`]http_["'`]/,
  ];

  WAS_DUPLICATED.forEach((snippet, i) => {
    assert.match(snippet, DECODERS[i], `pattern ${i} no longer matches the code it exists to forbid`);
  });

  // ...and does not fire on ordinary code that merely mentions the concept.
  for (const innocent of [
    'const outcome = classifyCrawlFailure(row);',
    'const label = `${site} answered ${status} for /robots.txt`;',
    'if (row.fetched_ok === true) return null;',
  ]) {
    for (const pattern of DECODERS) {
      assert.doesNotMatch(innocent, pattern, `the guard would false-positive on: ${innocent}`);
    }
  }

  // The comment stripper must not be so eager that it blanks real code.
  const stripped = stripComments('/* fetch_error === "timeout" in prose */\nif (fetchError === "timeout") {}');
  assert.doesNotMatch(stripped, /in prose/, "block comments must be removed");
  assert.match(stripped, /fetchError === "timeout"/, "but the code after them must survive");
});
