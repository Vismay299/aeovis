import { compareMetrics, validateMetric } from "../scoring/metricContract.js";
import { measuredNumberOrNull } from "../scoring/measuredNumber.js";
import { computeVisibilitySummary } from "../brandAnalyticsApi.js";

// A daily projection is a pointer to a report, not a new measurement. Read the
// report's unchanged DTO; a historical scalar alone cannot establish eligibility.
export function qualifyVisibilityPoint(row, source) {
  const headline = source?.headline_metric;
  const singleEngine = headline?.context?.engine_cohort;
  const metric = row.engine === "all" ? headline : source?.engine_metric ||
    (singleEngine === row.engine ? headline : null);
  const stored = measuredNumberOrNull(row.visibility_pct);
  const validation = metric ? validateMetric(metric) : null;
  const candidate = metric?.qualified === true ? measuredNumberOrNull(metric.qualified_pct) : null;
  const contradictions = [...(validation?.contradictions || [])];
  if (metric && (metric.metric_id !== "observed_exposure" || metric.unit !== "percent"))
    contradictions.push({code:"unexpected_metric_contract"});
  if (metric && metric.qualified !== true && measuredNumberOrNull(metric.qualified_pct) !== null)
    contradictions.push({code:"unqualified_with_value"});
  if (candidate !== null && (candidate < 0 || candidate > 100 ||
      Math.abs(candidate - (measuredNumberOrNull(metric.value_pct) ?? candidate)) > 0.05))
    contradictions.push({code:"qualified_value_mismatch"});
  if (stored !== null && candidate !== null && Math.abs(stored - candidate) > 0.05)
    contradictions.push({code:"daily_projection_mismatch"});
  const invalid = contradictions.length > 0;
  return {
    visibility_pct: invalid ? null : candidate,
    stored_visibility_pct: stored,
    metric: metric || null,
    metric_state: !metric ? "legacy_unknown" : invalid ? "contradictory" : metric.qualified_state || "not_assessed",
    metric_reason: !metric ? "metric_source_unavailable" : invalid ? "contradictory_counts" : metric.qualified_reason || null,
    contradictions,
  };
}

export function computeQualifiedVisibilitySummary(series) {
  const summary = computeVisibilitySummary(series);
  const latest = series?.at(-1), previous = series?.at(-2);
  const comparison = compareMetrics(
    latest?.visibility_pct == null ? null : latest?.metric,
    previous?.visibility_pct == null ? null : previous?.metric,
  );
  return {...summary, delta_visibility_pct: comparison.delta_pct, comparison};
}

// Plot only the latest uninterrupted comparable cohort. A line or hover delta
// must not bridge an unknown reading or a change in measurement instrument.
export function comparableVisibilityTail(series) {
  if(!Array.isArray(series) || !series.length || series.at(-1).visibility_pct==null)return [];
  const tail=[series.at(-1)];
  for(let i=series.length-2;i>=0;i--){
    if(series[i].visibility_pct==null || !compareMetrics(tail[0].metric,series[i].metric).comparable)break;
    tail.unshift(series[i]);
  }
  return tail;
}
