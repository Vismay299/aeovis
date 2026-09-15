import { isLlmUnavailable } from "../llmErrors.js";

/**
 * Roster continuity when rival extraction is unavailable (R0.3.3, findings B3/A9).
 *
 * The failure this closes: extractCompetitors reaches the LLM through
 * llmJson. When the LLM was off, the old client returned `{ text: "" }`,
 * extraction "succeeded" with zero rivals, the finalize-time roster came out
 * as `[self]` alone, and Share of Voice was computed self / self = 100%.
 * scanWorker.js used to carry a comment calling that "an acceptable
 * degradation, not a regression". It is not: a scan that could not look for
 * rivals is not a scan that found none.
 *
 * With R0.3.1 the extractor now THROWS `LlmUnavailableError`. This module is
 * where that throw is turned into an honest, labelled state instead of a
 * clean-looking empty one — and the label is what the dashboard reads to say
 * "not assessed" rather than "100%".
 *
 * Deliberately pure and dependency-injected: no DB import, no LLM import, so
 * every branch below is unit-testable with no network and no node_modules.
 */

/** The provenance values `roster_source` may take. */
export const ROSTER_SOURCE = Object.freeze({
  /** User supplied the competitor list. */
  CONFIGURED: "configured",
  /** Alias for user-configured roster. */
  USER: "user",
  /** Extraction ran and its answer is this scan's own roster. */
  EXTRACTED: "extracted",
  /** Extraction was unreachable; this roster belongs to an earlier scan. */
  CARRIED_FORWARD: "carried_forward",
  /** Extraction was unreachable and there is no earlier roster to carry. */
  UNAVAILABLE: "unavailable",
});

/**
 * Collapse `result_brands` rows from a previous scan into a competitor
 * roster. Self rows are dropped (the roster is the RIVALS; self is added back
 * by buildTrackedBrandRoster), names are de-duplicated case-insensitively,
 * and first-seen display casing wins.
 *
 * @param {Array<{name?: string, is_self?: boolean}>} rows
 * @returns {Array<{name: string, domain: string, source: "carried_forward"}>}
 */
export function carriedForwardRosterFromResultBrands(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (!row || row.is_self) continue;
    const name = String(row.name || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, domain: "", source: ROSTER_SOURCE.CARRIED_FORWARD });
  }
  return out;
}

/**
 * Run rival extraction, and when — and ONLY when — it fails because the LLM
 * was unreachable, fall back to the brand's last persisted roster under an
 * explicit `carried_forward` label.
 *
 * Any other error propagates untouched. A malformed extractor response, a
 * bug in the merge, a DB failure while loading the previous roster: those are
 * real faults and finalize should still die on them. Swallowing everything
 * here would rebuild the exact bug this function exists to close.
 *
 * @param {object} args
 * @param {() => Promise<Array>} args.extract runs rival extraction
 * @param {() => Promise<Array>} args.loadPreviousRoster returns the previous scan's result_brands rows
 * @param {Array} [args.userCompetitors] competitor names or objects configured by the user
 * @param {{warn: Function}} [args.logger]
 * @returns {Promise<{competitors: Array, roster_source: string, extraction_offline: boolean, extraction_error: string|null}>}
 */
export async function resolveCompetitorRoster({
  extract,
  loadPreviousRoster,
  userCompetitors = [],
  logger = console,
}) {
  const hasUserCompetitors =
    Array.isArray(userCompetitors) &&
    userCompetitors.some((c) => String(c?.name ?? c ?? "").trim().length > 0);

  let competitors;
  try {
    competitors = await extract();
  } catch (err) {
    if (!isLlmUnavailable(err)) throw err;

    // If the user configured competitors, their roster is authoritative even if
    // the LLM rival extraction leg was offline.
    if (hasUserCompetitors) {
      logger.warn(
        `[roster] Rival extraction unavailable (${err.reason}) — using user-configured ` +
          `competitor roster. Extractor could not discover additional rivals.`
      );
      const configuredRoster = userCompetitors
        .map((c) => {
          const name = typeof c === "string" ? c.trim() : String(c?.name || "").trim();
          return name ? { name, domain: c?.domain || "", source: ROSTER_SOURCE.CONFIGURED } : null;
        })
        .filter(Boolean);

      return {
        competitors: configuredRoster,
        roster_source: ROSTER_SOURCE.CONFIGURED,
        extraction_offline: true,
        extraction_error: err.message,
      };
    }

    const previousRows = await loadPreviousRoster();
    const carried = carriedForwardRosterFromResultBrands(previousRows);

    if (carried.length) {
      logger.warn(
        `[roster] Rival extraction unavailable (${err.reason}) — carrying forward ` +
          `${carried.length} rival(s) from the previous scan. This scan did NOT re-measure them.`
      );
      return {
        competitors: carried,
        roster_source: ROSTER_SOURCE.CARRIED_FORWARD,
        extraction_offline: true,
        extraction_error: err.message,
      };
    }

    // First scan for this brand, or nothing persisted yet. There is no honest
    // roster to show. Returning [] here is safe ONLY because roster_source
    // travels with it — the dashboard must render "not assessed", never "no
    // rivals found" and never a 100% share.
    logger.warn(
      `[roster] Rival extraction unavailable (${err.reason}) and no previous roster exists ` +
        `for this brand — Share of Voice is NOT measurable for this scan.`
    );
    return {
      competitors: [],
      roster_source: ROSTER_SOURCE.UNAVAILABLE,
      extraction_offline: true,
      extraction_error: err.message,
    };
  }

  return {
    competitors,
    roster_source: hasUserCompetitors ? ROSTER_SOURCE.CONFIGURED : ROSTER_SOURCE.EXTRACTED,
    extraction_offline: false,
    extraction_error: null,
  };
}

/**
 * True when a scan's roster cannot support a Share-of-Voice number.
 * The dashboard's single predicate — keep every surface reading this, not
 * re-deriving the rule from `roster_source` string comparisons of its own.
 */
export function isRosterAssessable(rosterSource) {
  return (
    rosterSource == null ||
    rosterSource === ROSTER_SOURCE.EXTRACTED ||
    rosterSource === ROSTER_SOURCE.CONFIGURED ||
    rosterSource === ROSTER_SOURCE.USER
  );
}

/**
 * The single description every rival-facing surface renders for a scan's
 * roster state. One function so the donut, the Rivals view and the verdict
 * sentence can never disagree about whether a number was measured — three
 * independent string comparisons on `roster_source` is how they would drift
 * back apart.
 *
 * @param {string|null|undefined} rosterSource the scan's `roster_source`
 * @returns {{assessable: boolean, label: string|null, detail: string|null}}
 *   `assessable: true` with null label means "render the real numbers".
 */
export function describeRosterState(rosterSource) {
  if (isRosterAssessable(rosterSource)) {
    return { assessable: true, label: null, detail: null };
  }
  if (rosterSource === ROSTER_SOURCE.CARRIED_FORWARD) {
    return {
      assessable: false,
      label: "Not assessed — rival extraction offline",
      detail:
        "The rivals below are carried forward from this brand's previous scan. " +
        "This scan could not look for rivals, so share of voice is not a measurement of it.",
    };
  }
  return {
    assessable: false,
    label: "Not assessed — rival extraction offline",
    detail:
      "Rival extraction was unavailable for this scan and there is no earlier roster to fall back on. " +
      "This is not the same as finding no rivals.",
  };
}
