import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { runProbingPhase, runFinalizePhase } from "./scanWorker.js";
import {
  describeEngineSetChange,
  ENGINE_SET_STATES,
} from "../scoring/enginePipeline.js";

/**
 * R3.2.5 (finding B3) — a frozen engine that stops resolving must not shrink
 * the headline in silence.
 *
 * THE DEFECT. `checkpoint.engines` is frozen at sourcing time so a mid-scan env
 * change cannot re-pick a running scan's engines. Two things break that promise
 * and both used to leave the scan record blank:
 *
 *   (a) SHRANK    — a frozen engine stops being registered, is never probed,
 *                   and the index is blended over the engines that remain.
 *                   `scans.engines_counted` falls with no reason attached.
 *   (b) REFROZEN  — persisted rows from a surface outside the frozen set,
 *                   possible on historical scans made before dispatch was
 *                   fenced to the frozen work matrix.
 *
 * R3.2.2 put both in `scan_runs.detail.skips`, which an operator reads and a
 * dashboard does not. These tests drive an engine out of the registry BETWEEN
 * two probing chunks of one scan and assert the finalized scan record says so —
 * they fail if it is silent, which is the whole accept.
 *
 * NO DATABASE IS TOUCHED. Every dep is injected; insertScan is a fake that
 * keeps the record in memory, and no vendor is called (the engine stubs return
 * canned answers).
 */

/**
 * Six, not four: computeHeadline only counts a slice with at least
 * HEADLINE_MIN_NON_BRANDED_ANSWERS (5) answered non-branded rows, so a shorter
 * set would give engines_counted 0 on both sides and the "the headline was
 * blended over fewer engines" claim these tests exist to make would be vacuous.
 */
const QUERIES = [
  { text: "best crm for small teams", is_branded: false },
  { text: "crm pricing comparison", is_branded: false },
  { text: "how to migrate crm data", is_branded: false },
  { text: "crm with good support", is_branded: false },
  { text: "top crm integrations", is_branded: false },
  { text: "best crm for onboarding", is_branded: false },
];

/** One canned probe result, in the shape enginePipeline's engines return. */
function probeResult(engineName, query, visible) {
  return {
    engine: engineName,
    prompt: query.text,
    is_branded_query: false,
    topic: "General",
    source: "llm_generated",
    intent_tier: "commercial",
    answer_present: true,
    aio_present: true,
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

/** A registry entry that answers without leaving the process. */
function fakeEngine(name) {
  return {
    name,
    concurrency: 2,
    isConfigured: () => true,
    probe: async (query) => probeResult(name, query, query.text.includes("best")),
  };
}

function makeBackend() {
  const rows = [];
  const jobs = new Map();
  const scans = [];
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
    // --- finalize ---
    claimJobStatus: async () => true,
    getPromptResultsForJob: async () => rows,
    insertScan: async (record) => {
      const id = `scan-${scans.length + 1}`;
      scans.push({ id, ...record });
      return [{ id }];
    },
    stampScanIdForJob: async () => {},
    deleteCitationsForJob: async () => {},
    insertCitations: async () => {},
    deleteResultBrandsForJob: async () => {},
    insertResultBrands: async () => {},
    upsertBrandMetricsDaily: async () => {},
    getScansByDomain: async () => [],
    getResultBrandsForScan: async () => [],
    extractCompetitors: async () => [],
    enrichCitations: async (c) => c,
  };

  return { rows, jobs, scans, deps };
}

function baseCheckpoint(frozen) {
  return {
    brand: "Acme",
    url: "acme.com",
    industry: "saas",
    competitors: [],
    competitors_raw: "",
    prompt_key: "acme.com",
    prompt_source: "llm_generated",
    static_pack_prompts: null,
    queries: QUERIES,
    unbranded_texts: QUERIES.map((q) => q.text),
    engines: frozen,
    stats: { cost: 0, tokens: 0, website_scrape: null },
    sourced_at: new Date().toISOString(),
  };
}

/**
 * One scan, two probing chunks, with the live registry CHANGING between them —
 * which is what "mid-scan" means here. Chunk 1 is cut off by the time budget
 * after a single batch; chunk 2 resumes against `registryAfter`.
 */
async function scanWithRegistryChange({ frozen, registryBefore, registryAfter, registryAtFinalize }) {
  const backend = makeBackend();
  const jobId = "job-r325";

  // Chunk 1 — the full frozen set is registered. Budget 0 stops it after the
  // first batch, so plenty of pairs are still unprobed when the registry moves.
  const chunkOne = await runProbingPhase(
    jobId,
    baseCheckpoint(frozen),
    {
      ...backend.deps,
      resolveEnabledEngines: () => registryBefore.map(fakeEngine),
      chunkBudgetMs: 0,
      now: () => 1000,
    },
    0,
    {}
  );
  assert.equal(chunkOne.budgetHit, true, "chunk 1 must stop mid-scan, or nothing is driven out mid-scan");

  // Chunk 2 — the registry has moved under the running scan.
  const chunkTwo = await runProbingPhase(
    jobId,
    chunkOne.checkpoint,
    {
      ...backend.deps,
      resolveEnabledEngines: () => registryAfter.map(fakeEngine),
    },
    // A real chunk start: `0` would make every elapsed-time check exceed the
    // default budget and cut chunk 2 short too.
    Date.now(),
    {}
  );

  const job = await runFinalizePhase(jobId, chunkTwo.checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => (registryAtFinalize || registryAfter).map(fakeEngine),
  });

  return { backend, job, chunkOne, chunkTwo, saved: backend.scans[0] };
}

// ---------------------------------------------------------------------------
// The accept: an engine driven out mid-scan, and a record that says so.
// ---------------------------------------------------------------------------

test("R3.2.5 — a frozen engine driven out mid-scan lands on the SCAN RECORD, not just the ledger", async () => {
  const { saved, job, chunkTwo } = await scanWithRegistryChange({
    frozen: ["aio", "perplexity"],
    registryBefore: ["aio", "perplexity"],
    registryAfter: ["aio"],
  });

  // The damage is real: the headline is blended over one engine, not the two
  // this scan was frozen with.
  assert.equal(saved.engines_counted, 1, "perplexity was never probed, so it cannot be counted");

  const change = saved.summary_stats.engine_set_change;
  assert.ok(
    change,
    "THE BUG: engines_counted fell from 2 to 1 and the scan record carried no reason for it"
  );
  assert.equal(change.state, ENGINE_SET_STATES.SHRANK, "some frozen engines still resolved");
  assert.deepEqual(
    change.dropped_engines.map((e) => e.engine),
    ["perplexity"],
    "the record must name the engine that went away"
  );
  assert.deepEqual(change.resolved_engines.map((e) => e.engine), ["aio"]);
  assert.equal(change.engines_frozen, 2);
  assert.equal(change.engines_resolved, 1);

  // What a dashboard renders. Prose, naming the engine and the arithmetic
  // behind engines_counted — the R2.2.6 shape, one step earlier.
  assert.match(change.title, /Perplexity/, "the title must name the engine");
  assert.match(change.detail, /1 of the 2 engines/, "the detail must say why engines_counted fell");

  // The same verdict is on the job's run_record and on the checkpoint that
  // survived the chunk boundary, so a mid-run reader sees it too.
  assert.equal(job.run_record.summary_stats.engine_set_change.state, ENGINE_SET_STATES.SHRANK);
  assert.equal(chunkTwo.checkpoint.engine_set_change.state, ENGINE_SET_STATES.SHRANK);
});

test("R3.2.5 — losing every frozen engine never substitutes today's set", async () => {
  const { saved } = await scanWithRegistryChange({
    frozen: ["aio", "perplexity"],
    registryBefore: ["aio", "perplexity"],
    // Every frozen engine is gone; today's set must not be probed instead.
    registryAfter: ["chatgpt"],
  });

  const change = saved.summary_stats.engine_set_change;
  assert.ok(change, "a scan whose frozen engines vanished cannot be silent");
  assert.equal(change.state, ENGINE_SET_STATES.SHRANK);
  assert.deepEqual(change.resolved_engines, [], "nothing frozen survived");
  assert.deepEqual(change.substituted_engines, []);
  assert.equal(saved.engines_counted, 0);
  assert.equal(saved.summary_stats.terminal_outcome.outcome, "blocked");
  assert.match(change.detail, /No frozen engine remained/);
});

test("R3.2.5 — a scan where every frozen engine resolved carries NO marker", async () => {
  const { saved } = await scanWithRegistryChange({
    frozen: ["aio", "perplexity"],
    registryBefore: ["aio", "perplexity"],
    registryAfter: ["aio", "perplexity"],
  });

  assert.equal(saved.engines_counted, 2, "both engines were probed");
  assert.equal(
    "engine_set_change" in saved.summary_stats,
    false,
    "the happy path must not be annotated — the key's presence is the signal"
  );
  assert.ok(saved.summary_stats.visibility_pct !== undefined, "the rest of summary_stats is untouched");
});

test("R3.2.5 — an engine that vanished mid-run and came back is still on the record", async () => {
  // The registry is whole again by the time finalize runs. A finalize-time
  // registry check alone would find nothing and report a clean scan; the
  // checkpoint remembers that chunk 2 never probed perplexity's pairs.
  const { saved } = await scanWithRegistryChange({
    frozen: ["aio", "perplexity"],
    registryBefore: ["aio", "perplexity"],
    registryAfter: ["aio"],
    registryAtFinalize: ["aio", "perplexity"],
  });

  const change = saved.summary_stats.engine_set_change;
  assert.ok(change, "a drop that healed before finalize still happened");
  assert.equal(change.state, ENGINE_SET_STATES.SHRANK);
  assert.deepEqual(change.dropped_engines.map((e) => e.engine), ["perplexity"]);
});

test("R3.2.5 — finalize catches a refreeze from the ROWS even with no checkpoint stamp", async () => {
  // The evidence path on its own: a checkpoint that never carried the stamp
  // (an older in-flight job, or one whose probing chunk predates R3.2.5) plus
  // persisted rows from an engine that was never frozen.
  const backend = makeBackend();
  const jobId = "job-r325-evidence";

  // A legacy persisted row may predate the frozen-dispatch guard. Recreate
  // that historical evidence directly; the current worker must not make it.
  const unexpected = probeResult("chatgpt", QUERIES[0], true);
  await backend.deps.upsertPromptResults([{
    job_id: jobId, brand: "acme.com", query: QUERIES[0].text,
    engine: "chatgpt", answered: true, mentioned: true,
    raw: unexpected,
  }]);

  // Strip the stamp: finalize must reach the same verdict from the rows alone.
  const stripped = baseCheckpoint(["aio", "perplexity"]);
  const job = await runFinalizePhase(jobId, stripped, {
    ...backend.deps,
    // The registry has recovered, so only the rows can prove the substitution.
    resolveEnabledEngines: () => ["aio", "perplexity"].map(fakeEngine),
  });

  const change = job.run_record.summary_stats.engine_set_change;
  assert.ok(change, "rows from a never-frozen engine are proof of a refreeze");
  assert.equal(change.state, ENGINE_SET_STATES.REFROZEN);
  assert.deepEqual(change.substituted_engines.map((e) => e.engine), ["chatgpt"]);
});

/**
 * WHAT THIS PROVES AND WHAT IT DOES NOT.
 *
 * Everything above is RUN: the phases execute, the record is built, the field
 * is on it. The hop after that — insertScan writing it and an API route handing
 * it back — cannot be run here: db.js needs a real Supabase client and the API
 * shapers import through the `@/` alias, which node's test runner does not
 * resolve. So this is a SOURCE GUARD, and it is deliberately narrow: it pins
 * the one property that made `summary_stats` the right carrier at all.
 *
 * insertScan is an ALLOWLIST, not a pass-through (db.js says so in its own
 * comment). A field it does not name is dropped before the write with nothing
 * logged. If `summary_stats` ever leaves that list, this record vanishes in
 * exactly the silence R3.2.5 exists to end — and no test above would notice,
 * because they all stop at the record insertScan is handed.
 *
 * IT DOES NOT PROVE A DASHBOARD RENDERS ANYTHING. No component reads
 * engine_set_change yet; wiring one is a follow-up. It proves the state reaches
 * the row and survives to `scan.summary_stats` in the two route shapers.
 */
test("R3.2.5 — summary_stats is a field insertScan actually persists", () => {
  const dbSource = readFileSync(new URL("../db.js", import.meta.url), "utf8");
  assert.match(
    dbSource,
    /summary_stats:\s*scanRecord\.summary_stats/,
    "insertScan's raw_results allowlist must still carry summary_stats — engine_set_change rides inside it"
  );
  assert.doesNotMatch(
    dbSource,
    /engine_set_change/,
    "engine_set_change must NOT need its own allowlist entry; if it grows one, move it out of summary_stats"
  );

  for (const shaper of [
    "../../app/api/scans/_lib/scanRow.js",
    "../../app/api/scans/[brand]/route.js",
  ]) {
    const source = readFileSync(new URL(shaper, import.meta.url), "utf8");
    assert.match(
      source,
      /const summary_stats\s*=\s*\n?\s*raw\.summary_stats/,
      `${shaper} must hand the stored summary_stats back verbatim, not rebuild a fixed subset of it`
    );
  }
});

// ---------------------------------------------------------------------------
// The decision itself, exercised directly.
// ---------------------------------------------------------------------------

test("describeEngineSetChange returns null when nothing changed, and when nothing was frozen", () => {
  assert.equal(
    describeEngineSetChange({ frozen: ["aio", "perplexity"], registered: ["aio", "perplexity"] }),
    null,
    "every frozen engine resolved"
  );
  assert.equal(
    describeEngineSetChange({ frozen: ["aio"], registered: ["aio", "chatgpt"], probed: ["aio"] }),
    null,
    "a registry that GREW does not change what this scan was frozen with"
  );
  assert.equal(
    describeEngineSetChange({ frozen: [], registered: ["aio"] }),
    null,
    "a scan with no frozen set has nothing to have changed from"
  );
  assert.equal(describeEngineSetChange({ frozen: null, registered: ["aio"] }), null);
  assert.equal(describeEngineSetChange(), null);
});

test("describeEngineSetChange tells a shrink apart from a refreeze", () => {
  const shrank = describeEngineSetChange({
    frozen: ["aio", "perplexity", "chatgpt"],
    registered: ["aio", "chatgpt"],
  });
  assert.equal(shrank.state, ENGINE_SET_STATES.SHRANK);
  assert.equal(shrank.engines_resolved, 2);
  assert.equal(shrank.engines_frozen, 3);

  const refrozen = describeEngineSetChange({
    frozen: ["aio", "perplexity"],
    registered: ["chatgpt"],
    priorSubstituted: ["chatgpt"],
  });
  assert.equal(refrozen.state, ENGINE_SET_STATES.REFROZEN);

  // The nastiest case: the registry looks whole, but rows exist from an engine
  // this scan never froze. Evidence beats configuration.
  const evidenced = describeEngineSetChange({
    frozen: ["aio", "perplexity"],
    registered: ["aio", "perplexity"],
    probed: ["aio", "perplexity", "chatgpt"],
  });
  assert.equal(evidenced.state, ENGINE_SET_STATES.REFROZEN);
  assert.deepEqual(evidenced.substituted_engines.map((e) => e.engine), ["chatgpt"]);
});

test("describeEngineSetChange keeps a prior chunk's drop, and refuses one it never froze", () => {
  const sticky = describeEngineSetChange({
    frozen: ["aio", "perplexity"],
    registered: ["aio", "perplexity"],
    probed: ["aio", "perplexity"],
    priorDropped: ["perplexity"],
  });
  assert.equal(sticky.state, ENGINE_SET_STATES.SHRANK, "an earlier chunk saw it go");

  const bogus = describeEngineSetChange({
    frozen: ["aio", "perplexity"],
    registered: ["aio", "perplexity"],
    priorDropped: ["gemini-3"],
  });
  assert.equal(bogus, null, "a checkpoint cannot add an engine this scan never froze");
});

test("describeEngineSetChange never counts 'I did not look' as 'nothing was probed'", () => {
  // probed omitted (probing does not know) vs probed: [] (finalize looked and
  // found no rows). Neither may invent a substitution.
  const notLooked = describeEngineSetChange({ frozen: ["aio"], registered: ["aio"] });
  const lookedFoundNone = describeEngineSetChange({ frozen: ["aio"], registered: ["aio"], probed: [] });
  assert.equal(notLooked, null);
  assert.equal(lookedFoundNone, null);

  // An empty scan whose engine really is gone is a drop, not a substitution.
  const gone = describeEngineSetChange({ frozen: ["aio"], registered: [], probed: [] });
  assert.equal(gone.state, ENGINE_SET_STATES.SHRANK);
  assert.deepEqual(gone.substituted_engines, [], "no substitute was observed, so none is claimed");
  assert.match(gone.detail, /No frozen engine remained/);
});

// ---------------------------------------------------------------------------
// R3.2.9 — On a refrozen scan, finalize summarizes the rows that actually
// exist rather than the frozen list that produced none.
// ---------------------------------------------------------------------------

test("R3.2.9 — a refrozen scan summarizes the rows that actually exist, not the frozen list that produced none", async () => {
  // Historical scans may already contain substituted rows from the old
  // fallback. New probing must never create them, but finalize still needs to
  // read the evidence that was already persisted.
  //
  // Use 8 queries (not 6) so that the legacy chatgpt rows pass
  // HEADLINE_MIN_NON_BRANDED_ANSWERS (5) and be eligible in computeHeadline.
  const MORE_QUERIES = [
    ...QUERIES,
    { text: "best crm for remote teams", is_branded: false },
    { text: "crm for startups", is_branded: false },
  ];

  const backend = makeBackend();
  const jobId = "job-r329";

  const frozen = ["aio", "perplexity"];
  const cp = {
    brand: "Acme",
    url: "acme.com",
    industry: "saas",
    competitors: [],
    competitors_raw: "",
    prompt_key: "acme.com",
    prompt_source: "llm_generated",
    static_pack_prompts: null,
    queries: MORE_QUERIES,
    unbranded_texts: MORE_QUERIES.map((q) => q.text),
    engines: frozen,
    stats: { cost: 0, tokens: 0, website_scrape: null },
    sourced_at: new Date().toISOString(),
  };

  // Chunk 1 — budget 0 stops after the first batch (2 aio rows).
  const chunkOne = await runProbingPhase(
    jobId,
    cp,
    {
      ...backend.deps,
      resolveEnabledEngines: () => ["aio", "perplexity"].map(fakeEngine),
      chunkBudgetMs: 0,
      now: () => 1000,
    },
    0,
    {}
  );
  assert.equal(chunkOne.budgetHit, true, "chunk 1 must stop mid-scan");

  // Chunk 2 — registry changed to chatgpt only.
  const chunkTwo = await runProbingPhase(
    jobId,
    chunkOne.checkpoint,
    {
      ...backend.deps,
      resolveEnabledEngines: () => ["chatgpt"].map(fakeEngine),
    },
    Date.now(),
    {}
  );

  // Simulate six legacy rows written by a pre-guard worker. The current worker
  // above must have dispatched none of these.
  assert.equal(backend.rows.filter((r) => r.engine === "chatgpt").length, 0);
  await backend.deps.upsertPromptResults(MORE_QUERIES.slice(2).map((query) => ({
    job_id: jobId, brand: "acme.com", query: query.text, engine: "chatgpt",
    answered: true, mentioned: query.text.includes("best"),
    raw: probeResult("chatgpt", query, query.text.includes("best")),
  })));

  // Finalize — must summarize those historical rows, not only the frozen list.
  const job = await runFinalizePhase(jobId, chunkTwo.checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => ["chatgpt"].map(fakeEngine),
  });

  const saved = backend.scans[0];

  // engines_counted must reflect chatgpt's data, not be 0.
  assert.ok(
    saved.engines_counted > 0,
    `THE BUG: engines_counted was ${saved.engines_counted} because finalize summarized the frozen list that produced no rows, ignoring chatgpt's rows`
  );

  // The engine_set_change marker is still present and says REFROZEN.
  const change = saved.summary_stats.engine_set_change;
  assert.ok(change, "the refreeze marker must still be present");
  assert.equal(change.state, ENGINE_SET_STATES.REFROZEN);

  // The scan record's engine summaries must include chatgpt — the engine that
  // actually produced rows — and engines_counted must reflect real evidence.
  assert.ok(
    saved.engines && saved.engines.chatgpt,
    "the engine summaries must include chatgpt, the engine that actually produced rows"
  );
  assert.ok(
    saved.engines_counted >= 1,
    "engines_counted must reflect at least one engine that produced evidence"
  );
});
