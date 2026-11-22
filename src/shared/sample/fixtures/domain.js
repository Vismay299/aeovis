/** Domain research: overview, ranking keywords, top pages and competitors, for any domain asked. */
import { DOMAIN, RIVALS, daysAgo, stable } from "./brand.js";

const MARKET = { locationCode: 2356, languageCode: "en", country: "India" };
const PATHS = ["/platform", "/nabh-reporting", "/readmission-analytics", "/blog/readmission-benchmarks-india", "/blog/nabh-quality-indicators", "/length-of-stay", "/pricing", "/case-studies", "/blog/hospital-kpi-dashboard", "/integrations"];
const KEYWORDS = ["hospital analytics software", "nabh quality indicators list", "readmission rate calculation", "hospital kpi dashboard", "nabh accreditation software", "length of stay dashboard", "clinical quality indicators nabh", "hospital bi tools", "patient readmission software", "hospital quality audit checklist", "healthcare analytics companies india", "icu bed management software", "hims analytics", "hospital dashboard examples", "nabh 5th edition standards"];

function target(body) {
  const raw = String(body?.domain || body?.target || DOMAIN).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  return raw || DOMAIN;
}
const size = (d) => (d === DOMAIN ? 1 : d === "northpeak.com" ? 3.4 : 0.6 + stable(d) * 1.8);
const declared = (d) => RIVALS.some((r) => r.domain === d);
const stamp = () => daysAgo(1, 11);
const provenance = { gateway: "dataforseo" };

export function overview(_u, _p, body) {
  const d = target(body);
  return {
    status: "ok", domain: d, displayTarget: d, scope: "subdomains",
    organicTraffic: Math.round(1840 * size(d)), organicKeywords: Math.round(312 * size(d)), hasData: true,
    market: MARKET, isOwnSite: d === DOMAIN, isDeclaredCompetitor: declared(d), cached: true, fetchedAt: stamp(), provenance,
  };
}

export function keywords(_u, _p, body) {
  const d = target(body);
  const rows = KEYWORDS.map((keyword, i) => {
    const s = stable(`${d}${keyword}`);
    const position = Math.max(1, Math.round(1 + s * 18 - (d === "northpeak.com" ? 4 : 0)));
    const path = PATHS[i % PATHS.length];
    const searchVolume = Math.round(300 + stable(keyword) * 3000);
    return { keyword, position, searchVolume, traffic: Math.round(searchVolume * (0.3 / position)), cpc: Math.round((0.5 + s * 2) * 100) / 100, url: `https://${d}${path}`, relativeUrl: path, keywordDifficulty: Math.round(20 + stable(keyword) * 45) };
  }).sort((a, b) => a.position - b.position);
  return { status: "ok", domain: d, page: 1, pageSize: 50, totalCount: rows.length, hasMore: false, keywords: rows, cached: true, fetchedAt: stamp(), provenance };
}

export function pages(_u, _p, body) {
  const d = target(body);
  const rows = PATHS.map((path, i) => ({ page: `https://${d}${path}`, relativePath: path, organicTraffic: Math.round((900 / (i + 1)) * size(d) * 10) / 10, keywords: Math.round((60 / (i + 1)) * size(d)) + 2 }));
  return { status: "ok", domain: d, page: 1, pageSize: 50, totalCount: rows.length, hasMore: false, pages: rows, cached: true, fetchedAt: stamp(), provenance };
}

export function competitors(_u, _p, body) {
  const d = target(body);
  const others = [DOMAIN, ...RIVALS.map((r) => r.domain), "expresshealthcare.in", "healthtechindia.com"].filter((x) => x !== d);
  return {
    status: "ok", keywordCount: KEYWORDS.length,
    competitors: others.map((domain, i) => ({
      domain, keywordsCount: Math.round(KEYWORDS.length * (0.9 - i * 0.1)), avgPosition: Math.round((3 + i * 1.6) * 10) / 10, medianPosition: 3 + i,
      visibility: Math.round((0.48 - i * 0.05) * 100) / 100, etv: Math.round(9000 * size(domain)), isOwnSite: domain === DOMAIN, isDeclaredCompetitor: declared(domain),
    })),
  };
}

export function declaredCompetitors() {
  return { available: true, competitors: RIVALS.map((r) => ({ domain: r.domain, name: r.name })), ownHost: DOMAIN };
}
