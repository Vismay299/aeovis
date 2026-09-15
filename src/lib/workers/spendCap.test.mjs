import test from "node:test";
import assert from "node:assert/strict";
import { runProbingPhase, CHUNK_SKIP_REASONS } from "./scanWorker.js";

/**
 * R3.6.2 — Per-scan and per-day spend caps enforced from the ledger.
 *
 * The scan path had no cap at all: a scan could burn unbounded vendor budget
 * across its probes. These tests drive both caps and assert that:
 *   1. Per-scan: exceeding SCAN_MAX_COST_PER_SCAN skips remaining pairs and
 *      records the reason on the tally.
 *   2. Per-day: exceeding SCAN_MAX_COST_PER_DAY skips remaining pairs and
 *      records the reason on the tally.
 *   3. Neither cap halts when unset or when spend is below the cap.
 *
 * NO DATABASE IS TOUCHED. Every dep is injected; the probe stubs return
 * canned results with explicit cost values.
 */

const SIX_QUERIES = [
  { text: "best crm for small teams", is_branded: false },
  { text: "crm pricing comparison", is_branded: false },
  { text: "how to migrate crm data", is_branded: false },
  { text: "crm with good support", is_branded: false },
  { text: "top crm integrations", is_branded: false },
  { text: "best crm for onboarding", is_branded: false },
];

function probeResult(engineName, query, visible) {
  return {
    engine: engineName,
    prompt: query.text,
    is_branded_query: false,
    topic: "General",
    source: "llm_generated",
    intent_tier: "commercial",
    answer_present: true,
    text: visible
      ? "Acme is a solid pick, though Rival One is popular too."
      : "Rival One and Rival Two lead this category.",
    citations: [],
    references: [],
    brand_mentioned_in_text: visible,
    brand_cited: false,
    visible,
    competitors_found_in_text: [],
    competitors_cited: [],
    brands: [{ name: "Acme", is_self: true, mentioned: visible }],
    error: null,
    cost: 0.001,
  };
}

function fakeEngine(name) {
  return {
    name,
    concurrency: 2,
    isConfigured: () => true,
    // The engine's probe function receives stats and must accumulate cost
    // into it, just like real engines (openai.js, perplexity.js) do.
    probe: async (query, _brand, _brandAliases, _brandDomain, _competitors, stats) => {
      const cost = 0.001;
      if (stats) stats.cost = (stats.cost || 0) + cost;
      return probeResult(name, query, query.text.includes("best"));
    },
  };
}

function makeBackend() {
  const rows = [];
  const jobs = new Map();
  let seq = 0;

  const deps = {
    updateScanJob: async (id, patch) => {
      const j = jobs.get(id) || { id };
      Object.assign(j, patch);
      jobs.set(id, j);
      return j;
    },
    getCompletedPairsForJob: async () =>
      new Set(rows.map((r) => `${r.engine}|${r.query}`)),
    upsertPromptResults: async (newRows) => {
      newRows.forEach((r) => rows.push({ id: `r${seq++}`, scan_id: null, ...r }));
      return newRows;
    },
    claimJobStatus: async () => true,
    claimJob: async () => true,
    getScanJob: async (id) => jobs.get(id) || null,
  };

  return { deps, jobs, rows };
}

function makeCheckpoint(overrides = {}) {
  return {
    brand: "Acme",
    url: "https://acme.com",
    industry: "SaaS",
    competitors: [],
    competitors_raw: "",
    prompt_key: "default",
    prompt_source: "llm_generated",
    static_pack_prompts: false,
    queries: SIX_QUERIES,
    unbranded_texts: SIX_QUERIES.map((q) => q.text.toLowerCase().trim()),
    engines: ["chatgpt"],
    geo: "us",
    stats: { cost: 0, tokens: 0 },
    engine_set_change: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Per-scan cap
// ---------------------------------------------------------------------------

test("R3.6.2 — per-scan spend cap halts new spend and records the skip reason", async () => {
  const backend = makeBackend();
  const tally = {};
  const jobId = "job-spend-scan";

  const orig = process.env.SCAN_MAX_COST_PER_SCAN;
  // Each probe costs 0.001, concurrency is 2, so after ~2 probes (0.002)
  // the cap of 0.003 is still under but after the batch it exceeds.
  process.env.SCAN_MAX_COST_PER_SCAN = "0.003";

  try {
    const checkpoint = makeCheckpoint();
    await backend.deps.updateScanJob(jobId, { status: "probing", checkpoint });

    await runProbingPhase(jobId, checkpoint, {
      ...backend.deps,
      resolveEnabledEngines: () => [fakeEngine("chatgpt")],
    }, Date.now(), tally);

    const skips = Array.isArray(tally.skips) ? tally.skips : [];
    const spendCapSkip = skips.find((s) => s.reason === CHUNK_SKIP_REASONS.SPEND_CAP_PER_SCAN);
    assert.ok(spendCapSkip, `tally must record a spend_cap_per_scan skip; skips=${JSON.stringify(skips)}`);
    assert.ok(spendCapSkip.count > 0, "skip must have a positive count");
  } finally {
    if (orig === undefined) delete process.env.SCAN_MAX_COST_PER_SCAN;
    else process.env.SCAN_MAX_COST_PER_SCAN = orig;
  }
});

test("R3.6.2 — per-scan cap of 0 halts all spend immediately", async () => {
  const backend = makeBackend();
  const tally = {};
  const jobId = "job-spend-zero";

  const orig = process.env.SCAN_MAX_COST_PER_SCAN;
  process.env.SCAN_MAX_COST_PER_SCAN = "0";

  try {
    const checkpoint = makeCheckpoint();
    await backend.deps.updateScanJob(jobId, { status: "probing", checkpoint });

    await runProbingPhase(jobId, checkpoint, {
      ...backend.deps,
      resolveEnabledEngines: () => [fakeEngine("chatgpt")],
    }, Date.now(), tally);

    const skips = Array.isArray(tally.skips) ? tally.skips : [];
    const spendCapSkip = skips.find((s) => s.reason === CHUNK_SKIP_REASONS.SPEND_CAP_PER_SCAN);
    assert.ok(spendCapSkip, "a cap of 0 must halt all spend immediately");
  } finally {
    if (orig === undefined) delete process.env.SCAN_MAX_COST_PER_SCAN;
    else process.env.SCAN_MAX_COST_PER_SCAN = orig;
  }
});

test("R3.6.2 — per-scan cap unset means no cap (all pairs probed)", async () => {
  const backend = makeBackend();
  const tally = {};
  const jobId = "job-spend-nocap";

  const orig = process.env.SCAN_MAX_COST_PER_SCAN;
  delete process.env.SCAN_MAX_COST_PER_SCAN;

  try {
    const checkpoint = makeCheckpoint();
    await backend.deps.updateScanJob(jobId, { status: "probing", checkpoint });

    await runProbingPhase(jobId, checkpoint, {
      ...backend.deps,
      resolveEnabledEngines: () => [fakeEngine("chatgpt")],
    }, Date.now(), tally);

    const skips = Array.isArray(tally.skips) ? tally.skips : [];
    const spendCapSkip = skips.find((s) => s.reason === CHUNK_SKIP_REASONS.SPEND_CAP_PER_SCAN);
    assert.ok(!spendCapSkip, "no spend cap skip should be recorded when cap is unset");
  } finally {
    if (orig === undefined) delete process.env.SCAN_MAX_COST_PER_SCAN;
    else process.env.SCAN_MAX_COST_PER_SCAN = orig;
  }
});

// ---------------------------------------------------------------------------
// Per-day cap
// ---------------------------------------------------------------------------

test("R3.6.2 — per-day spend cap halts new spend and records the skip reason", async () => {
  const backend = makeBackend();
  // Fake daily spend query returns spend already over cap
  backend.deps.queryScanCostToday = async () => 0.05;

  const tally = {};
  const jobId = "job-spend-day";

  const orig = process.env.SCAN_MAX_COST_PER_DAY;
  process.env.SCAN_MAX_COST_PER_DAY = "0.01";

  try {
    const checkpoint = makeCheckpoint();
    await backend.deps.updateScanJob(jobId, { status: "probing", checkpoint });

    await runProbingPhase(jobId, checkpoint, {
      ...backend.deps,
      resolveEnabledEngines: () => [fakeEngine("chatgpt")],
    }, Date.now(), tally);

    const skips = Array.isArray(tally.skips) ? tally.skips : [];
    const dailyCapSkip = skips.find((s) => s.reason === CHUNK_SKIP_REASONS.SPEND_CAP_PER_DAY);
    assert.ok(dailyCapSkip, "tally must record a spend_cap_per_day skip");
    assert.ok(dailyCapSkip.count > 0, "skip must have a positive count");
  } finally {
    if (orig === undefined) delete process.env.SCAN_MAX_COST_PER_DAY;
    else process.env.SCAN_MAX_COST_PER_DAY = orig;
  }
});

test("R3.6.2 — per-day cap unset means no daily cap", async () => {
  const backend = makeBackend();
  backend.deps.queryScanCostToday = async () => 999;

  const tally = {};
  const jobId = "job-spend-day-nocap";

  const orig = process.env.SCAN_MAX_COST_PER_DAY;
  delete process.env.SCAN_MAX_COST_PER_DAY;

  try {
    const checkpoint = makeCheckpoint();
    await backend.deps.updateScanJob(jobId, { status: "probing", checkpoint });

    await runProbingPhase(jobId, checkpoint, {
      ...backend.deps,
      resolveEnabledEngines: () => [fakeEngine("chatgpt")],
    }, Date.now(), tally);

    const skips = Array.isArray(tally.skips) ? tally.skips : [];
    const dailyCapSkip = skips.find((s) => s.reason === CHUNK_SKIP_REASONS.SPEND_CAP_PER_DAY);
    assert.ok(!dailyCapSkip, "no daily cap skip should be recorded when cap is unset");
  } finally {
    if (orig === undefined) delete process.env.SCAN_MAX_COST_PER_DAY;
    else process.env.SCAN_MAX_COST_PER_DAY = orig;
  }
});
