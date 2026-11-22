/**
 * The fictional company every sample fixture describes. Brightwave sells
 * hospital analytics to Indian hospitals; its rivals are equally fictional.
 * Dates are relative to today, so the sample always reads as current.
 */
export const BRAND = "Brightwave";
export const DOMAIN = "brightwave.io";
export const WEBSITE = `https://${DOMAIN}`;
export const BRAND_KEY = "sample-brightwave";

export const RIVALS = Object.freeze([
  { name: "NorthPeak", domain: "northpeak.com" },
  { name: "Lumen IQ", domain: "lumeniq.ai" },
  { name: "Vantage Health", domain: "vantagehealth.in" },
  { name: "Coreset", domain: "coreset.io" },
]);

const DAY = 86_400_000;

/** ISO time `n` days before now, at a fixed local hour. */
export function daysAgo(n, hour = 9, minute = 0) {
  const d = new Date(Date.now() - n * DAY);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

/** YYYY-MM-DD `n` days before today. */
export function dayKey(n) {
  return daysAgo(n).slice(0, 10);
}

/** Turns the generator's "@weeksAgo:N" placeholders into real times. */
export function resolveDates(value) {
  if (typeof value === "string") {
    const m = value.match(/^@weeksAgo:(\d+)$/);
    return m ? daysAgo(Number(m[1]) * 7 + 1) : value;
  }
  if (Array.isArray(value)) return value.map(resolveDates);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveDates(v)]));
  }
  return value;
}

/** A stable pseudo-random number in [0, 1) for a key, so fixtures never change between loads. */
export function stable(key) {
  let h = 2166136261;
  for (const ch of String(key)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * Moves every date in a copied fixture forward so its latest date is
 * yesterday, keeping the gaps between dates. Copied browser-test fixtures were
 * written on fixed days; the sample should read as current.
 */
export function rebaseDates(value) {
  const text = JSON.stringify(value);
  const dates = text.match(/\d{4}-\d{2}-\d{2}/g) || [];
  if (!dates.length) return value;
  const latest = dates.reduce((a, b) => (a > b ? a : b));
  const shift = Date.parse(`${dayKey(1)}T00:00:00Z`) - Date.parse(`${latest}T00:00:00Z`);
  const moved = text.replace(/(\d{4}-\d{2}-\d{2})(T[0-9:.]+Z)?/g, (_, day, time = "") => {
    const t = new Date(Date.parse(`${day}T00:00:00Z`) + shift).toISOString().slice(0, 10);
    return `${t}${time}`;
  });
  return JSON.parse(moved);
}
