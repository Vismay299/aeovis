/**
 * R1.7.3 — SerpAPI probe path and resolveSerpCredentials/serpFetch deleted.
 *
 * These tests cover the remaining live exports from serp.js: extractTextFromBlocks
 * (pure), probeGoogleAiOverview (Bright Data only), fetchPeopleAlsoAsk (Bright Data
 * only), and fetchAutocomplete (Google suggest).
 *
 * The SerpAPI-specific tests that exercised the dead code path have been removed
 * along with the code they tested. The env-scrubbing guards remain because
 * SERPAPI_KEY is still a real env var that must not leak between suites.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeGoogleAiOverview, extractTextFromBlocks, fetchPeopleAlsoAsk, fetchAutocomplete, isBrightDataConfigured } from './serp.js';

const SERP_ENV = [
  "SERP_PROVIDER",
  "SERPAPI_KEY",
  "BRIGHTDATA_API_KEY",
  "BRIGHTDATA_SERP_ZONE",
];

const PROCESS_START_ENV = Object.fromEntries(SERP_ENV.map((k) => [k, process.env[k]]));

function describeEnv(v) {
  return v === undefined ? "unset" : `set (len ${v.length})`;
}

function useSerpEnv(t, env) {
  const saved = Object.fromEntries(SERP_ENV.map((k) => [k, process.env[k]]));
  for (const k of SERP_ENV) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  t.after(() => {
    for (const k of SERP_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test('extractTextFromBlocks - nested list, snippets, tables, and expandable formats', () => {
  const blocks = [
    { snippet: "Here is the first paragraph." },
    {
      snippet: "Key features include:",
      list: [
        { snippet: "Feature A" },
        { snippet: "Feature B" }
      ]
    },
    {
      text_blocks: [
        { snippet: "Nested text snippet." }
      ]
    },
    {
      header: "Expandable Section Title",
      content: [
        { snippet: "Expandable inner text." }
      ]
    },
    {
      table: {
        headers: ["Plan", "Price"],
        rows: [
          ["Basic", "$10"],
          ["Pro", "$30"]
        ]
      }
    }
  ];

  const result = extractTextFromBlocks(blocks);
  assert.equal(
    result,
    "Here is the first paragraph.\nKey features include:\n- Feature A\n- Feature B\nNested text snippet.\nExpandable Section Title\nExpandable inner text.\nPlan | Price\nBasic | $10\nPro | $30"
  );
});

test('isBrightDataConfigured — returns false when no key', (t) => {
  useSerpEnv(t, {});
  assert.equal(isBrightDataConfigured(), false);
});

test('isBrightDataConfigured — returns true when BRIGHTDATA_API_KEY is set', (t) => {
  useSerpEnv(t, { BRIGHTDATA_API_KEY: 'bd-test-key' });
  assert.equal(isBrightDataConfigured(), true);
});

test('probeGoogleAiOverview — skipped when Bright Data is not configured', async (t) => {
  useSerpEnv(t, {});
  const result = await probeGoogleAiOverview("best crm");
  assert.equal(result.model_used, "google_ai_overview-skipped");
  assert.equal(result.text, "");
  assert.equal(result.citations.length, 0);
});

test('fetchPeopleAlsoAsk — returns empty when Bright Data is not configured', async (t) => {
  useSerpEnv(t, {});
  const result = await fetchPeopleAlsoAsk("aeo");
  assert.deepEqual(result, []);
});

test('fetchAutocomplete - mock suggestions', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return {
      ok: true,
      json: async () => [
        "aeo",
        ["aeo tracking", "aeo visibility tools"]
      ]
    };
  };

  const result = await fetchAutocomplete("aeo");
  assert.deepEqual(result, [
    "aeo tracking",
    "aeo visibility tools"
  ]);

  globalThis.fetch = originalFetch;
});

/**
 * GUARD — every provider var is restored to what the process started with.
 */
after(() => {
  const started = SERP_ENV.map((k) => `${k}: ${describeEnv(PROCESS_START_ENV[k])}`).join(", ");
  for (const k of SERP_ENV) {
    const before = PROCESS_START_ENV[k];
    const ended = process.env[k];
    assert.ok(
      ended === before,
      `${k} was not restored: started ${describeEnv(before)}, ended ${describeEnv(ended)}` +
        (describeEnv(before) === describeEnv(ended) ? " holding a different value" : "") +
        `\n  ambient at process start — ${started}` +
        `\n  every test in this file must restore the provider vars it sets;` +
        ` useSerpEnv(t, {...}) does that for you.`
    );
  }
});

const END_STATE_HOOK_FILES = [
  "src/lib/engines/serp.test.mjs",
  "src/lib/engines/types.test.mjs",
];

import { assertCorpusIntact } from "../testCorpus.mjs";

test("GUARD TEETH — assertCorpusIntact enforces length floor, uniqueness, and required targets", () => {
  assert.throws(
    () => assertCorpusIntact([], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /under its floor of 1/
  );
  assert.throws(
    () => assertCorpusIntact(["a", "a"], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /repeats/
  );
  assert.throws(
    () => assertCorpusIntact(["a"], "TEST_CORPUS", { floor: 1, required: ["b"], isTuple: false }),
    /no longer contains/
  );
  assert.throws(
    () => assertCorpusIntact([123], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /is not a string/
  );
});

test("GUARD — END_STATE_HOOK_FILES corpus is intact", () => {
  assertCorpusIntact(END_STATE_HOOK_FILES, "END_STATE_HOOK_FILES", {
    floor: 2,
    required: [
      "src/lib/engines/serp.test.mjs",
      "src/lib/engines/types.test.mjs",
    ],
    isTuple: false,
  });
});

test("GUARD — env end-state checks are file-scoped hooks, not positional tests", async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const offenders = [];
  for (const rel of END_STATE_HOOK_FILES) {
    const src = await readFile(path.join(repo, rel), "utf8");
    const importsAfter = /import\s+[^;]*\bafter\b[^;]*from\s+["']node:test["']/.test(src);
    const registersHook = /^after\(/m.test(src);
    if (!importsAfter || !registersHook) {
      offenders.push(
        `${rel}: ${importsAfter ? "" : "does not import after from node:test; "}` +
          `${registersHook ? "" : "has no top-level after(...) registration"}`
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these suites mutate engine credential vars but have no file-scoped end-state guard, " +
      "so a test appended below their last assertion is unguarded:\n  " +
      offenders.join("\n  ")
  );
});
