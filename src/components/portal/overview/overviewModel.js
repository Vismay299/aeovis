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

/*
 * T9 — the Overview data cards. `dailyMentions` and `engines` come from
 * GET /api/customer/overview as one entry per calendar day; a day without a
 * scan is null and stays null here (a gap), never 0.
 */
const ENGINE_STATUS = {
  measured: "up",
  measured_zero: "up",
  failed: "down",
  not_assessed: "unassessed",
};

/** Engine keys in the order the API lists them. */
export function engineKeys(overview) {
  return (Array.isArray(overview?.engines) ? overview.engines : [])
    .map((row) => row?.engine)
    .filter(Boolean);
}

/** MetricCard points: the blended count, plus one part per engine key. */
export function mentionSeries(overview, keys = engineKeys(overview)) {
  const days = Array.isArray(overview?.dailyMentions) ? overview.dailyMentions : [];
  return days
    .filter((day) => day && typeof day.date === "string")
    .map((day) => ({
      date: day.date,
      value: toNumber(day.mentioned),
      parts: keys.map((key) => toNumber(day.byEngine?.[key])),
    }));
}

/** UptimeCard rows: one per engine, one status per day. No row is "none". */
export function engineStatusRows(overview, label = engineLabel) {
  const rows = Array.isArray(overview?.engines) ? overview.engines : [];
  return rows
    .filter((row) => row?.engine && Array.isArray(row.days))
    .map((row) => ({
      name: label(row.engine),
      days: row.days.map((day) => ENGINE_STATUS[day?.state] ?? "none"),
    }));
}

/** The last calendar day the history covers, or null. */
export function historyEndDate(overview) {
  const engines = Array.isArray(overview?.engines) ? overview.engines : [];
  const days = Array.isArray(overview?.dailyMentions) ? overview.dailyMentions : engines[0]?.days || [];
  const last = days[days.length - 1];
  return typeof last?.date === "string" ? last.date : null;
}
