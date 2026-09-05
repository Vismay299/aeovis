import { describeRosterState } from "../../../lib/scoring/rosterContinuity.js";

/**
 * Share of Voice, as the BACKEND measured it (R2.7.1, finding A8).
 *
 * What this replaces: the Overview donut used to be handed the rank board's
 * `rankedEntries` — self + rivals keyed by VISIBILITY SCORE — and divided each
 * entry by their sum to produce "share". Two separate lies came out of that:
 *
 *   1. Visibility is not share. "Named in 40% of answers" and "40% of the
 *      brand mentions were mine" are different measurements over different
 *      denominators, and the donut printed the first under the second's name.
 *   2. With one entry (self alone — no rivals discovered, or none scored yet)
 *      value/total is 1, so the panel printed a confident "100.0% share" for a
 *      brand with a single mention. That is the exact number the scoring
 *      pipeline refuses to emit: enginePipeline.js returns `share_of_voice_pct
 *      = null` when the slice carries no rival roster, because SOV is
 *      UNDEFINED without rivals — not 0 and not 100.
 *
 * So this module never looks at a visibility number. It reads the measured
 * field and nothing else, and when the measurement does not exist it says so
 * rather than computing something that does.
 *
 * WHERE THE FIELD LIVES. `share_of_voice_pct` is produced per ENGINE by
 * computeEngineSummary (src/lib/scoring/enginePipeline.js) and persisted under
 * `raw_results.engines[<engine>]`, which normalizeResult surfaces as
 * `result.perEngineSummaries`. There is currently NO scan-level
 * `share_of_voice_pct`: summarizeEngineResults' backward-compat summary object
 * does not copy it and summarizeAioResults never computes one, so
 * `scans.raw_results.share_of_voice_pct` is written undefined. A scan-level
 * field is still read first here (`shareOfVoicePct` / `share_of_voice_pct` /
 * `summary_stats.share_of_voice_pct`) so this surface starts telling the truth
 * the moment the pipeline persists one; until then the per-engine summaries are
 * the only honest source and an AIO-only scan reports "not available".
 *
 * COMBINING ENGINES. Two engines' shares are not averaged — a mean of ratios
 * over different mention counts is not a ratio. The union is taken over the
 * counts the same summaries carry (`self_mentions` / `total_brand_mentions`),
 * which is the same definition applied to the union of the answers. If a
 * reporting engine does not carry those counts and there is more than one, the
 * result is "not available" with a reason, never a guess.
 */

export const SHARE_STATE = Object.freeze({
  /** A real measurement. `pct` is a number — including a genuine 0. */
  MEASURED: "measured",
  /** The rival roster itself was never assessed (extraction offline). */
  NOT_ASSESSED: "not_assessed",
  /** The roster is fine; the number was not computed or cannot be read. */
  UNAVAILABLE: "unavailable",
});

/** The words a null share renders as. One string, so every surface agrees. */
export const NOT_AVAILABLE_LABEL = "Share of voice not available";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const round1 = (v) => Math.round(v * 10) / 10;

function scanLevelShare(result) {
  const candidates = [
    result?.shareOfVoicePct,
    result?.share_of_voice_pct,
    result?.summary_stats?.share_of_voice_pct,
    result?.summaryStats?.share_of_voice_pct,
  ];
  for (const c of candidates) {
    if (isNum(c)) return c;
  }
  return null;
}

function engineSummaries(result) {
  const map = result?.perEngineSummaries || result?.engines || null;
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map).filter(([, s]) => s && typeof s === "object");
}

/**
 * Self + rival slices of the measured mention pool, in PERCENT (they already
 * sum to <= 100 and are never renormalized by the renderer). Rivals come from
 * `top_rivals[].mentions`, which is capped at ten by the pipeline, so whatever
 * is left over is returned as one explicit `isOther` slice rather than
 * silently inflating the named ones.
 */
function buildComposition({ selfMentions, allMentions, rivalMentions, selfName }) {
  if (!(allMentions > 0)) return null;
  const slices = [
    {
      name: selfName || "Your brand",
      pct: round1((selfMentions / allMentions) * 100),
      isSelf: true,
    },
    ...[...rivalMentions.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, mentions]) => ({
        name,
        pct: round1((mentions / allMentions) * 100),
        isSelf: false,
      })),
  ];
  const named = slices.reduce((s, x) => s + x.pct, 0);
  const remainder = round1(100 - named);
  if (remainder >= 0.1) {
    slices.push({
      name: "Other brands",
      pct: remainder,
      isSelf: false,
      isOther: true,
    });
  }
  return slices;
}

/**
 * @typedef {object} ShareOfVoice
 * @property {"measured"|"not_assessed"|"unavailable"} state
 * @property {number|null} pct measured share; null in every non-measured state
 * @property {string|null} label headline caption when `pct` is null
 * @property {string|null} detail one sentence saying WHY there is no number
 * @property {string|null} reason machine-readable cause
 * @property {string[]} engines which engines the number was measured over
 * @property {Array<{name: string, pct: number, isSelf: boolean, isOther?: boolean}>|null} composition
 */

/**
 * @param {object} result normalized scan record (services/api.js normalizeResult)
 * @returns {ShareOfVoice} never throws, never returns 0 for "not measured"
 */
export function resolveShareOfVoice(result) {
  const rosterState = describeRosterState(
    result?.rosterSource ?? result?.roster_source ?? null
  );

  // The roster question comes first: a scan that could not look for rivals
  // has no share to report, whatever any engine field happens to say.
  if (!rosterState.assessable) {
    return {
      state: SHARE_STATE.NOT_ASSESSED,
      pct: null,
      label: rosterState.label,
      detail: rosterState.detail,
      reason: "roster_offline",
      engines: [],
      composition: null,
    };
  }

  const selfName = result?.brand || "Your brand";
  const summaries = engineSummaries(result);
  const reporting = summaries.filter(([, s]) => isNum(s.share_of_voice_pct));

  let selfMentions = 0;
  let allMentions = 0;
  let counted = true;
  const rivalMentions = new Map();
  for (const [, s] of reporting) {
    if (!isNum(s.self_mentions) || !isNum(s.total_brand_mentions) || s.total_brand_mentions < 0) {
      counted = false;
      break;
    }
    selfMentions += s.self_mentions;
    allMentions += s.total_brand_mentions;
    for (const rival of Array.isArray(s.top_rivals) ? s.top_rivals : []) {
      if (!rival?.name || !isNum(rival.mentions)) continue;
      rivalMentions.set(rival.name, (rivalMentions.get(rival.name) || 0) + rival.mentions);
    }
  }

  const engineNames = reporting.map(([name]) => name);
  const composition = counted
    ? buildComposition({ selfMentions, allMentions, rivalMentions, selfName })
    : null;

  // A scan-level field, if the pipeline ever persists one, is the answer —
  // it is the field this panel is specified against.
  const scanLevel = scanLevelShare(result);
  if (scanLevel != null) {
    const self = composition?.find((s) => s.isSelf);
    // Two measured numbers that disagree cannot both be drawn. Keep the named
    // field as the headline and drop the composition rather than render a bar
    // whose own self slice contradicts the number above it.
    const agrees = self ? Math.abs(self.pct - scanLevel) <= 0.15 : false;
    return {
      state: SHARE_STATE.MEASURED,
      pct: scanLevel,
      label: null,
      detail: null,
      reason: null,
      engines: engineNames,
      composition: agrees ? composition : null,
    };
  }

  if (summaries.length === 0) {
    return {
      state: SHARE_STATE.UNAVAILABLE,
      pct: null,
      label: NOT_AVAILABLE_LABEL,
      detail:
        "This scan stored no per-engine summary, so share of voice was never computed for it.",
      reason: "no_engine_summaries",
      engines: [],
      composition: null,
    };
  }

  if (reporting.length === 0) {
    return {
      state: SHARE_STATE.UNAVAILABLE,
      pct: null,
      label: NOT_AVAILABLE_LABEL,
      detail:
        "No engine in this scan measured a rival roster, so share of voice is undefined for it. " +
        "That is not the same as a 0% share.",
      reason: "not_computed",
      engines: [],
      composition: null,
    };
  }

  if (!counted) {
    // One engine needs no weights — its own ratio IS the answer.
    if (reporting.length === 1) {
      return {
        state: SHARE_STATE.MEASURED,
        pct: reporting[0][1].share_of_voice_pct,
        label: null,
        detail: null,
        reason: null,
        engines: engineNames,
        composition: null,
      };
    }
    return {
      state: SHARE_STATE.UNAVAILABLE,
      pct: null,
      label: NOT_AVAILABLE_LABEL,
      detail:
        `${engineNames.length} engines reported a share but not the mention counts behind it, ` +
        "and averaging their percentages would not be a share of voice.",
      reason: "engine_counts_missing",
      engines: engineNames,
      composition: null,
    };
  }

  // allMentions === 0 across engines that DID assess a roster is a measured
  // zero: nobody, us included, was named. It renders as 0.0%, not as an
  // em dash — the pipeline reports exactly the same 0 in that case.
  return {
    state: SHARE_STATE.MEASURED,
    pct: allMentions > 0 ? round1((selfMentions / allMentions) * 100) : 0,
    label: null,
    detail: null,
    reason: null,
    engines: engineNames,
    composition,
  };
}
