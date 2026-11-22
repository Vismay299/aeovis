/** Keyword research, Google results, saved keywords and locations for the sample workspace. */
import { BRAND, DOMAIN, RIVALS, daysAgo, stable } from "./brand.js";

const SEED_KEYWORDS = [
  ["hospital analytics software", 2900, "commercial"],
  ["nabh accreditation software", 1300, "commercial"],
  ["hospital management system india", 8100, "commercial"],
  ["readmission rate calculation", 1900, "informational"],
  ["hims software for hospitals", 3600, "commercial"],
  ["clinical quality indicators nabh", 880, "informational"],
  ["length of stay dashboard", 590, "commercial"],
  ["hospital kpi dashboard", 1600, "commercial"],
  ["nabh quality indicators list", 2400, "informational"],
  ["hospital bi tools", 480, "commercial"],
  ["patient readmission software", 320, "transactional"],
  ["best hospital software in india", 1000, "commercial"],
  ["healthcare analytics companies india", 720, "commercial"],
  ["icu bed management software", 390, "commercial"],
  ["hospital quality audit checklist", 1300, "informational"],
  ["northpeak hospital software", 260, "navigational"],
];

function trend(base, key) {
  const now = new Date();
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1);
    const wobble = 0.82 + stable(`${key}${i}`) * 0.36 + i * 0.012;
    return { year: d.getFullYear(), month: d.getMonth() + 1, searchVolume: Math.round(base * wobble) };
  });
}

function row([keyword, searchVolume, intent]) {
  const s = stable(keyword);
  return {
    keyword, searchVolume, trend: trend(searchVolume, keyword),
    cpc: Math.round((0.6 + s * 2.4) * 100) / 100, competition: Math.round((0.25 + s * 0.6) * 100) / 100,
    keywordDifficulty: Math.round(18 + s * 52), intent,
  };
}

/** Ideas for any seed: the curated set, led by keywords that contain the seed's words. */
export function research(_url, _params, body) {
  const seed = String(body?.keyword || body?.seed || "hospital analytics software").toLowerCase().trim();
  if (body?.cacheOnly === true && !seed) return { notCached: true, cached: false };
  const words = seed.split(/\s+/).filter((w) => w.length > 2);
  const ranked = [...SEED_KEYWORDS].sort((a, b) => {
    const score = (k) => words.filter((w) => k[0].includes(w)).length;
    return score(b) - score(a) || b[1] - a[1];
  });
  const rows = ranked.map(row);
  if (!rows.some((r) => r.keyword === seed)) rows.unshift(row([seed, 1200, "commercial"]));
  return { rows, source: "blended", cached: true, fetchedAt: daysAgo(1, 12) };
}

export function serp(_url, _params, body) {
  const keyword = String(body?.keyword || "hospital analytics software");
  const depth = Number(body?.depth || 20);
  const domains = ["northpeak.com", DOMAIN, "lumeniq.ai", "expresshealthcare.in", "vantagehealth.in", "g2.com", "capterra.com", "coreset.io", "healthtechindia.com", "nabh.co"];
  const items = Array.from({ length: Math.min(depth, 20) }, (_, i) => {
    const domain = domains[i % domains.length];
    const ours = domain === DOMAIN;
    return {
      rank: i + 1,
      title: ours ? `${BRAND} — clinical analytics for Indian hospitals` : `${keyword.replace(/\b\w/g, (c) => c.toUpperCase())} | ${domain}`,
      url: `https://${domain}/${ours ? "platform" : "hospital-analytics"}`,
      domain,
      description: ours ? "Readmission, length-of-stay and NABH quality dashboards on top of your HIMS." : "Compare hospital analytics and reporting tools for Indian hospitals.",
      etv: Math.round(900 / (i + 1)), estimatedPaidTrafficCost: null,
      referringDomains: Math.round(40 + stable(domain) * 400), backlinks: Math.round(200 + stable(`${domain}b`) * 4000),
      isNew: i === 7, rankChange: ours ? 3 : i === 0 ? 0 : i % 4 === 0 ? -1 : null,
    };
  });
  return { requestedKeyword: keyword, depth, items, cached: true };
}

const TAGS = [
  { id: "a1111111-1111-4111-8111-111111111111", name: "NABH", normalizedName: "nabh", color: "sky" },
  { id: "a2222222-2222-4222-8222-222222222222", name: "Product pages", normalizedName: "product pages", color: "emerald" },
  { id: "a3333333-3333-4333-8333-333333333333", name: "Blog", normalizedName: "blog", color: "amber" },
];

function savedRows() {
  return SEED_KEYWORDS.slice(0, 12).map((k, i) => {
    const r = row(k);
    const tag = k[0].includes("nabh") ? TAGS[0] : k[2] === "informational" ? TAGS[2] : TAGS[1];
    return {
      id: `b${String(i).padStart(7, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`,
      keyword: r.keyword, locationCode: 2356, languageCode: "en", createdAt: daysAgo(40 - i),
      searchVolume: r.searchVolume, cpc: r.cpc, competition: r.competition, keywordDifficulty: r.keywordDifficulty,
      intent: r.intent, monthlySearches: r.trend, fetchedAt: daysAgo(3), tags: [tag],
    };
  });
}

export function savedList(url) {
  const rows = savedRows();
  const page = Number(url.searchParams.get("page") ?? 1);
  const pageSize = Number(url.searchParams.get("size") ?? 50);
  const tags = TAGS.map((t) => ({ ...t, keywordCount: rows.filter((r) => r.tags.some((x) => x.id === t.id)).length }));
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), totalCount: rows.length, page, pageSize, tags };
}

export function savedExport() {
  const rows = savedRows();
  return { rows, totalCount: rows.length, truncated: false };
}

export function locations(url) {
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  const registry = ["Mumbai,Maharashtra,India", "Pune,Maharashtra,India", "Bengaluru,Karnataka,India", "Chennai,Tamil Nadu,India", "Hyderabad,Telangana,India", "New Delhi,Delhi,India"]
    .map((n) => ({ locationName: n, displayLabel: n.replace(/,/g, ", "), locationType: "City" }));
  return { locations: registry.filter((r) => r.locationName.toLowerCase().includes(q)) };
}

/** A generic quote for any priced action. Shown only; nothing is ever charged in the sample. */
export function priceEstimate(_url, _params, body) {
  return {
    action: body?.action || "sample", currency: "USD", totalUsd: 0.08, expectedUsd: 0.05,
    units: [{ key: "items", label: "items", count: 1 }],
    lines: [{ label: "Sample workspace: nothing is charged", quantity: 1, unitUsd: 0.08, totalUsd: 0.08 }],
    monthly: null, warnings: [], blocked: null, priceVersion: "sample", quotedAt: new Date().toISOString(),
    inputsHash: "0".repeat(64),
  };
}

export const RIVAL_DOMAINS = RIVALS.map((r) => r.domain);
