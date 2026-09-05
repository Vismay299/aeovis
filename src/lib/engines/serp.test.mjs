import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeGoogleAiOverview, extractTextFromBlocks, fetchPeopleAlsoAsk, fetchAutocomplete } from './serp.js';

/**
 * Every env var getSerpProvider() branches on (serp.js:9-16, brightdata.js:5).
 *
 * R6.5.4 — these tests used to set SERPAPI_KEY and nothing else, which was only
 * sufficient because no .env.local existed. With BRIGHTDATA_API_KEY present in
 * the ambient environment — the normal state on a developer machine and in CI —
 * getSerpProvider returns "brightdata" before it ever consults SERPAPI_KEY, the
 * SerpAPI mocks never match, and three of these tests fail. The suite was green
 * for a reason that had nothing to do with the code under test.
 */
const SERP_ENV = [
  "SERP_PROVIDER",
  "SERPAPI_KEY",
  "BRIGHTDATA_API_KEY",
  "BRIGHTDATA_SERP_ZONE",
];

/**
 * Captured at module load, before any test touches the environment: exactly what
 * this process inherited. The file-scoped after() hook below asserts every var
 * is back to this on the way out — after every test in the file, wherever the
 * hook itself sits (R6.5.5). Without it, "restores them" has no teeth: a file
 * that leaves a sentinel standing where a real credential was has restored
 * nothing, and every later test in the run measures the sentinel.
 */
const PROCESS_START_ENV = Object.fromEntries(SERP_ENV.map((k) => [k, process.env[k]]));

/** Shape of a value, never the value: assertion output must not leak a real key. */
function describeEnv(v) {
  return v === undefined ? "unset" : `set (len ${v.length})`;
}

/**
 * Scrub every provider var, apply `env`, and restore on the way out — via
 * t.after so an assertion that throws still restores, which the old inline
 * `delete process.env.SERPAPI_KEY` at the end of each test did not.
 */
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

test('GUARD — an ambient Bright Data key is scrubbed, not inherited', (t) => {
  // Simulate the ambient key that made three tests below fail, then prove the
  // helper removes it. Without this, the SerpAPI mocks measure leakage.
  //
  // The restore must put back what was THERE, not delete unconditionally: an
  // unconditional delete strips a genuinely ambient key for every later test in
  // this file, which silently disarms the regression this guard exists for. The
  // first version of this test did exactly that, and the sabotage check that
  // should have failed passed instead.
  const ambient = process.env.BRIGHTDATA_API_KEY;
  process.env.BRIGHTDATA_API_KEY = 'bd-ambient';

  useSerpEnv(t, { SERPAPI_KEY: 'mock-key' });

  // Registered AFTER useSerpEnv, and that ordering IS the fix: node:test runs
  // t.after hooks in registration order. Registered first, this hook ran first
  // and useSerpEnv's ran last, putting the sentinel 'bd-ambient' back over the
  // real ambient key and leaving a fabricated credential standing for the rest
  // of the run. Last registered, last to run, so this one has the final word.
  t.after(() => {
    if (ambient === undefined) delete process.env.BRIGHTDATA_API_KEY;
    else process.env.BRIGHTDATA_API_KEY = ambient;
  });

  assert.equal(process.env.BRIGHTDATA_API_KEY, undefined,
    'an ambient Bright Data key must be scrubbed — getSerpProvider prefers it over SERPAPI_KEY');
  assert.equal(process.env.SERP_PROVIDER, undefined, 'an explicit provider override must be scrubbed too');
  assert.equal(process.env.SERPAPI_KEY, 'mock-key');
});

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

test('probeGoogleAiOverview - mock parsing correctness with text_blocks', async (t) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return {
      ok: true,
      json: async () => ({
        ai_overview: {
          text_blocks: [
            { snippet: "Acme CRM is highly rated." },
            { snippet: "It is built for small businesses." }
          ],
          references: [
            { title: "Acme Pricing", link: "https://acme.io/pricing?ref=google" },
            { title: "CRM Review", link: "https://reviews.com/acme-crm/" }
          ]
        }
      })
    };
  };

  useSerpEnv(t, { SERPAPI_KEY: "mock-key" });

  const result = await probeGoogleAiOverview("best crm");
  assert.equal(result.text, "Acme CRM is highly rated.\nIt is built for small businesses.");
  assert.equal(result.model_used, "google_ai_overview");
  assert.deepEqual(result.citations, [
    "https://acme.io/pricing",
    "https://reviews.com/acme-crm"
  ]);

  globalThis.fetch = originalFetch;
});

test('probeGoogleAiOverview - mock deferred page_token loading', async (t) => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  globalThis.fetch = async (url) => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: true,
        json: async () => ({
          ai_overview_deferred: {
            token: "deferred_token_xyz"
          }
        })
      };
    } else {
      assert.ok(url.includes("page_token=deferred_token_xyz"));
      assert.ok(url.includes("engine=google_ai_overview"));
      return {
        ok: true,
        json: async () => ({
          ai_overview: {
            text_blocks: [{ snippet: "Deferred content loaded successfully." }],
            references: [{ title: "Deferred link", link: "https://deferred.com/" }]
          }
        })
      };
    }
  };

  useSerpEnv(t, { SERPAPI_KEY: "mock-key" });

  const result = await probeGoogleAiOverview("best crm");
  assert.equal(result.text, "Deferred content loaded successfully.");
  assert.equal(result.model_used, "google_ai_overview");
  assert.deepEqual(result.citations, ["https://deferred.com"]);
  // Cost should include double charge: 0.01 + 0.01 = 0.02
  assert.equal(result.cost, 0.02);

  globalThis.fetch = originalFetch;
});

test('fetchPeopleAlsoAsk - mock fetches and returns question strings', async (t) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return {
      ok: true,
      json: async () => ({
        people_also_ask: [
          { question: "What is AEO?" },
          { question: "How to track SGE visibility?" }
        ]
      })
    };
  };

  useSerpEnv(t, { SERPAPI_KEY: "mock-key" });

  const result = await fetchPeopleAlsoAsk("aeo");
  assert.deepEqual(result, [
    "What is AEO?",
    "How to track SGE visibility?"
  ]);

  globalThis.fetch = originalFetch;
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
 *
 * This is a FILE-SCOPED after() hook, not a top-level test(), and that is the
 * whole point. node:test runs a file-scoped after hook once, after EVERY test
 * in the file has finished, no matter where in the file the hook is registered.
 *
 * R6.5.5 — the first version of this was a top-level test() sitting last in the
 * file. It worked, and it could not lie, but it could stop looking: appending a
 * test BELOW it left the file green (measured: 8 pass / 0 fail) while
 * SERPAPI_KEY leaked out of the file to every suite that ran after it. A guard
 * whose coverage depends on staying the last line in the file has an expiry
 * date that nobody can see in a diff. As a hook it has no position to lose —
 * move this block to the top of the file and it still guards the bottom.
 *
 * It exists because the ambient-key guard above used to register its restore
 * BEFORE calling useSerpEnv, and t.after hooks run in registration order — so
 * useSerpEnv's hook ran last and put the sentinel "bd-ambient" back over the
 * real ambient key, leaving a fabricated credential standing for the rest of
 * the run. Do not reorder the two calls in that test without re-reading this.
 *
 * A throwing after hook is reported by node:test as a file-level failure with a
 * nonzero exit code, so this cannot be a silent diagnostic.
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

/**
 * GUARD — the end-state check above stays position-independent.
 *
 * Reading a test file's own source is unusual, so: the failure this pins is a
 * refactor that turns the after() hook back into a top-level test(). That form
 * passes every existing assertion, looks tidier in the reporter output, and
 * silently reintroduces R6.5.5 — coverage that decays the next time someone
 * appends a test. Nothing at runtime can notice that, because the positional
 * guard still tells the truth about everything it looks at; it just stops
 * looking. Only the source can tell you.
 *
 * ALLOWLIST — files that mutate process.env for engine credentials and must
 * therefore own a file-scoped end-state hook. Both are engine suites that scrub
 * and reset provider vars in a shared process (types.test.mjs says so in its own
 * header: serp.test.mjs sets SERPAPI_KEY in this same process). Adding a third
 * such suite? Add it here. Removing one? Only because it stopped touching
 * process.env — not because this guard was inconvenient.
 */
const END_STATE_HOOK_FILES = [
  "src/lib/engines/serp.test.mjs",
  "src/lib/engines/types.test.mjs",
];

test("GUARD — env end-state checks are file-scoped hooks, not positional tests", async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const offenders = [];
  for (const rel of END_STATE_HOOK_FILES) {
    const src = await readFile(path.join(repo, rel), "utf8");
    // `after` must be imported from node:test — the bare identifier could
    // otherwise be a local helper that never runs.
    const importsAfter = /import\s+[^;]*\bafter\b[^;]*from\s+["']node:test["']/.test(src);
    // ...and invoked at top level (column 0), not nested inside a test body,
    // where it would degrade back into a per-test hook.
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
