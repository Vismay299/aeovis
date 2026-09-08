/**
 * R2.2.8 (finding A1) — a failed PAA / autocomplete leg must be OBSERVABLE and
 * CARRIED, not merely survived.
 *
 * What actually reproduced on this branch (the roadmap's "bare catch with no
 * log" had already been half-closed by R3.7.6, which added a warn to both seed
 * catches):
 *
 *   1. src/lib/engines/serp.js — `fetchPeopleAlsoAsk` caught a typed
 *      BrightDataZoneError per term, warned, and returned `[]`. `[]` is
 *      byte-for-byte what "Google had no People-Also-Ask for this term"
 *      returns, so a dead Bright Data zone never reached promptGen as a
 *      failure at all: it arrived as an empty success.
 *   2. src/lib/scoring/promptGen.js — with `seedQueries = []` the seed block
 *      took its success path and emitted NOTHING, and the prompt set went out
 *      with no record anywhere that seeding had been attempted and failed. A
 *      scan grounded in 30 real Google queries and one grounded in zero were
 *      indistinguishable to every consumer downstream.
 *
 * These tests therefore assert on two things a "just add a log" fix would not
 * satisfy: the state lands on the caller's `stats` accumulator (the same
 * channel `stats.website_scrape` uses), and the log carries the ERROR — its
 * type and its reason — rather than a bare message string.
 *
 * No test here makes a real SERP call: every provider is either injected
 * through `deps` or driven through a stubbed `globalThis.fetch`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateUnbrandedPrompts, SEED_STATE } from "./promptGen.js";
import { fetchPeopleAlsoAsk } from "../engines/serp.js";
import { BrightDataZoneError, invalidateBrightDataZoneCache } from "../engines/brightdata.js";

const brand = "Acme";
const website = "https://acme.io";
/** Yields several distinct seed terms, so "aborted early" is measurable. */
const industry = "Project Management Software";
const siteText = "Manage projects with teams and software";

function makeItems(prefix, n, topic = "General") {
  return Array.from({ length: n }, (_, i) => ({
    text: `${prefix} query number ${i} example`,
    topic,
    intent_tier: "informational",
  }));
}

const enoughPrompts = async () => makeItems("clean", 40);

/**
 * Capture console.warn, serializing an Error argument as `Name: message`.
 *
 * That serialization is the teeth for half this task: code that logs
 * `err.message` alone produces a line with no type in it, so an assertion on
 * "BrightDataZoneError:" fails exactly when the fix has been reverted.
 */
function captureWarnings() {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => {
    lines.push(
      args
        .map((a) => (a instanceof Error ? `${a.name}: ${a.message} reason=${a.reason ?? ""}` : String(a)))
        .join(" ")
    );
  };
  return { lines, restore: () => { console.warn = original; } };
}

function zoneError() {
  return new BrightDataZoneError("No active Bright Data SERP zone found on this account.", {
    reason: "no_active_zone",
    zone: null,
  });
}

// ---------------------------------------------------------------------------
// promptGen: the seeding verdict is recorded on `stats`, not just logged
// ---------------------------------------------------------------------------

test("a clean seeded run records state=ok with a non-zero query count", async () => {
  const stats = {};
  const warned = captureWarnings();
  try {
    const prompts = await generateUnbrandedPrompts(brand, website, industry, stats, 30, {
      scrapeForSummary: async () => siteText,
      fetchPeopleAlsoAsk: async () => ["how do teams pick a tool"],
      fetchAutocomplete: async () => ["best tool for teams"],
      llmJson: enoughPrompts,
    });
    assert.equal(prompts.length, 30);
  } finally {
    warned.restore();
  }

  assert.ok(stats.prompt_seeding, "the seeding leg must be recorded on every run, not only on failure");
  assert.equal(stats.prompt_seeding.state, SEED_STATE.OK);
  assert.equal(stats.prompt_seeding.state_reason, "seeded");
  assert.ok(stats.prompt_seeding.seed_queries > 0);
  assert.equal(stats.prompt_seeding.terms_failed, 0);
  assert.deepEqual(stats.prompt_seeding.failures, []);
});

test("a typed zone error during seeding is logged WITH THE ERROR and recorded as unavailable", async () => {
  const stats = {};
  const warned = captureWarnings();
  let prompts;
  try {
    prompts = await generateUnbrandedPrompts(brand, website, industry, stats, 30, {
      scrapeForSummary: async () => siteText,
      fetchPeopleAlsoAsk: async () => { throw zoneError(); },
      fetchAutocomplete: async () => ["best tool for teams"],
      llmJson: enoughPrompts,
    });
  } finally {
    warned.restore();
  }

  // Seeding stays best-effort: the scan still gets its prompt set.
  assert.equal(prompts.length, 30, "seeding is grounding, not a precondition — the run completes");

  const rec = stats.prompt_seeding;
  assert.ok(rec, "a dead SERP zone must leave a record, not just a log line");
  assert.equal(rec.state, SEED_STATE.UNAVAILABLE);
  assert.equal(rec.state_reason, "serp_zone_no_active_zone");
  assert.equal(rec.seed_queries, 0);
  assert.equal(rec.failures[0].error, "BrightDataZoneError");
  assert.equal(rec.failures[0].reason, "no_active_zone");
  assert.equal(rec.failures[0].stage, "seed");

  // Every remaining term hits the same dead zone; burning four more 10s
  // deadlines on it is the thing the abort exists to prevent.
  assert.equal(rec.terms_attempted, 1, "seeding must abandon the loop on a zone fault");

  assert.ok(
    warned.lines.some((l) => l.includes("BrightDataZoneError:") && l.includes("reason=no_active_zone")),
    `the log must carry the typed error, not a bare message; saw: ${JSON.stringify(warned.lines)}`
  );
  assert.ok(
    warned.lines.some((l) => l.includes("ABANDONING PAA seeding")),
    `the abandoned leg must say so; saw: ${JSON.stringify(warned.lines)}`
  );
  assert.ok(
    warned.lines.some((l) => l.includes("PAA/autocomplete seeding") && l.includes("unavailable")),
    `the ungrounded prompt set must be named as such; saw: ${JSON.stringify(warned.lines)}`
  );
});

test("every seed term failing is UNAVAILABLE, never a quiet success", async () => {
  const stats = {};
  const warned = captureWarnings();
  try {
    await generateUnbrandedPrompts(brand, website, industry, stats, 30, {
      scrapeForSummary: async () => siteText,
      fetchPeopleAlsoAsk: async () => { throw new Error("serp 503"); },
      fetchAutocomplete: async () => { throw new Error("serp 503"); },
      llmJson: enoughPrompts,
    });
  } finally {
    warned.restore();
  }

  const rec = stats.prompt_seeding;
  assert.equal(rec.state, SEED_STATE.UNAVAILABLE);
  assert.equal(rec.state_reason, "all_seed_terms_failed");
  assert.ok(rec.terms_attempted >= 2, "the test must actually reach seeding");
  assert.equal(rec.terms_failed, rec.terms_attempted);
  assert.equal(rec.seed_queries, 0);
});

test("a partial seed failure is DEGRADED — not ok, not unavailable", async () => {
  const stats = {};
  let calls = 0;
  const warned = captureWarnings();
  try {
    await generateUnbrandedPrompts(brand, website, industry, stats, 30, {
      scrapeForSummary: async () => siteText,
      fetchPeopleAlsoAsk: async () => {
        calls += 1;
        if (calls === 1) throw new Error("serp 503");
        return ["how do teams pick a tool"];
      },
      fetchAutocomplete: async () => ["best tool for teams"],
      llmJson: enoughPrompts,
    });
  } finally {
    warned.restore();
  }

  const rec = stats.prompt_seeding;
  assert.equal(rec.state, SEED_STATE.DEGRADED);
  assert.equal(rec.state_reason, "some_seed_terms_failed");
  assert.equal(rec.terms_failed, 1);
  assert.ok(rec.terms_attempted > 1);
  assert.ok(rec.seed_queries > 0, "the surviving terms' queries are still counted");
});

test("a measured zero is not a never-ran: fetches that succeed with nothing say so", async () => {
  const measured = {};
  const neverRan = {};
  const warned = captureWarnings();
  try {
    // Every fetch succeeds and Google genuinely returns nothing.
    await generateUnbrandedPrompts(brand, website, industry, measured, 30, {
      scrapeForSummary: async () => siteText,
      fetchPeopleAlsoAsk: async () => [],
      fetchAutocomplete: async () => [],
      llmJson: enoughPrompts,
    });
    // No industry label and no site text: no seed term can be derived, so no
    // SERP call is ever made.
    await generateUnbrandedPrompts(brand, website, "", neverRan, 30, {
      scrapeForSummary: async () => "",
      fetchPeopleAlsoAsk: async () => { throw new Error("must never be called"); },
      fetchAutocomplete: async () => { throw new Error("must never be called"); },
      llmJson: enoughPrompts,
    });
  } finally {
    warned.restore();
  }

  assert.equal(measured.prompt_seeding.state, SEED_STATE.OK);
  assert.equal(measured.prompt_seeding.state_reason, "no_seed_queries_returned");
  assert.ok(measured.prompt_seeding.terms_attempted > 0);

  assert.equal(neverRan.prompt_seeding.state, SEED_STATE.NOT_ATTEMPTED);
  assert.equal(neverRan.prompt_seeding.terms_attempted, 0);

  assert.notDeepEqual(
    measured.prompt_seeding,
    neverRan.prompt_seeding,
    "standing rule 1: a measured zero and a leg that never ran must not read alike"
  );
  // Both produce an ungrounded prompt set, so both are said out loud.
  assert.equal(
    warned.lines.filter((l) => l.includes("PAA/autocomplete seeding")).length,
    2,
    `both ungrounded runs must warn; saw: ${JSON.stringify(warned.lines)}`
  );
});

test("a realism-blend PAA failure lands in the same record under stage 'blend'", async () => {
  const stats = {};
  const warned = captureWarnings();
  try {
    await generateUnbrandedPrompts(brand, website, industry, stats, 3, {
      scrapeForSummary: async () => siteText,
      // Seed terms succeed (with nothing); the blend topic throws.
      fetchPeopleAlsoAsk: async (term) => {
        if (term === "General") throw new Error("blend 500");
        return [];
      },
      fetchAutocomplete: async () => [],
      // Two prompts only, so the blend is reached.
      llmJson: async () => makeItems("thin", 2),
    });
  } finally {
    warned.restore();
  }

  const rec = stats.prompt_seeding;
  assert.equal(rec.blend_topics_attempted, 1);
  assert.equal(rec.blend_fetches_failed, 1);
  assert.equal(rec.state, SEED_STATE.DEGRADED, "a blend that lost a fetch cannot read 'ok'");
  assert.equal(rec.state_reason, "blend_fetch_failed");
  assert.ok(rec.failures.some((f) => f.stage === "blend" && f.message.includes("blend 500")));
  assert.ok(
    warned.lines.some((l) => l.includes("realism blend") && l.includes("static industry pack")),
    `the blend shortfall must name its consequence; saw: ${JSON.stringify(warned.lines)}`
  );
});

test("the seeding record survives an LLM pass that throws afterwards", async () => {
  const stats = {};
  const warned = captureWarnings();
  try {
    await assert.rejects(
      generateUnbrandedPrompts(brand, website, industry, stats, 30, {
        scrapeForSummary: async () => siteText,
        fetchPeopleAlsoAsk: async () => { throw zoneError(); },
        fetchAutocomplete: async () => ["best tool for teams"],
        llmJson: async () => { throw new Error("gateway 502"); },
      }),
      /gateway 502/
    );
  } finally {
    warned.restore();
  }

  assert.ok(
    stats.prompt_seeding,
    "the SERP degrade must be attached before the LLM passes — a later throw must not take it down with the frame"
  );
  assert.equal(stats.prompt_seeding.state, SEED_STATE.UNAVAILABLE);
});

// ---------------------------------------------------------------------------
// serp.js: a dead zone propagates instead of flattening into an empty list
// ---------------------------------------------------------------------------

const SERP_ENV = ["SERP_PROVIDER", "SERPAPI_KEY", "BRIGHTDATA_API_KEY", "BRIGHTDATA_SERP_ZONE", "SERP_GEO"];

function useEnv(t, env) {
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

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = original; });
}

test("fetchPeopleAlsoAsk propagates a typed zone error instead of returning an empty list", async (t) => {
  // Placeholder credential value only; nothing here reaches Bright Data.
  useEnv(t, { SERP_PROVIDER: "brightdata", BRIGHTDATA_API_KEY: "bd-EXAMPLE-NOT-A-REAL-KEY" });
  invalidateBrightDataZoneCache("test setup");
  t.after(() => invalidateBrightDataZoneCache("test teardown"));

  let requestCalls = 0;
  stubFetch(t, async (url) => {
    const href = String(url);
    if (href.includes("get_all_zones")) {
      // An account with no active SERP zone -> BrightDataZoneError.
      return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
    }
    requestCalls += 1;
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  });

  const warned = captureWarnings();
  try {
    await assert.rejects(
      fetchPeopleAlsoAsk(["best crm", "best crm software", "crm tools"]),
      (err) => {
        assert.equal(err.name, "BrightDataZoneError");
        assert.equal(err.reason, "no_active_zone");
        return true;
      },
      "a dead zone must reach the caller — returning [] makes it look like Google had no PAA"
    );
  } finally {
    warned.restore();
  }

  assert.equal(requestCalls, 0, "no SERP request should have been attempted without a zone");
  assert.ok(
    warned.lines.some((l) => l.includes("PAA fetch ABORTED")),
    `the abort must be logged as well as thrown; saw: ${JSON.stringify(warned.lines)}`
  );
});

test("fetchPeopleAlsoAsk still absorbs an ordinary per-term failure", async (t) => {
  useEnv(t, { SERP_PROVIDER: "serpapi", SERPAPI_KEY: "serpapi-EXAMPLE-NOT-A-REAL-KEY" });
  stubFetch(t, async () => { throw new Error("socket hang up"); });

  const warned = captureWarnings();
  let questions;
  try {
    questions = await fetchPeopleAlsoAsk("best crm");
  } finally {
    warned.restore();
  }

  assert.deepEqual(questions, [], "a transient per-term failure stays best-effort");
  assert.ok(
    warned.lines.some((l) => l.includes("PAA fetch failed") && l.includes("Error: socket hang up")),
    `the swallowed error must be logged as an error object; saw: ${JSON.stringify(warned.lines)}`
  );
});
