// Isolated scan persistence for simulations and worker tests. No database or network access.
export function makeMemoryScanBackend() {
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
    // src/shared/analytics/citationEnrich.js (which itself defaults to a real
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
    // normally unset; with `--env-file=.env.local` (which src/server/liveDbGate.js
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
