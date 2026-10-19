import { contentLlmJson } from "../llm.js";
import { getScansForBrand } from "../db.js";
import { listContentItems } from "../db/content.js";
import { scanHeadline } from "../scoring/scanHeadline.js";

// ---------------------------------------------------------------------------
// R3.6.3 — Report quota: one report per brand per day.
//
// The paid refresh button was unmetered. A brand could regenerate its report
// on every click, each one costing an LLM call. This quota limits generation
// to once per brand per UTC day. The check is in-memory by default (same
// pattern as scanRateLimit in analytics.js); pass deps.checkReportQuota and
// deps.recordReportGeneration to override with a DB-backed implementation.
// ---------------------------------------------------------------------------

global.memoryReportQuota = global.memoryReportQuota || new Map();

function quotaDate(now) {
  return (now || new Date().toISOString()).slice(0, 10);
}

function quotaKey(brand, date) {
  return `${String(brand).trim().toLowerCase()}:${date}`;
}

/**
 * How many reports this brand has generated today. 0 means "under quota".
 * In-memory; pass deps.checkReportQuota to override.
 */
export function checkReportQuota(brand, deps = {}) {
  if (typeof deps.checkReportQuota === "function") return deps.checkReportQuota(brand);
  const date = quotaDate(deps.now);
  const key = quotaKey(brand, date);
  return global.memoryReportQuota.get(key) || 0;
}

/**
 * Record that a report was generated for this brand today.
 * In-memory; pass deps.recordReportGeneration to override.
 */
export function recordReportGeneration(brand, deps = {}) {
  if (typeof deps.recordReportGeneration === "function") return deps.recordReportGeneration(brand);
  const date = quotaDate(deps.now);
  const key = quotaKey(brand, date);
  global.memoryReportQuota.set(key, (global.memoryReportQuota.get(key) || 0) + 1);
}

/** The daily limit. 1 means "one report per brand per day". */
export const REPORT_QUOTA_PER_DAY = 1;

/**
 * Weekly report (Phase 4): one LLM call over scan history + content
 * activity, landing in Studio. Three KPIs with week-over-week deltas,
 * per-engine visibility, top movers, and EXACTLY three prioritized actions —
 * each backed by a number and tied to a concrete next step.
 *
 * "Fifteen opportunities is a to-do list nobody runs; three with numbers is
 * a plan." This is also the retention artifact the future paid tier emails.
 *
 * The deterministic KPI math is done in code; the LLM only writes the three
 * priorities and the narrative. Numbers never come from the model.
 */

function pct(n) {
  return n == null ? null : Math.round(Number(n) * 10) / 10;
}

function scanMetrics(scan) {
  const headline = scanHeadline(scan);
  const raw = scan?.raw_results || {};
  const summary = raw.summary_stats || {};
  const engines = raw.engines || {};
  const perEngine = {};
  for (const [name, s] of Object.entries(engines)) {
    perEngine[name] = pct(s?.share_of_ai_pct);
  }
  return {
    scanned_at: scan?.scanned_at,
    visibility_index_pct:
      headline ? headline.value : (pct(raw.visibility_index_pct) ?? pct(scan?.visibility_pct) ?? null),
    share_of_ai_pct: pct(summary.share_of_ai_pct ?? scan?.visibility_pct),
    aio_coverage_pct: pct(summary.aio_coverage_pct),
    citation_share_pct: pct(summary.citation_share_pct),
    per_engine: perEngine,
    prompts_tracked: scan?.prompts_tracked ?? null,
  };
}

function delta(cur, prev) {
  if (cur == null || prev == null) return null;
  return Math.round((cur - prev) * 10) / 10;
}

/** Build the deterministic KPI block from the two most recent scans. */
export function computeReportKpis(scans) {
  const sorted = [...(scans || [])].sort(
    (a, b) => new Date(b.scanned_at) - new Date(a.scanned_at)
  );
  const current = sorted[0] ? scanMetrics(sorted[0]) : null;
  const previous = sorted[1] ? scanMetrics(sorted[1]) : null;

  if (!current) return null;

  const kpis = [
    {
      key: "visibility_index",
      label: "AI Visibility Index",
      value: current.visibility_index_pct,
      delta: previous ? delta(current.visibility_index_pct, previous.visibility_index_pct) : null,
      unit: "%",
    },
    {
      key: "aio_coverage",
      label: "AI answer coverage",
      value: current.aio_coverage_pct,
      delta: previous ? delta(current.aio_coverage_pct, previous.aio_coverage_pct) : null,
      unit: "%",
    },
    {
      key: "citation_share",
      label: "Citation share",
      value: current.citation_share_pct,
      delta: previous ? delta(current.citation_share_pct, previous.citation_share_pct) : null,
      unit: "%",
    },
  ];

  const perEngine = Object.keys(current.per_engine).map((name) => ({
    engine: name,
    value: current.per_engine[name],
    delta: previous ? delta(current.per_engine[name], previous.per_engine?.[name]) : null,
  }));

  return { current, previous, kpis, per_engine: perEngine };
}

/** The worst uncovered gaps, for the LLM to tie priorities to real queries. */
function worstGaps(scan, limit = 8) {
  const rows = scan?.raw_results?.results || scan?.results || [];
  return rows
    .filter(
      (r) =>
        !(r.is_branded_query ?? r.isBrandedQuery) &&
        (r.answer_present || r.aio_present) &&
        !(r.brand_cited ?? r.brandCited)
    )
    .map((r) => ({
      query: r.prompt,
      engine: r.engine || "aio",
      visible: !!r.visible,
    }))
    .slice(0, limit);
}

export async function generateWeeklyReport(brand, deps = {}) {
  // R3.6.3 — quota check: one report per brand per day.
  const used = checkReportQuota(brand, deps);
  if (used >= REPORT_QUOTA_PER_DAY) {
    return {
      brand,
      error: `Report quota exceeded — ${brand} has already generated a report today. Try again tomorrow.`,
      quota_exceeded: true,
    };
  }

  // R2.8.4: a scan-read failure propagates out of here to the route's outer
  // catch, which answers 500. That is deliberate — before, a DB outage came
  // back as [] and this branch told the user "No scans yet" over a 400, the
  // same lie the dashboard was telling. This message is now reachable only
  // when the database answered and the brand really has no scans.
  const scans = await (deps.getScansForBrand || getScansForBrand)(brand);
  if (!scans || scans.length === 0) {
    return { brand, error: "No scans yet — run a scan before generating a report." };
  }

  const kpiBlock = computeReportKpis(scans);
  const items = await (deps.listContentItems || listContentItems)(brand);

  const contentActivity = {
    total: items.length,
    approved: items.filter((i) => i.status === "approved").length,
    awaiting: items.filter((i) => i.status === "awaiting_approval").length,
    rejected: items.filter((i) => i.status === "rejected").length,
  };

  const gaps = worstGaps(scans[0]);

  const prompt = `You are the analyst writing a brand's weekly GEO visibility report.
The KPI numbers are COMPUTED and FINAL — never change them, never invent new ones.
Your job is the narrative and EXACTLY THREE priorities.

## Computed KPIs (with week-over-week deltas)
${JSON.stringify(kpiBlock?.kpis || [], null, 2)}

## Per-engine visibility
${JSON.stringify(kpiBlock?.per_engine || [], null, 2)}

## Content pipeline activity this period
${JSON.stringify(contentActivity, null, 2)}

## Worst uncovered gaps (queries where the brand answers but is never cited, or is absent)
${JSON.stringify(gaps, null, 2)}

## Rules
- EXACTLY three priorities. Not two, not five. Three is a plan; fifteen is noise.
- Each priority MUST cite one of the numbers above and tie to ONE concrete next
  action a human can take this week (e.g. "Perplexity share fell 8% — generate
  GEO articles for these 2 gaps: <query>, <query>").
- Reference specific gap queries by name where a priority is about content.
- headline: one sentence, the single most important fact this week.
- Be direct. No filler, no "in today's landscape", no hedging.

## Output — return ONLY this JSON
{
  "headline": "one sentence",
  "summary": "2-3 sentence narrative grounded in the KPI deltas",
  "top_movers": ["engine or metric that moved most, with its number"],
  "priorities": [
    { "title": "short imperative", "why": "the number that justifies it", "action": "the concrete next step, naming gap queries if relevant" }
  ]
}`;

  const call = deps.llm || contentLlmJson;
  const out = await call(prompt, { stats: deps.stats, temperature: 0.3, max_tokens: 2000 });

  const priorities = Array.isArray(out?.priorities) ? out.priorities.slice(0, 3) : [];

  // R3.6.3 — record the generation AFTER the LLM call succeeds. If the LLM
  // throws, the quota is not consumed — the brand can retry.
  recordReportGeneration(brand, deps);

  return {
    brand,
    generated_at: deps.now || null,
    kpis: kpiBlock?.kpis || [],
    per_engine: kpiBlock?.per_engine || [],
    content_activity: contentActivity,
    headline: out?.headline || "",
    summary: out?.summary || "",
    top_movers: Array.isArray(out?.top_movers) ? out.top_movers : [],
    priorities,
    has_previous: !!kpiBlock?.previous,
  };
}
