/** Site Audit: one completed crawl of brightwave.io, with issues, pages, AI crawler access and Lighthouse. */
import { WEBSITE, daysAgo } from "./brand.js";

const AUDIT_ID = "d1000000-0000-4000-8000-000000000001";
const OLDER_ID = "d1000000-0000-4000-8000-000000000002";
const PATHS = [
  ["/", "Brightwave — clinical analytics for Indian hospitals", 1, 940, ["Organization", "WebSite"]],
  ["/platform", "Hospital analytics platform | Brightwave", 1, 1320, ["SoftwareApplication"]],
  ["/nabh-reporting", "NABH reporting software | Brightwave", 1, 1580, ["SoftwareApplication", "FAQPage"]],
  ["/readmission-analytics", "Readmission analytics | Brightwave", 1, 1210, []],
  ["/length-of-stay", null, 1, 890, []],
  ["/blog/readmission-benchmarks-india", "Readmission benchmarks for Indian hospitals (2026)", 1, 2410, ["Article"]],
  ["/blog/nabh-quality-indicators", "NABH quality indicators: the full list", 2, 3120, ["Article", "FAQPage"]],
  ["/blog/hospital-kpi-dashboard", "Hospital KPI dashboard: 12 metrics that matter", 1, 1980, ["Article"]],
  ["/case-studies", "Case studies | Brightwave", 1, 760, []],
  ["/pricing", "Pricing | Brightwave", 1, 640, []],
  ["/integrations", null, 0, 410, []],
  ["/old-demo", null, 0, 0, []],
];
const pageId = (i) => `d2000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;

const capabilities = () => ({ lighthouse: true, render: true, renderReason: null, maxPages: 10000, renderedMaxPages: 1000, monthlyPagesUsed: 148, monthlyPagesCap: 50000, defaultUrl: `${WEBSITE}/` });

export function list() {
  return {
    audits: [
      { id: AUDIT_ID, startUrl: `${WEBSITE}/`, status: "completed", pagesCrawled: 74, pagesTotal: 74, maxPages: 100, lighthouse: true, renderJavaScript: false, createdAt: daysAgo(3, 10), completedAt: daysAgo(3, 10, 4), issueCounts: { critical: 2, warning: 5, info: 3 } },
      { id: OLDER_ID, startUrl: `${WEBSITE}/`, status: "completed", pagesCrawled: 71, pagesTotal: 71, maxPages: 100, lighthouse: false, renderJavaScript: false, createdAt: daysAgo(24, 10), completedAt: daysAgo(24, 10, 3), issueCounts: { critical: 4, warning: 7, info: 3 } },
    ],
    capabilities: capabilities(),
  };
}

export function status(id) {
  if (id !== AUDIT_ID && id !== OLDER_ID) return undefined;
  const older = id === OLDER_ID;
  return { id, startUrl: `${WEBSITE}/`, status: "completed", currentPhase: "completed", pagesCrawled: older ? 71 : 74, pagesTotal: older ? 71 : 74, lighthouseTotal: older ? 0 : 6, lighthouseCompleted: older ? 0 : 6, lighthouseFailed: 0, renderJavaScript: false, lighthouse: !older, cancelRequested: false, errorCode: null, failedPhase: null, createdAt: daysAgo(older ? 24 : 3, 10), startedAt: daysAgo(older ? 24 : 3, 10), completedAt: daysAgo(older ? 24 : 3, 10, 4), pollAfterSeconds: null };
}

const GROUPS = [
  { issueType: "missing-title", severity: "critical", category: "content", scope: "page", pages: 2, rows: 2, paths: [4, 10] },
  { issueType: "broken-page", severity: "critical", category: "links", scope: "page", pages: 1, rows: 1, paths: [11] },
  { issueType: "missing-meta-description", severity: "warning", category: "content", scope: "page", pages: 3, rows: 3, paths: [4, 8, 10] },
  { issueType: "images-missing-alt", severity: "warning", category: "content", scope: "page", pages: 2, rows: 2, paths: [5, 7] },
  { issueType: "title-too-long", severity: "info", category: "content", scope: "page", pages: 2, rows: 2, paths: [6, 7] },
  { issueType: "missing-structured-data", severity: "info", category: "content", scope: "page", pages: 4, rows: 4, paths: [3, 4, 8, 9] },
];

export function summary(id) {
  if (id !== AUDIT_ID && id !== OLDER_ID) return undefined;
  return {
    audit: { id, startUrl: `${WEBSITE}/`, status: "completed", pagesCrawled: 74, pagesSeen: 81, maxPages: 100, crawlCompleted: true, lighthouse: id === AUDIT_ID, renderJavaScript: false, sitePlatform: "nextjs", createdAt: daysAgo(3, 10), completedAt: daysAgo(3, 10, 4) },
    stats: { averageResponseMs: 286, pagesBlocked: 0, pagesRateLimited: 0, pagesAbandoned: 0, pagesUnread: 0, lighthouse: { tests: 6, failed: 0, avgPerformance: 81, avgSeo: 96, avgAccessibility: 91 } },
    issueGroups: GROUPS.map(({ paths, ...g }) => g),
    aiAccess: {
      robotsStatus: "found",
      rows: [
        { name: "OAI-SearchBot", operator: "OpenAI", platform: "ChatGPT Search", purpose: "search", status: "open", matchedGroup: null, reason: null },
        { name: "GPTBot", operator: "OpenAI", platform: "ChatGPT", purpose: "training", status: "blocked", matchedGroup: "GPTBot", reason: "A GPTBot group disallows / (Disallow: /)." },
        { name: "ChatGPT-User", operator: "OpenAI", platform: "ChatGPT", purpose: "agent", status: "open", matchedGroup: null, reason: null },
        { name: "PerplexityBot", operator: "Perplexity", platform: "Perplexity", purpose: "search", status: "open", matchedGroup: null, reason: null },
        { name: "Google-Extended", operator: "Google", platform: "Gemini", purpose: "training", status: "open", matchedGroup: null, reason: null },
        { name: "ClaudeBot", operator: "Anthropic", platform: "Claude", purpose: "training", status: "open", matchedGroup: null, reason: null },
      ],
    },
    llmsTxt: { status: "found", httpStatus: 200, contentType: "text/plain", firstLine: "# Brightwave" },
    flags: { siteBlocked: false, crawlStopped: false, hasShells: false, unreadRendered: false, linkGraphComplete: true, discoveryTruncated: false },
  };
}

export function issues(id, url) {
  if (id !== AUDIT_ID && id !== OLDER_ID) return undefined;
  const type = url.searchParams.get("issueType") || url.searchParams.get("type") || "missing-title";
  const group = GROUPS.find((g) => g.issueType === type) || GROUPS[0];
  return { issueType: group.issueType, total: group.paths.length, rows: group.paths.map((p, i) => ({ id: `d3000000-0000-4000-8000-${String(p * 10 + i).padStart(12, "0")}`, pageId: pageId(p), pageUrl: `${WEBSITE}${PATHS[p][0]}`, details: null })) };
}

export function pages(id) {
  if (id !== AUDIT_ID && id !== OLDER_ID) return undefined;
  const rows = PATHS.map(([path, title, h1, words, sd], i) => {
    const broken = path === "/old-demo";
    return {
      id: pageId(i), url: `${WEBSITE}${path}`, statusCode: broken ? 404 : 200, fetchClass: broken ? "error" : "ok", redirectUrl: null,
      title, metaDescription: [4, 8, 10].includes(i) || broken ? null : `${title || "Brightwave"} — analytics for hospitals.`,
      h1Count: h1, wordCount: words, imagesTotal: 4 + (i % 5), imagesMissingAlt: [5, 7].includes(i) ? 2 : 0, responseTimeMs: 180 + i * 23,
      crawlDepth: i === 0 ? 0 : path.startsWith("/blog") ? 2 : 1, inSitemap: !broken, isIndexable: !broken, structuredDataTypes: sd,
      issueCount: GROUPS.filter((g) => g.paths.includes(i)).length, rendered: false,
    };
  });
  return { total: rows.length, rows };
}

export function performance(id) {
  if (id !== AUDIT_ID) return { rows: [] };
  const rows = [0, 1, 2].flatMap((p) => ["mobile", "desktop"].map((strategy, j) => ({
    id: `d4000000-0000-4000-8000-${String(p * 2 + j + 1).padStart(12, "0")}`, pageId: pageId(p), pageUrl: `${WEBSITE}${PATHS[p][0]}`, pagePath: PATHS[p][0], strategy,
    performanceScore: strategy === "mobile" ? 68 + p * 4 : 91 + p, accessibilityScore: 90 + p, bestPracticesScore: 96, seoScore: 95 + p,
    lcpMs: strategy === "mobile" ? 2900 - p * 200 : 1100, cls: 0.03, inpMs: strategy === "mobile" ? 170 : 80, ttfbMs: 220 + p * 20, errorMessage: null, hasDetails: true,
  })));
  return { rows };
}

export function lighthouse(id, resultId) {
  if (id !== AUDIT_ID) return undefined;
  const perf = performance(id).rows.find((r) => r.id === resultId);
  if (!perf) return undefined;
  const m = (v, unit) => ({ score: null, displayValue: unit === "ms" ? `${Math.round(v)} ms` : unit === "s" ? `${(v / 1000).toFixed(1)} s` : String(v), numericValue: v });
  return {
    id: resultId, finalUrl: perf.pageUrl, strategy: perf.strategy, createdAt: daysAgo(3, 10, 4), hasIssueDetails: true,
    scores: { performance: perf.performanceScore, accessibility: perf.accessibilityScore, "best-practices": perf.bestPracticesScore, seo: perf.seoScore },
    metrics: { firstContentfulPaint: m(1200, "s"), largestContentfulPaint: m(perf.lcpMs, "s"), totalBlockingTime: m(perf.inpMs, "ms"), cumulativeLayoutShift: m(perf.cls), speedIndex: m(2300, "s"), timeToInteractive: m(3600, "s"), interactionToNextPaint: m(perf.inpMs, "ms"), serverResponseTime: m(perf.ttfbMs, "s") },
    issues: [
      { category: "performance", auditKey: "unused-javascript", title: "Reduce unused JavaScript", description: "Remove scripts the page does not use.", score: 40, scoreDisplayMode: "metricSavings", displayValue: "Potential savings of 540 ms", impactMs: 540, impactBytes: null, severity: "warning", items: [] },
      { category: "accessibility", auditKey: "color-contrast", title: "Background and foreground colors do not have a sufficient contrast ratio.", description: "Improve contrast on the pricing table.", score: 0, scoreDisplayMode: "binary", displayValue: null, impactMs: null, impactBytes: null, severity: "warning", items: [] },
    ],
  };
}

export const feed = () => ({ entries: [], pollAfterSeconds: null });
export const crawlerAccess = () => ({ credentials: [] });
