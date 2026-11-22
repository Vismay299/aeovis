/** Overview, scans, scan reports, schedule and Search Console status. */
import REPORTS_RAW from "./data/scans.json" with { type: "json" };
import { BRAND, BRAND_KEY, DOMAIN, WEBSITE, daysAgo, dayKey, resolveDates } from "./brand.js";

let reportsCache = null;
/** The six sample scan reports, oldest first, built by scripts/sample/build-sample-reports.mjs. */
export function reports() {
  reportsCache ??= REPORTS_RAW.map((r) => resolveDates(r));
  return reportsCache;
}

function scanRow(report) {
  const s = report.scan;
  return {
    id: s.id, brand: s.brand, url: s.url, scanned_at: s.scanned_at, created_at: s.created_at,
    visibility_pct: s.visibility_pct, prompts_tracked: s.prompts_tracked, prompts_mentioned: s.prompts_mentioned,
    platform: Array.isArray(s.platform) ? s.platform : Object.keys(s.engines || {}),
  };
}

/** Newest first, as the API lists them. */
export function scanRows() {
  return reports().map(scanRow).reverse();
}

export function reportFor(id) {
  return reports().find((r) => r.scan.id === id) || null;
}

function engineKeys() {
  return Object.keys(reports().at(-1).scan.engines || {});
}

function mentionedBy(report, engine) {
  const questions = new Set(report.results.filter((r) => r.engine === engine && r.mentioned).map((r) => r.query));
  return questions.size;
}

export function overview() {
  const rows = scanRows();
  const byDay = new Map(reports().map((r) => [r.scan.scanned_at.slice(0, 10), r]));
  const engines = engineKeys();
  const days = Array.from({ length: 90 }, (_, i) => dayKey(89 - i));
  const dailyMentions = days.map((date) => {
    const r = byDay.get(date);
    return {
      date,
      mentioned: r ? r.scan.prompts_mentioned : null,
      byEngine: Object.fromEntries(engines.map((e) => [e, r ? mentionedBy(r, e) : null])),
    };
  });
  return {
    brand: { brand_key: BRAND_KEY, display_name: BRAND, website: WEBSITE },
    latest_scan: rows[0] || null,
    scans: rows,
    scan_jobs: [],
    metrics: [],
    content_items: [],
    dailyMentions,
    engines: engines.map((engine) => ({
      engine,
      days: days.map((date) => {
        const r = byDay.get(date);
        return { date, state: r ? (mentionedBy(r, engine) > 0 ? "measured" : "measured_zero") : null };
      }),
    })),
    features: { prompt_explorer: true },
  };
}

export function scansList() {
  return { scans: scanRows(), jobs: [] };
}

export function scansHistory(url) {
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const size = Math.max(1, Number(url.searchParams.get("size") || 50));
  const sort = url.searchParams.get("sort") || "date";
  const order = url.searchParams.get("order") || "desc";
  let rows = scanRows().map((s, i) => ({ ...s, collection_partial: false, started_by: i % 2 === 0 ? "scheduled" : "manual" }));
  rows.sort((a, b) => {
    const ka = sort === "visibility" ? a.visibility_pct : Date.parse(a.scanned_at);
    const kb = sort === "visibility" ? b.visibility_pct : Date.parse(b.scanned_at);
    return order === "asc" ? ka - kb : kb - ka;
  });
  return { brand_key: BRAND_KEY, scans: rows.slice((page - 1) * size, page * size), totalCount: rows.length, page, size };
}

export function schedule() {
  const latest = scanRows()[0];
  return {
    brandKey: BRAND_KEY,
    status: "on",
    role: "owner",
    interval: "weekly",
    dayOfWeek: 1,
    dayOfMonth: null,
    timeOfDay: "09:00",
    timezone: "Asia/Kolkata",
    nextRunAt: daysAgo(-6),
    approvedMaxUsd: 24,
    lastSkip: null,
    lastRunAt: latest?.scanned_at ?? null,
    windows: [],
  };
}

export function gscStatus() {
  return {
    brand_key: BRAND_KEY,
    connected: true,
    oauth_configured: true,
    connection: {
      brand_key: BRAND_KEY,
      site_url: `sc-domain:${DOMAIN}`,
      enabled: true,
      auth_mode: "oauth",
      connected_at: daysAgo(70),
      last_attempt_at: daysAgo(0, 6),
      last_status: "ok",
      last_error: null,
      last_rows_written: 1840,
      last_ingested_through: dayKey(2),
      permission_level: "siteOwner",
      connection_generation: 1,
    },
  };
}
