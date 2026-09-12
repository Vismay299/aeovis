import test from "node:test";
import assert from "node:assert/strict";
import {
  runScanChunk,
  runSourcingPhase,
  runProbingPhase,
  runFinalizePhase,
  runSchedulerTick,
  summarizeEngineSlice,
  buildMetricsRows,
  unionPromptCounts,
  toDateOnly,
  computeNextRunAt,
  shouldRescueJob,
  resolveSelfContinueUrl,
  domainMatches,
  unionCompetitorNames,
  CHUNK_TIME_BUDGET_MS,
} from "./scanWorker.js";
import { computeHeadline, summarizeEngineResults, buildTrackedBrandRoster } from "../scoring/enginePipeline.js";
import { summarizeAioResults } from "../scoring/aioPipeline.js";
import { judgeBrandsSymmetric } from "../scoring/judge.js";
import { getBrandAliases } from "../scoring/aliases.js";
import { HEARTBEAT_STALE_MS } from "../db.js";

/**
 * P0.2 coverage: the resumable checkpointed chunk worker. Every deps-taking
 * export is exercised through fully in-memory fakes (never a real Supabase
 * client, never a real probe/LLM network call) — this file's `makeFakeBackend`
 * mirrors db.js/db/analytics.js's contracts closely enough to exercise the
 * real orchestration logic in scanWorker.js deterministically and fast.
 */

// ---------------------------------------------------------------------------
// Fake backend + fixtures
// ---------------------------------------------------------------------------

function makeFakeBackend() {
  const jobs = new Map();
  const promptResults = [];
  const citations = [];
  const resultBrands = [];
  const scans = [];
  const brandMetrics = [];
  const scanRuns = [];
  const schedules = new Map();
  const calls = { updateScanJob: [], insertScan: [], selfContinue: [], claimJobStatus: [] };
  let idCounter = 0;
  const nextId = (prefix) => `${prefix}-${idCounter++}`;

  const deps = {
    getScanJob: async (jobId) => jobs.get(jobId) || null,
    updateScanJob: async (jobId, updates) => {
      const job = jobs.get(jobId) || { id: jobId };
      Object.assign(job, updates, { heartbeat_at: new Date().toISOString() });
      jobs.set(jobId, job);
      calls.updateScanJob.push({ jobId, updates });
      return job;
    },
    // Mirrors db.js's real claimJobStatus: a compare-and-set that only
    // succeeds while the job's CURRENT status is still in `fromStatus`.
    // Missing-job auto-vivify mirrors updateScanJob's own memory-mode
    // convenience (used throughout this file by tests that call
    // runFinalizePhase directly without first seeding a scan_jobs row) —
    // there's nothing concurrent to lose a race to when the job doesn't
    // exist yet. When the job DOES exist, this is a synchronous check-then-
    // mutate with no internal await, so two calls racing via Promise.all
    // resolve deterministically: whichever call's continuation reaches this
    // function first wins, atomically, before the other can even inspect
    // the row (see the concurrent-finalize test below).
    claimJobStatus: async (jobId, fromStatus, toStatus) => {
      const list = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
      calls.claimJobStatus.push({ jobId, fromStatus, toStatus });
      const job = jobs.get(jobId);
      if (job) {
        if (!list.includes(job.status)) return null;
        Object.assign(job, { status: toStatus, heartbeat_at: new Date().toISOString() });
        return job;
      }
      const created = { id: jobId, status: toStatus, heartbeat_at: new Date().toISOString() };
      jobs.set(jobId, created);
      return created;
    },
    createScanJob: async ({ brand, url, industry, competitors }) => {
      const id = nextId("job");
      const job = {
        id,
        brand,
        url,
        industry: industry || "",
        competitors: competitors || "",
        status: "pending",
        progress_pct: 0,
        checkpoint: null,
        created_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        result_id: null,
        error_message: null,
        run_record: null,
      };
      jobs.set(id, job);
      return job;
    },
    hasActiveScanForBrand: async () => false,

    upsertPromptResults: async (rows) => {
      const out = [];
      for (const row of rows) {
        const existing = promptResults.find(
          (r) => r.job_id === row.job_id && r.engine === row.engine && r.query === row.query
        );
        if (existing) {
          Object.assign(existing, row);
          out.push(existing);
        } else {
          const record = { id: nextId("pr"), scan_id: null, created_at: new Date().toISOString(), ...row };
          promptResults.push(record);
          out.push(record);
        }
      }
      return out;
    },
    insertCitations: async (rows) => rows.map((row) => {
      const record = { id: nextId("cit"), ...row };
      citations.push(record);
      return record;
    }),
    // P3a default: a deterministic no-network stand-in for the real
    // src/lib/analytics/citationEnrich.js (which itself defaults to a real
    // llmJson call when heuristics can't resolve a row). Every test in this
    // file that doesn't care about enrichment gets this for free via
    // `...backend.deps`, keeping the whole suite hermetic (no real
    // Supabase/probe/LLM network call — see the file header). Tests that DO
    // care about enrichment override `enrichCitations` (or `llmJson`)
    // per-call — see the "P3a citation enrichment wiring" tests below.
    enrichCitations: async (rows) => rows.map((row) => ({ ...row, content_type: null, domain_type: null, citation_class: null })),
    deleteCitationsForJob: async (jobId) => {
      let deleted = 0;
      for (let i = citations.length - 1; i >= 0; i--) {
        if (citations[i].job_id === jobId) {
          citations.splice(i, 1);
          deleted++;
        }
      }
      return deleted;
    },
    insertResultBrands: async (rows) => rows.map((row) => {
      const record = { id: nextId("rb"), ...row };
      resultBrands.push(record);
      return record;
    }),
    // Mirrors the real deleteResultBrandsForJob's job_id -> result_id join
    // (result_brands has no job_id column of its own): delete rows whose
    // result_id belongs to one of this job's prompt_results rows.
    deleteResultBrandsForJob: async (jobId) => {
      const resultIds = new Set(promptResults.filter((r) => r.job_id === jobId).map((r) => r.id));
      let deleted = 0;
      for (let i = resultBrands.length - 1; i >= 0; i--) {
        if (resultIds.has(resultBrands[i].result_id)) {
          resultBrands.splice(i, 1);
          deleted++;
        }
      }
      return deleted;
    },
    getCompletedPairsForJob: async (jobId) => {
      const set = new Set();
      promptResults.filter((r) => r.job_id === jobId).forEach((r) => set.add(`${r.engine}|${r.query}`));
      return set;
    },
    getPromptResultsForJob: async (jobId) =>
      promptResults
        .filter((r) => r.job_id === jobId)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    stampScanIdForJob: async (jobId, scanId) => {
      let n = 0;
      promptResults.forEach((r) => {
        if (r.job_id === jobId && r.scan_id == null) {
          r.scan_id = scanId;
          n++;
        }
      });
      return { promptResults: n, citations: 0 };
    },
    insertScan: async (record) => {
      calls.insertScan.push(record);
      const id = nextId("scan");
      scans.push({ id, ...record });
      return [{ id }];
    },
    upsertBrandMetricsDaily: async (rows) => {
      rows.forEach((row) => brandMetrics.push(row));
      return rows;
    },
    listDueSchedules: async () => Array.from(schedules.values()),
    upsertScanSchedule: async (brand, updates) => {
      const existing = schedules.get(brand) || { brand };
      const merged = { ...existing, ...updates };
      schedules.set(brand, merged);
      return merged;
    },

    selfContinue: (jobId) => {
      calls.selfContinue.push(jobId);
    },

    // R3.2.4 — the scan_runs ledger, faked in memory like everything else here.
    // Without these three, `resolveChunkLedger` falls back to db.js's shared
    // client and every `runScanChunk` in this file called the REAL
    // `open_scan_run()` RPC against whatever database the shell happened to be
    // pointing at. It wrote nothing only because `NEXT_PUBLIC_SUPABASE_*` is
    // normally unset; with `--env-file=.env.local` (which src/lib/liveDbGate.js
    // tells authors to use) those eight calls went to production. The file's
    // own header promises "never a real Supabase client" — these keep that
    // promise instead of relying on the ambient environment to keep it.
    openScanRun: async (fields) => {
      const row = { id: nextId("run"), ...fields, beats: 0, closed: null };
      scanRuns.push(row);
      return { ...row, open: true };
    },
    heartbeatScanRun: async ({ runId }) => {
      const row = scanRuns.find((r) => r.id === runId);
      if (!row) throw new Error(`heartbeatScanRun: no run ${runId}`);
      row.beats++;
      return { runId, heartbeatAt: new Date().toISOString() };
    },
    closeScanRun: async ({ runId, ...fields }) => {
      const row = scanRuns.find((r) => r.id === runId);
      if (!row) throw new Error(`closeScanRun: no run ${runId}`);
      row.closed = fields;
      return { ...row, ...fields, id: runId, open: false, endedAt: new Date().toISOString() };
    },
  };

  return { jobs, promptResults, citations, resultBrands, scans, brandMetrics, schedules, scanRuns, calls, deps };
}

function makeQueries(n) {
  return Array.from({ length: n }, (_, i) => ({
    text: `query ${i}`,
    source: "llm_generated",
    topic: "General",
    intent_tier: "informational",
  }));
}

function makeCheckpoint({ queries, engines = ["aio"], brand = "Acme", url = "acme.com", competitors = [] }) {
  return {
    brand,
    url,
    industry: "saas",
    competitors,
    competitors_raw: competitors.join(", "),
    prompt_key: "acme.com",
    queries,
    unbranded_texts: queries.map((q) => q.text.toLowerCase().trim()),
    engines,
    stats: { cost: 0, tokens: 0 },
    sourced_at: new Date().toISOString(),
  };
}

function makeProbeResult({ engine, query, visible = false, mentioned = null, cited = false, references = [], error = null, brands = [], text }) {
  return {
    engine,
    prompt: query.text,
    is_branded_query: !!query.is_branded_query,
    topic: query.topic || "General",
    source: query.source || "test",
    intent_tier: query.intent_tier || "informational",
    answer_present: !error,
    aio_present: !error,
    // `text` lets a test control exactly what the (re-)judging pipeline sees
    // (P1.2 full-roster fix — finalize now judges from this text fresh, not
    // from `brands` below); defaults to a generic placeholder for the many
    // tests that don't care about real brand mentions in the answer.
    text: error ? "" : text !== undefined ? text : `Answer about ${query.text}`,
    citations: [],
    references,
    brand_mentioned_in_text: mentioned == null ? visible : mentioned,
    brand_cited: cited,
    visible,
    competitors_found_in_text: [],
    competitors_cited: [],
    // P1.1 probe-time roster (self + USER-supplied competitors only —
    // enginePipeline.js's judgeBrandsSymmetric would attach this at probe
    // time). Still consumed by runProbingPhase (self position/sentiment ->
    // prompt_results, unchanged by the P1.2 full-roster fix). NO LONGER read
    // by runFinalizePhase's result_brands materialization, which now
    // re-judges `text` above fresh against the finalize-time full roster —
    // see the "P1.2 symmetric per-brand judging" tests below.
    brands,
    error,
    cost: error ? 0 : 0.001,
  };
}

function seedPromptResultRow(backend, { jobId, brand = "acme.com", raw, scanId = null }) {
  backend.promptResults.push({
    id: `${raw.engine}-${raw.prompt}-${Math.random().toString(36).slice(2)}`,
    job_id: jobId,
    brand,
    query: raw.prompt,
    engine: raw.engine,
    answered: raw.answer_present,
    mentioned: raw.brand_mentioned_in_text,
    brand_cited: raw.brand_cited,
    is_branded_query: raw.is_branded_query,
    scan_id: scanId,
    created_at: new Date().toISOString(),
    raw,
  });
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

test("domainMatches — exact match and subdomain suffix match", () => {
  assert.equal(domainMatches("acme.com", "acme.com"), true);
  assert.equal(domainMatches("blog.acme.com", "acme.com"), true);
  assert.equal(domainMatches("notacme.com", "acme.com"), false);
  assert.equal(domainMatches("", "acme.com"), false);
});

test("CHUNK_TIME_BUDGET_MS stays under HEARTBEAT_STALE_MS (constraint 1)", () => {
  assert.ok(CHUNK_TIME_BUDGET_MS < HEARTBEAT_STALE_MS, "chunk budget must leave heartbeat headroom");
});

test("toDateOnly — buckets by IST calendar day, matching scripts/backfill-analytics.mjs", () => {
  // 2026-07-23T19:00:00Z + 5:30 IST offset = 2026-07-24T00:30 IST -> next day.
  assert.equal(toDateOnly("2026-07-23T19:00:00.000Z"), "2026-07-24");
  assert.equal(toDateOnly("2026-07-23T10:00:00.000Z"), "2026-07-23");
  assert.equal(toDateOnly("not-a-date"), null);
});

test("computeNextRunAt — 72h/daily/weekly offsets; unknown cadence defaults to 72h", () => {
  const from = "2026-07-24T00:00:00.000Z";
  const fromMs = new Date(from).getTime();
  assert.equal(computeNextRunAt("72h", from), new Date(fromMs + 72 * 3600 * 1000).toISOString());
  assert.equal(computeNextRunAt("daily", from), new Date(fromMs + 24 * 3600 * 1000).toISOString());
  assert.equal(computeNextRunAt("weekly", from), new Date(fromMs + 7 * 24 * 3600 * 1000).toISOString());
  assert.equal(computeNextRunAt("bogus", from), computeNextRunAt("72h", from));
});

test("shouldRescueJob — rescues only running-status jobs with a stale/absent heartbeat; never complete/failed", () => {
  const now = Date.now();
  const fresh = new Date(now - 1000).toISOString();
  const stale = new Date(now - 4 * 60 * 1000).toISOString();

  assert.equal(shouldRescueJob({ status: "probing", heartbeat_at: fresh }, now), false, "fresh heartbeat => not rescued");
  assert.equal(shouldRescueJob({ status: "probing", heartbeat_at: stale }, now), true, "stale heartbeat => rescued");
  assert.equal(shouldRescueJob({ status: "pending", heartbeat_at: stale }, now), true, "stale pending => rescued too");
  assert.equal(shouldRescueJob({ status: "probing" }, now), true, "no heartbeat at all => rescued");
  assert.equal(
    shouldRescueJob({ status: "complete", heartbeat_at: stale }, now),
    false,
    "complete is never rescued (isJobAlive alone would wrongly call this 'not alive')"
  );
  assert.equal(shouldRescueJob({ status: "failed", heartbeat_at: stale }, now), false, "failed is never rescued");
  assert.equal(shouldRescueJob(null, now), false);
});

test("resolveSelfContinueUrl — prefers NEXT_PUBLIC_APP_URL, then VERCEL_URL, then localhost", () => {
  const saved = {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    VERCEL_URL: process.env.VERCEL_URL,
    PORT: process.env.PORT,
  };
  try {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com/";
    delete process.env.VERCEL_URL;
    assert.equal(resolveSelfContinueUrl("job-1"), "https://app.example.com/api/scan/worker?job_id=job-1");

    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.VERCEL_URL = "my-deploy.vercel.app";
    assert.equal(resolveSelfContinueUrl("job-2"), "https://my-deploy.vercel.app/api/scan/worker?job_id=job-2");

    delete process.env.VERCEL_URL;
    delete process.env.PORT;
    assert.equal(resolveSelfContinueUrl("job-3"), "http://localhost:3000/api/scan/worker?job_id=job-3");
  } finally {
    if (saved.NEXT_PUBLIC_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = saved.NEXT_PUBLIC_APP_URL;
    if (saved.VERCEL_URL === undefined) delete process.env.VERCEL_URL;
    else process.env.VERCEL_URL = saved.VERCEL_URL;
    if (saved.PORT === undefined) delete process.env.PORT;
    else process.env.PORT = saved.PORT;
  }
});

// ---------------------------------------------------------------------------
// brand_metrics_daily rollup math (must match scripts/backfill-analytics.mjs)
// ---------------------------------------------------------------------------

test("unionPromptCounts — counts a non-branded prompt once even if multiple engines probed it", () => {
  const rows = [
    { query: "Q1", engine: "aio", answered: true, mentioned: true, is_branded_query: false },
    { query: "Q1", engine: "chatgpt", answered: true, mentioned: false, is_branded_query: false },
    { query: "q2", engine: "aio", answered: false, mentioned: false, is_branded_query: false },
    { query: "brand query", engine: "aio", answered: true, mentioned: true, is_branded_query: true },
  ];
  const result = unionPromptCounts(rows);
  assert.equal(result.total, 2, "Q1/q2 distinct case-insensitive; branded excluded");
  assert.equal(result.answered, 1, "only Q1 was answered on >=1 engine");
  assert.equal(result.mentioned, 1, "only Q1 was mentioned on >=1 engine");
});

test("unionPromptCounts — returns null when every row is branded", () => {
  assert.equal(unionPromptCounts([{ query: "q", engine: "aio", answered: true, mentioned: true, is_branded_query: true }]), null);
  assert.equal(unionPromptCounts([]), null);
});

test("buildMetricsRows — multi-engine: per-engine rows + union-counted blended 'all' row", () => {
  const engineSummaries = {
    aio: { non_branded_queries: 10, non_branded_with_answer: 8, mentioned_non_branded: 3, cited_non_branded: 2, visibility_pct: 37.5, share_of_ai_pct: 37.5 },
    chatgpt: { non_branded_queries: 10, non_branded_with_answer: 10, mentioned_non_branded: 6, cited_non_branded: 4, visibility_pct: 60, share_of_ai_pct: 60 },
  };
  const promptResultRows = [
    { query: "q1", engine: "aio", answered: true, mentioned: true, is_branded_query: false },
    { query: "q1", engine: "chatgpt", answered: true, mentioned: false, is_branded_query: false },
    { query: "q2", engine: "aio", answered: false, mentioned: false, is_branded_query: false },
    { query: "q2", engine: "chatgpt", answered: true, mentioned: true, is_branded_query: false },
  ];
  const headline = { visibility_index_pct: 48.75, engines_counted: 2 };

  const rows = buildMetricsRows({
    isMultiEngine: true,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    scanId: "scan-1",
    promptSetId: "abc123",
    summary: {},
    engineSummaries,
    headline,
    promptResultRows,
  });

  assert.equal(rows.length, 3);
  const aioRow = rows.find((r) => r.engine === "aio");
  const chatgptRow = rows.find((r) => r.engine === "chatgpt");
  const allRow = rows.find((r) => r.engine === "all");

  assert.equal(aioRow.visibility_pct, 37.5);
  assert.equal(aioRow.citation_share_pct, Math.round((2 / 8) * 1000) / 10);
  assert.equal(chatgptRow.citation_share_pct, Math.round((4 / 10) * 1000) / 10);
  assert.equal(aioRow.sov_pct, null);
  assert.equal(aioRow.sentiment_avg, null);
  assert.equal(aioRow.position_avg, null);

  assert.equal(allRow.visibility_pct, 48.75);
  assert.equal(allRow.prompts_total, 2, "union across engines, not summed (4 rows -> 2 distinct prompts)");
  assert.equal(allRow.prompts_answered, 2, "q1 answered on aio, q2 answered on chatgpt -> both count once");
  assert.equal(allRow.prompts_mentioned, 2, "q1 mentioned on aio, q2 mentioned on chatgpt -> both count once");
  // sum-based rate (not union): sumCited=6, sumAnswered=18 across the two engine rows above.
  assert.equal(allRow.citation_share_pct, Math.round((6 / 18) * 1000) / 10);
  rows.forEach((r) => assert.equal(r.prompt_set_id, "abc123"));
  rows.forEach((r) => assert.equal(r.scan_id, "scan-1"));
});

test("buildMetricsRows — single engine (aio only): 'aio' and 'all' rows are identical", () => {
  const summary = {
    non_branded_queries: 20,
    non_branded_with_aio: 18,
    mentioned_non_branded: 9,
    visibility_pct: 50,
    share_of_ai_pct: 50,
    citation_share_pct: 22.2,
  };
  const rows = buildMetricsRows({
    isMultiEngine: false,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    scanId: "scan-2",
    promptSetId: "xyz",
    summary,
    engineSummaries: null,
    headline: null,
    promptResultRows: [],
  });
  assert.equal(rows.length, 2);
  const aio = rows.find((r) => r.engine === "aio");
  const all = rows.find((r) => r.engine === "all");
  assert.equal(aio.prompts_total, 20);
  assert.equal(aio.prompts_answered, 18);
  assert.equal(aio.citation_share_pct, 22.2);
  assert.deepEqual({ ...all, engine: "x" }, { ...aio, engine: "x" }, "aio and all rows must be identical apart from the engine label");
});

// ---------------------------------------------------------------------------
// Phase 1 — sourcing
// ---------------------------------------------------------------------------

test("runSourcingPhase — freezes brand/url/competitors/queries/engines/stats into the checkpoint", async () => {
  const job = { brand: "Acme", url: "acme.com", industry: "saas", competitors: "RivalA, RivalB" };
  const pool = Array.from({ length: 10 }, (_, i) => ({
    text: `unbranded seed ${i}`,
    intent_tier: "informational",
    topic: "General",
    weight: 1,
    enabled: true,
    source: "llm_generated",
    created_at: "2026-07-01T00:00:00Z",
  }));

  const checkpoint = await runSourcingPhase(job, {
    promptTarget: 10,
    getPromptsForBrand: async () => pool,
    upsertPrompts: async () => ({}),
    generateUnbrandedPrompts: async () => {
      throw new Error("must not generate — pool is already full");
    },
    buildBrandedQueries: () => [{ text: "acme", source: "branded_seed", topic: "Brand Presence", intent_tier: "branded" }],
    resolveEnabledEngines: () => [{ name: "aio" }, { name: "perplexity" }],
  });

  assert.equal(checkpoint.brand, "Acme");
  assert.equal(checkpoint.url, "acme.com");
  assert.deepEqual(checkpoint.competitors, ["RivalA", "RivalB"]);
  assert.equal(checkpoint.competitors_raw, "RivalA, RivalB");
  assert.equal(checkpoint.prompt_key, "acme.com");
  assert.equal(checkpoint.queries.length, 11, "10 unbranded + 1 branded seed");
  assert.equal(checkpoint.unbranded_texts.length, 10);
  assert.deepEqual(checkpoint.engines, ["aio", "perplexity"]);
  // R3.7.2 added `website_scrape` alongside cost/tokens so a degraded scrape
  // survives a resume; R2.2.12 added `prompt_seeding` for the same reason. This
  // job reuses a full prompt pool, so generation — and therefore the scrape and
  // the seeding leg — never ran: null is "nothing measured" for both, which is
  // the correct value here and NOT a stand-in for a healthy read.
  assert.deepEqual(checkpoint.stats, {
    cost: 0,
    tokens: 0,
    website_scrape: null,
    prompt_seeding: null,
  });
  assert.ok(checkpoint.sourced_at);
});

// ---------------------------------------------------------------------------
// Phase 2 — probing: resume-skip + budget checkpointing
// ---------------------------------------------------------------------------

test("runProbingPhase — resume skips pairs already in getCompletedPairsForJob", async () => {
  const backend = makeFakeBackend();
  const queries = makeQueries(3);
  const jobId = "job-resume-1";

  seedPromptResultRow(backend, {
    jobId,
    raw: makeProbeResult({ engine: "aio", query: queries[0] }),
  });

  const probeCalls = [];
  const engine = { name: "aio", concurrency: 2, probe: async (query) => {
    probeCalls.push(query.text);
    return makeProbeResult({ engine: "aio", query, visible: true });
  } };

  const checkpoint = makeCheckpoint({ queries, engines: ["aio"] });
  const outcome = await runProbingPhase(jobId, checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => [engine],
  });

  assert.equal(outcome.budgetHit, false);
  assert.deepEqual(probeCalls.sort(), [queries[1].text, queries[2].text].sort(), "must not re-probe the already-completed pair");

  const allForJob = backend.promptResults.filter((r) => r.job_id === jobId);
  assert.equal(allForJob.length, 3, "one pre-seeded + two newly probed");
});

test("runProbingPhase — persists the SELF brand's position/sentiment from result.brands (P1.1) into prompt_results, not a rival's", async () => {
  const backend = makeFakeBackend();
  const queries = makeQueries(1);
  const jobId = "job-p11-self-position";

  const engine = {
    name: "aio",
    concurrency: 1,
    probe: async (query) =>
      makeProbeResult({
        engine: "aio",
        query,
        visible: true,
        brands: [
          { name: "RivalCo", is_self: false, mentioned: true, position: 1, sentiment: 0 },
          { name: "Acme", is_self: true, mentioned: true, position: 2, sentiment: 100 },
        ],
      }),
  };

  const checkpoint = makeCheckpoint({ queries, engines: ["aio"] });
  await runProbingPhase(jobId, checkpoint, { ...backend.deps, resolveEnabledEngines: () => [engine] });

  const row = backend.promptResults.find((r) => r.job_id === jobId);
  assert.equal(row.position, 2, "self brand's position (2), not the rival's (1)");
  assert.equal(row.sentiment, 100, "self brand's sentiment (100), not the rival's (0)");
});

test("runProbingPhase — no per-brand data on the probe result -> position/sentiment stay null (pre-P1.1 shape still safe)", async () => {
  const backend = makeFakeBackend();
  const queries = makeQueries(1);
  const jobId = "job-p11-no-brands";
  const engine = { name: "aio", concurrency: 1, probe: async (query) => makeProbeResult({ engine: "aio", query, visible: true }) };
  const checkpoint = makeCheckpoint({ queries, engines: ["aio"] });

  await runProbingPhase(jobId, checkpoint, { ...backend.deps, resolveEnabledEngines: () => [engine] });

  const row = backend.promptResults.find((r) => r.job_id === jobId);
  assert.equal(row.position, null);
  assert.equal(row.sentiment, null);
});

test("runScanChunk — hits the time budget mid-probing: checkpoints, self-continues, does not finalize", async () => {
  const backend = makeFakeBackend();
  const queries = makeQueries(4);
  const job = await backend.deps.createScanJob({ brand: "Acme", url: "acme.com", industry: "saas", competitors: "" });
  job.status = "probing";
  job.checkpoint = makeCheckpoint({ queries, engines: ["aio"] });

  const probeCalls = [];
  const engine = { name: "aio", concurrency: 1, probe: async (query) => {
    probeCalls.push(query.text);
    return makeProbeResult({ engine: "aio", query, visible: true });
  } };

  const result = await runScanChunk(job.id, {
    ...backend.deps,
    resolveEnabledEngines: () => [engine],
    chunkBudgetMs: 0, // force a budget hit after the very first batch
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "checkpointed");
  assert.ok(probeCalls.length >= 1 && probeCalls.length < queries.length, "must stop before finishing all pairs");
  assert.equal(backend.calls.selfContinue.length, 1);
  assert.equal(backend.calls.selfContinue[0], job.id);
  assert.equal(job.status, "probing", "must not have advanced to scoring/complete");
  assert.equal(backend.scans.length, 0, "finalize must not have run");
  assert.ok(job.checkpoint.stats, "checkpoint must be re-saved with updated stats");
});

// ---------------------------------------------------------------------------
// Phase 3 — finalize: reconstruction fidelity + fail-loud + crash recovery
// ---------------------------------------------------------------------------

test("runFinalizePhase — multi-engine: reconstructs results from `raw` and matches a direct summarize call on the same rows", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-finalize-multi";
  const queries = makeQueries(6);
  const checkpoint = makeCheckpoint({ queries, engines: ["aio", "chatgpt"] });

  const aioRaws = queries.map((q, i) => makeProbeResult({ engine: "aio", query: q, visible: i < 2 }));
  const chatgptRaws = queries.map((q, i) => makeProbeResult({ engine: "chatgpt", query: q, visible: i < 4 }));
  [...aioRaws, ...chatgptRaws].forEach((raw) => seedPromptResultRow(backend, { jobId, raw }));

  const finalJob = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    extractCompetitors: async () => [],
    resolveEnabledEngines: () => [{ name: "aio" }, { name: "chatgpt" }],
  });

  assert.equal(finalJob.status, "complete");
  assert.ok(finalJob.result_id);

  const record = finalJob.run_record;
  assert.equal(record.results.length, 12);
  const rebuiltAio = record.results.filter((r) => r.engine === "aio");
  assert.deepEqual(rebuiltAio.map((r) => r.prompt).sort(), aioRaws.map((r) => r.prompt).sort());

  // Direct comparison against independently-computed summaries over the SAME
  // per-engine raw arrays (the exact scoring-fidelity requirement).
  const expectedAio = summarizeEngineSlice(aioRaws, "aio");
  const expectedChatgpt = summarizeEngineSlice(chatgptRaws, "chatgpt");
  const expectedHeadline = computeHeadline([expectedAio, expectedChatgpt]);
  const expectedWrapped = summarizeEngineResults({
    results: record.results,
    engines: { aio: expectedAio, chatgpt: expectedChatgpt },
    headline: expectedHeadline,
  });

  assert.deepEqual(record.engines.aio, expectedAio);
  assert.deepEqual(record.engines.chatgpt, expectedChatgpt);
  assert.equal(record.visibility_index_pct, expectedHeadline.visibility_index_pct);
  assert.equal(record.engines_counted, expectedHeadline.engines_counted);
  assert.deepEqual(record.summary_stats, expectedWrapped.summary);
  assert.equal(record.scoring_version, "v9-multi-engine");
  assert.equal(record.platform, "multi");
});

test("runFinalizePhase — single engine (aio only): uses summarizeAioResults directly, matches a direct call", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-finalize-single";
  const queries = makeQueries(6);
  const checkpoint = makeCheckpoint({ queries, engines: ["aio"] });

  const raws = queries.map((q, i) => makeProbeResult({ engine: "aio", query: q, visible: i < 3 }));
  raws.forEach((raw) => seedPromptResultRow(backend, { jobId, raw }));

  const finalJob = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => [],
  });

  assert.equal(finalJob.status, "complete");
  const record = finalJob.run_record;
  assert.equal(record.scoring_version, "v8.1-aio-unbranded-plus-presence");
  assert.equal(record.platform, "google_ai_overview");
  assert.equal(record.engines, undefined, "single-engine records must not carry the engines map");

  const expected = summarizeAioResults(raws).summary;
  assert.deepEqual(record.summary_stats, expected);
  assert.equal(record.visibility_pct, expected.visibility_pct);
});

test("runFinalizePhase — insertScan throws => the error propagates (never swallowed)", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-finalize-fail-1";
  const queries = makeQueries(5);
  const checkpoint = makeCheckpoint({ queries, engines: ["aio"] });
  queries.forEach((q) => seedPromptResultRow(backend, { jobId, raw: makeProbeResult({ engine: "aio", query: q, visible: true }) }));

  await assert.rejects(
    () =>
      runFinalizePhase(jobId, checkpoint, {
        ...backend.deps,
        resolveEnabledEngines: () => [{ name: "aio" }],
        extractCompetitors: async () => [],
        insertScan: async () => {
          throw new Error("supabase insert boom");
        },
      }),
    /Failed to save scan results: supabase insert boom/
  );
  assert.equal(backend.scans.length, 0);
});

test("runFinalizePhase — insertScan resolves with no id => throws (never silently completes with result_id: null)", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-finalize-fail-2";
  const queries = makeQueries(5);
  const checkpoint = makeCheckpoint({ queries, engines: ["aio"] });
  queries.forEach((q) => seedPromptResultRow(backend, { jobId, raw: makeProbeResult({ engine: "aio", query: q, visible: true }) }));

  await assert.rejects(
    () =>
      runFinalizePhase(jobId, checkpoint, {
        ...backend.deps,
        resolveEnabledEngines: () => [{ name: "aio" }],
        extractCompetitors: async () => [],
        insertScan: async () => [],
      }),
    /Failed to save scan results/
  );
});

test("runScanChunk — a finalize failure marks the job failed, never complete (end-to-end fail-loud)", async () => {
  const backend = makeFakeBackend();
  const queries = makeQueries(5);
  const job = await backend.deps.createScanJob({ brand: "Acme", url: "acme.com", industry: "saas", competitors: "" });
  // "probing", not "scoring": finalize now claims probing -> scoring (FIX 2)
  // before it will do any work, so a job dispatched straight into finalize
  // must actually be sitting in "probing" for that claim to succeed — every
  // pair is already persisted (seeded below), so runProbingPhase's own pass
  // is a same-chunk no-op and falls straight through into finalize.
  job.status = "probing";
  job.checkpoint = makeCheckpoint({ queries, engines: ["aio"] });
  queries.forEach((q) => seedPromptResultRow(backend, { jobId: job.id, raw: makeProbeResult({ engine: "aio", query: q, visible: true }) }));

  const result = await runScanChunk(job.id, {
    ...backend.deps,
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => [],
    insertScan: async () => {
      throw new Error("supabase insert boom");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "error");
  assert.equal(job.status, "failed");
  assert.notEqual(job.status, "complete");
  assert.equal(job.result_id, null);
  assert.ok(job.error_message.includes("supabase insert boom"));
  assert.equal(backend.scans.length, 0);
});

test("runFinalizePhase — resumed after scan_id was already stamped (crash mid-finalize): reuses it, does not call insertScan again", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-crash-finalize";
  const queries = makeQueries(4);
  const checkpoint = makeCheckpoint({ queries, engines: ["aio"] });

  queries.forEach((q) =>
    seedPromptResultRow(backend, {
      jobId,
      raw: makeProbeResult({ engine: "aio", query: q, visible: true }),
      scanId: "scan-already-there", // simulates a prior finalize attempt that got this far before crashing
    })
  );

  const insertScanCalls = [];
  const finalJob = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => [],
    insertScan: async (record) => {
      insertScanCalls.push(record);
      return [{ id: "brand-new-should-not-be-used" }];
    },
  });

  assert.equal(insertScanCalls.length, 0, "must not call insertScan again when scan_id is already stamped");
  assert.equal(finalJob.result_id, "scan-already-there");
  assert.equal(finalJob.status, "complete");
});

// ---------------------------------------------------------------------------
// Citations are finalize-derived (P0.2 FIX 1): materialized from
// prompt_results.raw.references at finalize time, never during probing.
// ---------------------------------------------------------------------------

test("runFinalizePhase — prompt_results committed with no citations written yet → finalize materializes every citation from raw.references, none lost", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-materialize-citations";
  const queries = makeQueries(3);
  const checkpoint = makeCheckpoint({ queries, brand: "Acme", url: "acme.com", engines: ["aio"] });

  // Mirrors the crash window FIX 1 closes: prompt_results rows are fully
  // committed (each `raw` carries its complete `references`), but — since
  // probing no longer writes citations at all — none exist yet anywhere.
  const referenceSets = [
    [{ href: "https://ref-a.com/x", title: "A", source: "s", domain: "ref-a.com" }],
    [{ href: "https://acme.com/self-page", title: "Self", source: "s", domain: "acme.com" }], // brand's own domain
    [], // no references on this one -> contributes zero citation rows
  ];
  queries.forEach((q, i) =>
    seedPromptResultRow(backend, {
      jobId,
      raw: makeProbeResult({ engine: "aio", query: q, visible: true, references: referenceSets[i] }),
    })
  );

  assert.equal(backend.citations.length, 0, "precondition: probing must not have written any citations");

  const finalJob = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => [],
  });

  assert.equal(finalJob.status, "complete");
  assert.equal(backend.citations.length, 2, "one citation per reference across the seeded rows — none lost");

  const refACitation = backend.citations.find((c) => c.domain === "ref-a.com");
  assert.ok(refACitation, "the non-self reference must be materialized");
  assert.equal(refACitation.job_id, jobId);
  assert.equal(refACitation.scan_id, finalJob.result_id);
  assert.equal(refACitation.engine, "aio");
  assert.equal(refACitation.rank, 1);
  assert.equal(refACitation.is_self, false);
  assert.ok(refACitation.result_id, "must carry the owning prompt_results row id");

  const selfCitation = backend.citations.find((c) => c.domain === "acme.com");
  assert.ok(selfCitation, "the brand's-own-domain reference must be materialized too");
  assert.equal(selfCitation.is_self, true, "domain matching the brand's own domain -> is_self");
});

// ---------------------------------------------------------------------------
// unionCompetitorNames — the finalize-time roster union (competitor-judging
// gap fix): the checkpoint's user-supplied competitor list UNIONED with
// extractCompetitors' discovered competitorObjects, deduped by a simple
// trim+lowercase key, user-supplied entries first.
// ---------------------------------------------------------------------------

test("unionCompetitorNames — unions user-supplied names with discovered competitorObjects, user-supplied first", () => {
  const result = unionCompetitorNames(["RivalA"], [{ name: "RivalB" }, { name: "RivalC" }]);
  assert.deepEqual(result, ["RivalA", "RivalB", "RivalC"]);
});

test("unionCompetitorNames — dedupes case/whitespace-insensitively, keeping the user-supplied casing", () => {
  const result = unionCompetitorNames(["RivalCo"], [{ name: "  rivalco  " }, { name: "RIVALCO" }, { name: "NewRival" }]);
  assert.deepEqual(result, ["RivalCo", "NewRival"], "the discovered duplicate of a user-typed name must not appear twice");
});

test("unionCompetitorNames — a user-supplied competitor survives even when competitorObjects doesn't echo it back (defensive backstop)", () => {
  // Mirrors an extractCompetitors deps override (or a real edge case) that
  // returns something unrelated to userCompetitors -- the fix must never
  // silently drop a typed-in rival from the judging roster because of that.
  assert.deepEqual(unionCompetitorNames(["RivalA"], []), ["RivalA"]);
});

test("unionCompetitorNames — blank/whitespace-only names and objects with no `.name` are skipped; null/undefined inputs are safe", () => {
  assert.deepEqual(
    unionCompetitorNames(["", "  ", "RivalA"], [{ name: "" }, {}, { name: null }, { name: "RivalB" }]),
    ["RivalA", "RivalB"]
  );
  assert.deepEqual(unionCompetitorNames(null, null), []);
  assert.deepEqual(unionCompetitorNames(undefined, undefined), []);
});

test("unionCompetitorNames — empty on both sides -> empty roster (self-only judging upstream)", () => {
  assert.deepEqual(unionCompetitorNames([], []), []);
});

// ---------------------------------------------------------------------------
// Symmetric per-brand judging is finalize-derived too (P1.2, competitor-
// judging gap fix): result_brands is now materialized by RE-JUDGING each
// reconstructed non-branded answer's text fresh against the FULL roster
// (self + every discovered competitor, not just the user-supplied ones
// baked into prompt_results.raw.brands at probe time). Same
// delete-then-reinsert idempotency shape as citations.
//
// These tests deliberately re-derive their "expected" values by calling the
// SAME real judgeBrandsSymmetric/buildTrackedBrandRoster building blocks
// runFinalizePhase itself now uses (imported directly, above) rather than
// hand-predicting sentiment/position numbers — the sentiment window in
// particular (detectSentiment's +-100 chars) makes hand-predicted values
// brittle for short fixture text; asserting against the real function is
// both robust and a direct test of "finalize's output matches a fresh
// judgeBrandsSymmetric call over the reconstructed text", which is exactly
// the contract being fixed.
// ---------------------------------------------------------------------------

test("runFinalizePhase — writes one result_brands row per (non-branded result, tracked brand): self + every competitor, judged fresh from answer text (P1.2 symmetric judging)", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-p12-symmetric";
  const queries = makeQueries(2);
  const brandedQuery = { text: "who is acme", source: "branded_seed", topic: "Brand Presence", intent_tier: "branded", is_branded_query: true };
  const checkpoint = makeCheckpoint({ queries, brand: "Acme", url: "acme.com", competitors: ["RivalCo"], engines: ["aio"] });

  seedPromptResultRow(backend, {
    jobId,
    raw: makeProbeResult({ engine: "aio", query: queries[0], visible: true, text: "Acme is a solid pick for this." }),
  });
  seedPromptResultRow(backend, {
    jobId,
    raw: makeProbeResult({ engine: "aio", query: queries[1], visible: true, text: "Acme leads the pack, though RivalCo is a common alternative." }),
  });
  // A branded-query row that clearly mentions RivalCo too -- must be
  // excluded from result_brands entirely: full-roster judging is scoped to
  // the SAME non-branded pool sov_pct/visibility_pct are computed over.
  seedPromptResultRow(backend, {
    jobId,
    raw: makeProbeResult({ engine: "aio", query: brandedQuery, visible: true, text: "Acme versus RivalCo: which is better?" }),
  });

  const finalJob = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => [],
  });

  assert.equal(finalJob.status, "complete");
  assert.equal(
    backend.resultBrands.length,
    4,
    "2 NON-BRANDED results x 2 tracked brands (self + 1 competitor) -- the branded row contributes zero rows"
  );

  const selfRows = backend.resultBrands.filter((r) => r.is_self);
  const rivalRows = backend.resultBrands.filter((r) => !r.is_self);
  assert.equal(selfRows.length, 2);
  assert.equal(rivalRows.length, 2);
  assert.ok(selfRows.every((r) => r.name === "Acme" && r.mentioned === true), "Acme is mentioned in both non-branded answers");
  assert.ok(backend.resultBrands.every((r) => r.scan_id === finalJob.result_id));
  assert.ok(backend.resultBrands.every((r) => r.brand === "acme.com"));
  assert.ok(backend.resultBrands.every((r) => r.result_id), "every row carries the owning prompt_results row id");

  const resultIdForQuery = (text) => backend.promptResults.find((p) => p.job_id === jobId && p.query === text)?.id;
  const row1Id = resultIdForQuery(queries[0].text);
  const row2Id = resultIdForQuery(queries[1].text);
  const brandedId = resultIdForQuery(brandedQuery.text);

  const row1Rival = rivalRows.find((r) => r.result_id === row1Id);
  assert.equal(row1Rival.mentioned, false, "row 1's text never mentions RivalCo");
  assert.equal(row1Rival.position, null);
  assert.equal(row1Rival.sentiment, null);

  const row2Self = selfRows.find((r) => r.result_id === row2Id);
  const row2Rival = rivalRows.find((r) => r.result_id === row2Id);
  assert.equal(row2Self.position, 1, "Acme is named before RivalCo in row 2's text");
  assert.equal(row2Rival.mentioned, true);
  assert.equal(row2Rival.position, 2);

  assert.equal(
    backend.resultBrands.filter((r) => r.result_id === brandedId).length,
    0,
    "the branded-query row must have zero result_brands rows, even though its text mentions both brands"
  );
});

test("runFinalizePhase — no competitors at all (none user-supplied, none discovered): roster is self-only, one result_brands row per result, and sov_pct is NOT the old 100% (R4.3.2)", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-p12-empty-roster";
  const queries = makeQueries(2);
  const checkpoint = makeCheckpoint({ queries, brand: "Acme", url: "acme.com", competitors: [], engines: ["aio"] });
  queries.forEach((q) =>
    seedPromptResultRow(backend, {
      jobId,
      raw: makeProbeResult({ engine: "aio", query: q, visible: true, text: "Acme is the right pick here." }),
    })
  );

  const finalJob = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => [], // the free LLM found nothing (or is down) -- extractCompetitors fails soft, never throws
  });

  assert.equal(finalJob.status, "complete");
  assert.equal(backend.resultBrands.length, 2, "one row per non-branded result -- self only, no rivals to track");
  assert.ok(backend.resultBrands.every((r) => r.is_self && r.name === "Acme" && r.mentioned === true));

  // R4.3.2 -- this assertion used to read `sov_pct === 100`, described as
  // "legitimate when zero rivals were ever tracked, not a bug". It was the bug.
  // self / self is 1 by construction, so the stored daily metric reported a
  // confident 100% share of voice for a brand measured against nobody -- while
  // the dashboard donut (fixed by R2.7.1) said "not available" for the same
  // scan. The durable row was the worse of the two lies: it is what a trend
  // chart and any export read.
  const allRow = backend.brandMetrics.find((m) => m.scan_id === finalJob.result_id && m.engine === "all");
  assert.notEqual(allRow.sov_pct, 100, "a self-only roster must never store a 100% share");
  assert.equal(allRow.sov_pct, null, "share of voice is UNDEFINED without rivals -- not 0 and not 100");
  assert.equal(allRow.sov_state, "not_assessed");
  assert.equal(allRow.sov_state_reason, "self_only_roster", "and the row says WHY there is no number");
});

test("runFinalizePhase — re-finalize (crash recovery) deletes-then-reinserts result_brands, never duplicates them (P1.2 idempotency, full-roster judging)", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-p12-refinalize";
  const queries = makeQueries(2);
  const checkpoint = makeCheckpoint({ queries, brand: "Acme", url: "acme.com", competitors: ["RivalCo"], engines: ["aio"] });

  queries.forEach((q) =>
    seedPromptResultRow(backend, {
      jobId,
      raw: makeProbeResult({
        engine: "aio",
        query: q,
        visible: true,
        text: "Acme is the recommended choice; RivalCo also comes up as an alternative.",
      }),
      scanId: "scan-prior-finalize", // a PRIOR finalize attempt already reached stampScanIdForJob
    })
  );
  const seededResultIds = backend.promptResults.filter((r) => r.job_id === jobId).map((r) => r.id);

  // Stand-ins for whatever a prior, interrupted finalize attempt left behind
  // (result_brands has no unique constraint, so a naive re-run would pile
  // these up instead of replacing them). Values deliberately differ from
  // what the fresh judging below will compute, so a leftover stale row
  // would also be visible as a content mismatch, not just a stray id.
  backend.resultBrands.push(
    { id: "stale-rb-1", result_id: seededResultIds[0], scan_id: "scan-prior-finalize", brand: "acme.com", name: "Acme", is_self: true, mentioned: false, position: null, sentiment: null },
    { id: "stale-rb-2", result_id: seededResultIds[0], scan_id: "scan-prior-finalize", brand: "acme.com", name: "RivalCo", is_self: false, mentioned: false, position: null, sentiment: null }
  );
  assert.equal(backend.resultBrands.length, 2, "precondition: stale rows exist from a prior attempt");

  const insertScanCalls = [];
  const finalJob = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => [],
    insertScan: async (record) => {
      insertScanCalls.push(record);
      return [{ id: "should-not-be-used" }];
    },
  });

  assert.equal(insertScanCalls.length, 0, "must reuse the already-stamped scan_id, not insertScan again");
  assert.equal(finalJob.result_id, "scan-prior-finalize");

  // 2 results x 2 tracked brands = 4 fresh rows, replacing (not adding to) the 2 stale ones.
  assert.equal(backend.resultBrands.length, 4, "stale rows replaced, not piled on top of");
  assert.ok(
    backend.resultBrands.every((r) => r.id !== "stale-rb-1" && r.id !== "stale-rb-2"),
    "the old rows must actually be deleted, not merely left alongside freshly-materialized ones"
  );
  assert.ok(
    backend.resultBrands.every((r) => r.mentioned === true),
    "fresh rows reflect the real text (both brands actually mentioned) -- not the stale fixture's mentioned:false"
  );
});

test("runFinalizePhase — judges LLM-DISCOVERED competitors, not just user-supplied ones: a job with NO user-supplied competitors still gets rival result_brands rows and sov_pct < 100% (closes the competitor-judging gap)", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-discovered-competitors";
  const queries = makeQueries(2);
  // job.competitors === "" (the common no-signup case) -> checkpoint.competitors is [].
  const checkpoint = makeCheckpoint({ queries, brand: "Acme", url: "acme.com", competitors: [], engines: ["aio"] });

  seedPromptResultRow(backend, {
    jobId,
    raw: makeProbeResult({ engine: "aio", query: queries[0], visible: true, text: "Acme is a leading choice for this." }),
  });
  seedPromptResultRow(backend, {
    jobId,
    raw: makeProbeResult({ engine: "aio", query: queries[1], visible: true, text: "RivalCo is a leading choice for this too." }),
  });

  const finalJob = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => [{ name: "aio" }],
    // extractCompetitors discovers RivalCo purely from AIO text/citations --
    // the user never typed it in (checkpoint.competitors is [] above).
    extractCompetitors: async () => [
      { name: "RivalCo", source: "discovered", mentions: 1, citations: 0, prompts: 1, userAbsent: false, visibilityScore: 50, citationShare: 0 },
    ],
  });

  assert.equal(finalJob.status, "complete");
  assert.equal(backend.resultBrands.length, 4, "2 results x 2 tracked brands (self + the discovered rival)");

  const rivalRows = backend.resultBrands.filter((r) => !r.is_self);
  assert.ok(rivalRows.length > 0, "result_brands must carry rows for the DISCOVERED rival, not just self");
  assert.ok(rivalRows.some((r) => r.name === "RivalCo" && r.mentioned === true), "the discovered rival's real mention must be captured");

  const allRow = backend.brandMetrics.find((m) => m.scan_id === finalJob.result_id && m.engine === "all");
  assert.ok(allRow.sov_pct < 100, "self is not the only tracked-brand mention any more -- sov_pct must be a real fraction, not 100%");
  assert.equal(allRow.sov_pct, 50, "self mentioned once (row 1), rival mentioned once (row 2) -> 1/2 = 50%");
});

test("runFinalizePhase — SOV math: self + 2 tracked rivals (one user-supplied, one LLM-discovered) with known mention counts -> exact sov_pct", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-sov-two-rivals";
  const queries = makeQueries(3);
  const checkpoint = makeCheckpoint({ queries, brand: "Acme", url: "acme.com", competitors: ["RivalA"], engines: ["aio"] });

  seedPromptResultRow(backend, {
    jobId,
    raw: makeProbeResult({ engine: "aio", query: queries[0], visible: true, text: "Acme is the best fit for this need." }), // self only
  });
  seedPromptResultRow(backend, {
    jobId,
    raw: makeProbeResult({ engine: "aio", query: queries[1], visible: true, text: "Acme is often compared to RivalA in this space." }), // self + RivalA
  });
  seedPromptResultRow(backend, {
    jobId,
    raw: makeProbeResult({ engine: "aio", query: queries[2], visible: true, text: "RivalB is a common alternative worth checking out." }), // RivalB only
  });

  const finalJob = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => [
      { name: "RivalA", source: "user", mentions: 1, citations: 0, prompts: 1, userAbsent: false, visibilityScore: 33.3, citationShare: 0 },
      { name: "RivalB", source: "discovered", mentions: 1, citations: 0, prompts: 1, userAbsent: false, visibilityScore: 33.3, citationShare: 0 },
    ],
  });

  assert.equal(finalJob.status, "complete");

  const names = new Set(backend.resultBrands.map((r) => r.name));
  assert.deepEqual(names, new Set(["Acme", "RivalA", "RivalB"]), "roster is the full union: self + user-supplied + discovered");
  assert.equal(backend.resultBrands.length, 9, "3 results x 3 tracked brands");

  assert.equal(backend.resultBrands.filter((r) => r.is_self && r.mentioned).length, 2, "self mentioned in rows 1 and 2");
  assert.equal(backend.resultBrands.filter((r) => r.name === "RivalA" && r.mentioned).length, 1, "RivalA mentioned in row 2 only");
  assert.equal(backend.resultBrands.filter((r) => r.name === "RivalB" && r.mentioned).length, 1, "RivalB mentioned in row 3 only");

  const allRow = backend.brandMetrics.find((m) => m.scan_id === finalJob.result_id && m.engine === "all");
  // self=2, RivalA=1, RivalB=1 -> 4 total tracked-brand mentions, 2 self -> 50%.
  assert.equal(allRow.sov_pct, 50);
});

test("runFinalizePhase — a single row's full-roster judging throwing is skipped (logged), not fatal to the whole finalize", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-judging-fails-soft";
  const queries = makeQueries(2);
  const checkpoint = makeCheckpoint({ queries, brand: "Acme", url: "acme.com", competitors: ["RivalCo"], engines: ["aio"] });

  seedPromptResultRow(backend, {
    jobId,
    raw: makeProbeResult({ engine: "aio", query: queries[0], visible: true, text: "BOOM this text triggers the injected failure." }),
  });
  seedPromptResultRow(backend, {
    jobId,
    raw: makeProbeResult({ engine: "aio", query: queries[1], visible: true, text: "Acme is a solid pick here." }),
  });

  const finalJob = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => [],
    // Wraps the REAL judgeBrandsSymmetric (imported above) so every row
    // judges normally except the one engineered to blow up.
    judgeBrandsSymmetric: (text, roster) => {
      if (text.includes("BOOM")) throw new Error("judge exploded");
      return judgeBrandsSymmetric(text, roster);
    },
  });

  assert.equal(finalJob.status, "complete", "one row's judging failure must not fail the whole finalize");
  assert.equal(backend.resultBrands.length, 2, "1 surviving result x 2 tracked brands (self + RivalCo) -- the BOOM row contributes zero rows");
  const survivingId = backend.promptResults.find((p) => p.job_id === jobId && p.query === queries[1].text).id;
  assert.ok(backend.resultBrands.every((r) => r.result_id === survivingId));
});

test("runFinalizePhase — brand_metrics_daily rows carry real sov_pct/sentiment_avg/position_avg from a FRESH full-roster judging of the reconstructed answer text (P1.3 rollup wiring)", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-p13-rollup";
  const queries = makeQueries(2); // both non-branded
  const checkpoint = makeCheckpoint({ queries, brand: "Acme", url: "acme.com", competitors: ["RivalCo"], engines: ["aio"] });

  const texts = [
    "Acme is an excellent platform for this particular need.",
    "RivalCo is a decent option, but Acme remains the better recommended pick overall.",
  ];
  queries.forEach((q, i) =>
    seedPromptResultRow(backend, { jobId, raw: makeProbeResult({ engine: "aio", query: q, visible: true, text: texts[i] }) })
  );

  const finalJob = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => [
      { name: "RivalCo", source: "user", mentions: 0, citations: 0, prompts: 0, userAbsent: false, visibilityScore: 0, citationShare: 0 },
    ],
  });

  assert.equal(finalJob.status, "complete");

  // Ground truth: independently re-derive what the fix's roster judging
  // SHOULD produce, using the exact same building blocks runFinalizePhase
  // itself now uses (buildTrackedBrandRoster + judgeBrandsSymmetric).
  const roster = buildTrackedBrandRoster("Acme", getBrandAliases("Acme", "acme.com"), ["RivalCo"]);
  const expectedPerRow = texts.map((t) => judgeBrandsSymmetric(t, roster));
  const expectedSelf = expectedPerRow.map((r) => r.find((b) => b.is_self));
  const expectedRival = expectedPerRow.map((r) => r.find((b) => !b.is_self));

  // Fixture sanity: this test is only meaningful if the fixture actually
  // exercises mixed mention/no-mention rows, or it would pass vacuously.
  assert.ok(expectedSelf.every((b) => b.mentioned), "fixture sanity: self must be mentioned in both answers");
  assert.equal(expectedRival[0].mentioned, false, "fixture sanity: row 1 must NOT mention the rival");
  assert.equal(expectedRival[1].mentioned, true, "fixture sanity: row 2 MUST mention the rival");

  const totalMentions = expectedSelf.filter((b) => b.mentioned).length + expectedRival.filter((b) => b.mentioned).length;
  const selfMentions = expectedSelf.filter((b) => b.mentioned).length;
  const expectedSov = Math.round((selfMentions / totalMentions) * 1000) / 10;
  const expectedSentimentAvg = Math.round((expectedSelf.reduce((a, b) => a + b.sentiment, 0) / expectedSelf.length) * 10) / 10;
  const expectedPositionAvg = Math.round((expectedSelf.reduce((a, b) => a + b.position, 0) / expectedSelf.length) * 10) / 10;

  const allRow = backend.brandMetrics.find((m) => m.scan_id === finalJob.result_id && m.engine === "all");
  assert.ok(allRow);
  assert.equal(allRow.sov_pct, expectedSov);
  assert.equal(allRow.sentiment_avg, expectedSentimentAvg);
  assert.equal(allRow.position_avg, expectedPositionAvg);

  const aioRow = backend.brandMetrics.find((m) => m.scan_id === finalJob.result_id && m.engine === "aio");
  assert.deepEqual(
    { sov: aioRow.sov_pct, sentiment: aioRow.sentiment_avg, position: aioRow.position_avg },
    { sov: allRow.sov_pct, sentiment: allRow.sentiment_avg, position: allRow.position_avg },
    "single tracked engine -> per-engine and blended rollups agree"
  );
});

test("runFinalizePhase — re-finalize (crash recovery) deletes-then-reinserts citations, never duplicates them", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-refinalize-citations";
  const queries = makeQueries(2);
  const checkpoint = makeCheckpoint({ queries, brand: "Acme", url: "acme.com", engines: ["aio"] });

  queries.forEach((q) =>
    seedPromptResultRow(backend, {
      jobId,
      raw: makeProbeResult({
        engine: "aio",
        query: q,
        visible: true,
        references: [{ href: "https://ref-b.com/y", title: "B", source: "s", domain: "ref-b.com" }],
      }),
      scanId: "scan-prior-finalize", // a PRIOR finalize attempt already reached stampScanIdForJob
    })
  );

  // Stand-ins for whatever a prior, interrupted finalize attempt left behind
  // (citations has no unique constraint, so a naive re-run would pile these
  // up instead of replacing them).
  backend.citations.push(
    { id: "stale-1", job_id: jobId, scan_id: "scan-prior-finalize", domain: "ref-b.com", url: "https://ref-b.com/y", rank: 1 },
    { id: "stale-2", job_id: jobId, scan_id: "scan-prior-finalize", domain: "ref-b.com", url: "https://ref-b.com/y", rank: 1 }
  );
  assert.equal(backend.citations.filter((c) => c.job_id === jobId).length, 2, "precondition: stale rows exist from a prior attempt");

  const insertScanCalls = [];
  const finalJob = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => [],
    insertScan: async (record) => {
      insertScanCalls.push(record);
      return [{ id: "should-not-be-used" }];
    },
  });

  assert.equal(insertScanCalls.length, 0, "must reuse the already-stamped scan_id, not insertScan again");
  assert.equal(finalJob.result_id, "scan-prior-finalize");

  const citationsForJob = backend.citations.filter((c) => c.job_id === jobId);
  assert.equal(citationsForJob.length, 2, "one row per (result, reference) pair — stale rows replaced, not piled on top of");
  assert.ok(
    citationsForJob.every((c) => c.id !== "stale-1" && c.id !== "stale-2"),
    "the old rows must actually be deleted, not merely left alongside freshly-materialized ones"
  );
  assert.ok(citationsForJob.every((c) => c.domain === "ref-b.com"));
});

// ---------------------------------------------------------------------------
// P3a — citation enrichment wiring (src/lib/analytics/citationEnrich.js).
// Classifier correctness itself is covered by citationEnrich.test.mjs; these
// tests cover ONLY that runFinalizePhase wires it in correctly: candidate
// rows (with a transient `title`) go in, enriched fields come back and land
// on the inserted DB rows, `title` never reaches insertCitations (citations
// has no such column), and a broken/throwing enrichCitations degrades to
// unenriched rows rather than failing the scan.
// ---------------------------------------------------------------------------

test("runFinalizePhase — P3a: passes {url,domain,title} candidates + brandDomain/competitorNames into enrichCitations, persists its content_type/domain_type/citation_class, and strips title before insert", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-p3a-enrich-wiring";
  const queries = makeQueries(1);
  const checkpoint = makeCheckpoint({ queries, brand: "Acme", url: "acme.com", competitors: ["RivalCo"], engines: ["aio"] });

  queries.forEach((q) =>
    seedPromptResultRow(backend, {
      jobId,
      raw: makeProbeResult({
        engine: "aio",
        query: q,
        visible: true,
        references: [{ href: "https://ref-a.com/x", title: "Ref A Title", source: "s", domain: "ref-a.com" }],
      }),
    })
  );

  let enrichCall = null;
  const finalJob = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => [
      { name: "RivalCo", source: "user", mentions: 0, citations: 0, prompts: 0, userAbsent: false, visibilityScore: 0, citationShare: 0 },
    ],
    enrichCitations: async (rows, ctx) => {
      enrichCall = { rows, ctx };
      return rows.map((r) => ({ ...r, content_type: "article", domain_type: "editorial", citation_class: "earned" }));
    },
  });

  assert.equal(finalJob.status, "complete");

  // enrichCitations received the candidate row WITH title, plus brand/competitor context.
  assert.equal(enrichCall.rows.length, 1);
  assert.equal(enrichCall.rows[0].url, "https://ref-a.com/x");
  assert.equal(enrichCall.rows[0].domain, "ref-a.com");
  assert.equal(enrichCall.rows[0].title, "Ref A Title");
  assert.equal(enrichCall.ctx.brandDomain, "acme.com");
  assert.deepEqual(enrichCall.ctx.competitorNames, ["RivalCo"]);

  // Its return value's classification fields land on the persisted row...
  const persisted = backend.citations.find((c) => c.domain === "ref-a.com");
  assert.ok(persisted);
  assert.equal(persisted.content_type, "article");
  assert.equal(persisted.domain_type, "editorial");
  assert.equal(persisted.citation_class, "earned");
  // ...but `title` is classification-only and must never reach the DB row
  // (the citations table has no such column).
  assert.equal(persisted.title, undefined, "title must be stripped before insert");
});

test("runFinalizePhase — P3a: enrichCitations throwing degrades to unenriched rows instead of failing the scan", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-p3a-enrich-throws";
  const queries = makeQueries(1);
  const checkpoint = makeCheckpoint({ queries, brand: "Acme", url: "acme.com", engines: ["aio"] });

  queries.forEach((q) =>
    seedPromptResultRow(backend, {
      jobId,
      raw: makeProbeResult({
        engine: "aio",
        query: q,
        visible: true,
        references: [{ href: "https://ref-c.com/y", title: "C", source: "s", domain: "ref-c.com" }],
      }),
    })
  );

  const finalJob = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => [],
    enrichCitations: async () => {
      throw new Error("classifier exploded");
    },
  });

  assert.equal(finalJob.status, "complete", "a broken classifier must never fail the scan");
  const persisted = backend.citations.find((c) => c.domain === "ref-c.com");
  assert.ok(persisted, "the citation row must still be inserted, just unenriched");
  assert.equal(persisted.content_type, undefined);
  assert.equal(persisted.domain_type, undefined);
  assert.equal(persisted.citation_class, undefined);
  assert.equal(persisted.title, undefined, "title must still be stripped even on the fallback path");
});

test("runFinalizePhase — P3a: the REAL citationEnrich module classifies via heuristics alone, with zero LLM calls, for a representative mix of URLs", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-p3a-real-enrich";
  const queries = makeQueries(1);
  const checkpoint = makeCheckpoint({ queries, brand: "Acme", url: "acme.com", competitors: ["RivalCo"], engines: ["aio"] });

  queries.forEach((q) =>
    seedPromptResultRow(backend, {
      jobId,
      raw: makeProbeResult({
        engine: "aio",
        query: q,
        visible: true,
        references: [
          { href: "https://acme.com/", title: "Acme — Home", source: "s", domain: "acme.com" }, // owned + homepage
          { href: "https://blog.example.com/how-to-pick-a-crm", title: "How to pick a CRM", source: "s", domain: "blog.example.com" }, // corporate + article
          { href: "https://www.reddit.com/r/saas/comments/xyz/hubspot_thoughts", title: "Hubspot thoughts", source: "s", domain: "reddit.com" }, // ugc + forum
          { href: "https://rivalco.com/blog/pricing-guide", title: "Pricing guide", source: "s", domain: "rivalco.com" }, // competitor + article
        ],
      }),
    })
  );

  let llmCallCount = 0;
  const finalJob = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    enrichCitations: undefined, // fall through to the REAL module (not the shared no-op fake)
    llmJson: async () => {
      llmCallCount++;
      return [];
    },
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => [
      { name: "RivalCo", source: "user", mentions: 0, citations: 0, prompts: 0, userAbsent: false, visibilityScore: 0, citationShare: 0 },
    ],
  });

  assert.equal(finalJob.status, "complete");
  assert.equal(llmCallCount, 0, "every reference here is heuristically resolvable — the LLM must never be called");

  const byDomain = Object.fromEntries(backend.citations.map((c) => [c.domain, c]));

  assert.equal(byDomain["acme.com"].content_type, "homepage");
  assert.equal(byDomain["acme.com"].domain_type, "owned");
  assert.equal(byDomain["acme.com"].citation_class, "owned");

  assert.equal(byDomain["blog.example.com"].content_type, "article");
  assert.equal(byDomain["blog.example.com"].domain_type, "corporate");
  assert.equal(byDomain["blog.example.com"].citation_class, "earned");

  assert.equal(byDomain["reddit.com"].content_type, "forum");
  assert.equal(byDomain["reddit.com"].domain_type, "ugc");
  assert.equal(byDomain["reddit.com"].citation_class, "social");

  assert.equal(byDomain["rivalco.com"].content_type, "article");
  assert.equal(byDomain["rivalco.com"].domain_type, "competitor");
  assert.equal(byDomain["rivalco.com"].citation_class, "earned");
});

// ---------------------------------------------------------------------------
// Structural single-flight (P0.2 FIX 2): finalize claims "probing" ->
// "scoring" before insertScan, so two instances can't both complete it.
// ---------------------------------------------------------------------------

test("runFinalizePhase — two concurrent finalizes on the same job: exactly one insertScan / one scans row, the claim loser bails", async () => {
  const backend = makeFakeBackend();
  const jobId = "job-concurrent-finalize";
  backend.jobs.set(jobId, { id: jobId, status: "probing", brand: "Acme", url: "acme.com", heartbeat_at: new Date().toISOString() });

  const queries = makeQueries(4);
  const checkpoint = makeCheckpoint({ queries, brand: "Acme", url: "acme.com", engines: ["aio"] });
  queries.forEach((q) =>
    seedPromptResultRow(backend, { jobId, raw: makeProbeResult({ engine: "aio", query: q, visible: true }) })
  );

  const deps = {
    ...backend.deps,
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => [],
  };

  // This is the actual race: two chunk invocations both reach finalize for
  // the same job (e.g. a legitimately slow finalize plus a rescue that fired
  // on top of it) and race to claim it. Against pre-FIX-2 code (no claim at
  // all) BOTH of these would proceed straight through to insertScan.
  const [resultA, resultB] = await Promise.all([
    runFinalizePhase(jobId, checkpoint, deps),
    runFinalizePhase(jobId, checkpoint, deps),
  ]);

  const winners = [resultA, resultB].filter((r) => r && r.status === "complete");
  const losers = [resultA, resultB].filter((r) => r === null);
  assert.equal(winners.length, 1, "exactly one finalize attempt must complete");
  assert.equal(losers.length, 1, "exactly one finalize attempt must bail (lost the claim), returning null");
  assert.equal(
    backend.calls.insertScan.length,
    1,
    "insertScan must run exactly once — this fails against pre-FIX-2 code, which lets both callers reach it"
  );
  assert.equal(backend.scans.length, 1, "exactly one scans row must be created, never two");
  assert.equal(
    backend.calls.claimJobStatus.filter((c) => c.jobId === jobId).length,
    2,
    "both attempts must have gone through the claim"
  );
});

// ---------------------------------------------------------------------------
// runScanChunk dispatch edge cases
// ---------------------------------------------------------------------------

test("runScanChunk — already-complete job is a no-op (never re-finalizes)", async () => {
  const backend = makeFakeBackend();
  const job = await backend.deps.createScanJob({ brand: "Done Co", url: "done.co" });
  job.status = "complete";
  job.result_id = "scan-done";

  const result = await runScanChunk(job.id, backend.deps);
  assert.deepEqual(result, { ok: true, reason: "already_finished", status: "complete" });
  assert.equal(backend.scans.length, 0);
});

test("runScanChunk — unknown job id returns not_found without throwing", async () => {
  const backend = makeFakeBackend();
  const result = await runScanChunk("does-not-exist", backend.deps);
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

test("runScanChunk — a getScanJob read failure is reported, not thrown, and never marks the job failed", async () => {
  // R3.2.4: the fake backend first, so the scan_runs ledger is the in-memory
  // one. A bare `{ getScanJob }` here left `resolveChunkLedger` to fall through
  // to db.js's shared client, and this case opened a real run.
  const backend = makeFakeBackend();
  const result = await runScanChunk("job-x", {
    ...backend.deps,
    getScanJob: async () => {
      throw new Error("connection refused");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "read_failed");
});

// ---------------------------------------------------------------------------
// Scheduler tick
// ---------------------------------------------------------------------------

test("runSchedulerTick — creates jobs only for due schedules with no active scan, computes next_run_at from cadence, skips cadence:'off'", async () => {
  const backend = makeFakeBackend();
  const nowIso = new Date("2026-07-24T00:00:00.000Z").toISOString();

  backend.schedules.set("due-inactive.com", {
    brand: "due-inactive.com",
    display_name: "Due Inactive Co",
    cadence: "72h",
    enabled: true,
    next_run_at: null,
  });
  backend.schedules.set("due-but-active.com", {
    brand: "due-but-active.com",
    display_name: "Due But Active Co",
    cadence: "daily",
    enabled: true,
    next_run_at: null,
  });
  backend.schedules.set("off-cadence.com", {
    brand: "off-cadence.com",
    display_name: "Off Co",
    cadence: "off",
    enabled: true,
    next_run_at: null,
  });

  const activeBrands = new Set(["Due But Active Co"]);
  const kicked = [];

  const result = await runSchedulerTick(nowIso, {
    ...backend.deps,
    hasActiveScanForBrand: async (brand) => activeBrands.has(brand),
    runScanChunk: async (jobId) => {
      kicked.push(jobId);
    },
  });

  assert.equal(result.started.length, 1);
  assert.equal(result.started[0].brand, "Due Inactive Co");

  const createdJob = Array.from(backend.jobs.values()).find((j) => j.brand === "Due Inactive Co");
  assert.ok(createdJob, "must have created a scan_jobs row for the due+inactive brand");
  assert.equal(createdJob.url, "due-inactive.com");
  assert.equal(kicked.length, 1);
  assert.equal(kicked[0], createdJob.id);

  assert.equal(Array.from(backend.jobs.values()).filter((j) => j.brand === "Due But Active Co").length, 0);
  assert.equal(Array.from(backend.jobs.values()).filter((j) => j.brand === "Off Co").length, 0);

  const updatedSchedule = backend.schedules.get("due-inactive.com");
  assert.equal(updatedSchedule.last_run_at, nowIso);
  assert.equal(updatedSchedule.next_run_at, computeNextRunAt("72h", nowIso));

  assert.equal(backend.schedules.get("due-but-active.com").last_run_at, undefined, "unfired schedules must be untouched");
  assert.equal(backend.schedules.get("off-cadence.com").last_run_at, undefined);
});

test("runSchedulerTick — bumps next_run_at BEFORE firing the kick, and still bumps it even when the kick throws (FIX C, reviewer D7)", async () => {
  // Regression guard for the ordering bug: if the process dies right after
  // createScanJob — including during the fire-and-forget kick itself —
  // next_run_at must already be advanced, or listDueSchedules keeps finding
  // the schedule "due" and piles up a fresh job on every subsequent tick.
  //
  // An end-state-only assertion ("next_run_at ended up bumped") would pass
  // against the OLD create -> kick -> upsertSchedule ordering too, because
  // the kick's rejection is caught locally (`.catch`) and never blocks the
  // loop — so the real regression guard here is the call-order log: it
  // fails against the pre-fix ordering regardless of whether the kick
  // throws, and only the reordering itself (not the throw) is what FIX C
  // changed.
  const backend = makeFakeBackend();
  const nowIso = new Date("2026-07-24T00:00:00.000Z").toISOString();

  backend.schedules.set("flaky.com", {
    brand: "flaky.com",
    display_name: "Flaky Co",
    cadence: "daily",
    enabled: true,
    next_run_at: null,
  });

  const order = [];
  const result = await runSchedulerTick(nowIso, {
    ...backend.deps,
    hasActiveScanForBrand: async () => false,
    createScanJob: async (...args) => {
      order.push("createScanJob");
      return backend.deps.createScanJob(...args);
    },
    upsertScanSchedule: async (...args) => {
      order.push("upsertScanSchedule");
      return backend.deps.upsertScanSchedule(...args);
    },
    runScanChunk: async () => {
      order.push("kick");
      throw new Error("kick exploded");
    },
  });

  assert.equal(result.started.length, 1);
  assert.deepEqual(
    order,
    ["createScanJob", "upsertScanSchedule", "kick"],
    "the schedule must be bumped before the fire-and-forget kick is even invoked, not after"
  );

  const createdJob = Array.from(backend.jobs.values()).find((j) => j.brand === "Flaky Co");
  assert.ok(createdJob, "the job itself must still have been created (recoverable via the staleness sweep)");

  const updatedSchedule = backend.schedules.get("flaky.com");
  assert.equal(updatedSchedule.last_run_at, nowIso, "schedule must be bumped even though the kick failed");
  assert.equal(updatedSchedule.next_run_at, computeNextRunAt("daily", nowIso));
});

// ---------------------------------------------------------------------------
// Full lifecycle: multiple chunk invocations to completion
// ---------------------------------------------------------------------------

test("runScanChunk — full lifecycle across multiple chunk invocations: pending -> sourcing -> resumed probing -> finalize", async () => {
  const backend = makeFakeBackend();
  const POOL_SIZE = 12;
  // Text deliberately avoids any brand alias substring ("lifecycle",
  // "lifecycle co", "lifecycle.co") — sourceUnbrandedQueries' real
  // isBrandedQuery filter would otherwise (correctly) exclude these rows
  // from the reusable pool and force generation.
  const pool = Array.from({ length: POOL_SIZE }, (_, i) => ({
    text: `sample market research question number ${i}`,
    intent_tier: "informational",
    topic: "General",
    weight: 1,
    enabled: true,
    source: "llm_generated",
    created_at: `2026-07-0${(i % 9) + 1}T00:00:00Z`,
  }));

  const job = await backend.deps.createScanJob({
    brand: "Lifecycle Co",
    url: "lifecycle.co",
    industry: "saas",
    competitors: "RivalCo",
  });

  const probedPairs = [];
  const makeEngine = (name, concurrency) => ({
    name,
    label: name,
    concurrency,
    probe: async (query) => {
      probedPairs.push(`${name}|${query.text}`);
      return makeProbeResult({
        engine: name,
        query,
        visible: query.text.includes("2") || query.text.includes("5"),
        references: [{ href: "https://ref-example.com/a", title: "t", source: "s", domain: "ref-example.com" }],
      });
    },
  });

  // Deterministic fake clock (independent of real wall-clock speed): every
  // call advances by 20s; a 45s chunk budget lets ~2 batches through before
  // tripping, forcing several chunk invocations regardless of how fast the
  // in-memory fakes actually execute.
  let fakeNow = 0;
  const now = () => {
    fakeNow += 20_000;
    return fakeNow;
  };

  const deps = {
    ...backend.deps,
    promptTarget: POOL_SIZE,
    getPromptsForBrand: async () => pool,
    upsertPrompts: async () => ({}),
    generateUnbrandedPrompts: async () => {
      throw new Error("must not generate — pool is already full");
    },
    buildBrandedQueries: () => [],
    resolveEnabledEngines: () => [makeEngine("aio", 2), makeEngine("chatgpt", 2)],
    extractCompetitors: async ({ userCompetitors }) =>
      userCompetitors.map((name) => ({
        name,
        source: "user",
        mentions: 0,
        citations: 0,
        prompts: 0,
        userAbsent: false,
        visibilityScore: 0,
        citationShare: 0,
      })),
    now,
    chunkBudgetMs: 45_000,
  };

  let result;
  let iterations = 0;
  do {
    result = await runScanChunk(job.id, deps);
    iterations++;
    assert.ok(iterations < 50, "must converge well before 50 chunk invocations");
  } while (result.reason === "checkpointed");

  assert.equal(result.ok, true);
  assert.equal(result.reason, "complete");
  assert.equal(job.status, "complete");
  assert.ok(job.result_id);
  assert.ok(iterations > 1, "the tiny time budget must have forced at least one resume across chunks");

  // Every (engine, query) pair probed exactly once.
  assert.equal(probedPairs.length, POOL_SIZE * 2);
  assert.equal(new Set(probedPairs).size, POOL_SIZE * 2, "no pair probed twice across chunk resumes");

  const rows = backend.promptResults.filter((r) => r.job_id === job.id);
  assert.equal(rows.length, POOL_SIZE * 2);
  assert.ok(rows.every((r) => r.scan_id === job.result_id));

  assert.equal(backend.citations.length, POOL_SIZE * 2, "one citation per probe result (one reference each)");
  assert.ok(backend.citations.every((c) => c.job_id === job.id));

  const metricsForScan = backend.brandMetrics.filter((m) => m.scan_id === job.result_id);
  assert.equal(metricsForScan.length, 3, "aio + chatgpt + blended all");
  assert.ok(metricsForScan.some((m) => m.engine === "all"));

  const record = job.run_record;
  assert.equal(record.scoring_version, "v9-multi-engine");
  assert.equal(record.competitors_raw, "RivalCo");
  assert.equal(record.prompts_tracked, POOL_SIZE);
  assert.ok(record.prompt_set_hash);
  assert.equal(record.competitors[0].name, "RivalCo");
});
