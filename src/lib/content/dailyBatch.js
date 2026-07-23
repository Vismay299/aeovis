import { getScansForBrand } from "../db.js";
import {
  createContentJob,
  listContentItems,
  listContentJobs,
  CONTENT_JOB_RUNNING,
} from "../db/content.js";
import { normalizeScanRows } from "./steps/shared.js";

/**
 * Daily batch (Phase 4, default OFF): create up to CONTENT_DAILY_BATCH
 * geo_article jobs from the worst uncovered gaps of the most recent scan
 * for a brand. Off until dogfooding proves quality (locked plan note).
 *
 * "Worst" ordering: rank-not-cited gaps first (structure problem — cheapest
 * wins), then absent gaps with the most competitor citations (the queries
 * rivals are actively winning).
 */

export function getDailyBatchSize() {
  const n = Number(process.env.CONTENT_DAILY_BATCH);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 10) : 0;
}

function queryKey(text) {
  return String(text || "").toLowerCase().trim();
}

/** Pure gap selection — exported for tests. */
export function selectGapsForBatch(scan, { alreadyTargeted = new Set(), limit = 2 } = {}) {
  const rows = normalizeScanRows(scan).filter(
    (r) => !r.is_branded_query && r.present && !r.brand_cited
  );

  // One gap per query text; a query absent on multiple engines is still one gap.
  const byQuery = new Map();
  for (const r of rows) {
    const key = queryKey(r.prompt);
    if (!key || alreadyTargeted.has(key)) continue;
    const entry = byQuery.get(key) || {
      query: r.prompt,
      engines: [],
      rank_not_cited: false,
      competitor_citations: 0,
      sample: r,
    };
    entry.engines.push(r.engine);
    if (r.visible && !r.brand_cited) entry.rank_not_cited = true;
    entry.competitor_citations += (r.references || []).length;
    byQuery.set(key, entry);
  }

  return Array.from(byQuery.values())
    .filter((g) => !g.sample.visible || g.rank_not_cited)
    .sort((a, b) => {
      if (a.rank_not_cited !== b.rank_not_cited) return a.rank_not_cited ? -1 : 1;
      return b.competitor_citations - a.competitor_citations;
    })
    .slice(0, limit);
}

/**
 * Create batch jobs for one brand. Dedupes against every query already
 * targeted by an existing item or a live job. Returns created job records.
 */
export async function createDailyBatchJobs(brand, deps = {}) {
  const batchSize = deps.batchSize ?? getDailyBatchSize();
  if (batchSize <= 0) return [];

  const scans = await (deps.getScansForBrand || getScansForBrand)(brand);
  const scan = scans?.[0];
  if (!scan) return [];

  const [items, jobs] = await Promise.all([
    (deps.listContentItems || listContentItems)(brand),
    (deps.listContentJobs || listContentJobs)(brand, 50),
  ]);

  const alreadyTargeted = new Set();
  for (const item of items) {
    for (const q of item.target_queries || []) alreadyTargeted.add(queryKey(q));
  }
  for (const job of jobs) {
    if (job.status === "failed") continue;
    const q = job.input?.query;
    if (q) alreadyTargeted.add(queryKey(q));
  }

  // Respect the one-running-job-per-brand+playbook guard: if a geo job is
  // already live, skip this brand today rather than queueing a pile-up.
  const hasLiveGeoJob = jobs.some(
    (j) => j.playbook === "geo_article" && CONTENT_JOB_RUNNING.includes(j.status)
  );
  if (hasLiveGeoJob) return [];

  const gaps = selectGapsForBatch(scan, { alreadyTargeted, limit: batchSize });

  const created = [];
  for (const gap of gaps) {
    const job = await (deps.createContentJob || createContentJob)({
      brand,
      playbook: "geo_article",
      input: {
        type: "gap",
        source: "daily_batch",
        query: gap.query,
        engine: gap.engines[0] || "aio",
        gap_kind: gap.rank_not_cited ? "rank_not_cited" : "absent",
        answer_text: gap.sample.text || "",
        citations: (gap.sample.references || []).map((r) => ({ href: r.href, title: r.title })),
        topic: gap.sample.topic,
      },
    });
    created.push(job);
  }
  return created;
}
