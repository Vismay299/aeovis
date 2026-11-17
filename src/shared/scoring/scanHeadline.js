/** Read the stored qualification decision without falling back through a refused null. */
export function scanHeadline(record) {
  const raw = record?.raw_results || record || {};
  const summary = record?.summary_stats || raw.summary_stats || {};
  if (!summary.metric_contract_version) return null;
  const metric = summary.headline_metric ?? null;
  const qualified = summary.headline_qualified === true && Number.isFinite(summary.headline_pct);
  return {
    value: qualified ? summary.headline_pct : null,
    qualified,
    state: summary.headline_state ?? metric?.qualified_state ?? null,
    reason: summary.headline_reason ?? metric?.qualified_reason ?? null,
    exploratory: summary.exploratory_index_pct ?? raw.visibility_index_pct ?? null,
    metric,
  };
}
