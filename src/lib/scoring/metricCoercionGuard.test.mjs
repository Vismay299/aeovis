import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { measuredNumberOrNull, ratioPctOrNull } from "./measuredNumber.js";
import { summarizeEngineSlice, summarizeEngineResults } from "./enginePipeline.js";
import { computeContentLiftReport } from "./contentLift.js";

/**
 * R2.9.7 — THE SWEEP, AND THE WALKER THAT ENDS IT.
 *
 * ONE defect class has been caught SEVEN separate times across this rebuild
 * (R2.1.2, R2.7.12, R2.2.7, R2.8.16, R2.7.13, R2.7.16, R2.9.6), each time in a
 * new place and each time by accident: a value meaning "not measured" silently
 * becoming `0`.
 *
 * THE STRUCTURAL LESSON, proven by R2.7.16 and the reason this guard lives here
 * rather than next to a component: THE COERCION IS ALMOST NEVER IN THE THING
 * THAT PRINTS THE NUMBER. `DashboardShell.jsx:1004` already read
 * `{engine.error_rate_pct == null || !Number.isFinite(...) ? "—" : ...}` — a
 * correct guard — and still rendered `0%`, because `describeDegradedSlice` in
 * enginePipeline.js had done `Number(slice.error_rate_pct)` two layers earlier.
 * `Number(null) === 0` and `Number.isFinite(0) === true`, so by the time the
 * renderer saw it, a fabricated zero and a measured zero were literally the same
 * value and no downstream guard could ever separate them again. The layer that
 * PRODUCES metric objects is the only place the distinction still exists, and
 * `src/lib/scoring/` is that layer.
 *
 * WHAT THIS FILE DOES.
 *
 *   1. BY EXECUTION. Drives the fixed producers with a slice that measured
 *      nothing and a slice that measured zero, and asserts the two do not
 *      collapse onto the same object. Both directions, always: an over-eager
 *      fix that blanks genuine zeros is exactly as dishonest as the
 *      fabrication, and fails here just as hard.
 *   2. BY SOURCE WALK. Every bare coercion (`Number()`, `parseFloat()`,
 *      `parseInt()`, unary `+`, `|| 0`, `?? 0`, and the `denominator > 0 ? r : 0`
 *      ternary that is the same lie in another construct) sitting near an
 *      identifier whose name carries a metric suffix (`_pct`, `_rate`,
 *      `_count`, `_score`, `cost`) anywhere under src/lib/scoring/ must appear
 *      in DECLARED_COERCIONS below WITH A WRITTEN REASON. A new one fails the
 *      test. Silencing it means writing down, in this file, why the value is
 *      not a measurement — or admitting in writing that it is a known defect
 *      and naming who owns it.
 *
 * WHAT IT DOES NOT DO, said rather than implied.
 *
 *   - It is a LINE walker over blanked-comment source, not an AST. A coercion
 *     split so that neither the operator nor any metric identifier falls inside
 *     the same four-line window can evade it — `computeVisibilityScore.js:216`
 *     (`return total > 0 ? ... : 0.0;` inside `computeShareOfVoice`) is a real
 *     live example, missed because the metric's name is only in the function
 *     signature. The net is deliberately cheap and deliberately noisy; it is
 *     the second line of defence behind the shared helpers in
 *     ./measuredNumber.js, not a proof.
 *   - It guards src/lib/scoring/ ONLY. src/services/api.js has its own
 *     equivalent (servicesApiNullMetrics.test.mjs, R2.1.2) and the component
 *     layer has none.
 *   - It does not follow a null to the screen.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// The walker.
// ---------------------------------------------------------------------------

/** Comments blanked (not deleted, so line numbers survive) so the walk reads code. */
function codeOnly(source) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)));
}

/**
 * The coercions. Each is a way of turning "no reading" into the number zero.
 * The last one is not an operator at all — `denominator > 0 ? ratio : 0` — and
 * it is in the list because it was the form the R2.9.7 sweep found MOST often
 * in the producer layer, and because a guard that only knew `Number()` would
 * have watched the sweep's own fixes be undone in a different syntax.
 */
const COERCION_PATTERNS = [
  [/\bNumber\s*\(/, "Number()", "Number(null) === 0, and Number.isFinite(0) is true — the R2.7.16 defect verbatim."],
  [/\bparseFloat\s*\(/, "parseFloat()", "parseFloat(null) is NaN, which downstream `?? 0` and `|| 0` then turn into zero."],
  [/\bparseInt\s*\(/, "parseInt()", "same as parseFloat, for counts."],
  [/\?\?\s*0(?:\.\d+)?(?![\w.])/, "?? 0", "standing rule 5, stated as an operator: never `?? 0` on a metric."],
  [/\|\|\s*0(?:\.\d+)?(?![\w.])/, "|| 0", "worse than `?? 0`: it also eats a genuinely measured 0."],
  [/:\s*0(?:\.\d+)?\s*[,;)]?\s*$/, ": 0", "the `denominator > 0 ? ratio : 0` ternary, and the literal zero field."],
  [/[=(,[]\s*\+\s*[A-Za-z_$(]/, "unary +", "`+null` is 0; the terse spelling of Number()."],
];

/** Does this identifier name a measurement? The suffix vocabulary already in use. */
function isMetricName(id) {
  if (/_(pct|rate|count|score|cost)/.test(id)) return true;
  if (/^(pct|rate|count|score|cost)s?(_|$)/.test(id)) return true;
  if (/(Pct|Rate|Count|Score|Cost)/.test(id)) return true;
  return false;
}

/**
 * How many lines above the coercion count as "the same expression". Three,
 * because the producers wrap their ternaries over four lines:
 *
 *     const presenceRatePct =        <- the metric's name is here
 *       nonBranded.length > 0
 *         ? Math.round(...)
 *         : 0;                       <- the coercion is here
 */
const CONTEXT_LINES = 3;

/**
 * @param {Array<{file: string, source: string}>} sources
 * @returns {Array<{file: string, line: number, operator: string, metric: string, text: string, key: string}>}
 */
function walkForBareCoercions(sources) {
  const offences = [];
  for (const { file, source } of sources) {
    const lines = codeOnly(source).split("\n");
    lines.forEach((raw, i) => {
      const text = raw.trim();
      if (!text) return;
      const hit = COERCION_PATTERNS.find(([re]) => re.test(text));
      if (!hit) return;
      const context = lines.slice(Math.max(0, i - CONTEXT_LINES), i + 1).join(" ");
      const metric = (context.match(/[A-Za-z_$][\w$]*/g) || []).find(isMetricName);
      if (!metric) return;
      offences.push({
        file,
        line: i + 1,
        operator: hit[1],
        metric,
        text,
        // Line numbers move every time anyone edits these files, and this tree
        // has several agents in it at once, so the key deliberately does not
        // contain one. file + metric + the exact source text is stable under
        // an unrelated edit and still unique enough to argue about.
        key: `${file} » ${metric} » ${text}`,
      });
    });
  }
  return offences;
}

function scoringSources() {
  return readdirSync(HERE)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((file) => ({ file, source: readFileSync(path.join(HERE, file), "utf8") }));
}

// ---------------------------------------------------------------------------
// The allowlist. Every entry carries a verdict and a written reason.
// ---------------------------------------------------------------------------

const SAFE = "safe";
const DEFERRED = "deferred-defect";

/**
 * THE R2.9.7 ENUMERATION, IN EXECUTABLE FORM.
 *
 * `[key, verdict, reason]`. Two verdicts, and the difference is the whole point
 * of writing them down:
 *
 *   SAFE     — the value cannot be an absent measurement here. It is an
 *              accumulator seed, an array length, a literal initialiser that is
 *              overwritten before it is read, or a branch that is unreachable
 *              with an empty denominator. Argue with the reason, not the regex.
 *   DEFERRED — it IS the defect, it is pre-existing, and it is NOT fixed by
 *              R2.9.7. The reason must say why and who owns it. An allowlist
 *              that cannot say "this is a bug we are leaving" ends up
 *              pretending the bug is fine, which is how this class survived six
 *              previous sweeps.
 *
 * Adding an entry is how you argue with this test. Do it in writing, on the
 * record; do not widen the regex and do not delete the walk.
 */
const DECLARED_COERCIONS = [
  // --- enginePipeline.js: the live multi-engine producer ---------------------
  [
    "enginePipeline.js » cost » cost: 0,",
    SAFE,
    "the per-query result row's initialiser, before any probe has run. It is assigned the resolved price (or left for the catch) further down the same function; nothing reads this literal as a measurement. Two occurrences, probeAio and probeTextEngine, same argument.",
  ],
  [
    "enginePipeline.js » cost » if (stats) stats.cost = (stats.cost || 0) + result.cost;",
    SAFE,
    "an ACCUMULATOR SEED: `stats.cost` is undefined on the first query and this is what starts the running total. It coerces the accumulator, not a reading. NOTE the adjacent hazard, out of scope here: `result.cost` can be null (see the R2.9.6 entry below) and `0 + null` is 0, so a null price is absorbed silently — that belongs to R2.9.6's fix, not to this line.",
  ],
  [
    "enginePipeline.js » cost » const hasCitations = (citations?.length || 0) > 0 || (references?.length || 0) > 0;",
    SAFE,
    "`Array.length` on an optional chain: `|| 0` is the undefined guard for a missing array, and the result is a boolean, not a published metric. Matched only because the word `cost` appears in the surrounding window.",
  ],
  [
    "enginePipeline.js » cost » result.cost = probeResult.cost || 0;",
    DEFERRED,
    "THIS IS THE DEFECT AND IT IS OWNED BY R2.9.6, which is in flight on this exact line: probeTextEngine drops `cost_state` and coerces a deliberate `cost: null` (an unpriced model) into $0, violating standing rule 3. R2.9.7 was instructed to enumerate it and leave it alone so two tasks do not edit one line.",
  ],
  [
    "enginePipeline.js » enginesCounted » enginesCounted: hasSuppliedCount ? suppliedCount : 0,",
    DEFERRED,
    "the legacy-path fallback in describeScanDataSourceIssue. R2.9.7 fixed the COERCION above it (`Number(options.enginesCounted)` could not tell null from 0) but deliberately left this `: 0`: it is the documented legacy contract that this function's own docstring and services/api.js:687 both cite by name, and making it null is a consumer-visible change that needs the owner of that contract. Filed as a follow-up.",
  ],

  // --- aioPipeline.js: the legacy single-engine producer, still live ---------
  [
    "aioPipeline.js » cost » cost: 0.0,",
    SAFE,
    "result-row initialiser, same argument as enginePipeline's.",
  ],
  [
    "aioPipeline.js » cost » if (stats) stats.cost = (stats.cost || 0) + result.cost;",
    SAFE,
    "accumulator seed, same argument as enginePipeline's.",
  ],
  [
    "aioPipeline.js » counts » counts[domain] = (counts[domain] || 0) + 1;",
    SAFE,
    "accumulator seed for a domain-frequency tally. A domain absent from the map has not been seen zero times as a measurement — it simply has no entry yet, and this is the line that creates it.",
  ],
  [
    "aioPipeline.js » aioCoveragePct » : 0.0;",
    DEFERRED,
    "summarizeAioResults fabricates every one of its seven percentages on an empty denominator, exactly as summarizeEngineSlice did before R2.9.7 fixed it. NOT fixed here for two reasons stated rather than implied: (1) this function emits no `state`/`state_reason` pair, so a bare null would render as an em dash with no chip and no explanation — standing rule 5 needs the measurement-state vocabulary ported here first, which is a design change; (2) src/lib/analytics/rollup.js:337 and citationShareEmptyDenominator.test.mjs:201 both assert IN PROSE that this function 'still emits 0.0', and R2.9.7 is forbidden to touch src/lib/analytics/, so fixing it silently would leave two false citations behind. Filed as a follow-up. It is still LIVE: scanWorker.js:1752 binds it for single-engine scans.",
  ],
  [
    "aioPipeline.js » errorRatePct » const errorRatePct = total > 0 ? Math.round((errored / total) * 1000) / 10 : 0.0;",
    DEFERRED,
    "error_rate_pct 0.0 for a scan that ran no queries: 'nothing errored' said about an engine that was never called. Byte-for-byte the line R2.9.7 fixed in summarizeEngineSlice, one module over. Deferred for the two reasons spelled out in the aioCoveragePct entry above.",
  ],
  [
    "aioPipeline.js » visibilityPct » : 0.0;",
    DEFERRED,
    "THE HERO METRIC, and the highest-value line in the deferred set: visibility_pct / share_of_ai_pct published as 0.0 for a single-engine scan whose non-branded prompts produced no AI Overview at all. Deferred for the two reasons spelled out in the aioCoveragePct entry above; whoever takes that follow-up should start here.",
  ],
  [
    "aioPipeline.js » brandedVisibilityPct » : 0.0;",
    DEFERRED,
    "branded_visibility_pct 0.0 when no branded prompt was answered — 'the engines did not name you even when asked about you by name', claimed about a question nobody asked. Persisted to scans.branded_visibility_pct. Deferred for the two reasons spelled out in the aioCoveragePct entry above.",
  ],
  [
    "aioPipeline.js » mentionRatePct » : 0.0;",
    DEFERRED,
    "mention_rate_pct 0.0 over an empty answered pool, persisted to scans.mention_rate_pct by scanWorker.js:2082. Deferred for the two reasons spelled out in the aioCoveragePct entry above.",
  ],
  [
    "aioPipeline.js » citationSharePct » : 0.0;",
    DEFERRED,
    "citation_share_pct 0.0 over an empty pool. Already named BY LINE in src/lib/analytics/rollup.js:337 and in citationShareEmptyDenominator.test.mjs:201 as the surviving false-zero producer that R2.2.11 had to build a downstream defence against — which is precisely why R2.9.7 cannot fix it quietly: correcting it would falsify two prose citations in files this task is forbidden to touch.",
  ],
  [
    "aioPipeline.js » presenceRatePct » : 0.0;",
    DEFERRED,
    "presence_rate_pct 0.0 with no non-branded prompt in the set, persisted to scans.presence_rate_pct by scanWorker.js:2081. Deferred for the two reasons spelled out in the aioCoveragePct entry above.",
  ],

  // --- aggregate.js / computeVisibilityScore.js: no live importer ------------
  [
    "aggregate.js » maxCount » counts[item] = (counts[item] || 0) + 1;",
    SAFE,
    "accumulator seed in getMostCommon's frequency tally.",
  ],
  [
    "aggregate.js » promptScores » const promptScores = runs.map(r => r.prompt_score || 0);",
    DEFERRED,
    "a real null-to-zero fabrication — an unscored run enters the median as a hard 0 — but aggregate.js has NO importer outside src/lib/scoring/ and its own tests (`git grep aggregatePromptRuns -- src/ scripts/` returns only this file). Fixing dead code costs review attention and buys no honesty on any surface. Recorded so the next reader does not have to re-derive that it is dead; delete the module or fix it, as its own task.",
  ],
  [
    "computeVisibilityScore.js » count » finalBreakdown[tier] = count > 0 ? Math.round((sum / count) * 10) / 10 : 0.0;",
    DEFERRED,
    "empty-denominator fabrication in computeIntentBreakdown; module has no live importer (see the aggregate.js entry). Same follow-up.",
  ],
  [
    "computeVisibilityScore.js » topicScores » topicScores[topic] = count > 0 ? Math.round((sum / count) * 10) / 10 : 0.0;",
    DEFERRED,
    "same shape in computeTopicScores; same dead module, same follow-up.",
  ],
  [
    "computeVisibilityScore.js » prompt_score_stddev » const stddevs = results.map(r => r.prompt_score_stddev || 0.0);",
    DEFERRED,
    "a run with no recorded spread is averaged in as perfectly stable, which then sets `stability: \"high\"`. Same dead module, same follow-up.",
  ],
  [
    "computeVisibilityScore.js » gap_score » r.gap_score = Math.round((maxCompScore - (r.prompt_score || 0.0)) * 10) / 10;",
    DEFERRED,
    "an unscored prompt is reported as the maximum possible gap behind the best competitor. Same dead module, same follow-up.",
  ],
  [
    "computeVisibilityScore.js » score_ci_low » average_stddev: 0.0,",
    SAFE,
    "the no-results early return, whose OTHER fields already say there is nothing here (`sample_size_adequacy: false`). A literal in an explicitly-empty object, not a division. Matched only because `score_ci_low` is two lines above.",
  ],
  [
    "computeVisibilityScore.js » runScores » return found ? 100.0 : 0.0;",
    SAFE,
    "a MEASURED boolean rendered as a score: the competitor was looked for in this run's competitors_found and was not there. 0 is the correct answer, not an absence. Two occurrences (computeCompetitorVisibility and computeGapScores), same argument.",
  ],
  [
    "computeVisibilityScore.js » compPromptScore » compPromptScore = found ? 100.0 : 0.0;",
    SAFE,
    "same as the entry above, on the no-run_details branch. Two occurrences, same argument.",
  ],
];

/**
 * Borrowed verbatim from src/services/servicesApiNullMetrics.test.mjs (R2.1.2),
 * which is the sibling guard for the normalize layer. A corpus that quietly
 * shrinks to nothing makes every assertion over it vacuous, which is the same
 * category of lie as the zero this file is about.
 */
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
      assert.ok(typeof item === "string", `${name}[${i}] is not a string: ${JSON.stringify(item)}`);
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

// ---------------------------------------------------------------------------
// The corpus floors. A walker that scans nothing passes vacuously.
// ---------------------------------------------------------------------------

const REQUIRED_SCORING_FILES = [
  "enginePipeline.js",
  "aioPipeline.js",
  "measuredNumber.js",
  "contentLift.js",
  "computeVisibilityScore.js",
  "aggregate.js",
];

test("R2.9.7 GUARD FLOOR — the walker actually reads the scoring layer", () => {
  const files = scoringSources().map((s) => s.file);
  assertCorpusIntact(files, "scoring/*.js", {
    floor: 20,
    required: REQUIRED_SCORING_FILES,
    isTuple: false,
  });
  // ...and it must read CONTENT, not just find filenames.
  const bytes = scoringSources().reduce((n, s) => n + s.source.length, 0);
  assert.ok(
    bytes > 50_000,
    `the walker read ${bytes} bytes of scoring source, which is far less than this directory holds. ` +
      `It has stopped reading the files it guards, and every assertion below is vacuous.`
  );
});

test("R2.9.7 GUARD FLOOR — the coercion and allowlist corpora are intact", () => {
  assertCorpusIntact(
    COERCION_PATTERNS.map(([, label, why]) => [label, why]),
    "COERCION_PATTERNS",
    {
      floor: 7,
      required: ["Number()", "|| 0", "?? 0", ": 0", "parseFloat()", "unary +"],
      isTuple: true,
    }
  );
  assertCorpusIntact(DECLARED_COERCIONS, "DECLARED_COERCIONS", {
    floor: 20,
    required: [
      "enginePipeline.js » cost » result.cost = probeResult.cost || 0;",
      "aioPipeline.js » visibilityPct » : 0.0;",
      "enginePipeline.js » enginesCounted » enginesCounted: hasSuppliedCount ? suppliedCount : 0,",
    ],
    isTuple: true,
  });
  for (const [key, verdict] of DECLARED_COERCIONS) {
    assert.ok(
      verdict === SAFE || verdict === DEFERRED,
      `${key} carries the verdict ${JSON.stringify(verdict)}, which is neither ${SAFE} nor ${DEFERRED}`
    );
  }
});

// ---------------------------------------------------------------------------
// The guard itself.
// ---------------------------------------------------------------------------

test("R2.9.7 GUARD — every bare coercion on a metric-named field is declared, with a reason", () => {
  const offences = walkForBareCoercions(scoringSources());

  // Teeth for the whole test: if the walker stops matching, everything below is
  // vacuous and a reintroduced `Number(slice.error_rate_pct)` sails through.
  assert.ok(
    offences.length >= 20,
    `the walker found ${offences.length} coercion sites in src/lib/scoring/, well under the ${25} it was ` +
      `written against. Either a large cleanup landed (lower this floor in the same commit and say so) or ` +
      `the walker has stopped reading the code it guards.`
  );

  const declared = new Set(DECLARED_COERCIONS.map(([key]) => key));
  const undeclared = [...new Set(offences.filter((o) => !declared.has(o.key)).map((o) => o.key))];
  assert.deepEqual(
    undeclared,
    [],
    "A bare coercion on a metric-named field in src/lib/scoring/ that is not in DECLARED_COERCIONS.\n" +
      "If it is a MEASUREMENT, do not coalesce it: use measuredNumberOrNull()/ratioPctOrNull() from " +
      "./measuredNumber.js so an absent reading stays null and a measured 0 stays 0. Null renders as an " +
      "em dash plus a state chip (standing rule 5); the producer does not get to invent the number.\n" +
      "If it is genuinely an accumulator seed, an array length or an unreachable branch, add it to " +
      "DECLARED_COERCIONS with the reason. If it is a defect you are choosing not to fix, add it as " +
      `"${DEFERRED}" and say who owns it.`
  );
});

test("R2.9.7 GUARD — the allowlist has no dead entries", () => {
  const present = new Set(walkForBareCoercions(scoringSources()).map((o) => o.key));
  const dead = DECLARED_COERCIONS.map(([key]) => key).filter((k) => !present.has(k));
  assert.deepEqual(
    dead,
    [],
    "an allowlisted coercion no longer exists in src/lib/scoring/. A stale permission is how an allowlist " +
      "grows until it permits the thing it was written to forbid — delete the entry along with the line. " +
      "(If the line only MOVED, the key is file + metric + source text and contains no line number, so a " +
      "pure move cannot cause this; the text itself changed.)"
  );
});

test("R2.9.7 — the deferred set is stated as defects, not laundered as safe", () => {
  const deferred = DECLARED_COERCIONS.filter(([, v]) => v === DEFERRED);
  assert.ok(
    deferred.length > 0,
    "there are no deferred entries at all. That is either a clean sweep (delete this assertion and say so) " +
      "or someone relabelled known defects as safe to quieten the guard."
  );
  for (const [key, , reason] of deferred) {
    assert.ok(
      reason.length > 60,
      `${key} is declared a known defect with a one-line excuse. A deferral that does not say WHY it was ` +
        `deferred and who picks it up is indistinguishable from a permanent exemption.`
    );
  }
});

// ---------------------------------------------------------------------------
// TEETH. The walker must go red on a fresh offence.
// ---------------------------------------------------------------------------

test("R2.9.7 TEETH — a freshly reintroduced coercion is caught, in every syntax", () => {
  const cases = [
    ["Number()", "  const errorRatePct = Number(slice.error_rate_pct);"],
    ["|| 0", "  const coveragePct = slice.coverage_pct || 0;"],
    ["?? 0", "  const presenceRatePct = slice.presence_rate_pct ?? 0;"],
    ["parseFloat()", "  const sovPct = parseFloat(slice.share_of_voice_pct);"],
    ["unary +", "  const citedCount = +slice.cited_count;"],
    [": 0", "  const mentionRatePct = answered > 0 ? mentioned / answered : 0;"],
  ];
  for (const [operator, line] of cases) {
    const offences = walkForBareCoercions([{ file: "fresh.js", source: `${line}\n` }]);
    assert.equal(
      offences.length,
      1,
      `the walker did not catch a fresh ${operator} coercion: ${JSON.stringify(line)}`
    );
    assert.equal(offences[0].operator, operator);
    assert.ok(
      !new Set(DECLARED_COERCIONS.map(([k]) => k)).has(offences[0].key),
      "a fresh offence must not already be declared"
    );
  }
});

test("R2.9.7 TEETH — a multi-line ternary does not slip through the gap the window exists to close", () => {
  const source = [
    "  const presenceRatePct =",
    "    nonBranded.length > 0",
    "      ? Math.round((visible / nonBranded.length) * 1000) / 10",
    "      : 0;",
    "",
  ].join("\n");
  const offences = walkForBareCoercions([{ file: "fresh.js", source }]);
  assert.equal(offences.length, 1, "the `: 0;` line carries no identifier of its own — the context window is what catches it");
  assert.equal(offences[0].metric, "presenceRatePct");
});

test("R2.9.7 TEETH — the walker is not so blunt that it flags everything", () => {
  const innocent = [
    "  const rows = results.filter((r) => r.answer_present);",
    "  const label = engineDisplayLabel(slice.engine);",
    "  const pct = ratioPctOrNull(visible, answered);",
    "  const n = measuredNumberOrNull(slice.error_rate_pct);",
    "  const names = brands.map((b) => b.name).join(', ');",
  ].join("\n");
  assert.deepEqual(
    walkForBareCoercions([{ file: "fresh.js", source: innocent }]),
    [],
    "a guard that fails on the correct code is a guard people delete. The two shared helpers in particular " +
      "must never be flagged — they are the fix."
  );
});

test("R2.9.7 TEETH — a coercion inside a comment is not an offence", () => {
  const source = [
    "  // const errorRatePct = Number(slice.error_rate_pct);",
    "  /* const coveragePct = slice.coverage_pct || 0; */",
    "",
  ].join("\n");
  assert.deepEqual(
    walkForBareCoercions([{ file: "fresh.js", source }]),
    [],
    "the walk must read code, not the comments that explain why the code is the way it is — this whole " +
      "repo documents the defect in prose next to the fix"
  );
});

// ---------------------------------------------------------------------------
// BY EXECUTION. Both directions, on the producers R2.9.7 actually changed.
// ---------------------------------------------------------------------------

test("R2.9.7 — measuredNumberOrNull keeps a real zero and refuses to invent one", () => {
  assert.equal(measuredNumberOrNull(0), 0);
  assert.equal(measuredNumberOrNull("0"), 0);
  assert.equal(measuredNumberOrNull(12.5), 12.5);
  assert.equal(measuredNumberOrNull(null), null);
  assert.equal(measuredNumberOrNull(undefined), null);
  assert.equal(measuredNumberOrNull(""), null);
  assert.equal(measuredNumberOrNull("not a number"), null);
  assert.equal(measuredNumberOrNull(NaN), null);
  assert.equal(measuredNumberOrNull(Infinity), null);
});

test("R2.9.7 — ratioPctOrNull: an empty denominator has no percentage, a zero numerator does", () => {
  assert.equal(ratioPctOrNull(0, 30), 0, "we read 30 answers and you were in none: a measurement");
  assert.equal(ratioPctOrNull(15, 30), 50);
  assert.equal(ratioPctOrNull(1, 3), 33.3);
  assert.equal(ratioPctOrNull(5, 0), null, "nothing was asked, so nothing was answered");
  assert.equal(ratioPctOrNull(0, 0), null);
  assert.equal(ratioPctOrNull(0, null), null);
  assert.equal(ratioPctOrNull(null, 30), null, "a numerator nobody counted is not zero hits");
  assert.equal(ratioPctOrNull(undefined, undefined), null);
});

/** Six answered non-branded rows, a rival named in every one, our brand in none. */
function measuredZeroRows(n = 6) {
  return Array.from({ length: n }, () => ({
    is_branded_query: false,
    answer_present: true,
    error: null,
    visible: false,
    brand_mentioned_in_text: false,
    brand_cited: false,
    brands: [
      { name: "Rival", mentioned: true, is_self: false },
      { name: "Us", mentioned: false, is_self: true },
    ],
  }));
}

const SLICE_METRICS = [
  "coverage_pct",
  "error_rate_pct",
  "presence_rate_pct",
  "elicitation_rate_pct",
  "share_of_voice_pct",
  "share_of_ai_pct",
];

test("GUARD — SLICE_METRICS corpus is intact", () => {
  assertCorpusIntact(SLICE_METRICS, "SLICE_METRICS", {
    floor: 6,
    required: ["error_rate_pct", "coverage_pct", "presence_rate_pct", "share_of_voice_pct"],
    isTuple: false,
  });
});

test("R2.9.7 ACCEPT — a slice that ran nothing publishes null for every rate, not 0", () => {
  const slice = summarizeEngineSlice([], "perplexity");
  for (const key of SLICE_METRICS) {
    assert.equal(
      slice[key],
      null,
      `${key} came back as ${JSON.stringify(slice[key])} for a slice with no rows at all. ` +
        `error_rate_pct 0 means "nothing errored"; nothing RAN.`
    );
  }
  assert.equal(slice.state, "not_assessed", "...and the state is what says which kind of nothing this was");
  assert.equal(slice.state_reason, "no_results");
});

test("R2.9.7 ACCEPT — a slice that measured zero still publishes zero (the trap in reverse)", () => {
  const slice = summarizeEngineSlice(measuredZeroRows(), "perplexity");
  assert.equal(slice.coverage_pct, 100, "every non-branded prompt was answered");
  assert.equal(slice.error_rate_pct, 0, "a measured 0% error rate is a real and good finding");
  assert.equal(slice.presence_rate_pct, 0, "the brand was in none of six answers — measured");
  assert.equal(slice.elicitation_rate_pct, 100, "every answer named a vendor");
  assert.equal(slice.share_of_voice_pct, 0, "the rival took every mention; that is a finding, not an absence");
  assert.equal(slice.share_of_ai_pct, 0);
  assert.equal(slice.state, "measured_zero");

  // The whole point, stated as itself.
  const neverRan = summarizeEngineSlice([], "perplexity");
  assert.notDeepEqual(
    SLICE_METRICS.map((k) => slice[k]),
    SLICE_METRICS.map((k) => neverRan[k]),
    "'measured, and it was zero' must not be the same tuple as 'we never got a number'"
  );
});

test("R2.9.7 — an errored slice reports its real error rate and is still flagged", () => {
  const rows = measuredZeroRows(2).concat(
    Array.from({ length: 8 }, () => ({
      is_branded_query: false,
      answer_present: false,
      error: "TIMEOUT",
      brands: [],
    }))
  );
  const slice = summarizeEngineSlice(rows, "perplexity");
  assert.equal(slice.error_rate_pct, 80, "8 of 10 errored");
  assert.equal(slice.data_source_issue, true);
  assert.equal(slice.state, "failed");
  assert.equal(slice.state_reason, "high_error_rate", "the null-aware gate must still name the error rate");
});

test("R2.9.7 — the scan-level mirror passes the slice's nulls through instead of re-zeroing them", () => {
  const neverRan = summarizeEngineSlice([], "aio");
  const { summary } = summarizeEngineResults({
    results: [],
    engines: { aio: neverRan },
    headline: null,
  });
  for (const key of [
    "aio_coverage_pct",
    "error_rate_pct",
    "presence_rate_pct",
    "branded_visibility_pct",
    "mention_rate_pct",
  ]) {
    assert.equal(
      summary[key],
      null,
      `${key} was re-fabricated by summarizeEngineResults one statement after the producer refused to. ` +
        `This object is written straight onto the persisted scans row.`
    );
  }
});

test("R2.9.7 — ...and a measured zero still reaches the persisted mirror as zero", () => {
  const measured = summarizeEngineSlice(measuredZeroRows(), "aio");
  const { summary } = summarizeEngineResults({
    results: [],
    engines: { aio: measured },
    headline: { visibility_index_pct: 0, engines_counted: 1 },
  });
  assert.equal(summary.error_rate_pct, 0);
  assert.equal(summary.presence_rate_pct, 0);
  assert.equal(summary.mention_rate_pct, 0, "six answers read, the brand named in none of them");
  assert.equal(summary.aio_coverage_pct, 100);
});

test("R2.9.7 — content lift averages the prompts that have a score, and says so when none do", () => {
  const unscored = computeContentLiftReport(
    { url: "https://acme.example/tiles-guide" },
    [{ prompt: "best tiles guide", related_content_url: "https://acme.example/tiles-guide" }]
  );
  assert.equal(
    unscored.current_score,
    null,
    "every matched row was unscored, so the mean was over nothing — `?? 0` used to report that as a score of 0"
  );
  assert.equal(unscored.lift, null);

  const scored = computeContentLiftReport(
    { url: "https://acme.example/tiles-guide" },
    [
      { prompt: "a", related_content_url: "https://acme.example/tiles-guide", prompt_score: 40 },
      { prompt: "b", related_content_url: "https://acme.example/tiles-guide" },
    ]
  );
  assert.equal(scored.current_score, 40, "the unscored row must not dilute the one real reading toward zero");

  const realZero = computeContentLiftReport(
    { url: "https://acme.example/tiles-guide" },
    [{ prompt: "a", related_content_url: "https://acme.example/tiles-guide", prompt_score: 0 }]
  );
  assert.equal(realZero.current_score, 0, "a row scored 0 was measured, and must survive as 0");
});

test("R2.9.7 — a lift needs two readings; null minus null is not 'no change'", () => {
  const report = computeContentLiftReport(
    { url: "https://acme.example/tiles-guide" },
    [{ prompt: "best tiles", related_content_url: "https://acme.example/tiles-guide" }],
    [{ prompt: "best tiles", related_content_url: "https://acme.example/tiles-guide" }]
  );
  assert.equal(
    report.lift,
    null,
    "`null - null` is 0 in JavaScript, which would have reported 'this page changed nothing' about two " +
      "measurements that do not exist"
  );

  const real = computeContentLiftReport(
    { url: "https://acme.example/tiles-guide" },
    [{ prompt: "best tiles", related_content_url: "https://acme.example/tiles-guide", prompt_score: 60 }],
    [{ prompt: "best tiles", related_content_url: "https://acme.example/tiles-guide", prompt_score: 45 }]
  );
  assert.equal(real.lift, 15, "two real readings still produce a real lift");
});
