/**
 * Defensive readers for the scan payloads. Every field can be null, missing,
 * or in a shape the worker does not document, so nothing here throws and
 * nothing turns an unknown into a number.
 */
import {terminalOutcomeFromRecord} from "../../../lib/scanOutcome.js";
import {validateMetric,METRIC_REASON_DETAIL} from "../../../lib/scoring/metricContract.js";

const ENGINE_LABELS = {
  google_ai_overview: "Google AI Overviews",
  aio: "Google AI Overviews",
  openai: "ChatGPT",
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  gemini: "Gemini",
  claude: "Claude",
};

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 41.6 -> 42; null / NaN -> null. Used for Stat values (Stat renders null as an em dash). */
export function roundedPct(value) {
  const n = finiteNumber(value);
  return n === null ? null : Math.round(n);
}

export function qualifiedMetricValue(metric){
  const value=finiteNumber(metric?.qualified_pct),raw=finiteNumber(metric?.value_pct);
  return metric?.qualified===true && validateMetric(metric).valid && value!==null && value>=0 && value<=100 && raw!==null && Math.abs(value-raw)<=0.05 ? value : null;
}

export function customerReportQuality(scan){
  // summary_stats.metrics is the primary engine slice, not a blended scan figure.
  // It speaks for the scan only when one engine was measured; otherwise keep the
  // stored scan-level scalars the report has always shown.
  const sliced=Object.values(scan?.engines || {}).filter(slice=>isRecord(slice?.metrics)).length===1;
  const metrics=sliced ? scan?.summary_stats?.metrics || {} : null;
  return {outcome:terminalOutcomeFromRecord(scan),headline:qualifiedMetricValue(scan?.summary_stats?.headline_metric),
    share:metrics ? qualifiedMetricValue(metrics.share_of_voice) : finiteNumber(scan?.share_of_voice_pct),
    citation:metrics ? qualifiedMetricValue(metrics.owned_citation) : finiteNumber(scan?.brand_citation_share_pct)};
}

export function engineMetricReading(summary,legacyPct){
  const metric=summary?.metrics?.observed_exposure;
  if(!metric)return {pct:summary?.data_source_issue ? null : legacyPct,legacy:true,incomplete:summary?.data_source_issue===true,note:"Legacy reading: qualification is unknown."};
  const valid=finiteNumber(metric.collection?.valid),planned=finiteNumber(metric.collection?.planned);
  const pct=qualifiedMetricValue(metric);
  return {pct,legacy:false,incomplete:valid!==null && planned>0 ? valid<planned : summary?.data_source_issue===true,
    note:pct===null ? METRIC_REASON_DETAIL[metric.qualified_reason] || "No qualified measurement is available." : null,
    exploratory:finiteNumber(metric.value_pct),numerator:metric.numerator,denominator:metric.denominator};
}

export function engineLabel(engine) {
  if (!engine) return "Unknown engine";
  const key = String(engine);
  if (ENGINE_LABELS[key]) return ENGINE_LABELS[key];
  return key.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** scans.platform is a free-form string; arrays are joined, anything else is "—". */
export function platformLabel(platform) {
  if (typeof platform === "string" && platform.trim()) {
    return platform.split(/[,+]/).map((part) => engineLabel(part.trim())).join(", ");
  }
  if (Array.isArray(platform) && platform.length) {
    return platform.map((part) => engineLabel(part)).join(", ");
  }
  return "—";
}

/**
 * How a history row draws its visibility bar. A real number is measured; a null
 * score on a finalized scan (scanned_at) or a failed collection is settled
 * "not measured". Healthy collections can also finish without a score when
 * no answer names a tracked brand. Only an unfinished scan stays pending.
 * Returns "measured" | "unmeasured" | "pending".
 */
export function scanVisibilityState(scan) {
  if (finiteNumber(scan?.visibility_pct) !== null) return "measured";
  return scan?.scanned_at || scan?.collection_partial === true ? "unmeasured" : "pending";
}

/**
 * Per-engine visibility -> [{ name, pct }] sorted high to low. Current workers
 * write summaries under engines; older scans only carry engine_scores.
 * An unmeasured current slice stays absent rather than using a legacy score.
 */
export function readEngineScores(engineScores, engines) {
  const rows = [];
  if (isRecord(engines) || Array.isArray(engines)) {
    const entries = Array.isArray(engines)
      ? engines.map((slice) => [slice?.engine || slice?.name, slice])
      : Object.entries(engines);
    entries.forEach(([name, slice]) => {
      if (!name || !isRecord(slice)) return;
      const pct = finiteNumber(slice.visibility_pct);
      if (pct !== null || slice.data_source_issue === true || slice.insufficient_sample === true || isRecord(slice.metrics?.observed_exposure)) rows.push({ name: String(name), pct });
    });
  } else if (isRecord(engineScores)) {
    Object.entries(engineScores).forEach(([name, value]) => {
      const pct = finiteNumber(value);
      if (pct !== null) rows.push({ name, pct });
    });
  } else if (Array.isArray(engineScores)) {
    engineScores.forEach((item) => {
      if (!isRecord(item)) return;
      const name = item.engine || item.name;
      const pct = finiteNumber(item.score ?? item.value ?? item.pct ?? item.visibility_pct);
      if (name && pct !== null) rows.push({ name: String(name), pct });
    });
  }
  return rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
}

/** Per-engine slices: engines is an object keyed by engine (or an array with .engine). */
function engineSlices(engines) {
  if (isRecord(engines)) return Object.values(engines).filter(isRecord);
  if (Array.isArray(engines)) return engines.filter(isRecord);
  return [];
}

/**
 * "Who the engines named instead of you", ranked. Mention counts come from the
 * per-engine top_rivals lists; the scan's competitor roster adds names that
 * were never counted. Counts stay null when the scan did not record them.
 * Returns { rows: [{ name, count, isBrand }], hasCounts }.
 */
export function readCompetitors({ competitors, engines, brand }) {
  const totals = new Map();
  const add = (name, count) => {
    const label = typeof name === "string" ? name.trim() : "";
    if (!label) return;
    const key = label.toLowerCase();
    const prev = totals.get(key) || { name: label, count: null };
    const next = finiteNumber(count);
    totals.set(key, {
      name: prev.name,
      count: next === null ? prev.count : (prev.count ?? 0) + next,
    });
  };

  engineSlices(engines).forEach((slice) => {
    if (!Array.isArray(slice.top_rivals)) return;
    slice.top_rivals.forEach((rival) => {
      if (typeof rival === "string") add(rival, null);
      else if (isRecord(rival)) add(rival.name, rival.mentions ?? rival.count);
    });
  });

  if (Array.isArray(competitors)) {
    competitors.forEach((item) => {
      if (typeof item === "string") add(item, null);
      else if (isRecord(item)) add(item.name, item.mentions ?? item.count);
    });
  }

  const brandKey = typeof brand === "string" ? brand.trim().toLowerCase() : "";
  const rows = [...totals.values()].map((row) => ({
    name: row.name,
    count: row.count,
    isBrand: !!brandKey && row.name.toLowerCase() === brandKey,
  }));
  const hasCounts = rows.some((row) => row.count !== null);
  rows.sort((a, b) => {
    if (a.isBrand !== b.isBrand) return a.isBrand ? -1 : 1;
    if (hasCounts) return (b.count ?? -1) - (a.count ?? -1) || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });
  return { rows, hasCounts };
}

/** Group prompt_results rows by question text, keeping the engine rows in order. */
export function groupQuestions(results, planned) {
  const groups = new Map();
  const key = (text) => text.toLowerCase();
  // Planned questions come first, in panel order, so a question that produced no
  // row (not attempted, blocked before a request) is still listed by name.
  const prompts = Array.isArray(planned?.prompts) ? planned.prompts : [];
  const plannedEngines = Array.isArray(planned?.engines) ? planned.engines.map(String) : [];
  prompts.forEach((text) => {
    if (typeof text !== "string" || !text.trim() || groups.has(key(text.trim()))) return;
    groups.set(key(text.trim()), { query: text.trim(), rows: [], planned: true });
  });
  (Array.isArray(results) ? results : []).forEach((row) => {
    if (!isRecord(row)) return;
    const query = typeof row.query === "string" && row.query.trim() ? row.query.trim() : "Untitled question";
    if (!groups.has(key(query))) groups.set(key(query), { query, rows: [], planned: false });
    groups.get(key(query)).rows.push(row);
  });
  return [...groups.values()].map((group) => ({
    ...group,
    missing: group.planned ? plannedEngines.filter((engine) => !group.rows.some((row) => String(row.engine) === engine)) : [],
  }));
}

/** Does this question count as "naming you" for the chosen engine filter? */
export function questionNamesBrand(question, engine) {
  const rows = engine === "all" ? question.rows : question.rows.filter((row) => row.engine === engine);
  return rows.some((row) => row.answered === true && !row.raw?.error && row.mentioned === true);
}

export function questionHasAnswer(question, engine) {
  const rows = engine === "all" ? question.rows : question.rows.filter((row) => row.engine === engine);
  return rows.some((row) => row.answered === true && !row.raw?.error);
}

export function engineOptions(results, planned) {
  const names = new Set(Array.isArray(planned?.engines) ? planned.engines.map(String) : []);
  (Array.isArray(results) ? results : []).forEach((row) => {
    if (isRecord(row) && row.engine) names.add(String(row.engine));
  });
  return [...names].sort().map((name) => ({ value: name, label: engineLabel(name) }));
}
