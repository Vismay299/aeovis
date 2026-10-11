/**
 * Pure helpers for the Overview page. Every input can be null, so each helper
 * returns null (rendered as an em dash) rather than 0 or NaN for unknown data.
 */

export function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Whole-number count, or "—" when unknown. */
export function countText(value) {
  const n = toNumber(value);
  return n === null ? "—" : n.toLocaleString();
}

/** Visibility percentage rounded to a whole number, or null. */
export function roundedPct(value) {
  const n = toNumber(value);
  return n === null ? null : Math.round(n);
}

/** "2026-10-02T..." -> "Oct 2"; "—" when unknown. */
export function shortDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "https://www.acme.com/" -> "www.acme.com". */
export function websiteHost(website) {
  if (!website) return "";
  return String(website).trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
}

export function scanTimestamp(scan) {
  return scan?.scanned_at || scan?.created_at || null;
}

/** Scans oldest to newest, with a usable visibility reading. */
export function scanSeries(scans) {
  return (scans || [])
    .filter((scan) => toNumber(scan?.visibility_pct) !== null)
    .map((scan) => ({ ...scan, visibility: toNumber(scan.visibility_pct), at: scanTimestamp(scan) }))
    .sort((a, b) => new Date(a.at || 0).getTime() - new Date(b.at || 0).getTime());
}

/** Engine key ("chatgpt_web") -> "Chatgpt web". */
export function engineLabel(engine) {
  const text = String(engine || "Unknown").replace(/[_-]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Unknown";
}

/** Badge tone for a visibility percentage. */
export function visibilityTone(value) {
  const n = toNumber(value);
  if (n === null) return "neutral";
  if (n >= 50) return "good";
  if (n >= 20) return "warn";
  return "neutral";
}
