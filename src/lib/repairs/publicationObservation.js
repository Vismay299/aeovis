import {
  checkComparability,
  estimateUncertainty,
} from "../scoring/metricContract.js";
const key = (q) =>
  String(q || "")
    .trim()
    .toLowerCase();
export function comparePublicationObservations({
  publication,
  scans = [],
  rowsForScan,
  now = Date.now(),
  windowDays = 28,
}) {
  const unavailable = (reason) => ({
    applicable: false,
    reason,
    cited_delta: null,
    visible_delta: null,
    causal_claim: false,
  });
  const time = Date.parse(publication?.published_at);
  if (!Number.isFinite(time))
    return unavailable("verified_publication_required");
  const targets = new Set((publication.target_queries || []).map(key));
  if (!targets.size) return unavailable("no_target_questions");
  const candidates = scans
    .filter(
      (s) =>
        Math.abs(Date.parse(s.scanned_at) - time) <= windowDays * 86400_000 &&
        Date.parse(s.scanned_at) <= now,
    )
    .sort((a, b) => Date.parse(a.scanned_at) - Date.parse(b.scanned_at));
  const before = candidates
      .filter((s) => Date.parse(s.scanned_at) < time)
      .at(-1),
    after = candidates.filter((s) => Date.parse(s.scanned_at) > time).at(-1);
  if (!before || !after) return unavailable("waiting_for_matched_observations");
  const metric = (s) =>
    s.raw_results?.summary_stats?.headline_metric ||
    s.summary_stats?.headline_metric;
  const boundary = checkComparability(metric(before), metric(after));
  if (!boundary.comparable)
    return { ...unavailable(boundary.boundary_reason), boundary };
  const extract = (scan) => {
    const unique = [
      ...new Map(
        rowsForScan(scan)
          .filter(
            (r) => targets.has(key(r.prompt || r.query)) && !r.is_branded_query,
          )
          .map((r) => [`${r.engine}:${key(r.prompt || r.query)}`, r]),
      ).values(),
    ];
    const valid = unique.filter(
      (r) => !r.error && (r.answer_present || r.serp_state === "valid_serp"),
    );
    return {
      planned: unique.length,
      valid: valid.length,
      visible: valid.filter((r) => r.visible === true).length,
      cited: valid.filter((r) => r.brand_cited === true).length,
      distinct_prompts: new Set(valid.map((r) => key(r.prompt || r.query)))
        .size,
      uncertainty: estimateUncertainty(
        valid.map((r) => ({
          promptId: key(r.prompt || r.query),
          value: r.visible === true,
        })),
      ),
      keys: unique.map((r) => `${r.engine}:${key(r.prompt || r.query)}`).sort(),
    };
  };
  const a = extract(before),
    b = extract(after);
  if (JSON.stringify(a.keys) !== JSON.stringify(b.keys))
    return unavailable("target_cohort_changed");
  const qualified =
    a.distinct_prompts >= 20 &&
    b.distinct_prompts >= 20 &&
    a.valid / a.planned >= 0.95 &&
    b.valid / b.planned >= 0.95;
  return {
    applicable: true,
    publication_url: publication.url,
    published_at: publication.published_at,
    target_count: targets.size,
    has_post_scan: true,
    before: a,
    after: b,
    cited_delta: qualified ? b.cited - a.cited : null,
    visible_delta: qualified ? b.visible - a.visible : null,
    qualified,
    reason: qualified ? null : "exploratory_small_or_incomplete_sample",
    pre_scan_at: before.scanned_at,
    post_scan_at: after.scanned_at,
    window_days: windowDays,
    causal_claim: false,
    interpretation:
      "Observed change around verified publication; this comparison does not establish causation.",
  };
}
