/** Backlinks: overview with trends, backlink rows, referring domains, top pages, weekly snapshots. */
import { DOMAIN, RIVALS, daysAgo, dayKey, stable } from "./brand.js";

const REFERRERS = ["expresshealthcare.in", "healthtechindia.com", "medicaldialogues.in", "nabh.co", "ehealth.eletsonline.com", "g2.com", "capterra.com", "hospitalmanagement.net", "yourstory.com", "inc42.com", "linkedin.com", "medium.com", "healthcareradius.in", "cxotoday.com", "biospectrumindia.com"];
const PAGES = ["/", "/blog/readmission-benchmarks-india", "/nabh-reporting", "/platform", "/blog/nabh-quality-indicators", "/case-studies", "/length-of-stay"];
const provenance = { gateway: "dataforseo" };
const stamp = () => daysAgo(1, 11);

function target(body) {
  return String(body?.target || DOMAIN).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "") || DOMAIN;
}
const scale = (t) => (t === DOMAIN ? 1 : t === "northpeak.com" ? 3.1 : 0.7 + stable(t) * 1.5);

export function overview(_u, _p, body) {
  const t = target(body);
  const k = scale(t);
  const months = 12;
  const trends = Array.from({ length: months }, (_, i) => {
    const grow = 0.62 + (i / (months - 1)) * 0.38;
    return { date: dayKey((months - 1 - i) * 30), backlinks: Math.round(4120 * k * grow), referringDomains: Math.round(312 * k * grow), rank: Math.round(21 + i * 0.4) };
  });
  const newLostTrends = trends.map((tr, i) => ({ date: tr.date, newBacklinks: Math.round((60 + stable(`n${i}`) * 50) * k), lostBacklinks: Math.round((18 + stable(`l${i}`) * 25) * k), newReferringDomains: Math.round((5 + stable(`nd${i}`) * 6) * k), lostReferringDomains: Math.round((1 + stable(`ld${i}`) * 4) * k) }));
  return {
    status: "ok", target: t, displayTarget: t, scope: "subdomains",
    summary: { rank: 26, backlinks: Math.round(4120 * k), referringPages: Math.round(2980 * k), referringDomains: Math.round(312 * k), brokenBacklinks: 14, brokenPages: 3, backlinksSpamScore: 9, targetSpamScore: 3, newBacklinks: Math.round(85 * k), lostBacklinks: Math.round(40 * k), newReferringDomains: 9, lostReferringDomains: 5 },
    trends, newLostTrends,
    tracked: t === DOMAIN ? snapshotTarget() : null,
    isOwnSite: t === DOMAIN, isDeclaredCompetitor: RIVALS.some((r) => r.domain === t),
    cached: true, fetchedAt: stamp(), provenance,
  };
}

function page(rows, body) {
  const p = Number(body?.page || 1);
  const size = Number(body?.pageSize || 50);
  return { status: "ok", rows: rows.slice((p - 1) * size, p * size), totalCount: rows.length, hasMore: p * size < rows.length, page: p, pageSize: size, cached: true, fetchedAt: stamp(), provenance };
}

export function rows(_u, _p, body) {
  const t = target(body);
  const list = REFERRERS.flatMap((domainFrom, i) => [0, 1].map((j) => {
    const s = stable(`${domainFrom}${j}`);
    return {
      domainFrom, urlFrom: `https://${domainFrom}/${j ? "news" : "articles"}/hospital-analytics-${i + 1}`, urlTo: `https://${t}${PAGES[(i + j) % PAGES.length]}`,
      anchor: ["Brightwave", "readmission benchmarks", "NABH reporting software", "hospital analytics", "brightwave.io"][(i + j) % 5],
      itemType: "anchor", isDofollow: s > 0.25, relAttributes: s > 0.25 ? [] : ["nofollow"], rank: Math.round(20 + s * 60),
      domainFromRank: Math.round(30 + stable(domainFrom) * 55), pageFromRank: Math.round(15 + s * 50), spamScore: Math.round(s * 20),
      firstSeen: daysAgo(30 + Math.round(s * 300)), lastSeen: daysAgo(Math.round(s * 6)), isLost: i === 13 && j === 1, isBroken: i === 9 && j === 0, linksCount: 1,
    };
  }));
  return page(list, body);
}

export function referringDomains(_u, _p, body) {
  const list = REFERRERS.map((domain, i) => ({ domain, backlinks: Math.round(40 / (i + 1)) + 2, referringPages: Math.round(20 / (i + 1)) + 1, rank: Math.round(30 + stable(domain) * 55), spamScore: Math.round(stable(`${domain}s`) * 18), firstSeen: daysAgo(40 + i * 17), brokenBacklinks: i === 9 ? 1 : 0, brokenPages: 0 }));
  return page(list, body);
}

export function topPages(_u, _p, body) {
  const t = target(body);
  const list = PAGES.map((path, i) => ({ page: `https://${t}${path}`, backlinks: Math.round(900 / (i + 1)), referringDomains: Math.round(120 / (i + 1)) + 3, rank: Math.round(40 - i * 3), brokenBacklinks: i === 4 ? 2 : 0 }));
  return page(list, body);
}

export function ahrefsDr(_u, _p, body) {
  const domains = Array.isArray(body?.domains) ? body.domains : REFERRERS;
  return { ratings: Object.fromEntries(domains.map((d) => [d, Math.round(25 + stable(`dr${d}`) * 60)])) };
}

function snapshotTarget() {
  return { id: "sample-snapshot-target", target: DOMAIN, scope: "subdomains", label: null, interval: "weekly", enabled: true, nextRunAt: daysAgo(-4, 0), lastRunAt: daysAgo(3, 0), lastSkipReason: null, lastSkipMessage: null };
}
export const snapshotTargets = () => ({ targets: [snapshotTarget()] });
export function snapshots() {
  return {
    snapshots: Array.from({ length: 8 }, (_, i) => {
      const n = 7 - i;
      return {
        capturedOn: dayKey(3 + n * 7), capturedAt: daysAgo(3 + n * 7, 0), source: "scheduled", rank: 26,
        backlinks: 4120 - n * 38, referringDomains: 312 - n * 3, referringPages: 2980 - n * 25, brokenBacklinks: 14, brokenPages: 3,
        newBacklinks: 20 + (n % 3) * 4, lostBacklinks: 8 + (n % 2) * 3, newReferringDomains: 2 + (n % 2), lostReferringDomains: n % 2,
        backlinksSpamScore: 9, targetSpamScore: 3,
      };
    }),
  };
}
