import { SAMPLE_FEATURES } from "./workspace.js";
import { BRAND_KEY } from "./brand.js";
import * as core from "./core.js";
import * as ws from "./workspace-data.js";
import * as explore from "./explore.js";
import * as kw from "./keywords.js";
import * as domain from "./domain.js";
import * as bl from "./backlinks.js";
import * as local from "./local.js";
import * as audit from "./audit.js";
import * as rank from "./rankTracking.js";
import * as assistant from "./assistant.js";
import * as rep from "./reports.js";
import * as ga4 from "./ga4.js";
import * as content from "./content.js";
import * as sc from "./searchConsole.js";

/** [path or RegExp, (url, params) => body]. First match wins. A handler returning undefined means "no data". */
export const routes = [
  ["/api/customer/features", () => ({ brandKey: BRAND_KEY, features: SAMPLE_FEATURES })],
  ["/api/customer/overview", () => core.overview()],
  ["/api/customer/gsc", () => core.gscStatus()],
  ["/api/customer/schedule", () => core.schedule()],
  ["/api/customer/scan", () => core.scansList()],
  ["/api/customer/scans/history", (url) => core.scansHistory(url)],
  [/^\/api\/customer\/scan\/report\/([^/]+)$/, (url, [id]) => core.reportFor(decodeURIComponent(id)) ?? { __status: 404, body: { error: "Scan not found" } }],
  ["/api/customer/questions", () => ws.questionsState()],
  ["/api/customer/repairs/panel", () => ws.repairsPanel()],
  [/^\/api\/customer\/repairs\/[a-z_]+$/, () => ws.repairsList()],
  ["/api/customer/measurement", () => ws.measurement()],
  ["/api/customer/context", () => ws.context()],
  ["/api/customer/team", () => ws.team()],
  ["/api/customer/usage", (url) => ws.usage(url)],
  ["/api/customer/email/preferences", () => ws.emailPreferences()],
  ["/api/customer/privacy", () => ws.privacy()],
  ["/api/customer/explore", () => explore.exploreList()],
  [/^\/api\/customer\/explore\/([^/]+)$/, (url, [id]) => explore.exploreRun(decodeURIComponent(id))],
  ["/api/customer/keywords/research", kw.research, "POST"],
  ["/api/customer/keywords/serp", kw.serp, "POST"],
  ["/api/customer/keywords/saved", (url) => kw.savedList(url)],
  ["/api/customer/keywords/saved/export", () => kw.savedExport()],
  ["/api/customer/keywords/locations", (url) => kw.locations(url)],
  ["/api/customer/price/estimate", kw.priceEstimate, "POST"],
  ["/api/customer/domain/overview", domain.overview, "POST"],
  ["/api/customer/domain/keywords", domain.keywords, "POST"],
  ["/api/customer/domain/pages", domain.pages, "POST"],
  ["/api/customer/domain/competitors", domain.competitors, "POST"],
  ["/api/customer/domain/competitors/declared", () => domain.declaredCompetitors()],
  ["/api/customer/backlinks/overview", bl.overview, "POST"],
  ["/api/customer/backlinks/rows", bl.rows, "POST"],
  ["/api/customer/backlinks/referring-domains", bl.referringDomains, "POST"],
  ["/api/customer/backlinks/top-pages", bl.topPages, "POST"],
  ["/api/customer/backlinks/ahrefs-dr", bl.ahrefsDr, "POST"],
  ["/api/customer/backlinks/snapshot-targets", () => bl.snapshotTargets()],
  ["/api/customer/backlinks/snapshots", () => bl.snapshots()],
  ["/api/customer/local/businesses", () => local.businesses()],
  [/^\/api\/customer\/local\/businesses\/([^/]+)$/, (u, [id]) => local.business(id)],
  ["/api/customer/local/profile", () => local.profile(), "POST"],
  ["/api/customer/local/fetches", () => local.fetches()],
  [/^\/api\/customer\/local\/fetches\/([^/]+)$/, (u, [id]) => local.fetchDetail(id)],
  ["/api/customer/local/grids", () => local.grids()],
  [/^\/api\/customer\/local\/grids\/([^/]+)$/, (u, [id]) => local.grid(id)],
  ["/api/customer/local/serp", () => local.serp(), "POST"],
  ["/api/customer/local/listings", () => local.listings(), "POST"],
  ["/api/customer/local/categories", () => local.categories()],
  ["/api/customer/audit", () => audit.list()],
  ["/api/customer/audit/crawler-access", () => audit.crawlerAccess()],
  [/^\/api\/customer\/audit\/([^/]+)$/, (u, [id]) => audit.status(id)],
  [/^\/api\/customer\/audit\/([^/]+)\/summary$/, (u, [id]) => audit.summary(id)],
  [/^\/api\/customer\/audit\/([^/]+)\/issues$/, (u, [id]) => audit.issues(id, u)],
  [/^\/api\/customer\/audit\/([^/]+)\/pages$/, (u, [id]) => audit.pages(id)],
  [/^\/api\/customer\/audit\/([^/]+)\/performance$/, (u, [id]) => audit.performance(id)],
  [/^\/api\/customer\/audit\/([^/]+)\/feed$/, () => audit.feed()],
  [/^\/api\/customer\/audit\/([^/]+)\/lighthouse\/([^/]+)$/, (u, [id, rid]) => audit.lighthouse(id, rid)],
  ["/api/customer/rank-tracking/configs", () => rank.trackers()],
  [/^\/api\/customer\/rank-tracking\/configs\/([^/]+)$/, (u, [id]) => rank.config(id)],
  [/^\/api\/customer\/rank-tracking\/configs\/([^/]+)\/results$/, (u, [id]) => rank.results(id)],
  [/^\/api\/customer\/rank-tracking\/configs\/([^/]+)\/runs\/latest$/, (u, [id]) => rank.runsLatest(id)],
  [/^\/api\/customer\/rank-tracking\/configs\/([^/]+)\/trend$/, (u, [id]) => rank.trend(id, u)],
  [/^\/api\/customer\/rank-tracking\/configs\/([^/]+)\/matrix$/, (u, [id]) => rank.matrix(id, u)],
  [/^\/api\/customer\/rank-tracking\/configs\/([^/]+)\/keywords\/([^/]+)\/history$/, (u, [id, kid]) => rank.history(id, kid)],
  ["/api/customer/rank-tracking/suggestions", () => rank.suggestions(), "POST"],
  ["/api/customer/assistant/config", () => assistant.config()],
  ["/api/customer/assistant/sessions", () => assistant.sessions()],
  // No turn is streaming in the sample, which the real route answers with 204.
  [/^\/api\/customer\/assistant\/sessions\/([^/]+)\/stream$/, () => ({ __status: 204, body: null })],
  [/^\/api\/customer\/assistant\/sessions\/([^/]+)$/, (u, [id]) => assistant.session(decodeURIComponent(id))],
  ["/api/customer/reports", () => rep.list()],
  ["/api/customer/reports/templates", () => rep.templates()],
  [/^\/api\/customer\/reports\/([^/]+)$/, (u, [id]) => rep.detail(decodeURIComponent(id))],
  ["/api/customer/ga4", () => ga4.status()],
  ["/api/customer/ga4/overview", () => ga4.overview()],
  ["/api/customer/ga4/opportunities", () => ga4.opportunities()],
  ["/api/customer/ga4/health", () => ga4.health()],
  ["/api/customer/ga4/properties", () => ga4.properties()],
  ["/api/customer/ga4/accounts", () => ga4.accounts()],
  [/^\/api\/customer\/ga4\/reports\/([a-z_]+)$/, (u, [kind]) => ga4.report(kind)],
  ["/api/customer/content", () => content.list()],
  [/^\/api\/customer\/content\/([^/]+)$/, (u, [id]) => content.item(decodeURIComponent(id))],
  ["/api/customer/agents", () => content.agents()],
  ["/api/customer/gsc/data", (url) => sc.data(url)],
  ["/api/customer/indexnow", () => sc.indexnow()],
  ["/api/customer/indexnow/submissions", () => sc.indexnowSubmissions()],
];
