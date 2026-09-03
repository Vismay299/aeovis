import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ENGINE_LABELS,
  deployedEngines,
  deployedEngineLabels,
  formatEngineList,
  parseEngineList,
  engineDriftWarning,
} from "./engines/deployedEngines.js";
import { DEFAULT_UNBRANDED_TARGET } from "./scoring/promptSetSize.js";
import { SAMPLE_DESTINATIONS, SAMPLE_RESULT } from "../data/mockData.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFile(path.join(REPO, rel), "utf8");

const SHEET_PATH = path.join(REPO, "src/components/landing/AnswerSheet.jsx");

/**
 * Evaluate the sample report AND the hero's sample card under a given
 * NEXT_PUBLIC_ENGINES.
 *
 * deployedEngines() captures the inlined env expression at MODULE LOAD, so an
 * in-process test can only ever see one engine list. A child process is the
 * only way to assert the sample actually FOLLOWS the deployment rather than
 * happening to match it today — the same thing the verifier did by hand with a
 * rebuild.
 *
 * R2.10.5 widened it past mockData.js. AnswerSheet.jsx is JSX and cannot be
 * imported by bare node, so the card is covered two ways in the SAME child, at
 * the same env: `sheetEngine` is the value the chip is now assigned, evaluated
 * under this deployment, and `sheetLiterals` is every engine name still TYPED
 * into that file. A returned literal shows up in the second even when the first
 * is right, which is exactly the state the card was found in.
 */
function sampleReadingUnder(engines) {
  const href = pathToFileURL(path.join(REPO, "src/data/mockData.js")).href;
  const enginesHref = pathToFileURL(path.join(REPO, "src/lib/engines/deployedEngines.js")).href;
  const code = `
    const m = await import(${JSON.stringify(href)});
    const eng = await import(${JSON.stringify(enginesHref)});
    const { readFileSync } = await import("node:fs");
    // The same comment-stripper the source guards use, shipped into the child
    // rather than re-typed, so a comment that EXPLAINS this fix cannot read as
    // the literal it removed.
    const withoutComments = ${withoutComments.toString()};
    const sheetSrc = withoutComments(readFileSync(${JSON.stringify(SHEET_PATH)}, "utf8"));
    const allLabels = Object.values(eng.ENGINE_LABELS);
    const deployedLabels = eng.deployedEngineLabels();
    const r = m.SAMPLE_RESULT;
    process.stdout.write(JSON.stringify({
      sheetEngine: eng.primaryDeployedEngineLabel(),
      sheetLiterals: allLabels.filter((l) => sheetSrc.includes(l)),
      sheetLiteralsOffDeployment: allLabels.filter(
        (l) => sheetSrc.includes(l) && !deployedLabels.includes(l),
      ),
      tracked: r.promptsTracked,
      analyzed: r.promptsAnalyzed,
      rows: r.results.length,
      topPrompts: r.topPrompts.length,
      rowEngines: [...new Set(r.results.map((x) => x.engine))],
      promptEngines: [...new Set(r.topPrompts.map((x) => x.engine))],
      engineKeys: Object.keys(r.engines),
      probeSources: r.probeSources,
      destinations: m.SAMPLE_DESTINATIONS,
      wins: r.results.filter((x) => x.visible).length,
      share: r.visibilityScore,
      refs: r.results.reduce((a, x) => a + x.aio_references.length, 0),
      ownRefs: r.results.filter((x) => x.brand_cited).length,
    }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, NEXT_PUBLIC_ENGINES: engines, ENGINES: engines },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

/**
 * R2.10.1 — the landing page must not claim more than the deployment does.
 *
 * Three specific overclaims: a "Live" chip with a status LED on a hardcoded
 * script, a fictional sample answer stamped with a precise timestamp, and a
 * hero sentence naming three engines while the deployment probed two and had
 * no OPENAI_API_KEY at all.
 */

test("deployedEngines — under-claims when unset, never over-claims", () => {
  assert.deepEqual(deployedEngines({}), ["aio"], "an unconfigured deployment claims the default only");
  assert.deepEqual(deployedEngines({ ENGINES: "aio,perplexity" }), ["aio", "perplexity"]);
  assert.deepEqual(
    deployedEngines({ NEXT_PUBLIC_ENGINES: "aio,chatgpt" }),
    ["aio", "chatgpt"],
    "the client-readable mirror wins, because that is what the page can actually see"
  );
  // An unknown name must be dropped, not rendered as a label the user cannot place.
  assert.deepEqual(deployedEngines({ ENGINES: "aio,gemini-ultra-9" }), ["aio"]);
  assert.deepEqual(parseEngineList("  AIO , Perplexity "), ["aio", "perplexity"]);
});

test("formatEngineList reads as prose for one, two and three engines", () => {
  assert.equal(formatEngineList(["Google AI Overview"]), "Google AI Overview");
  assert.equal(formatEngineList(["Google AI Overview", "Perplexity"]), "Google AI Overview and Perplexity");
  assert.equal(
    formatEngineList(["Google AI Overview", "ChatGPT", "Perplexity"]),
    "Google AI Overview, ChatGPT and Perplexity"
  );
  assert.equal(formatEngineList([]), "no answer engines");
});

test("engineDriftWarning fires when the copy and the fleet disagree", () => {
  assert.equal(engineDriftWarning({ ENGINES: "aio,perplexity", NEXT_PUBLIC_ENGINES: "aio,perplexity" }), null);
  assert.equal(engineDriftWarning({ ENGINES: "aio,perplexity", NEXT_PUBLIC_ENGINES: "perplexity,aio" }), null);
  const warn = engineDriftWarning({ ENGINES: "aio", NEXT_PUBLIC_ENGINES: "aio,chatgpt" });
  assert.match(String(warn), /does not match/);
});

test("GUARD — the landing page names no engine in prose", async () => {
  const src = await read("src/app/page.js");

  // The hero sentence must be DERIVED, not typed.
  //
  // This used to assert only that the token ENGINE_SENTENCE appeared somewhere
  // and that one specific phrasing did not. That left the whole overclaim one
  // line away: replacing the assignment with
  //   const ENGINE_SENTENCE = 'Google AI Overview, ChatGPT and Perplexity';
  // put all three engines back in the rendered hero and every guard here still
  // passed. Assert the ASSIGNMENT, the way the rail guard does for DEMO_ENGINES.
  assert.match(
    src,
    /const ENGINE_SENTENCE = formatEngineList\(deployedEngineLabels\(\)\);/,
    "ENGINE_SENTENCE must be assigned from formatEngineList(deployedEngineLabels())"
  );
  assert.ok(
    !/const ENGINE_SENTENCE\s*=\s*['"`]/.test(src),
    "a typed sentence is exactly how the hero came to advertise an engine with no API key"
  );
  assert.match(src, /Perceev asks \{ENGINE_SENTENCE\}/, "and the hero must render it");
  assert.ok(
    !/asks Google AI Overview, ChatGPT and Perplexity/.test(src),
    "the hardcoded three-engine claim must not return"
  );
});

test("GUARD — no 'Live' chip on scripted content", async () => {
  const sheet = await read("src/components/landing/AnswerSheet.jsx");

  assert.ok(
    !/chip__led/.test(sheet),
    "the status LED asserts a live probe; this component types out a hardcoded script"
  );
  assert.ok(!/>\s*Live\s*</.test(sheet), "no Live label on scripted content");
  assert.match(sheet, /Sample answer/, "it must say what it is");
});

/**
 * Strip comments before asserting on rendered copy.
 *
 * Without this the guard fails on the comment that EXPLAINS the fix — the same
 * trap the CI guard in testCoverageGuard.test.mjs documents, where a comment
 * saying "no `|| true` here" reads as an escape hatch itself.
 */
function withoutComments(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "") // JSX comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/^\s*\/\/.*$/gm, ""); // line comments
}

test("GUARD — the sample answer card is labelled, and carries no fake timestamp", async () => {
  const raw = await read("src/app/page.js");
  const src = withoutComments(raw);

  assert.ok(
    !/16 Aug 2026 · 09:14 IST/.test(src),
    "a fictional answer must not wear a real answer's provenance"
  );
  assert.match(src, /Sample · illustrative brands/, "the card must declare itself a sample");

  // The brands on that card are invented; they may stay, but only as samples.
  assert.ok(/NorthPeak/.test(src) && /Brightwave/.test(src));
});

test("GUARD — the advertised question count is the count a scan tracks", async () => {
  const src = await read("src/app/page.js");

  assert.match(src, /const TRACKED = DEFAULT_UNBRANDED_TARGET;/, "TRACKED must be derived, not typed");
  assert.ok(
    !/const TRACKED = \d+/.test(src),
    "a literal here is how the page came to advertise 36 while a scan tracked 30"
  );

  // The worker must read the same constant, or the two can drift again.
  const worker = await read("src/lib/workers/scanWorker.js");
  assert.match(worker, /import \{ DEFAULT_UNBRANDED_TARGET \}/);
  assert.ok(
    !/const DEFAULT_UNBRANDED_TARGET = \d+/.test(worker),
    "the worker must not redeclare its own copy"
  );
});

test("GUARD — the donut is the sample report's own split, not a second copy", async () => {
  const src = withoutComments(await read("src/app/page.js"));

  // The donut must account for every tracked question, or the illustration
  // contradicts the number beside it. It used to be four typed literals in
  // page.js, which is how the page reached 13/10/5/2 while the sample report
  // one click away stayed on 15/12/6/3. Now it renders the report's own array.
  assert.match(
    src,
    /const DESTINATIONS = SAMPLE_DESTINATIONS\.map/,
    "the donut must render the sample report's split, not a second copy of it"
  );
  assert.ok(
    !/answers:\s*\d+/.test(src),
    "a typed answer count on the landing page is the drift this guard exists to stop"
  );

  assert.equal(SAMPLE_DESTINATIONS.length, 4, "expected four destinations");
  const sum = SAMPLE_DESTINATIONS.reduce((a, d) => a + d.answers, 0);
  assert.equal(
    sum,
    DEFAULT_UNBRANDED_TARGET,
    `the destinations sum to ${sum}, not the ${DEFAULT_UNBRANDED_TARGET} the page advertises`
  );

  // And the split is the ROWS, not a plausible set of numbers beside them.
  const held = (key) => SAMPLE_DESTINATIONS.find((d) => d.key === key).answers;
  assert.equal(held("you"), SAMPLE_RESULT.results.filter((r) => r.visible).length);
  assert.equal(
    held("r1") + held("r2"),
    SAMPLE_RESULT.results.filter((r) => r.competitors_found_in_text.length > 0).length
  );
});

test("GUARD — the engine rail shows only deployed engines, with the report's own tallies", async () => {
  const src = await read("src/app/page.js");

  assert.match(
    src,
    /DEMO_ENGINES = DEPLOYED_ENGINE_KEYS\.map/,
    "the rail must be derived from the deployed list"
  );
  assert.match(
    src,
    /SAMPLE_RESULT\.engines\[key\]/,
    "and its asked/reached must be the sample report's rows, not a share typed beside them"
  );
  assert.ok(
    !/\{ name: 'ChatGPT', asked:/.test(src),
    "a hardcoded ChatGPT row advertises an engine this deployment does not probe"
  );
  assert.ok(
    !/reachedShare/.test(src),
    "a hardcoded reach share is a gauge with nothing behind it — it read 42% while the report it previews said 40%"
  );
});

test("GUARD — every engine label the page can render is a known engine", () => {
  for (const label of deployedEngineLabels({ ENGINES: "aio,chatgpt,perplexity" })) {
    assert.ok(Object.values(ENGINE_LABELS).includes(label), `${label} is not a known engine label`);
  }
});

/**
 * R2.10.1 (second pass) — the sample report is ONE CLICK from the hero.
 *
 * page.js "See a sample report" -> saveScan -> services/api.js sessionStorage
 * -> dashboard/page.js loadScan/isSample -> DashboardShell -> OverviewView,
 * which renders promptsTracked verbatim. The first pass moved the landing page
 * to 30 questions and two engines and left mockData.js on 36 with twelve
 * answers credited to ChatGPT, an engine with no API key on this deployment.
 * Nothing tied the two files together. These do.
 */

test("GUARD — the sample report tracks the count a scan tracks", () => {
  assert.equal(
    SAMPLE_RESULT.promptsTracked,
    DEFAULT_UNBRANDED_TARGET,
    "the report behind the hero button must not claim more questions than a scan runs"
  );
  assert.equal(SAMPLE_RESULT.promptsAnalyzed, DEFAULT_UNBRANDED_TARGET);
  assert.equal(SAMPLE_RESULT.results.length, DEFAULT_UNBRANDED_TARGET, "one row per tracked question");
  assert.equal(SAMPLE_RESULT.topPrompts.length, DEFAULT_UNBRANDED_TARGET, "and one tracked-prompt row per question");
});

test("GUARD — the sample report names no engine this deployment does not probe", () => {
  const deployed = new Set(deployedEngines());

  for (const key of Object.keys(SAMPLE_RESULT.engines)) {
    assert.ok(deployed.has(key), `engines has "${key}", which this deployment does not probe`);
  }
  for (const key of SAMPLE_RESULT.probeSources) {
    assert.ok(deployed.has(key), `probeSources has "${key}", which this deployment does not probe`);
  }
  for (const row of SAMPLE_RESULT.results) {
    assert.ok(deployed.has(row.engine), `a result row is attributed to "${row.engine}"`);
  }
  for (const row of SAMPLE_RESULT.topPrompts) {
    assert.ok(deployed.has(row.engine), `a tracked prompt is attributed to "${row.engine}"`);
  }

  // Every per-engine tally must add back up to the whole reading, or the
  // dashboard's multi-engine mode shows a total nothing sums to.
  const answered = Object.values(SAMPLE_RESULT.engines).reduce((a, e) => a + e.answered, 0);
  const visible = Object.values(SAMPLE_RESULT.engines).reduce((a, e) => a + e.visible, 0);
  assert.equal(answered, DEFAULT_UNBRANDED_TARGET);
  assert.equal(visible, SAMPLE_RESULT.results.filter((r) => r.visible).length);
});

test("GUARD — the sample report FOLLOWS the deployed engine list", () => {
  // Not "matches today" — follows. Run it under a different deployment and the
  // report has to move, the way the hero and the rail were proven to.
  const two = sampleReadingUnder("aio,perplexity");
  assert.deepEqual(two.probeSources, ["aio", "perplexity"]);
  assert.deepEqual(two.rowEngines.sort(), ["aio", "perplexity"]);
  assert.deepEqual(two.promptEngines.sort(), ["aio", "perplexity"]);
  assert.equal(two.tracked, DEFAULT_UNBRANDED_TARGET);

  const three = sampleReadingUnder("aio,chatgpt,perplexity");
  assert.deepEqual(three.probeSources, ["aio", "chatgpt", "perplexity"]);
  assert.deepEqual(three.rowEngines.sort(), ["aio", "chatgpt", "perplexity"]);
  assert.equal(three.tracked, DEFAULT_UNBRANDED_TARGET, "the count does not move with the engine list");

  const one = sampleReadingUnder("aio");
  assert.deepEqual(one.probeSources, ["aio"]);
  assert.deepEqual(one.rowEngines, ["aio"], "a single-engine deployment must not show a second engine");
  assert.equal(one.tracked, DEFAULT_UNBRANDED_TARGET);

  // The verdict itself is the same reading whatever the split.
  assert.equal(one.wins, two.wins);
  assert.equal(two.wins, three.wins);
  assert.equal(one.share, three.share);
  assert.deepEqual(one.destinations, three.destinations);

  // R2.10.5 — the hero's own answer sheet, in the same child, under the same
  // varied env. Its chip was the literal 'Perplexity': rebuilt under
  // NEXT_PUBLIC_ENGINES=aio the hero sentence and the rail both narrowed to
  // Google AI Overview and the served HTML still held exactly one Perplexity,
  // and it was this chip. A second deployment where perplexity is the ONLY
  // engine is what makes this follow rather than match — under "aio" alone a
  // typed "Google AI Overview" would still look right.
  const solo = sampleReadingUnder("perplexity");
  assert.deepEqual(solo.probeSources, ["perplexity"]);
  assert.equal(one.sheetEngine, "Google AI Overview");
  assert.equal(two.sheetEngine, "Google AI Overview");
  assert.equal(three.sheetEngine, "Google AI Overview");
  assert.equal(
    solo.sheetEngine,
    "Perplexity",
    "the sample card's chip must move with the deployment, not merely match it today"
  );

  for (const [name, reading] of [["aio", one], ["aio,perplexity", two], ["aio,chatgpt,perplexity", three], ["perplexity", solo]]) {
    assert.deepEqual(
      reading.sheetLiteralsOffDeployment,
      [],
      `under ENGINES=${name} the sample card still types ${reading.sheetLiteralsOffDeployment.join(", ")}, `
        + "an engine this deployment does not probe"
    );
    assert.deepEqual(
      reading.sheetLiterals,
      [],
      "no engine name may be TYPED into the sample card at all — it happening to be "
        + "true of today's deployment is how the Perplexity chip survived R2.10.1"
    );
  }

  // And the chip must be assigned from the deployed list, not from a string
  // that happens to spell one. Assert the assignment, the way the hero
  // sentence and the rail do.
  const sheet = withoutComments(readFileSync(SHEET_PATH, "utf8"));
  assert.match(
    sheet,
    /const SHEET_ENGINE = primaryDeployedEngineLabel\(\);/,
    "SHEET_ENGINE must be assigned from primaryDeployedEngineLabel()"
  );
  assert.ok(
    !/const SHEET_ENGINE\s*=\s*['"`]/.test(sheet),
    "a typed chip is exactly how this card came to name Perplexity on an aio-only deployment"
  );
  assert.match(sheet, /className="chip">\{SHEET_ENGINE\}/, "and the chip must render it");
});

test("GUARD — the sample report backs the '64 pages, six of them yours' claim", () => {
  const refs = SAMPLE_RESULT.results.reduce((a, r) => a + r.aio_references.length, 0);
  const mine = SAMPLE_RESULT.results.filter((r) => r.brand_cited).length;

  // page.js states these as words ("The 64 pages...", "The other fifty-eight")
  // and hands them to SourcesViz as literals. They are only true because the
  // data below produces them; if it stops, this fails instead of the copy
  // quietly becoming fiction.
  assert.equal(refs, 64, "the sample must actually cite 64 sources");
  assert.equal(mine, 6, "six of them must actually be pages the brand controls");

  const src = withoutComments(readFileSync(path.join(REPO, "src/app/page.js"), "utf8"));
  assert.match(src, /SourcesViz total=\{64\} mine=\{6\}/, "the slide must quote those same two numbers");
});

test("GUARD — the scan page's sample panel is read off the sample report", async () => {
  const src = withoutComments(await read("src/app/scan/page.js"));

  // Scoped to the panel, because a CSS width of '100%' elsewhere on the page is
  // not a claim about anything.
  const start = src.indexOf("const SAMPLE_FACTS");
  assert.ok(start >= 0, "the scan page must still declare SAMPLE_FACTS");
  const block = src.slice(start, src.indexOf("export default function Scan"));

  // It used to type '41%' and '15 / 36' beside a button that opens a report
  // now reading 43% and 13 / 30.
  assert.ok(!/'\d+%'/.test(block), "a typed share of AI cannot follow the report this panel previews");
  assert.ok(!/\d+ \/ \d+/.test(block), "nor a typed 'n / total'");
  assert.match(block, /SAMPLE_RESULT\.visibilityScore/);
  assert.match(block, /SAMPLE_RESULT\.promptsTracked/);
  assert.match(block, /SAMPLE_RESULT\.competitorsFound/);
});

test("GUARD — engineDriftWarning runs in production, not only here", async () => {
  // It was written for a real failure and documented in .env.example as though
  // it ran on deploy, but the ONLY caller anywhere was this file. A guard that
  // exists solely inside its own test is the same shape of claim as a Live chip
  // on a script.
  const script = await read("scripts/check-secrets.mjs");
  assert.match(
    script,
    /engineDriftWarning\(process\.env\)/,
    "check:secrets must actually call it, on the real environment"
  );
  assert.match(
    script,
    /engine advertising — what the landing page names vs what the fleet can probe/,
    "and report it under its own heading, so it is never silent"
  );
  assert.match(
    script,
    /failures\.length \|\| !engines\.ok \? 1 : 0/,
    "a mismatch must move the exit code — a warning nobody reads is what this replaces"
  );

  // The same check closes the isConfigured() gap deployedEngines() cannot see:
  // an advertised engine with no key is an engine every scan skips.
  assert.match(script, /OPENAI_API_KEY/, "the advertised-vs-funded check must know chatgpt's key");
  assert.match(script, /PERPLEXITY_API_KEY/, "and perplexity's");

  // And the operator-facing comment must name the thing that actually runs.
  const envExample = await read(".env.example");
  assert.match(
    envExample,
    /check:secrets/,
    ".env.example must point operators at the check that exists, not at a function nothing calls"
  );
});
