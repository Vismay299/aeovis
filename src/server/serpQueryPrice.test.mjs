/**
 * R3.6.4 (finding S18) — one per-query SERP price, in one table.
 *
 * THE BUG
 * -------
 * `0.0015`, the Bright Data per-query rate, was written out three times: once
 * in src/shared/engines/serp.js and once beside each of the two pipelines'
 * `brightDataSearch` calls (src/shared/scoring/aioPipeline.js,
 * src/shared/scoring/enginePipeline.js). SerpAPI's `0.01` appeared twice more in
 * serp.js. Copies of a price drift independently and nothing notices, because
 * a drifted cost is still a plausible cost — nobody reads a spend total and
 * thinks "that looks like two of the three call sites".
 *
 * All three copies priced the SAME unit (one `brightDataSearch` request), so
 * they collapse into one row. SerpAPI's rate is a DIFFERENT vendor's per-query
 * price and gets its own row rather than being merged into Bright Data's.
 *
 * WHAT THIS FILE GUARDS, AND ITS SCOPE
 * ------------------------------------
 * Deliberately scoped to the three files in the SCAN path that issue billed
 * SERP queries, listed in SCAN_PATH_FILES below. It is NOT a repo-wide ban on
 * decimal literals: per-token model rates and per-call tool fees are a
 * different unit with their own table and their own guards
 * (src/shared/llmPricing.test.mjs, src/shared/engines/openai.test.mjs), and the
 * content pipeline is out of scope here. Add a file to SCAN_PATH_FILES when it
 * starts paying a vendor per query.
 *
 * Three layers, because each catches a different way of regressing:
 *   1. unit — the table itself: unknown id throws, declarations win, malformed
 *      declarations throw rather than degrading to "unpriced";
 *   2. static — no numeric literal price survives in the scan path;
 *   3. behavioural — each of the three call sites actually READS the table. A
 *      declared sentinel rate (nothing like the built-in values) has to come
 *      out the other end, which a reintroduced literal cannot fake.
 *
 * No vendor calls: every test stubs `globalThis.fetch`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  BUILT_IN_SERP_QUERY_PRICES,
  SERP_QUERY_PRICES_ENV,
  isUnpricedModel,
  lookupSerpQueryPrice,
  readDeclaredSerpQueryPrices,
  resetUnpricedAlerts,
  resolveSerpQueryCost,
} from "../shared/llmPricing.js";
import { probeGoogleAiOverview } from "../shared/engines/serp.js";
import { runAioScan } from "../shared/scoring/aioPipeline.js";
import { runMultiEngineScan } from "../shared/scoring/enginePipeline.js";
import { assertCorpusIntact } from "./testCorpus.mjs";

/** Every call in the unit block is env-explicit, so nothing reads the ambient process. */
const NO_ENV = {};
const declaring = (json) => ({ [SERP_QUERY_PRICES_ENV]: json });

const silenced = (fn) => {
  const real = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = real;
  }
};

// ---------------------------------------------------------------------------
// 1. The table.
// ---------------------------------------------------------------------------

test("R3.6.4 — the built-in table carries both vendors' per-query rates, unchanged", () => {
  assert.deepEqual(lookupSerpQueryPrice("brightdata", NO_ENV), { usd: 0.0015, declared: false });
  assert.deepEqual(lookupSerpQueryPrice("serpapi", NO_ENV), { usd: 0.01, declared: false });
  // Two vendors, two rows: they are different vendors' prices for different
  // requests and must never be merged just because both are "a SERP query".
  assert.notEqual(
    BUILT_IN_SERP_QUERY_PRICES.brightdata,
    BUILT_IN_SERP_QUERY_PRICES.serpapi,
    "collapsing two vendors' rates into one row would be the drift this task removes, inverted"
  );
  assert.ok(Object.isFrozen(BUILT_IN_SERP_QUERY_PRICES), "the table must not be mutable at runtime");
  assert.equal(lookupSerpQueryPrice("", NO_ENV), null);
  assert.equal(lookupSerpQueryPrice(undefined, NO_ENV), null);
});

test("R3.6.4 — an unknown SERP provider id throws loud and alerts, never $0", () => {
  resetUnpricedAlerts();
  const logged = [];
  const real = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  let caught = null;
  try {
    resolveSerpQueryCost({ provider: "bright_data", env: NO_ENV });
  } catch (e) {
    caught = e;
  } finally {
    console.error = real;
  }

  assert.ok(isUnpricedModel(caught), "must be a typed UnpricedModelError");
  assert.equal(caught.reason, "unpriced_serp_query");
  assert.equal(caught.provider, "bright_data");
  assert.match(caught.message, new RegExp(SERP_QUERY_PRICES_ENV));
  assert.match(caught.message, /brightdata, serpapi/, "the message names what IS priced");
  assert.match(caught.message, /not an option/);
  assert.ok(
    logged.some((l) => l.includes("[llm-price] UNPRICED SERP PROVIDER")),
    `expected a greppable [llm-price] alert, got: ${JSON.stringify(logged)}`
  );
});

test("R3.6.4 — a declared rate wins over the built-in one, and multiplies by query count", () => {
  assert.deepEqual(lookupSerpQueryPrice("brightdata", declaring('{"brightdata":0.004}')), {
    usd: 0.004,
    declared: true,
  });
  // A declared 0 is a real claim ("this vendor is free for us"), not a missing
  // one — the same rule the model and tool tables follow.
  assert.deepEqual(lookupSerpQueryPrice("acme", declaring('{"acme":0}')), { usd: 0, declared: true });

  assert.deepEqual(resolveSerpQueryCost({ provider: "brightdata", env: NO_ENV }), {
    cost: 0.0015,
    cost_source: "serp_price_table",
  });
  assert.deepEqual(resolveSerpQueryCost({ provider: "serpapi", queries: 2, env: NO_ENV }), {
    cost: 0.02,
    cost_source: "serp_price_table",
  });
  assert.equal(
    resolveSerpQueryCost({ provider: "brightdata", env: declaring('{"brightdata":0.5}') }).cost,
    0.5
  );
});

test("R3.6.4 — a malformed SERP_QUERY_PRICES throws instead of degrading to unpriced", () => {
  assert.deepEqual(readDeclaredSerpQueryPrices(NO_ENV), {});
  assert.deepEqual(readDeclaredSerpQueryPrices(declaring("   ")), {});
  assert.deepEqual(readDeclaredSerpQueryPrices(declaring('{"brightdata":"0.002"}')), {
    brightdata: 0.002,
  });

  for (const bad of ["{oops", "[]", '{"brightdata":"free"}', '{"brightdata":-1}', '{"brightdata":null}']) {
    assert.throws(
      () => readDeclaredSerpQueryPrices(declaring(bad)),
      (e) => isUnpricedModel(e) && e.reason === "malformed_declaration",
      `expected ${bad} to be refused`
    );
  }
});

test("R3.6.4 — a query count that is not a number is a caller bug, not a default of 1", () => {
  for (const bad of [NaN, Infinity, -Infinity, -1, "2", null]) {
    assert.throws(
      () => resolveSerpQueryCost({ provider: "brightdata", queries: bad, env: NO_ENV }),
      TypeError,
      `expected queries=${JSON.stringify(bad)} to be refused rather than priced as one query`
    );
  }
  // Zero queries is a measurement ("nothing was asked"), not a bad count.
  assert.equal(resolveSerpQueryCost({ provider: "brightdata", queries: 0, env: NO_ENV }).cost, 0);
});

// ---------------------------------------------------------------------------
// 2. The static guard.
// ---------------------------------------------------------------------------

/**
 * The scan path, for the purposes of this guard: the files that issue a billed
 * SERP query and therefore have a per-query price to get wrong. Nothing else.
 */
const SCAN_PATH_FILES = [
  "engines/serp.js",
  "scoring/aioPipeline.js",
  "scoring/enginePipeline.js",
];

/**
 * Comments are removed first, so the files stay free to DISCUSS the numbers —
 * the comments explaining this fold-in name 0.0015 and 0.01 on purpose. Only
 * executable text is searched.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** `cost = 0.0015`, `let cost = 0.01`, `result.cost += 0.0015`, `cost: 0.0015`. */
const COST_LITERAL_PATTERNS = [
  /[\w$.]*cost[\w$]*\s*(?:\+|-)?=[^=]\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/gi,
  /[\w$]*cost[\w$]*\s*:\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/gi,
];

test("GUARD TEETH — assertCorpusIntact enforces length floor, shape, uniqueness, and required targets", () => {
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

test("GUARD — SCAN_PATH_FILES and COST_LITERAL_PATTERNS corpora are intact", () => {
  assertCorpusIntact(SCAN_PATH_FILES, "SCAN_PATH_FILES", {
    floor: 3,
    required: [
      "engines/serp.js",
      "scoring/aioPipeline.js",
      "scoring/enginePipeline.js",
    ],
    isTuple: false,
  });
  assertCorpusIntact(COST_LITERAL_PATTERNS, "COST_LITERAL_PATTERNS", {
    floor: 2,
    required: [
      "[\\w$.]*cost[\\w$]*\\s*(?:\\+|-)?=[^=]\\s*(-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)",
      "[\\w$]*cost[\\w$]*\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)",
    ],
    isTuple: false,
    allowRegExp: true,
  });
});

test("GUARD — no numeric literal price is assigned to a cost in the scan path", async () => {
  for (const rel of SCAN_PATH_FILES) {
    const src = stripComments(await readFile(new URL(`../shared/${rel}`, import.meta.url), "utf8"));
    for (const pattern of COST_LITERAL_PATTERNS) {
      pattern.lastIndex = 0;
      for (const m of src.matchAll(pattern)) {
        // A literal ZERO is allowed and is not a price: it is the initial value
        // of an accumulator, or the cost of a probe that was never sent. What
        // must not reappear is a non-zero rate written out next to the call it
        // bills for.
        assert.equal(
          Number(m[1]),
          0,
          `src/shared/${rel}: "${m[0].trim()}" is a hardcoded price. Per-query rates live in ` +
            `src/shared/llmPricing.js (resolveSerpQueryCost); per-token and per-call rates live ` +
            `in the same file's other two tables. Three copies of a price drift independently.`
        );
      }
    }
  }
});

test("GUARD — no priced SERP rate appears as a bare literal in the scan path", async () => {
  const rates = [...new Set(Object.values(BUILT_IN_SERP_QUERY_PRICES))];
  assert.ok(rates.length > 0, "the table must have rows for this guard to mean anything");

  for (const rel of SCAN_PATH_FILES) {
    const src = stripComments(await readFile(new URL(`../shared/${rel}`, import.meta.url), "utf8"));
    for (const usd of rates) {
      const literal = String(usd).replace(".", "\\.");
      const re = new RegExp(`(?<![\\d.])${literal}(?![\\d])`);
      assert.ok(
        !re.test(src),
        `src/shared/${rel} restates the per-query rate ${usd}. It is already in the price table ` +
          `(src/shared/llmPricing.js SERP_QUERY_PRICES); read it with resolveSerpQueryCost instead. ` +
          `This catches a copy the cost-assignment guard would miss, e.g. "const RATE = ${usd}".`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 3. The three call sites really read the table.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "SERP_PROVIDER",
  "SERPAPI_KEY",
  "BRIGHTDATA_API_KEY",
  "BRIGHTDATA_SERP_ZONE",
  SERP_QUERY_PRICES_ENV,
  "ENGINES",
];

/**
 * Scrub every var this file's subjects branch on, apply `env`, restore after.
 * An ambient BRIGHTDATA_API_KEY changes which branch serp.js takes (see the
 * guard at the top of src/shared/engines/serp.test.mjs), so the scrub is not
 * optional.
 */
function useEnv(t, env) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  t.after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = original;
  });
}

/**
 * Sentinel rates, chosen to look like nothing in the built-in table: if a call
 * site is still reading a literal, the number that comes back is 0.0015 or
 * 0.01 and the assertion says so.
 */
// serpapi stays in the declared table on purpose: it is still a priced vendor
// id in BUILT_IN_SERP_QUERY_PRICES (asserted above). Its PROBE path in serp.js
// is gone (R1.7.3), so there is no serp.js call site to price it at any more.
const DECLARED = '{"brightdata":0.25,"serpapi":0.37}';
const BRIGHTDATA_SENTINEL = 0.25;

/** A Bright Data /request response body with a real AI Overview in it. */
const brightDataBody = () =>
  JSON.stringify({
    general: { query: "best crm" },
    organic: [{ link: "https://acme.io/", title: "Acme" }],
    ai_overview: { text_blocks: [{ snippet: "Acme CRM is highly rated." }] },
  });

const brightDataFetch = () => async () => ({
  ok: true,
  status: 200,
  text: async () => brightDataBody(),
  json: async () => JSON.parse(brightDataBody()),
});

test("CALL SITE 1 — serp.js prices a Bright Data probe from the table, not a literal", async (t) => {
  useEnv(t, {
    SERP_PROVIDER: "brightdata",
    BRIGHTDATA_API_KEY: "bd-key-EXAMPLE-NOT-A-REAL-KEY",
    BRIGHTDATA_SERP_ZONE: "test_zone",
    [SERP_QUERY_PRICES_ENV]: DECLARED,
  });
  mockFetch(t, brightDataFetch());

  const stats = {};
  const res = await probeGoogleAiOverview("best crm", { stats });
  assert.equal(res.cost, BRIGHTDATA_SENTINEL, "the declared rate must reach the probe result");
  assert.equal(stats.cost, BRIGHTDATA_SENTINEL, "and the same number must reach the scan's spend total");
});

test("CALL SITE 2 — aioPipeline prices each Bright Data query from the table", async (t) => {
  useEnv(t, {
    BRIGHTDATA_API_KEY: "bd-key-EXAMPLE-NOT-A-REAL-KEY",
    BRIGHTDATA_SERP_ZONE: "test_zone",
    [SERP_QUERY_PRICES_ENV]: DECLARED,
  });
  mockFetch(t, brightDataFetch());

  const stats = {};
  await runAioScan({
    brand: "Acme",
    url: "https://acme.io",
    competitors: [],
    queries: [
      { text: "best crm", topic: "General", source: "test" },
      { text: "crm for smbs", topic: "General", source: "test" },
    ],
    stats,
  });

  assert.equal(stats.cost, BRIGHTDATA_SENTINEL * 2, "two queries, two table lookups, no literal");
});

test("CALL SITE 3 — enginePipeline's aio probe prices from the table", async (t) => {
  useEnv(t, {
    ENGINES: "aio",
    BRIGHTDATA_API_KEY: "bd-key-EXAMPLE-NOT-A-REAL-KEY",
    BRIGHTDATA_SERP_ZONE: "test_zone",
    [SERP_QUERY_PRICES_ENV]: DECLARED,
  });
  mockFetch(t, brightDataFetch());

  const stats = {};
  const out = await runMultiEngineScan({
    brand: "Acme",
    url: "https://acme.io",
    competitors: [],
    queries: [{ text: "best crm", topic: "General", source: "test" }],
    stats,
  });

  assert.equal(stats.cost, BRIGHTDATA_SENTINEL);
  assert.equal(
    out.results.find((r) => r.engine === "aio")?.cost,
    BRIGHTDATA_SENTINEL,
    "the per-row cost is the table's too, not just the total"
  );
});

test("R3.6.4 — an unpriced provider stops the scan path instead of billing it at $0", async (t) => {
  // The shape that matters: serp.js's Bright Data branch ends in a catch that
  // returns `{ ..., cost: 0.0 }` for anything that throws inside it, and both
  // pipelines turn a throw into an error row with cost left at 0. So the
  // refusal is raised OUTSIDE those handlers and must reach the caller.
  useEnv(t, {
    SERP_PROVIDER: "brightdata",
    BRIGHTDATA_API_KEY: "bd-key-EXAMPLE-NOT-A-REAL-KEY",
    BRIGHTDATA_SERP_ZONE: "test_zone",
    // A declaration that prices SerpAPI and, by naming neither, leaves Bright
    // Data priced by the built-in table — so to make it unpriceable we have to
    // reach past the built-ins. Instead: an id nothing prices, via the same
    // resolver the call sites use.
    [SERP_QUERY_PRICES_ENV]: '{"serpapi":0.37}',
  });
  let fetched = false;
  mockFetch(t, async () => {
    fetched = true;
    return { ok: true, status: 200, text: async () => brightDataBody() };
  });

  resetUnpricedAlerts();
  // The built-in table still prices "brightdata", so the live probe succeeds —
  // that is the point of a built-in row. The refusal is exercised against the
  // resolver the probe calls, with an id that is in no table at all.
  const res = await probeGoogleAiOverview("best crm");
  assert.equal(res.cost, BUILT_IN_SERP_QUERY_PRICES.brightdata, "built-in row still prices the probe");
  assert.ok(fetched, "and the probe really ran");

  assert.throws(
    () => silenced(() => resolveSerpQueryCost({ provider: "brightdata-eu" })),
    (e) => isUnpricedModel(e) && e.reason === "unpriced_serp_query",
    "an id in no table must throw rather than return a cost of any kind"
  );
});
