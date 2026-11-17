/**
 * The verdict band for a score, or `null` when there is no score to band.
 *
 * R2.1.2, round 2 — WHY THE NULL ARM EXISTS. R2.1.1 made the hero score
 * genuinely nullable (`not_assessed` stores no number), and this function's
 * final `return "weak"` was a FALLTHROUGH, not a decision: `null >= 50` and
 * `null >= 25` are both false, so a scan that measured nothing was banded
 * "weak" — the tier for a brand that is genuinely absent from AI answers. The
 * shipped symptom was a red "Weak" chip in DashboardShell's hero sitting beside
 * the em dash where the percentage should be: a verdict rendered from a
 * measurement that does not exist, which is the same defect this task's diff
 * already fixed once for Sidebar (see the comment at
 * src/shared/scoring/enginePipeline.js:462-465).
 *
 * So an absent score has no tier at all, and the check is deliberately STRICT
 * (`typeof === "number"`, matching ScoreBand's own `isNumeric`) rather than
 * `Number.isFinite(Number(score))`: coercing first would put `null` and `""`
 * back at 0 and hand them "weak" again through a longer route.
 *
 * Callers must treat `null` as "render no chip". `tierLabel(null)` is an em dash
 * and `tierClasses(null)` is the neutral pair, so a caller that forwards the
 * null rather than testing it still cannot print a colour-coded verdict.
 *
 * A measured 0 IS a score and still bands "weak" — standing rule 1: a measured
 * zero must stay visibly different from "we never got a number".
 *
 * @param {unknown} score
 * @param {string} [scoringVersion]
 * @returns {"strong"|"moderate"|"weak"|null}
 */
export function scoreTier(score, scoringVersion = "v2-composite") {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;

  const isBinary = scoringVersion === "v1-binary";
  const strongThreshold = isBinary ? 70 : 50;
  const moderateThreshold = isBinary ? 40 : 25;

  if (score >= strongThreshold) return "strong";
  if (score >= moderateThreshold) return "moderate";
  return "weak";
}

export function tierLabel(tier) {
  return { strong: "Strong", moderate: "Moderate", weak: "Weak" }[tier] || "—";
}

export function tierClasses(tier) {
  switch (tier) {
    case "strong":
      return "text-[var(--good)] border-[var(--good-border)]";
    case "moderate":
      return "text-[var(--warn)] border-[var(--warn-border)]";
    case "weak":
      return "text-[var(--crit)] border-[var(--crit-border)]";
    default:
      return "text-[var(--text-2)] border-[var(--border-2)]";
  }
}

/**
 * True when `iso` can be read as a real instant. A missing or unparseable
 * timestamp is a *state*, not a time — callers must render it as an em dash
 * rather than substituting the current clock (finding C1).
 */
export function hasTimestamp(iso) {
  if (!iso) return false;
  return !Number.isNaN(new Date(iso).getTime());
}

export function formatTimestamp(iso) {
  if (!hasTimestamp(iso)) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export function relativeTime(iso) {
  // No timestamp is not "just now". Without this guard an unparseable value
  // fell through to `NaNd ago`, and a null one used to never arrive here at all
  // because the caller stamped it with the current clock (finding C1).
  if (!hasTimestamp(iso)) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function rankColor(rank) {
  if (rank === "—" || rank == null) return "text-[#999999]";
  if (rank <= 2) return "text-[#2F5C4F]";
  if (rank <= 4) return "text-[#8F6614]";
  return "text-[#8B3A3A]";
}

/**
 * The collection window as a short human phrase (R2.7.4).
 *
 * A scan collects over a span — chunked, and sometimes resumed after a crash —
 * so the finalize instant is not "when this was measured". This renders the
 * span compactly enough to sit beside the headline timestamp:
 *
 *   under a minute  -> "in under a minute"
 *   same day        -> "over 42 min"
 *   across days     -> "over 2 days"
 *
 * Returns null when either end is missing, so a caller can omit the chip
 * entirely rather than render a half-known window.
 */
export function formatCollectionWindow(fromIso, toIso) {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;

  const ms = Math.max(0, to - from);

  // Test the raw span, not the rounded minutes: Math.round(30_000 / 60_000) is
  // 1, so rounding first reports a 30-second window as "over 1 min".
  if (ms < 60_000) return "in under a minute";

  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `over ${minutes} min`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `over ${hours} ${hours === 1 ? "hour" : "hours"}`;

  const days = Math.round(hours / 24);
  return `over ${days} ${days === 1 ? "day" : "days"}`;
}
