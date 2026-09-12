/**
 * R2.2.12 — the prompt-seeding verdict must LEAVE THE PROCESS, and a zone fault
 * must not take the autocomplete leg down with it.
 *
 * Two findings from the R2.2.8 verifier, both reproduced on this branch before
 * these tests were written:
 *
 *   1. THE RECORD WAS IN-PROCESS ONLY. `stats.prompt_seeding` was written by
 *      src/lib/scoring/promptGen.js and read by nobody: the chunk's `stats`
 *      allowlist on the checkpoint carried only { cost, tokens, website_scrape },
 *      and runSourcingPhase turned only `website_scrape` into a
 *      CHUNK_SKIP_REASONS skip. So a prompt set grounded in 30 real Google
 *      queries and one grounded in zero, because the Bright Data zone was dead,
 *      wrote identical scan_runs rows — and the fact died at the first resume.
 *   2. THE ABORT WAS OVER-BROAD. The PAA and autocomplete legs were fetched as
 *      `Promise.all` raced against one timeout. A typed BrightDataZoneError from
 *      the PAA leg rejected the pair, which DISCARDED the autocomplete result
 *      that had already come back — and Google suggest does not route through a
 *      Bright Data zone, so that result was real. The abandon log then said "no
 *      seed term can succeed", which was strictly wrong about that leg.
 *
 * These tests drive the REAL promptGen (its SERP legs injected, never called)
 * through the REAL worker phases, so the record has to cross both files to pass.
 * Nothing here touches the network or a database.
 */
import test from "node:test";
import assert from "node:assert/strict";

/**
 * Same hermetic-import contract as scanChunkLedger.test.mjs: with
 * NEXT_PUBLIC_SUPABASE_* set (which src/lib/liveDbGate.js tells live-test
 * authors to do) db.js builds a real client and the sourcing phase's schedule
 * write would reach production. Cleared BEFORE the module graph is evaluated,
 * which is why every import below is dynamic.
 */
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const {
  runSourcingPhase,
  runProbingPhase,
  chunkRunOutcome,
  createChunkTally,
  CHUNK_SKIP_REASONS,
} = await import("./scanWorker.js");
const { generateUnbrandedPrompts, SEED_STATE } = await import("../scoring/promptGen.js");
const { BrightDataZoneError } = await import("../engines/brightdata.js");
const { supabase } = await import("../db.js");

assert.equal(
  supabase,
  null,
  "the credential clearing above did not take effect: these cases would reach a real database"
);

// ---------------------------------------------------------------------------
// promptGen inputs. The industry label yields several distinct seed terms, so
// "abandoned early" and "every term" are measurable rather than assumed.
// ---------------------------------------------------------------------------

const brand = "Acme";
const website = "https://acme.io";
const industry = "Project Management Software";
const siteText = "Manage projects with teams and software";

function makeItems(prefix, n) {
  return Array.from({ length: n }, (_, i) => ({
    text: `${prefix} query number ${i} example`,
    topic: "General",
    intent_tier: "informational",
  }));
}
const enoughPrompts = async () => makeItems("clean", 40);

function zoneError() {
  return new BrightDataZoneError("No active Bright Data SERP zone found on this account.", {
    reason: "no_active_zone",
    zone: null,
  });
}

/** Captures console.warn, serializing Errors so a typed name is assertable. */
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

/** The real promptGen, SERP + LLM injected, run quietly. Returns the record. */
async function seedWith(legs, { count = 30 } = {}) {
  const stats = {};
  const warned = captureWarnings();
  let prompts;
  try {
    prompts = await generateUnbrandedPrompts(brand, website, industry, stats, count, {
      scrapeForSummary: async () => siteText,
      llmJson: enoughPrompts,
      ...legs,
    });
  } finally {
    warned.restore();
  }
  return { record: stats.prompt_seeding, prompts, lines: warned.lines };
}

// ---------------------------------------------------------------------------
// Finding 2 — the two legs settle independently
// ---------------------------------------------------------------------------

test("a zone fault in the PAA leg KEEPS the autocomplete queries that succeeded", async () => {
  const { record, prompts } = await seedWith({
    fetchPeopleAlsoAsk: async () => { throw zoneError(); },
    // Google suggest does not route through the Bright Data zone, so this leg
    // answers. Under `Promise.all` its answer was thrown away.
    fetchAutocomplete: async () => ["best tool for teams", "project software for teams"],
  });

  assert.equal(prompts.length, 30, "seeding is grounding, not a precondition — the run completes");
  assert.equal(
    record.seed_queries,
    2,
    "the autocomplete leg returned two real Google queries; binding it to the PAA rejection " +
      "discarded them and recorded a zero that was never measured"
  );

  // The zone verdict still stands — the PAA leg really is dead.
  assert.equal(record.state, SEED_STATE.UNAVAILABLE);
  assert.equal(record.state_reason, "serp_zone_no_active_zone");

  // Per-leg accounting: one leg died, the term was not unseeded.
  assert.equal(record.legs_failed, 1, "exactly one of the two legs failed");
  assert.equal(record.legs_attempted, 2, "and both were attempted — a real denominator");
  assert.equal(record.terms_failed, 1, "the term lost a leg, so the set is grounded on less");
  assert.equal(
    record.terms_unseeded,
    0,
    "…but the term still yielded queries, so it is not an unseeded term"
  );
  assert.equal(record.failures.length, 1, "one failed leg is one recorded failure, not two");
  assert.equal(record.failures[0].leg, "paa", "the record must name WHICH leg the zone killed");
  assert.equal(record.failures[0].error, "BrightDataZoneError");
  assert.equal(record.failures[0].reason, "no_active_zone");
});

test("the abandon log says what was actually abandoned, not that nothing can succeed", async () => {
  const { lines } = await seedWith({
    fetchPeopleAlsoAsk: async () => { throw zoneError(); },
    fetchAutocomplete: async () => ["best tool for teams"],
  });

  const abandon = lines.find((l) => l.includes("ABANDONING PAA seeding"));
  assert.ok(abandon, `the abandoned leg must still say so; saw: ${JSON.stringify(lines)}`);
  assert.ok(
    !abandon.includes("no seed term can succeed"),
    `this claim is false about the autocomplete leg, which answered; saw: ${abandon}`
  );
  assert.match(
    abandon,
    /paa leg cannot succeed for any term/,
    "the dead leg must be named, since only one of the two is dead"
  );
  assert.match(abandon, /KEPT: 1 query from this term's surviving autocomplete leg/);
  assert.match(
    abandon,
    /ABANDONED: the remaining \d+ seed term\(s\), BOTH legs/,
    "the abort is still over-broad by choice, so the log has to own that"
  );
  assert.match(
    abandon,
    /does NOT route through the Bright Data zone/,
    "…and say why abandoning the autocomplete leg of those terms costs something real"
  );
});

test("every term losing ONLY its PAA leg is DEGRADED — not unavailable, which would disown real queries", async () => {
  const { record } = await seedWith({
    // A plain error, so the loop does not abort: every term loses PAA.
    fetchPeopleAlsoAsk: async () => { throw new Error("serp 503"); },
    fetchAutocomplete: async (term) => [`best ${term} for teams`],
  });

  assert.ok(record.terms_attempted >= 2, "the case must actually reach several seed terms");
  assert.equal(record.terms_failed, record.terms_attempted, "every term lost a leg");
  assert.equal(record.terms_unseeded, 0, "…and no term came back empty");
  assert.ok(record.seed_queries > 0, "the autocomplete legs produced real queries");
  assert.equal(
    record.state,
    SEED_STATE.DEGRADED,
    "UNAVAILABLE here would state that the leg could not run while holding its results"
  );
  assert.equal(
    record.state_reason,
    "every_seed_term_lost_a_leg",
    '"some_seed_terms_failed" understates a set where every term was hit'
  );
  assert.equal(record.legs_failed, record.terms_attempted);
  assert.equal(record.legs_attempted, record.terms_attempted * 2);
});

test("BOTH legs dying is still all_seed_terms_failed — the unavailable verdict is not weakened", async () => {
  const { record } = await seedWith({
    fetchPeopleAlsoAsk: async () => { throw new Error("serp 503"); },
    fetchAutocomplete: async () => { throw new Error("serp 503"); },
  });

  assert.ok(record.terms_attempted >= 2);
  assert.equal(record.terms_unseeded, record.terms_attempted, "no term yielded anything");
  assert.equal(record.state, SEED_STATE.UNAVAILABLE);
  assert.equal(record.state_reason, "all_seed_terms_failed");
  assert.equal(record.seed_queries, 0, "and this zero IS measured");
  assert.equal(record.legs_failed, record.terms_attempted * 2, "both legs of every term");
});

// ---------------------------------------------------------------------------
// Finding 1 — the verdict reaches the scan_runs row and the checkpoint
// ---------------------------------------------------------------------------

/** A hermetic in-memory scan_jobs table: enough for sourcing + probing. */
function makeBackend() {
  const jobs = new Map();
  const promptResults = [];
  return {
    jobs,
    promptResults,
    seed: (job) => jobs.set(job.id, { brand, url: "acme.io", industry, competitors: "", ...job }),
    deps: {
      // scanWorker's test-only injection: without it the attempt policy falls
      // through to db.js's shared client and a real RPC.
      client: null,
      getScanJob: async (id) => jobs.get(id) || null,
      updateScanJob: async (id, updates) => {
        const job = jobs.get(id) || { id };
        Object.assign(job, updates);
        jobs.set(id, job);
        return job;
      },
      getCompletedPairsForJob: async () => new Set(),
      upsertPromptResults: async (rows) => {
        rows.forEach((r) => promptResults.push(r));
        return rows;
      },
      setIntervalFn: () => null,
      clearIntervalFn: () => {},
    },
  };
}

/**
 * Sourcing deps whose generation step is the REAL promptGen with its SERP legs
 * injected. sourceUnbrandedQueries calls `generate(brand, url, industry, stats,
 * shortfall)` with no deps argument, so the injection has to happen in this
 * wrapper — which is also what makes this an end-to-end test of the two files:
 * promptGen writes the record, the worker has to read it.
 */
function sourcingDepsWithRealPromptGen(legs, { target = 4 } = {}) {
  return {
    promptTarget: target,
    getPromptsForBrand: async () => [],
    upsertPrompts: async (key, rows) => rows,
    buildBrandedQueries: () => [],
    resolveEnabledEngines: () => [{ name: "aio" }],
    generateUnbrandedPrompts: (b, u, i, stats, shortfall) =>
      generateUnbrandedPrompts(b, u, i, stats, shortfall, {
        scrapeForSummary: async () => siteText,
        llmJson: enoughPrompts,
        ...legs,
      }),
  };
}

async function sourceQuietly(deps) {
  const tally = createChunkTally();
  const warned = captureWarnings();
  try {
    const checkpoint = await runSourcingPhase(
      { brand, url: "acme.io", industry, competitors: "" },
      deps,
      tally
    );
    return { checkpoint, tally, lines: warned.lines };
  } finally {
    warned.restore();
  }
}

const ZONE_DEAD_LEGS = {
  fetchPeopleAlsoAsk: async () => { throw zoneError(); },
  fetchAutocomplete: async () => ["best tool for teams"],
};

test("runSourcingPhase — the seeding verdict is RECORDED as a skip, not left in the process", async () => {
  const { tally, lines } = await sourceQuietly(sourcingDepsWithRealPromptGen(ZONE_DEAD_LEGS));

  const skip = tally.skips.find((s) => s.reason === CHUNK_SKIP_REASONS.PROMPT_SEEDING_DEGRADED);
  assert.ok(
    skip,
    `the seeding verdict reached no skip; got ${JSON.stringify(tally.skips)}. A console line is ` +
      `not a record: promptGen wrote stats.prompt_seeding and nothing read it.`
  );
  assert.equal(skip.count, 1);
  assert.match(skip.sample[0], /unavailable:serp_zone_no_active_zone/, "the row carries state AND reason");
  assert.match(
    skip.sample[0],
    /queries=1\b/,
    `the row carries the surviving autocomplete query count; got ${JSON.stringify(skip.sample)}`
  );
  assert.match(skip.sample[0], /terms=1\/1/, "…and how many seed terms actually yielded something");
  assert.ok(
    lines.some((l) => l.includes("PAA/autocomplete seeding is unavailable") && l.includes("[scan-chunk]")),
    `the worker must say it too, naming the reason it filed; saw: ${JSON.stringify(lines)}`
  );
});

test("chunkRunOutcome — the seeding skip lands on the CLOSED row's detail.skips", async () => {
  const { tally } = await sourceQuietly(sourcingDepsWithRealPromptGen(ZONE_DEAD_LEGS));
  const closed = chunkRunOutcome({ ok: true, reason: "complete" }, tally);

  const entry = (closed.detail.skips || []).find(
    (s) => s.reason === CHUNK_SKIP_REASONS.PROMPT_SEEDING_DEGRADED
  );
  assert.ok(
    entry,
    `the skip did not survive into the row payload close_scan_run writes; got ` +
      `${JSON.stringify(closed.detail.skips)}`
  );
  assert.equal(entry.count, 1);
  assert.ok(closed.detail.skips_total >= 1);
});

test("runSourcingPhase — a MEASURED-ZERO seeding run is recorded and reads as a measured zero", async () => {
  // Every fetch succeeds and Google genuinely has nothing. state is `ok`, so a
  // bare `state !== OK` reader would file nothing at all and the ungrounded set
  // would look seeded — but the sample must still say `ok:` so this is never
  // confused with a failure.
  const { tally } = await sourceQuietly(
    sourcingDepsWithRealPromptGen({
      fetchPeopleAlsoAsk: async () => [],
      fetchAutocomplete: async () => [],
    })
  );

  const skip = tally.skips.find((s) => s.reason === CHUNK_SKIP_REASONS.PROMPT_SEEDING_DEGRADED);
  assert.ok(skip, "zero real Google queries is not a grounded prompt set, whatever the state");
  assert.match(
    skip.sample[0],
    /^ok:no_seed_queries_returned queries=0/,
    `a measured zero must not be written down as a failure; got ${JSON.stringify(skip.sample)}`
  );
});

test("runSourcingPhase — a HEALTHY seeded run records nothing, so the reason still means something", async () => {
  const { tally } = await sourceQuietly(
    sourcingDepsWithRealPromptGen({
      fetchPeopleAlsoAsk: async () => ["how do teams pick a tool"],
      fetchAutocomplete: async () => ["best tool for teams"],
    })
  );

  assert.equal(
    tally.skips.find((s) => s.reason === CHUNK_SKIP_REASONS.PROMPT_SEEDING_DEGRADED),
    undefined,
    "a reason recorded on every scan is a reason nobody reads"
  );
});

test("runSourcingPhase — a chunk that never generated is NOT reported as a seeding degrade", async () => {
  // The reuse path in sourceUnbrandedQueries returns a full tracked pool without
  // calling generation, so `stats.prompt_seeding` is absent. Filing a degrade
  // there would assert a measurement nobody took — the same lie pointing the
  // other way (standing rule 1).
  const pool = Array.from({ length: 4 }, (_, i) => ({
    text: `tracked query number ${i}`,
    topic: "General",
    intent_tier: "informational",
    source: "llm_generated",
    weight: 1,
    enabled: true,
  }));
  const { tally } = await sourceQuietly({
    promptTarget: pool.length,
    getPromptsForBrand: async () => pool,
    upsertPrompts: async (k, rows) => rows,
    buildBrandedQueries: () => [],
    resolveEnabledEngines: () => [{ name: "aio" }],
    generateUnbrandedPrompts: async () => {
      throw new Error("generation must not be reached on the reuse path");
    },
  });

  assert.equal(
    tally.skips.find((s) => s.reason === CHUNK_SKIP_REASONS.PROMPT_SEEDING_DEGRADED),
    undefined,
    "no seeding was attempted; claiming it degraded would invent a measurement"
  );
});

// ---------------------------------------------------------------------------
// The resume boundary — the only boundary that matters
// ---------------------------------------------------------------------------

test("the seeding record survives a checkpoint round-trip: sourcing freezes it, probing keeps it", async () => {
  const { checkpoint } = await sourceQuietly(sourcingDepsWithRealPromptGen(ZONE_DEAD_LEGS));

  assert.ok(
    checkpoint.stats.prompt_seeding,
    "the checkpoint's `stats` is an ALLOWLIST: a field nobody adds dies with the chunk"
  );
  assert.equal(checkpoint.stats.prompt_seeding.state, SEED_STATE.UNAVAILABLE);
  assert.equal(checkpoint.stats.prompt_seeding.state_reason, "serp_zone_no_active_zone");
  assert.equal(checkpoint.stats.prompt_seeding.seed_queries, 1);
  assert.equal(checkpoint.stats.cost, 0, "and cost/tokens are unchanged alongside it");

  // scan_jobs.checkpoint is jsonb: a resume reads back what JSON can carry.
  const persisted = JSON.parse(JSON.stringify(checkpoint));
  assert.deepEqual(
    persisted.stats.prompt_seeding,
    checkpoint.stats.prompt_seeding,
    "nothing in the record may be unserializable — a resume reads jsonb, not this object"
  );

  // …and the per-batch checkpoint rebuild inside probing must not erase it. That
  // rebuild was a fresh { cost, tokens } literal once, which is exactly how
  // website_scrape used to die at the first persisted batch.
  const backend = makeBackend();
  const jobId = "2212a2b2-2212-4212-8212-221222122212";
  backend.seed({ id: jobId, status: "probing" });

  const warned = captureWarnings();
  let outcome;
  try {
    outcome = await runProbingPhase(
      jobId,
      persisted,
      {
        ...backend.deps,
        resolveEnabledEngines: () => [
          {
            name: "aio",
            concurrency: 2,
            probe: async (q) => ({
              engine: "aio",
              prompt: q.text,
              is_branded_query: false,
              topic: "General",
              source: "test",
              intent_tier: "informational",
              answer_present: true,
              aio_present: true,
              text: `An answer about ${q.text}`,
              citations: [],
              references: [],
              brand_mentioned_in_text: false,
              brand_cited: false,
              visible: false,
              competitors_found_in_text: [],
              competitors_cited: [],
              brands: [],
              error: null,
              cost: 0,
            }),
          },
        ],
      },
      Date.now(),
      createChunkTally()
    );
  } finally {
    warned.restore();
  }

  assert.deepEqual(
    outcome.checkpoint.stats.prompt_seeding,
    persisted.stats.prompt_seeding,
    "probing's per-batch checkpoint rebuild dropped the seeding record"
  );
  assert.deepEqual(
    backend.jobs.get(jobId).checkpoint.stats.prompt_seeding,
    persisted.stats.prompt_seeding,
    "and the checkpoint actually PERSISTED to scan_jobs keeps it, which is what a resume reads"
  );
});

// ---------------------------------------------------------------------------
// GUARD — every checkpoint `stats` allowlist carries the record
//
// The two literals are ~200 lines apart in scanWorker.js and the second one
// exists only to re-state the first. Adding a field to one and not the other is
// how website_scrape died at the first persisted batch before R3.7.2, and a
// future third allowlist would reintroduce the same hole silently.
// ---------------------------------------------------------------------------

test("GUARD — every checkpoint stats allowlist in scanWorker.js carries prompt_seeding", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./scanWorker.js", import.meta.url), "utf8");

  // The corpus: every object literal assigned to a `stats:` key that carries the
  // two fields definitionally present in a checkpoint stats allowlist. Keyed on
  // `cost:`/`tokens:` rather than on the sibling `website_scrape`, because that
  // name also appears in the COMMENTS inside these blocks and a corpus filter
  // that a comment can satisfy is not a filter. No nested braces appear here.
  const allowlists = [...src.matchAll(/stats:\s*\{[^{}]*\}/g)]
    .map((m) => m[0])
    .filter((block) => /\bcost:/.test(block) && /\btokens:/.test(block));

  // VACUITY GUARD. If the pattern stops matching — a rename, a reformat, a
  // removal — this test would otherwise pass by enumerating nothing at all,
  // which is the empty-state-as-clean-state failure it exists to catch.
  assert.ok(
    allowlists.length >= 2,
    `expected at least 2 checkpoint stats allowlists to guard, found ${allowlists.length}. ` +
      `An empty corpus is not a pass: the pattern this guard enumerates no longer matches ` +
      `the code it guards, so nothing was checked.`
  );

  allowlists.forEach((block, i) => {
    assert.match(
      block,
      /prompt_seeding/,
      `checkpoint stats allowlist #${i + 1} carries website_scrape but not prompt_seeding, so the ` +
        `seeding verdict dies at this resume boundary:\n${block}`
    );
  });
});
