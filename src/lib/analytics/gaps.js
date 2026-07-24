/**
 * Gap analysis (P3a — plan.md §5 Phase 3): domains/URLs where at least one
 * TRACKED RIVAL is mentioned in an AI answer that cites this domain/URL, and
 * the tracked brand itself is NEVER mentioned in any answer that cites it —
 * "this source helps my rivals and never helps me."
 *
 * Pure + unit-testable: every function here operates on plain arrays already
 * fetched from the DB (src/lib/db/analytics.js's getCitationsForBrand /
 * getResultBrandsForBrand) — no DB access, no LLM, fully deterministic.
 */

// ---------------------------------------------------------------------------
// Join: citations x result_brands, by result_id
// ---------------------------------------------------------------------------

/**
 * Joins raw `citations` rows with `result_brands` rows (both already scoped
 * to one brand — see db/analytics.js's `brand` column convention) into one
 * flat per-citation row carrying the brand context of ITS SAME answer:
 *
 *   { domain, url, domain_type, result_id, is_self, self_mentioned, rival_names }
 *
 *   is_self         - citations.is_self: this CITATION'S domain IS the
 *                     tracked brand's own domain (can never be a gap).
 *   self_mentioned  - the tracked brand ITSELF was mentioned in the SAME
 *                     answer (a result_brands row with is_self=true,
 *                     mentioned=true) that cited this domain/url.
 *   rival_names     - names of every OTHER tracked brand mentioned in that
 *                     SAME answer (result_brands rows with is_self=false,
 *                     mentioned=true).
 *
 * A citation whose result_id has no matching result_brands rows at all
 * (P1.2 symmetric judging never ran for that scan — e.g. a pre-P1.2
 * historical scan) is kept with self_mentioned=false and rival_names=[]: it
 * simply can never qualify as a gap row (no rival signal either), not an
 * error. Citation rows missing a domain or result_id are dropped.
 */
export function joinCitationsWithResultBrands(citations = [], resultBrands = []) {
  const byResult = new Map(); // result_id -> { selfMentioned, rivalNames: Set }

  (resultBrands || []).forEach((rb) => {
    if (!rb || !rb.result_id || !rb.mentioned) return;
    const bucket = byResult.get(rb.result_id) || { selfMentioned: false, rivalNames: new Set() };
    if (rb.is_self) {
      bucket.selfMentioned = true;
    } else if (rb.name) {
      bucket.rivalNames.add(rb.name);
    }
    byResult.set(rb.result_id, bucket);
  });

  return (citations || [])
    .filter((c) => c && c.domain && c.result_id)
    .map((c) => {
      const bucket = byResult.get(c.result_id);
      return {
        domain: c.domain,
        url: c.url,
        domain_type: c.domain_type ?? null,
        result_id: c.result_id,
        is_self: !!c.is_self,
        self_mentioned: bucket ? bucket.selfMentioned : false,
        rival_names: bucket ? Array.from(bucket.rivalNames) : [],
      };
    });
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// gap_score
// ---------------------------------------------------------------------------

/**
 * Shared core for computeDomainGaps/computeUrlGaps — identical math, grouped
 * either by `domain` or by `url`. Kept private so the formula stays
 * documented in exactly one public place (computeDomainGaps, below).
 */
function computeGaps(rows, { selfBrandKey, level } = {}) {
  const input = Array.isArray(rows) ? rows : [];
  if (input.length === 0) return [];

  const totalDistinctResults = new Set(input.map((r) => r.result_id)).size || 1;
  const totalCitationRows = input.length;

  // The full universe of rival names seen ANYWHERE in the input — the
  // denominator for rival_presence_pct below. Zero when nothing tracked any
  // rival at all ("the zero-rival case": no domain/url can ever qualify).
  const allRivalNames = new Set();
  input.forEach((r) => (r.rival_names || []).forEach((n) => n && allRivalNames.add(n)));
  const totalTrackedRivals = allRivalNames.size;

  const buckets = new Map();
  input.forEach((r) => {
    if (!r || r.is_self || r.domain_type === "owned") return; // your own domain/url is never a gap against yourself
    const key = level === "url" ? r.url : r.domain;
    if (!key) return;
    const bucket = buckets.get(key) || {
      key,
      domain: r.domain,
      url: r.url,
      domain_type: r.domain_type ?? null,
      resultIds: new Set(),
      citationRowCount: 0,
      rivalNames: new Set(),
      selfEver: false,
    };
    bucket.resultIds.add(r.result_id);
    bucket.citationRowCount += 1;
    (r.rival_names || []).forEach((n) => n && bucket.rivalNames.add(n));
    if (r.self_mentioned) bucket.selfEver = true;
    if (!bucket.domain_type && r.domain_type) bucket.domain_type = r.domain_type; // prefer a non-null value if rows disagree
    buckets.set(key, bucket);
  });

  // Qualifies as a gap ONLY when >=1 tracked rival co-occurred and self NEVER did.
  const candidates = Array.from(buckets.values()).filter((b) => b.rivalNames.size >= 1 && !b.selfEver);

  const scored = candidates.map((b) => {
    const rival_count = b.rivalNames.size;
    const citation_rate = round1((b.resultIds.size / totalDistinctResults) * 100);
    const retrieval_share_pct = round1((b.citationRowCount / totalCitationRows) * 100);
    const rival_presence_pct = totalTrackedRivals > 0 ? (rival_count / totalTrackedRivals) * 100 : 0;
    const raw = (retrieval_share_pct / 100) * (rival_presence_pct / 100) * (citation_rate / 100);
    return { b, rival_count, citation_rate, retrieval_share_pct, raw };
  });

  const maxRaw = scored.reduce((m, s) => Math.max(m, s.raw), 0);

  const out = scored.map(({ b, rival_count, citation_rate, retrieval_share_pct, raw }) => {
    const gap_score = maxRaw > 0 ? Math.round((raw / maxRaw) * 100) : 0;
    const keyed = level === "url" ? { url: b.url, domain: b.domain } : { domain: b.domain };
    const branded = selfBrandKey ? { brand: selfBrandKey } : {};
    return {
      ...branded,
      ...keyed,
      domain_type: b.domain_type,
      rival_count,
      rival_names: Array.from(b.rivalNames).sort(),
      retrieval_share_pct,
      citation_rate,
      gap_score,
    };
  });

  return out.sort((a, b) => {
    if (b.gap_score !== a.gap_score) return b.gap_score - a.gap_score;
    if (b.retrieval_share_pct !== a.retrieval_share_pct) return b.retrieval_share_pct - a.retrieval_share_pct;
    const aKey = level === "url" ? a.url : a.domain;
    const bKey = level === "url" ? b.url : b.domain;
    return String(aKey).localeCompare(String(bKey));
  });
}

/**
 * Domain-level gap table.
 *
 * gap_score formula (documented precisely, per each candidate DOMAIN D):
 *
 *   citingResultIds(D)      = distinct result_id values where D was cited
 *   citation_rate(D)        = |citingResultIds(D)| / totalDistinctResults * 100
 *                             — "what % of ALL tracked answers cite D at all"
 *   retrieval_share_pct(D)  = citationRowCount(D) / totalCitationRows * 100
 *                             — "D's share of every citation placement in
 *                             the input" (a domain cited twice in the same
 *                             answer counts twice — this is retrieval
 *                             real-estate, not answer coverage)
 *   rival_names(D)          = sorted unique tracked-rival names mentioned in
 *                             the SAME answers (result_id) where D was cited
 *   rival_count(D)          = rival_names(D).length
 *   self_ever(D)            = true if the tracked brand itself was EVER
 *                             mentioned in any of citingResultIds(D)'s answers
 *
 *   D QUALIFIES as a gap row iff rival_count(D) >= 1 AND self_ever(D) is
 *   false ("a rival shows up wherever this domain gets cited, and you
 *   never do") — and D is never your own domain (is_self / domain_type
 *   'owned' rows are excluded before any of the above is computed).
 *
 *   totalTrackedRivals = size of the union of every rival name appearing
 *                        ANYWHERE in the input (not just qualifying rows) —
 *                        the full universe of rivals this data tracked at
 *                        all. Zero when the brand tracks no rivals (or none
 *                        were ever mentioned) — see "the zero-rival case".
 *   rival_presence_pct(D)   = rival_count(D) / totalTrackedRivals * 100
 *                             (0 when totalTrackedRivals is 0)
 *
 *   raw(D)      = (retrieval_share_pct(D)/100) * (rival_presence_pct(D)/100)
 *                 * (citation_rate(D)/100)
 *   gap_score(D) = round(100 * raw(D) / max(raw(*)) across all qualifying
 *                  rows) — i.e. max-scaled to 0-100 so the single biggest
 *                  gap in THIS result set always reads as 100; 0 when there
 *                  are no qualifying rows (nothing to scale against).
 *
 * Ties: rows with an identical raw(D) (and therefore identical gap_score)
 * sort by retrieval_share_pct desc, then by domain (or url) ascending — a
 * stable, deterministic order.
 *
 * `selfBrandKey`, when given, is stamped onto every returned row as `brand`
 * (convenience for API responses — every other DB row shape in this project
 * carries its own `brand` column; this keeps gap rows consistent with that).
 *
 * @param {Array} rows - joinCitationsWithResultBrands(...) output
 * @param {{selfBrandKey?: string}} [options]
 * @returns {Array<{brand?, domain, domain_type, rival_count, rival_names,
 *   retrieval_share_pct, citation_rate, gap_score}>} sorted gap_score desc
 */
export function computeDomainGaps(rows, { selfBrandKey } = {}) {
  return computeGaps(rows, { selfBrandKey, level: "domain" });
}

/**
 * URL-level gap table — identical math to computeDomainGaps (see its
 * docstring for the full gap_score formula), grouped by `url` instead of
 * `domain`. Each row still carries `domain`/`domain_type` (a URL belongs to
 * one domain) alongside `url`.
 *
 * @param {Array} rows - joinCitationsWithResultBrands(...) output
 * @param {{selfBrandKey?: string}} [options]
 * @returns {Array<{brand?, url, domain, domain_type, rival_count,
 *   rival_names, retrieval_share_pct, citation_rate, gap_score}>} sorted
 *   gap_score desc
 */
export function computeUrlGaps(rows, { selfBrandKey } = {}) {
  return computeGaps(rows, { selfBrandKey, level: "url" });
}
