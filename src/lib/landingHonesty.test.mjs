import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENGINE_LABELS,
  deployedEngines,
  deployedEngineLabels,
  formatEngineList,
  parseEngineList,
  engineDriftWarning,
} from "./engines/deployedEngines.js";
import { DEFAULT_UNBRANDED_TARGET } from "./scoring/promptSetSize.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFile(path.join(REPO, rel), "utf8");

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

  // The hero sentence must be derived, not typed. A hardcoded list is how it
  // came to advertise an engine with no API key configured.
  assert.match(src, /ENGINE_SENTENCE/, "the hero must render the derived sentence");
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

test("GUARD — the demonstration figures sum to the advertised count", async () => {
  const src = withoutComments(await read("src/app/page.js"));

  // DESTINATIONS is the donut on the page: it must account for every tracked
  // question, or the illustration contradicts the number beside it. The old
  // comment asked a human to keep these in step; this asserts it instead.
  const block = src.slice(src.indexOf("const DESTINATIONS"), src.indexOf("const DEMO_ENGINE_STATS"));
  const answers = [...block.matchAll(/answers:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.equal(answers.length, 4, "expected four destinations");
  assert.equal(
    answers.reduce((a, b) => a + b, 0),
    DEFAULT_UNBRANDED_TARGET,
    `the destinations sum to ${answers.reduce((a, b) => a + b, 0)}, not the ${DEFAULT_UNBRANDED_TARGET} the page advertises`
  );
});

test("GUARD — the engine rail shows only deployed engines", async () => {
  const src = await read("src/app/page.js");

  assert.match(src, /DEMO_ENGINES = DEPLOYED_ENGINE_LABELS\.map/, "the rail must be derived from the deployed list");
  assert.ok(
    !/\{ name: 'ChatGPT', asked:/.test(src),
    "a hardcoded ChatGPT row advertises an engine this deployment does not probe"
  );
});

test("GUARD — every engine label the page can render is a known engine", () => {
  for (const label of deployedEngineLabels({ ENGINES: "aio,chatgpt,perplexity" })) {
    assert.ok(Object.values(ENGINE_LABELS).includes(label), `${label} is not a known engine label`);
  }
});
