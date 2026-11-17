/**
 * Pure aggregation helpers for GET /api/brands/[brand]/citations (P3a).
 * Operates on already-fetched `citations` rows (content_type/domain_type/
 * citation_class populated by src/shared/analytics/citationEnrich.js at
 * finalize, or by scripts/enrich-citations.mjs for historical rows — rows
 * enriched by neither yet simply carry null values here, not an error).
 *
 * No DB access — kept out of the route file so it's unit-testable with
 * `node --test` alone, without booting Next.js (mirrors the rationale
 * src/shared/brandAnalyticsApi.js documents for the sibling metrics/schedule
 * routes).
 */

export const VALID_CITATION_GROUPS = ["domain", "url", "type"];

/**
 * Validates + normalizes the `group` query param. Defaults to "domain" when
 * absent/empty. Returns `{ group, error }` — exactly one is non-null.
 */
export function parseGroupParam(raw) {
  if (raw == null || raw === "") return { group: "domain", error: null };
  const normalized = String(raw).trim().toLowerCase();
  if (!VALID_CITATION_GROUPS.includes(normalized)) {
    return { group: null, error: `group must be one of: ${VALID_CITATION_GROUPS.join(", ")}` };
  }
  return { group: normalized, error: null };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Aggregates a brand's citation rows into three views over the SAME window:
 *
 *   domains       - one row per distinct domain: { domain, domain_type,
 *                    citation_class, is_self, count, share_pct }
 *   urls          - one row per distinct url: { url, domain, domain_type,
 *                    content_type, is_self, count, share_pct }
 *   content_types - one row per OBSERVED content_type (never a zero row for
 *                    an unobserved type): { content_type, count, share_pct,
 *                    leader_url, leader_domain, leader_count } — the
 *                    "leader" is the single most-cited url of that type
 *                    (ties keep whichever url was encountered first in the
 *                    input array — a deterministic, if not alphabetic, rule)
 *
 * `count` = number of citation ROWS (retrieval events), not distinct
 * results — the same domain/url cited twice for two different prompts
 * counts twice ("how much retrieval real-estate this commands"). share_pct
 * is that count as a percentage of the TOTAL citation rows in the input
 * (i.e. of whatever window the caller already filtered by from/to).
 *
 * Rows missing `domain`/`url`/`content_type` are simply excluded from that
 * one dimension's map (a row missing `domain` can still contribute to
 * `urls`, etc.) — citations.url/domain are NOT NULL columns in practice, so
 * this is defensive, not an expected path.
 */
export function aggregateCitations(citationRows) {
  const rows = Array.isArray(citationRows) ? citationRows : [];
  const total = rows.length;

  const domainMap = new Map();
  const urlMap = new Map();
  const typeMap = new Map();

  rows.forEach((r) => {
    if (!r) return;

    if (r.domain) {
      const bucket = domainMap.get(r.domain) || {
        domain: r.domain,
        domain_type: null,
        citation_class: null,
        is_self: false,
        count: 0,
      };
      bucket.count += 1;
      if (!bucket.domain_type && r.domain_type) bucket.domain_type = r.domain_type;
      if (!bucket.citation_class && r.citation_class) bucket.citation_class = r.citation_class;
      if (r.is_self) bucket.is_self = true;
      domainMap.set(r.domain, bucket);
    }

    if (r.url) {
      const bucket = urlMap.get(r.url) || {
        url: r.url,
        domain: r.domain || null,
        domain_type: null,
        content_type: null,
        is_self: false,
        count: 0,
      };
      bucket.count += 1;
      if (!bucket.domain_type && r.domain_type) bucket.domain_type = r.domain_type;
      if (!bucket.content_type && r.content_type) bucket.content_type = r.content_type;
      if (r.is_self) bucket.is_self = true;
      urlMap.set(r.url, bucket);
    }

    const typeKey = r.content_type || "unclassified";
    const typeBucket = typeMap.get(typeKey) || { content_type: typeKey, count: 0, leaders: new Map() };
    typeBucket.count += 1;
    if (r.url) {
      const entry = typeBucket.leaders.get(r.url) || { count: 0, domain: r.domain || null };
      entry.count += 1;
      typeBucket.leaders.set(r.url, entry);
    }
    typeMap.set(typeKey, typeBucket);
  });

  const domains = Array.from(domainMap.values())
    .map((d) => ({ ...d, share_pct: round1((d.count / (total || 1)) * 100) }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));

  const urls = Array.from(urlMap.values())
    .map((u) => ({ ...u, share_pct: round1((u.count / (total || 1)) * 100) }))
    .sort((a, b) => b.count - a.count || a.url.localeCompare(b.url));

  const content_types = Array.from(typeMap.values())
    .map((t) => {
      let leaderUrl = null;
      let leaderDomain = null;
      let leaderCount = 0;
      for (const [url, entry] of t.leaders) {
        if (entry.count > leaderCount) {
          leaderCount = entry.count;
          leaderUrl = url;
          leaderDomain = entry.domain;
        }
      }
      return {
        content_type: t.content_type,
        count: t.count,
        share_pct: round1((t.count / (total || 1)) * 100),
        leader_url: leaderUrl,
        leader_domain: leaderDomain,
        leader_count: leaderCount,
      };
    })
    .sort((a, b) => b.count - a.count || a.content_type.localeCompare(b.content_type));

  return {
    totals: { citations: total, distinct_domains: domainMap.size, distinct_urls: urlMap.size },
    domains,
    urls,
    content_types,
  };
}
