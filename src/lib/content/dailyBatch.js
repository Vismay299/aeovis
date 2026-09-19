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

  // R2.8.4: a scan-read failure PROPAGATES to the caller (the cron at
  // src/app/api/content/worker/route.js counts it per brand and names it in
  // the response). Do not wrap this — `return []` below must keep meaning
  // "this brand has genuinely never been scanned, so there are no gaps to
  // work", not "we could not find out".
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
  //
  // R3.5.7 — A REWOUND ROW IS NOT LIVE WORK. A job in a running status that
  // already carries an `item_id` has DELIVERED; its status was rewound by a
  // second execution (see shouldRescueContentJob in src/lib/db/content.js).
  // Nothing is working it — R3.5.6 stopped the re-dispatch loop — so counting it
  // as live blocked the brand's ENTIRE daily batch until an operator cleared the
  // row by hand. The cron sweep now heals such rows, and this predicate no
  // longer depends on the heal having already happened.
  const geoJobs = jobs.filter(
    (j) => j.playbook === "geo_article" && CONTENT_JOB_RUNNING.includes(j.status)
  );
  const rewoundGeoJobs = geoJobs.filter((j) => !!j.item_id);
  const liveGeoJobs = geoJobs.filter((j) => !j.item_id);
  if (rewoundGeoJobs.length) {
    console.warn(
      `[daily-batch] ${brand}: ignoring ${rewoundGeoJobs.length} rewound geo_article job(s) ` +
        `(${rewoundGeoJobs.map((j) => `${j.id}:${j.status}`).join(", ")}) — each already delivered ` +
        `an item, so none of them is live work blocking today's batch (R3.5.7).`
    );
  }
  if (liveGeoJobs.length) {
    // A skip is not a success (standing rule 1): say which job caused it.
    console.log(
      `[daily-batch] ${brand}: skipped — geo_article job ${liveGeoJobs[0].id} is still live ` +
        `("${liveGeoJobs[0].status}"). No batch created for this brand today.`
    );
    return [];
  }

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
