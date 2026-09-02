/**
 * The SERP geo target, defined once.
 *
 * R1.6.2 — this existed in two places with two different values. The Bright
 * Data client defaulted to "in"; the SerpAPI client defaulted to "us". Both
 * read the same SERP_GEO variable, so the disagreement was invisible whenever
 * the variable was set, and appeared only on a deployment that left it unset —
 * where the two clients would then probe different countries and produce
 * results that could not legitimately be compared.
 *
 * "in" is the product default: the target market is India. `rollup.js` buckets
 * brand_metrics_daily by IST and `citationEnrich.js` curates India-first press
 * on the strength of it, so "us" was the outlier, not the convention.
 */
export const DEFAULT_SERP_GEO = "in";

/**
 * Resolve the geo for a probe. Blank or whitespace-only is treated as unset —
 * an empty SERP_GEO in a .env file must not become `gl=`, which Google reads
 * as an unqualified search rather than a targeted one.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveSerpGeo(env = process.env) {
  return (env.SERP_GEO || "").trim().toLowerCase() || DEFAULT_SERP_GEO;
}
