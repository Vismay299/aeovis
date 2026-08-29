/**
 * Source counting for the Sources view (finding A10).
 *
 * WHAT v9 ACTUALLY WRITES. Every probe result row produced by the v9 engine
 * pipeline (src/lib/scoring/enginePipeline.js — probeAio and probeTextEngine)
 * carries `references` (objects: { href, title, source, domain }) and
 * `citations` (the deduped, normalized hrefs of those references). The v8
 * names `aio_references` / `aio_citations` are written by the legacy
 * src/lib/scoring/aioPipeline.js only, and finalize stores each probe result
 * verbatim in raw_results.results (scanWorker.js), so a v9 scan reaching the
 * dashboard has NO `aio_citations` key at all. SourcesView read only that dead
 * name, summed nothing, and printed "Sources cited: 0" next to a populated
 * "Distinct domains: 14".
 *
 * WHY REFERENCES COME FIRST. `top_domains` — the source of the distinct-domain
 * count — is aggregated from `aio_references` (aggregateAioTopDomains in
 * aioPipeline.js, fed rows whose aio_references is r.references; see
 * scanWorker.js's normalizedForCompetitors). Counting the same field family
 * the domains were derived from is what makes the two numbers agree: every
 * listed domain came from at least one reference, so a references-derived
 * total can never be smaller than the number of distinct domains.
 *
 * WHY A NULL EXISTS. A row that carries no citation array of any vintage was
 * never counted — that is not a measured zero, and it must not render as one.
 * summarizeSources returns totalCitations: null with a state the view turns
 * into an em dash plus a chip, and it refuses to emit a total that contradicts
 * the domain list rather than printing a number it cannot justify.
 */

/** v9 first, then the camelCase the API sometimes returns, then v8. */
const REFERENCE_FIELDS = ["references", "aioReferences", "aio_references"];
const CITATION_FIELDS = ["citations", "aioCitations", "aio_citations"];

/**
 * URLs referenced by one answer row.
 *
 * @param {Object} row - A probe result row (snake_case or camelCase)
 * @returns {number|null} Count, or null when the row carries no citation list
 *   at all — never counted is not the same as counted zero.
 */
export function countRowCitations(row) {
  if (!row || typeof row !== "object") return null;

  let carriesList = false;
  for (const key of [...REFERENCE_FIELDS, ...CITATION_FIELDS]) {
    const value = row[key];
    if (!Array.isArray(value)) continue;
    carriesList = true;
    // First non-empty list wins: v9 rows initialize both arrays, and an AIO
    // answer can have references while `citations` is still the empty default.
    if (value.length > 0) return value.length;
  }

  return carriesList ? 0 : null;
}

/**
 * Reconciles the per-answer citation count with the aggregated domain list.
 *
 * @param {Object} input
 * @param {Array} input.rawResults - Per-answer probe rows
 * @param {Array} input.topDomains - Aggregated { domain, count, type } rows
 * @returns {{ totalCitations: number|null, domainCount: number, state: string, note: string }}
 *   state is "measured" (totalCitations is a real number), "not_recorded"
 *   (no row carried a citation list) or "inconsistent" (the rows on hand
 *   cannot account for the domains the scan aggregated).
 */
export function summarizeSources({ rawResults, topDomains } = {}) {
  const rows = Array.isArray(rawResults) ? rawResults : [];
  const domains = Array.isArray(topDomains) ? topDomains : [];
  const domainCount = domains.length;

  let total = 0;
  let countedRows = 0;
  for (const row of rows) {
    const n = countRowCitations(row);
    if (n === null) continue;
    countedRows += 1;
    total += n;
  }

  if (countedRows === 0) {
    return {
      totalCitations: null,
      domainCount,
      state: "not_recorded",
      note:
        rows.length === 0
          ? "This record carries no per-answer rows, so its sources were never counted."
          : "No answer in this record carries a source list, so its sources were never counted.",
    };
  }

  // Each distinct domain needed at least one cited URL to exist. A total below
  // the domain count therefore means the rows on hand are not the rows the
  // domain list was built from — report that, never the impossible number.
  if (total < domainCount) {
    return {
      totalCitations: null,
      domainCount,
      state: "inconsistent",
      note: `The stored answers account for ${total} source URL${
        total === 1 ? "" : "s"
      }, fewer than the ${domainCount} distinct domains this scan aggregated, so the count is not trustworthy.`,
    };
  }

  return { totalCitations: total, domainCount, state: "measured", note: "" };
}

export default summarizeSources;
