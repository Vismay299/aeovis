/** Search Console query data and IndexNow status for brightwave.io. */
import { BRAND_KEY, DOMAIN, dayKey, daysAgo, stable } from "./brand.js";

const QUERIES = [
  ["brightwave hospital analytics", 6.2, 4.1], ["nabh quality indicators list", 11.4, 3.2], ["readmission rate calculation", 9.8, 5.6],
  ["hospital kpi dashboard", 14.1, 7.3], ["brightwave", 1.4, 1.2], ["nabh accreditation software", 18.5, 9.4],
  ["length of stay dashboard", 21.2, 11.8], ["hospital analytics software india", 24.6, 13.1], ["clinical quality indicators", 16.3, 8.9],
  ["readmission benchmarks india", 8.1, 4.4], ["hospital bi tools", 31.5, 17.2], ["nabh 5th edition indicators", 12.7, 6.5],
];

export function data(url) {
  const days = Math.max(1, Math.min(Number(url.searchParams.get("days") || 30), 90));
  const rows = [];
  for (let d = 2; d < days + 2; d++) {
    for (const [query, posStart, posEnd] of QUERIES) {
      const t = 1 - (d - 2) / days;
      const position = Math.round((posStart + (posEnd - posStart) * t + (stable(`${query}${d}`) - 0.5) * 1.5) * 10) / 10;
      const impressions = Math.round((40 + stable(`${query}i`) * 260) * (1 + t * 0.4) / Math.max(1, position / 6));
      const clicks = Math.round(impressions * Math.max(0.005, 0.28 / position));
      rows.push({ date: dayKey(d), query, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
    }
  }
  const totals = rows.reduce((a, r) => ({ clicks: a.clicks + r.clicks, impressions: a.impressions + r.impressions }), { clicks: 0, impressions: 0 });
  totals.ctr = totals.impressions ? totals.clicks / totals.impressions : 0;
  totals.avg_position = rows.reduce((s, r) => s + r.position, 0) / rows.length;
  totals.note = "Query totals exclude anonymized queries. Average position is from available query data only.";
  return {
    brand_key: BRAND_KEY, connected: true, property: `sc-domain:${DOMAIN}`, data_through: dayKey(2), days, data: rows, totals,
    measurement_source: "google_search_console_search_analytics_web_query_api", ai_visibility_imported: false, capability_checked_on: "2026-10-20",
    source_note: "Google provides a separate Generative AI performance report. This integration imports Search Analytics query data and has not ingested that report; these rows cannot establish AI-only visibility.",
  };
}

export const indexnow = () => ({
  domain: DOMAIN, key: "00000000000000000000000000000000",
  hosts: [{ host: DOMAIN, status: "found" }, { host: `www.${DOMAIN}`, status: "moved" }],
  checkedAt: daysAgo(1), ready: true,
  limits: { requestsLastHour: 0, maxRequestsPerHour: 30, urlsToday: 3, maxUrlsPerDay: 10000 },
});

export const indexnowSubmissions = () => ({
  submissions: [
    { id: "a9000000-0000-4000-8000-000000000001", createdAt: daysAgo(14, 16), source: "content", sourceRef: "c9000000", host: DOMAIN, urlCount: 1, urls: [`https://${DOMAIN}/blog/readmission-benchmarks-india`], status: "submitted", engine: "bing", httpStatus: 202, message: `Submitted 1 URL. Search engines will verify the key file on https://${DOMAIN} first.` },
  ],
});
