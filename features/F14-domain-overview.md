# F14 — Domain overview and competitor research

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F14 |
| Wave | 2 |
| Comparison rows covered | "Domain and competitor research" (OpenSEO: traffic estimate, ranked keywords with about 20 filters, top pages, SERP competitors. Perceev: none) |
| Depends on | F13 phase 1 (merged): `createLabsClient().domain.*` and `.labs.serpCompetitors`, `src/lib/providers/dataforseo/{filters,researchScopeFilters}.ts`, `src/shared/researchScope.ts`, `src/lib/research/{target,cache,providerErrors}.ts`, `ResearchScopeSelect`, `SearchCard`, `PricedActionButton`, `LABS_LOCATION_OPTIONS`, `workspaceMarket`. F13 phase 3: `upsertKeywordMetrics`, `POST /api/customer/keywords/saved`. F01, F02 phase 2, F03 phase 1, F07 phase 1 (`applyContextUpdates`, `declaredCompetitors`, `appendResearch`, `findRecentResearch`), F09 phase 1. UI phases also need F04, F05, F06 merged. |
| Blocks | F27 (free-tool hand-off preset), F15 (keyword suggestions from a domain, optional), F21/F22 (domain tools) |
| Reserved migrations | 105–109. **None used**: F14 stores nothing new (lookups live in F01's provider cache, saved keywords in F13's tables, competitors in F07's). |
| Feature flag | `FEATURE_DOMAIN_RESEARCH` (feature name `domain_research`, spend `["domain.research"]`): page, routes, sidebar item. In `CLIENT_FEATURES`. Off in production by default. |
| Spend features | `domain.research` ("Domain research"), `domain.competitors` ("SERP competitor research"). Both ship disabled. |
| OpenSEO reference | `openseo:src/serverFunctions/domain.ts`, `openseo:src/server/features/domain/services/*`, `openseo:src/server/lib/dataforseo/{labs,filters,researchScopeFilters}.ts`, `openseo:src/types/schemas/domain.ts`, `openseo:src/shared/researchScope.ts`, `openseo:src/client/features/domain/**`, `openseo:src/routes/_app/p/$projectId/domain.tsx`, `openseo:src/server/mcp/tools/dataforseo-research-tools.ts:325-372,560-578,612-620,829-836,1093-1150` (find_serp_competitors) at `c5f8db1` |

## 1. Summary

Customers look up any domain, subdomain, folder or page and see its estimated organic traffic and keyword count, the keywords it ranks for (with about 20 filters translated to DataForSEO server-side), its top pages, and the domains competing with it in Google results. Good keywords go to F13's saved list in one click, competitors go to the workspace's declared competitor list in project memory (F07), and every table exports through F06. A URL preset ("keywords ranking 4–20, by volume") lets F27's free-tool hand-off open the page on striking-distance keywords.

## 2. What OpenSEO does (observed)

1. **Server functions** `getDomainOverview`, `getDomainKeywordSuggestions`, `getDomainKeywordsPage`, `getDomainPagesPage`, all resolving a Labs-only market with `resolveLabsMarket` (falls back to the US when the project market is Google-Ads-only) (`openseo:src/serverFunctions/domain.ts:20-84`, `openseo:src/shared/keyword-locations.ts:744-766`).
2. **Research target and scope.** Input may be a domain or URL; scopes `exact_url`, `subfolder`, `domain`, `subdomains`; root inputs default to `subdomains`, inputs with a path to `subfolder`; credentials, fake TLDs and `_` hosts are rejected before any paid call (`openseo:src/shared/researchScope.ts:17-180`).
3. **Overview** (`openseo:src/server/features/domain/services/DomainService.ts:22-120`): `domain_rank_overview` for the bare hostname (it has no filters and always covers subdomains, so every scope shares one entry per hostname); traffic = rounded `metrics.organic.etv`, keywords = rounded `metrics.organic.count`; `hasData = keywords > 0`; cached 12 h **only when it has data**, written with `waitUntil` so the write survives the response; the scope and display target are echoed.
4. **Keywords page** (`openseo:src/server/features/domain/services/domainKeywordsPage.ts:19-135`): `ranked_keywords` with `limit = pageSize`, `offset = (page − 1) × pageSize`, `order_by` from the sort mode (`rank`, `traffic`, `volume`, `score`, `cpc` → DataForSEO fields, `domainKeywordFilters.ts:12-33`), filters built server-side, every result cached 12 h under a key that includes the filters and search; `hasMore` from `total_count` or a full page (`pagination.ts:1-12`). Rows map keyword, position (`rank_absolute`), volume, traffic (ETV), CPC, URL, relative URL, difficulty (`domainKeywordMapper.ts:4-45`).
5. **Filters** (`openseo:src/types/schemas/domain.ts:69-146`, `domainKeywordFilters.ts:35-123`): keywords take include/exclude terms (one `ilike`/`not_ilike` per term), traffic, volume, CPC, difficulty and rank ranges (one condition per bound) and a free-text search (an OR group of keyword and URL, counted as 2). Pages take include/exclude page-URL terms, traffic and keyword-count ranges and a search term (`domainPagesPage.ts:81-120`). Twelve keyword and six page filter fields, eighteen in all, plus search. DataForSEO allows 8 conditions per request; scope filters consume `RESEARCH_SCOPE_FILTER_SLOTS` (keywords: exact URL 4, subfolder 4, domain 1, subdomains 0; pages: 4, 4, 2, 0) and the server throws when over budget (`filters.ts:64-77`, `researchScope.ts:182-193`).
6. **Scope filters** pin the host (`domain`) or add path patterns (`subfolder`, `exact_url`) to `ranked_keywords` and `relevant_pages` (`openseo:src/server/lib/dataforseo/researchScopeFilters.ts:95-172`).
7. **Pages page** (`domainPagesPage.ts:20-227`): `relevant_pages` sorted by traffic or keywords, same paging and 12 h cache.
8. **Keyword suggestions** for rank-tracking setup: top 100 ranked keywords by ETV, cached 12 h when non-empty (`DomainService.ts:122-217`).
9. **SERP competitors** exist only as the MCP tool `find_serp_competitors`: 1–100 keywords, result types default `organic` + `local_pack`, optional exclusions matched as host or subdomain, sort by visibility (default), traffic, average position (ascending) or keyword count, limit 1–100 default 50 (`dataforseo-research-tools.ts:62-67`, `:325-372`, `:560-578`, `:612-620`, `:1093-1150`); endpoint `serp_competitors/live` (`labs.ts:369-396`); columns domain, keywords, avg pos, median pos, visibility, ETV (`:829-836`).
10. **Prices**: overview `labsUsd(1)`, ranked keywords, relevant pages and SERP competitors `labsUsd(limit)` = $0.012 + $0.00012 per row (`openseo:src/server/lib/dataforseo/pricing.ts:84-85`, `:247-253`, `:286-288`).
11. **Page** (`openseo:src/client/features/domain/DomainOverviewPage.tsx:439-708`): `PageHeader` "Domain Overview" / "Analyze any domain's SEO profile: traffic, keywords, and backlinks."; search card with "Enter a domain or URL", scope select, Labs-only location select and sort select ("By Rank", "By Traffic", "By Volume", "By Score", "By CPC") (`components/DomainSearchCard.tsx:21-130`); recent searches "Enter a domain to get started"; search tabs; overview card with the display target, a scope badge and a metrics table "Estimated organic traffic", "Organic keywords" with hint "Whole domain incl. subdomains" for narrower scopes (`:508-513`, `:626-670`); info alert "Not enough data for this scope yet. Try another domain or a broader scope." (`:616-624`); error "Lookup failed." (`:529-536`); tabs "Top Keywords" / "Top Pages".
12. **URL state** (`openseo:src/client/features/domain/domainRouteState.ts:36-138`, `openseo:src/types/schemas/domain.ts:171-207`): domain, scope (omitted when it equals the input's default), sort, order (rank ascending by default, others descending, `utils.ts:27-29`), tab, location (Labs codes only), page, size and all eighteen filters (page filters prefixed `p`); defaults are stripped from the URL (`openseo:src/routes/_app/p/$projectId/domain.tsx:14-47`).
13. **Last-used filters per target** (`useDomainFilterPreferences.ts:12-157`): each tab's applied filters are saved per project and target in local storage and restored when the URL carries none; restored filters over the scope's budget are held back with "Saved filters exceed this scope's {n}-condition limit and were not applied. Open Filters to trim them." (`components/KeywordsTab.tsx:107-130`, `components/DomainTableToolbar.tsx:54-65`).
14. **Keywords tab** (`components/KeywordsTab.tsx:89-336`): bulk bar "Save Keywords" (enabled only when the shown market matches the form and the overview has data, `DomainOverviewPage.tsx:394-402`) and an export menu "Export to Sheets" / "Download CSV"; toolbar "· Select keywords to save" / "{n} selected"; filter panel labels "Include Terms" ("audit, checker, template"), "Exclude Terms" ("jobs, salary, course"), "Traffic", "Volume", "CPC (USD)", "Score (KD)", "Rank"; filter panel shows "{n} / {max} conditions" and "Too many filter conditions" (`DomainFilterPanel.tsx:150-239`). Columns "Keyword", "Rank", "Volume", "Traffic", "CPC" ("Cost per click in USD."), "URL", "Score" (`DomainKeywordsTable.tsx:60-150`). Export headers `Keyword, Rank, Volume, Traffic, CPC, URL, Score` (`utils.ts:85-98`).
15. **Pages tab** (`components/PagesTab.tsx:39-228`): "Include Page Terms" ("pricing, tools, guides"), "Exclude Page Terms" ("blog, tag, archive"), "Traffic", "Keywords"; columns "Page", "Organic Traffic", "Keywords"; empty "No pages match this search." (`DomainPagesTable.tsx:40-100`).
16. **Save from the domain page** sends volume, CPC and difficulty as client metrics (`domainActions.ts:21-59`) and toasts "Saved {n} keywords".
17. **Free-tool hand-off** (marketing site): the competitor keyword finder reads 20 organic ranked keywords for a domain (`openseo:web/src/routes/api/competitor-keyword-finder.ts:67-79`). The "keywords ranking 4–20 by volume" landing behaviour is F27's.
18. **Tests** we port: `domainKeywordFilters.test.ts:4-86` (6 cases), `pagination.test.ts`, `domainRouteState.test.ts:5-70`, `components/domainResultLinks.test.ts`.

## 3. What Perceev has today

- No domain research. Competitor information exists only on the tracking side (extracted from answers, `src/lib/scoring/competitorExtract.js:92`), which is the deferred Mixed row "Competitors (tracking side)"; F07 adds a declared competitor list in project memory (`project_competitors`).
- F13 phase 1 provides the Labs client (including `domain.*` and `serpCompetitors`), research scope, filters, target parsing and cache helpers; F13 phase 3 the saved-keyword service and the shared `keyword_metrics` table.
- **Must not break:** P0 controls (F14 calls only Labs endpoints through `metered()`, never an answer engine); scan competitor extraction and roster continuity (F14 writes only F07's declared list, which scans do not read); F13's saved keywords.

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F14-AC-01 | `buildKeywordFilters` and the page filter builder pass OpenSEO's six cases (translation, LIKE escaping, search OR-group last, exactly 8 accepted, 9 refused with `400 filters_over_budget`, search counts 2) with scope clauses consuming the budget. | unit `src/lib/domain/domainKeywordFilters.test.ts` |
| F14-AC-02 | The overview calls `domain_rank_overview` once per hostname and market, maps traffic and keywords rounded, sets `hasData = keywords > 0`, caches 12 h only when `hasData`, and echoes scope and display target; a narrower scope reuses the hostname entry. | unit `src/lib/domain/domainService.test.ts` |
| F14-AC-03 | Keyword and page tables page through `ranked_keywords`/`relevant_pages` with OpenSEO's offsets, sort fields, scope filters and `hasMore`; every page is cached 12 h per filter/search/sort/page combination. | unit `domainService.test.ts`; `src/lib/domain/pagination.test.ts` |
| F14-AC-04 | Domain lookups are cached with `scope: "workspace"`: workspace B looking up the same domain pays again; workspace A repeating it pays nothing within 12 h. | unit `domainService.test.ts`; route test |
| F14-AC-05 | Every paid call is metered under `domain.research` (tables) or `domain.competitors` (competitors) with F03 estimates; `cacheOnly: true` never reserves or calls; a link or reload of `/portal/domain?...` never spends. | route `src/lib/domain/domain.route.test.mjs`; browser B2 |
| F14-AC-06 | Ranked keyword rows from a fetch (not a cache hit) are upserted into F13's `keyword_metrics` with `source "labs_ranked"` (volume, CPC, difficulty only) without delaying the response. | unit `domainService.test.ts` |
| F14-AC-07 | Priced actions `domain.lookup.run` (overview + first table page; approval optional), `domain.keywords.page`, `domain.pages.page` (approval optional) and `domain.competitors.run` (approval **required**) quote §6.4's lines; a stale `maxUsd` returns `409 price_changed` before anything is reserved. | unit `src/lib/pricing/actions/domain.test.ts`; route test |
| F14-AC-08 | SERP competitors for 1–100 keywords exclude the researched host and its subdomains, sort by visibility (desc), traffic (desc), average position (asc) or keyword count (desc), and flag each row `isOwnSite` and `isDeclaredCompetitor`. | unit `src/lib/domain/serpCompetitors.test.ts` |
| F14-AC-09 | "Add as competitor" writes through F07 `applyContextUpdates` (`addCompetitors`, author `user`), refuses the workspace's own host with F07's message, maps F07 caps, and is offered only when `project_memory` is on and the domain is not already declared. Scan competitor extraction is unchanged. | route test; browser B7 |
| F14-AC-10 | "Save keywords" saves the selected rows to F13's list with the shown market and optional tags, without sending metrics; it is disabled when the form's market differs from the shown market or the overview has no data, and hidden when `keyword_research` is off. | browser B5; route test |
| F14-AC-11 | URL state carries domain, scope, sort, order, tab, location, page, size and all eighteen filters (page filters prefixed `p`), drops defaults and non-Labs locations; `buildDomainResearchHref({ domain, preset: "striking_distance" })` yields `/portal/domain?domain=<d>&minRank=4&maxRank=20&sort=volume&order=desc`. | unit `src/shared/domain.test.ts` (ported route-state cases) |
| F14-AC-12 | Last-used filters are restored per workspace, target and tab when the URL has none; restored filters over the scope budget are held back with OpenSEO's message. | unit `src/shared/domain.test.ts`; browser B4 |
| F14-AC-13 | A cache-miss lookup appends a research-log entry (`kind "domain.research"`) and a competitor search one (`kind "domain.competitors"`); the lookup quote warns `recent_research` when one exists within 90 days. | unit `domainService.test.ts`, `domain.test.ts` |
| F14-AC-14 | `/portal/domain` renders every state of §6.6 with its exact copy, prices every paid button before the click, and has no horizontal scroll at 375 px. | browser `scripts/qa/check-f14-browser.mjs` B1–B9 |
| F14-AC-15 | With `domain_research` off the sidebar item is hidden, the page shows the unavailable copy and every route returns `404 feature_unavailable`; a disabled spend control returns `403 feature_disabled`. | route test; browser B1 |

## 5. Scope

**In scope:** overview, top keywords, top pages, SERP competitors, server-side filter translation and budgets, scopes, workspace cache, URL state, last-used filters, search tabs and recent searches, save to F13, export via F06, "Add as competitor" via F07, declared-competitor quick picks, priced actions, research-log writes, tools for F22, the F27 URL preset.

**Out of scope:** the backlinks columns OpenSEO's overview schema reserves (F16 owns backlinks), keyword suggestions for rank tracking (F15 may call `getSuggestedKeywords`, which F14 ports but does not expose in the UI), the free-tool landing itself (F27), competitor tracking in scans (deferred Mixed row; unchanged), Google-Ads-only countries (Labs does not serve them; the location list excludes them, as OpenSEO).

## 6. Design

### 6.1 Data model

No migration. Migrations 105–109 stay unused, so no migration paperwork applies. Data lives in: F01 `provider_cache` (namespaces in §6.4), F13 `saved_keywords`/`keyword_metrics`, F07 `project_competitors` and `project_research_log`.

### 6.2 Server modules (`src/lib/domain/`, TypeScript, relative imports with `.ts`)

| File | Mode | Exports and behaviour |
|---|---|---|
| `domainKeywordFilters.ts` | COPY `openseo:src/server/features/domain/services/domainKeywordFilters.ts` | `DomainKeywordsSortMode`, `DomainKeywordsSortOrder`, `buildOrderBy`, `buildKeywordFilters(filters, search?, scopeFilter?)`. Imports F13's `filters.ts` and `researchScopeFilters.ts`. |
| `domainPagesFilters.ts` | PORT `domainPagesPage.ts:22-120` | `DomainPagesSortMode`, `buildPagesOrderBy`, `buildPageFilters(filters, search?, scopeFilter)` (local helpers replaced by F13's `filters.ts`). |
| `domainKeywordMapper.ts` | COPY | `mapKeywordItem(item)`; `toRelativePath` from F13 `src/lib/research/target.ts`. |
| `pagination.ts` | COPY | `computeHasMore`. |
| `domainService.ts` | PORT `DomainService.ts`, `domainKeywordsPage.ts`, `domainPagesPage.ts` | `DOMAIN_CACHE_SCOPE = "workspace"`; `getOverview(input, deps)`, `getKeywordsPage(input, deps)`, `getPagesPage(input, deps)`, `getSuggestedKeywords(input, deps)`. `deps = { labs: LabsClient; brandKey; requestId; maxUsd?: number; cacheOnly: boolean; upsertMetrics; keepAlive }`. Calls `labs.domain.rankOverview/rankedKeywords/relevantPages({ brandKey, feature: "domain.research", idempotencyKey: "domain.research:<requestId>:<call>", maxUsd }, input)`. Caching: overview `cachedIf(..., (r) => r.hasData)`; pages `cached`; `cacheOnly` → `peekCached` → `null` means not cached. Ranked rows from a fetch → `keepAlive(upsertMetrics(rows → { keyword, location_code, language_code, search_volume, cpc, competition: null, keyword_difficulty, intent: null, monthly_searches: [], source: "labs_ranked" }))`. |
| `serpCompetitors.ts` | PORT `dataforseo-research-tools.ts:560-578`, `:612-620`, `:1110-1150` | `SERP_COMPETITOR_RESULT_TYPES = ["organic","paid","featured_snippet","local_pack"]`; `hostMatchesDomain(host, domain)`; `sortCompetitors(rows, sortBy)`; `findSerpCompetitors(input, deps)` → `labs.labs.serpCompetitors({ brandKey, feature: "domain.competitors", idempotencyKey: "domain.competitors:<requestId>", maxUsd }, { keywords, locationCode, languageCode, itemTypes, includeSubdomains, limit, offset: 0 })`, cached `cachedIf` (workspace, 12 h, keep when rows > 0), then excludes the researched host, maps rows and flags `isOwnSite` (workspace `website_host` without `www.`) and `isDeclaredCompetitor` (F07 `declaredCompetitors`). |
| `addCompetitor.ts` | new | `addDomainAsCompetitor(admin, brand, user, { domain, name? })` → F07 `applyContextUpdates(admin, brandRow, [{ addCompetitors: [{ domain, name }] }], "user", user.id)`; returns `{ competitor: { domain, name }, added }` where `added` = the domain was absent from `declaredCompetitors` before the call. |
| `researchLog.ts` | new | `domainResearchKey({ hostname, scope, path, locationCode, languageCode })` = `` `${hostname}|${scope}|${path}|${locationCode}|${languageCode}` ``; summaries: overview "Domain overview for <display> in <Country>: <keywords> organic keywords, about <traffic> visits a month." (unknown → "no data"); competitors "SERP competitors for <n> keywords of <display>: <top three domains>.". |
| `domain.contract.ts` | new | Route contracts (§6.5). |
| `tools.ts` | new | F22 tools `get_domain_overview` and `get_ranked_keywords` (paid; input includes `maxUsd`), same shape as F07 §6.2.8. |

Shared client-safe module `src/shared/domain.ts` (PORT of `openseo:src/types/schemas/domain.ts:41-209`, `openseo:src/client/features/domain/{domainRouteState,domainFilterUtils,utils,types}.ts`):

```ts
export const DOMAIN_SORT_MODES = ["rank","traffic","volume","score","cpc"] as const;
export const DOMAIN_TABS = ["keywords","pages","competitors"] as const;   // "competitors" added
export const DOMAIN_PAGE_SIZES = [50, 100, 200] as const;
export const DEFAULT_DOMAIN_PAGE_SIZE = 50;
export const domainKeywordsFiltersSchema;     // 12 fields, numbers accept "" (theirs, :73-102)
export const domainSearchSchema;              // URL params (theirs, :171-207) + tab "competitors"
export type DomainSearchParams;
export const KEYWORD_FILTER_FIELDS, PAGE_FILTER_FIELDS, PAGE_SEARCH_PARAM_BY_FIELD;
export function getDomainRouteState(search, defaultLocationCode: number): DomainOverviewRouteState;
export function countKeywordFilterConditions(values): number;
export function countPageFilterConditions(values): number;
export function buildKeywordsSearchUpdate(values), buildPagesSearchUpdate(values), buildDomainFiltersClearSearchUpdate();
export function getDefaultSortOrder(mode): "asc" | "desc";   // rank asc, else desc
export function keywordsToTable(rows), pagesToTable(rows), competitorsToTable(rows);
export function buildDomainResearchHref(i: { domain: string; preset?: "striking_distance"; locationCode?: number }): string;
// striking_distance → minRank=4, maxRank=20, sort=volume, order=desc (F27 hand-off)
```

### 6.3 Jobs

None. Every F14 call is a single synchronous paid request (≤ 60 s), as OpenSEO's server functions.

### 6.4 Provider calls and cost

| Use | Endpoint | Body | Response used | Estimate (F03) | Cache (F01, scope **workspace**) | Spend feature | Fixtures `tests/fixtures/f14/` |
|---|---|---|---|---|---|---|---|
| Overview | `POST /v3/dataforseo_labs/google/domain_rank_overview/live` | `target` (hostname), `location_code`, `language_code`, `limit: 1` | `items[0].metrics.organic.{etv,count}` | `domain.rankOverview` = 0.01212 | `domain.overview` v1, 12 h, keyParts `[hostname, loc, lang]`, only when `hasData` | `domain.research` | `labs-domain-rank-overview.json`, `labs-domain-rank-overview-empty.json` |
| Top keywords | `POST …/ranked_keywords/live` | target, market, `limit`, `offset`, `order_by`, `filters` | `items[]`, `total_count` | `domain.rankedKeywords({ limit })` = 0.012 + 0.00012 × limit | `domain.keywords_page` v1, 12 h, keyParts `[hostname, scope, path, loc, lang, page, pageSize, sortMode, sortOrder, filters, search]` | `domain.research` | `labs-ranked-keywords.json` |
| Top pages | `POST …/relevant_pages/live` | target, market, limit, offset, order_by, filters | `items[]`, `total_count` | `domain.relevantPages({ limit })` | `domain.pages_page` v1, 12 h, same key shape | `domain.research` | `labs-relevant-pages.json` |
| Competitors | `POST …/serp_competitors/live` | `keywords[]`, market, `item_types`, `include_subdomains`, `limit` | `items[]` (`domain, avg_position, median_position, visibility, etv, keywords_count`) | `labs.serpCompetitors({ limit })` | `domain.competitors` v1, 12 h, keyParts `[sorted keywords, loc, lang, itemTypes, includeSubdomains, limit]`, only when rows > 0 | `domain.competitors` | `labs-serp-competitors.json` |
| Errors | — | — | — | — | — | — | `labs-invalid-field.json` (shared with F13) |

**Worked example** (offcult.in, India, page size 50): overview $0.01212 + first keywords page $0.018 = **$0.03012**; each further page, sort or filter change $0.018; competitors for 50 keywords with limit 50 $0.018.

**Cache scope decision: workspace.** A domain lookup reveals which sites a workspace studies (often its competitors), and the same target is less often shared across tenants than a keyword. Global caching would let a request's instant $0 answer reveal that another workspace looked at the same domain in the last 12 hours. The cost of the choice: two workspaces researching the same domain each pay (about $0.03 per lookup). `DOMAIN_CACHE_SCOPE` is one constant if the owner prefers global later. OpenSEO also keys per organisation and project (`DomainService.ts:58-64`). Keyword market data extracted from these lookups still goes into F13's shared `keyword_metrics` (public data, no identity).

**Priced actions** (`src/lib/pricing/actions/domain.ts`, registered in `src/lib/pricing/actions/index.ts`):

| Key | Feature | Input (`z.strictObject`) | `requireApproval` | Lines (exact labels) |
|---|---|---|---|---|
| `domain.lookup.run` | `domain.research` | `{ domain: string(1..2048), scope?: ResearchScope, locationCode?: int>0, languageCode?: string(2..8), tab: "keywords"\|"pages"\|"competitors" = "keywords", pageSize: 50\|100\|200 = 50 }` | false | "Domain overview" `domain.rankOverview({})`; tab keywords → "First <pageSize> ranked keywords" `domain.rankedKeywords({ limit: pageSize })`; tab pages → "First <pageSize> top pages" `domain.relevantPages({ limit: pageSize })`; tab competitors → no second line. Warnings `cache_note` "Looking up the same domain and market again within 12 hours is free."; `recent_research` "You looked this up on <entryDate>: <summary>". Blocked `invalid_target` with the parse message. |
| `domain.keywords.page` | `domain.research` | `{ domain, scope?, locationCode?, languageCode?, pageSize }` | false | "<pageSize> ranked keywords" |
| `domain.pages.page` | `domain.research` | same | false | "<pageSize> top pages" |
| `domain.competitors.run` | `domain.competitors` | `{ domain, scope?, locationCode?, languageCode?, keywordCount: z.int().min(1).max(100), limit: z.int().min(10).max(100).default(50) }` | **true** | "Competitor analysis across <keywordCount> keywords (up to <limit> domains)" `labs.serpCompetitors({ limit })`. Warning `cache_note` "The same keywords and market are reused for 12 hours." |

### 6.5 API routes

All under `src/app/api/customer/domain/**/route.ts`; `requireWorkspace(request)` (brand from `?brand_key=`); `isFeatureEnabled("domain_research", brandKey)` false → `AppError(404, "feature_unavailable", "This page is not available for your workspace yet.")`; strict bodies; `z.looseObject` responses; `toErrorResponse`; `Cache-Control: no-store`; members and owners; `maxDuration = 60`. Market: `resolveLabsMarket(body, workspaceMarket(brand))` (F13 `keyword-locations.ts`); a non-Labs `locationCode` → `400 invalid_location` "Domain research is not available for this country." Provider errors go through `toResearchError` with `domain_unavailable` "Domain data is unavailable right now. Please retry.". Common codes as F13 §6.5 plus `invalid_target`, `filters_over_budget`, `invalid_location`, `domain_unavailable`.

**`POST /api/customer/domain/overview`**

```ts
z.strictObject({ domain: z.string().trim().min(1).max(2048), scope: researchScopeSchema.optional(),
  locationCode: z.int().positive().optional(), languageCode: z.string().min(2).max(8).optional(),
  cacheOnly: z.boolean().default(false), maxUsd: z.number().positive().max(1000).optional(), requestId: z.uuid() })
```

Not `cacheOnly`: `requireApprovedPrice("domain.lookup.run", ctx, { domain, scope, locationCode, languageCode, tab: "keywords", pageSize: 50 }, maxUsd)` (implicit when absent). Response:

```json
{ "status": "ok", "domain": "offcult.in", "displayTarget": "offcult.in", "scope": "subdomains",
  "organicTraffic": 1840, "organicKeywords": 312, "hasData": true,
  "market": { "locationCode": 2356, "languageCode": "en", "country": "India" },
  "isOwnSite": true, "isDeclaredCompetitor": false,
  "cached": false, "fetchedAt": "2026-10-21T09:30:00.000Z", "provenance": { "gateway": "dataforseo" } }
```

`cacheOnly` miss → `{ "status": "not_cached", "domain": "offcult.in", "displayTarget": "offcult.in", "scope": "subdomains", "market": { … } }`.

**`POST /api/customer/domain/keywords`** — body = overview fields + `page: z.int().positive().default(1)`, `pageSize: 50|100|200 = 50`, `sortMode: enum = "traffic"`, `sortOrder: asc|desc = "desc"`, `filters: domainKeywordsFiltersSchema.default({})`, `search: z.string().max(200).optional()`. Action `domain.keywords.page`. Response:

```json
{ "status": "ok", "domain": "offcult.in", "page": 1, "pageSize": 50, "totalCount": 312, "hasMore": true,
  "keywords": [ { "keyword": "oversized t shirt", "position": 7, "searchVolume": 74000, "traffic": 1290.5,
                  "cpc": 0.41, "url": "https://offcult.in/collections/oversized", "relativeUrl": "/collections/oversized",
                  "keywordDifficulty": 38 } ],
  "cached": true, "fetchedAt": "2026-10-21T09:30:01.000Z", "provenance": { "gateway": "dataforseo" } }
```

**`POST /api/customer/domain/pages`** — same body with `sortMode: "traffic"|"keywords" = "traffic"` and the six page filters in `filters` (`include`, `exclude`, `minTraffic`, `maxTraffic`, `minVol` = keyword count, `maxVol`). Action `domain.pages.page`. Response `{ status, domain, page, pageSize, totalCount, hasMore, pages: [{ page, relativePath, organicTraffic, keywords }], cached, fetchedAt, provenance }`.

**`POST /api/customer/domain/competitors`** — `z.strictObject({ domain, scope?, locationCode?, languageCode?, keywords: z.array(z.string().trim().min(1).max(120)).min(1).max(100), resultTypes: z.array(z.enum(SERP_COMPETITOR_RESULT_TYPES)).min(1).max(4).default(["organic","local_pack"]), includeSubdomains: z.boolean().default(true), sortBy: z.enum(["visibility","traffic_estimate","avg_position","keyword_count"]).default("visibility"), limit: z.int().min(10).max(100).default(50), cacheOnly: z.boolean().default(false), maxUsd?, requestId: z.uuid() })`. Not `cacheOnly`: `requireApprovedPrice("domain.competitors.run", ctx, { domain, scope, locationCode, languageCode, keywordCount: keywords.length, limit }, maxUsd)` (required). On a miss, `appendResearch(kind "domain.competitors")`. Response:

The route body after auth and parsing lives in `src/lib/domain/serpCompetitors.ts` as `runSerpCompetitorsRequest(ws: Workspace, i: { domain; scope?; locationCode?; languageCode?; keywords: string[]; resultTypes?; limit; maxUsd?: number; requestId: string }): Promise<{ competitors; totalCount }>`; the route is a thin wrapper and F22's `find_serp_competitors` tool calls it directly with the same price check (`domain.competitors.run`).

```json
{ "status": "ok", "keywordCount": 50,
  "competitors": [ { "domain": "bewakoof.com", "keywordsCount": 31, "avgPosition": 4.2, "medianPosition": 3,
                     "visibility": 0.41, "etv": 18120.5, "isOwnSite": false, "isDeclaredCompetitor": true } ],
  "cached": false, "fetchedAt": "2026-10-21T09:31:00.000Z", "provenance": { "gateway": "dataforseo" } }
```

**`POST /api/customer/domain/competitors/add`** — needs `project_memory` on (else `404 feature_unavailable` "Project memory is not enabled for this workspace."). Body `z.strictObject({ domain: z.string().trim().min(3).max(255), name: z.string().trim().min(1).max(120).optional() })`. Response `{ "competitor": { "domain": "bewakoof.com", "name": null }, "added": true }`. Errors from F07: `400 context_invalid` (own site: "updates[0] was rejected (nothing in this batch was applied): Your own website cannot be a competitor."), `400 context_cap`, `503 context_unavailable`. Free; idempotent (re-adding keeps the stored name).

**`GET /api/customer/domain/competitors/declared`** → `{ "available": true, "competitors": [ { "domain": "bewakoof.com", "name": "Bewakoof" } ], "ownHost": "offcult.in" }`; `available: false, competitors: []` when `project_memory` is off. Free.

Job status: none. Contracts in `src/lib/domain/domain.contract.ts`.

### 6.6 UI

Built from F04 (`PageHeader`, `BackButton`, `Card`, `Badge`, `Alert`, `MetricsTable` (F06), `HelpLabel`, `EmptyState`, `QueryError`, `SkeletonPresets`, `LocationSelect`, `Select`, `Tabs`, `FormDialog`, `ui/*`), F05 (`useUrlSearchState`, `useLocalPref`, search tabs, `RecentSearches`, `useTimestampedSearchHistory`, `fetchJson`, `withBrand`), F06 (`DataTable`, `DataTableTabs`, `DataTableToolbar`, `DataTableFilterPanel`, `TableBulkActionBar`, `TablePagination`, `SortableHeader`, `ScoreBadge`, `ExternalUrlCell`, `ExportMenu`, `useExportRows`), F09 (`CostReviewDialog`) and F13 (`SearchCard`, `ResearchScopeSelect`, `PricedActionButton`). Unknown numbers render "—".

**Navigation:** `src/components/app/navigation/items.ts` group `research` → `{ id: "domain", label: "Domain", href: "/portal/domain", icon: Globe, flag: "domain_research" }`. `CLIENT_FEATURES` gains `"domain_research"`. Query keys (F05 `keys.ts`): `domainOverview(brandKey, inputKey)`, `domainKeywords(brandKey, inputKey)`, `domainPages(brandKey, inputKey)`, `domainCompetitors(brandKey, inputKey)`, `declaredCompetitors(brandKey)`.

**Page** `src/app/portal/domain/page.tsx` → `src/components/portal/domain/DomainOverviewPage.tsx` (PORT). URL state through `useUrlSearchState(domainSearchSchema, defaults)` with defaults stripped; default location = `workspaceMarket(brand).locationCode` when it is a Labs country, else 2840.

**Live mode** (same rule as F13 §6.6.2): until the customer clicks a priced button on this page, overview and table queries are sent with `cacheOnly: true`; a miss shows the not-loaded state. After the first priced click (`liveMode = true`, reset on workspace change), paging, sorting and filtering run directly with `maxUsd` from `domain.keywords.page`/`domain.pages.page` quotes.

| State | Shown |
|---|---|
| Flag off | `EmptyState` "This page is not available for your workspace yet." / "Ask Perceev support to turn on domain research." |
| Header | `PageHeader` title "Domain Overview", description "Analyze any domain's SEO profile: traffic, keywords, and top pages."; back button "Recent searches" once a domain is in the URL |
| Search card | `SearchInput` placeholder "Enter a domain or URL" (`aria-label` "Domain or URL"); `ResearchScopeSelect`; `LocationSelect options={LABS_LOCATION_OPTIONS}`; sort `Select` ("By Rank", "By Traffic", "By Volume", "By Score", "By CPC", `aria-label` "Sort keywords"); `PricedActionButton` label "Search", action `domain.lookup.run`; validation errors under the input ("Enter a valid domain like example.com", "Add a path to use Subfolder (e.g. example.com/blog)") from `parseResearchTarget` |
| Quick picks (below the card, when `declaredCompetitors.available`) | muted label "Quick picks:" then chips "Your site · {ownHost}" and one per declared competitor (max 8, then "+{n} more"); a chip fills the input and scope only (no request) |
| No domain | `RecentSearches` (title = domain, subtitle = scope label) with empty title "Enter a domain to get started" |
| Loading | `DomainOverviewLoadingState` (PORT) |
| Not loaded (cache-only miss) | `Card`: "Results for {displayTarget} are not loaded." / "Running this lookup buys fresh data for {Country}." + `PricedActionButton` "Run lookup" |
| Error, no data | `QueryError` "Lookup failed." with Retry; spend refusals via F05 `SpendRefusedError` |
| Price changed | `CostReviewDialog` "The price changed" state |
| No data for scope | info `Alert` "Not enough data for this scope yet. Try another domain or a broader scope." above the card; metrics "—" |
| Overview card | `h2` display target, scope `Badge`, badges "Your site" (when `isOwnSite`) and "Competitor" (when declared), "Updated {relative time}"; button "Add as competitor" (outline, `UserPlus`) when `project_memory` is on, not own site, not declared → toast "Added {domain} to your competitors." with action "View context" → `/portal/context`; `MetricsTable` rows "Estimated organic traffic", "Organic keywords", each with `HelpLabel` "Whole domain incl. subdomains" when the scope is narrower |
| Tabs | `DataTableTabs`: "Top Keywords", "Top Pages", "Competitors" |
| Keywords tab | toolbar: filter toggle with count; "{total} keywords" then "· Select keywords to save" or "· {k} selected"; muted cost hint "Each new page, sort or filter costs up to {formatUsd}. Pages are reused for 12 hours."; `ExportMenu` (sheets, csv; current page). Table: select, Keyword, Rank, Volume, Traffic, CPC (help "Cost per click in USD."), URL (relative link resolved against the hostname, external), Score (help "Organic ranking difficulty (0-100): higher means harder to reach Google's top 10."). Pagination 50/100/200 with total and next. Filter panel: "Include Terms" ("audit, checker, template"), "Exclude Terms" ("jobs, salary, course"), ranges "Traffic", "Volume", "CPC (USD)", "Score (KD)", "Rank"; footer "{n} / {max} conditions", over budget "Too many filter conditions ({n} of {max}). Remove some to apply." with "Apply filters" disabled; "Clear". Held-back saved filters: `Alert` "Saved filters exceed this scope's {max}-condition limit and were not applied. Open Filters to trim them." Filtered empty: F06 filtered state "No keywords match these filters" + "Clear filters"; unfiltered empty "No ranked keywords found for this target." |
| Keywords bulk bar | "Save keywords" (hidden when `keyword_research` off; disabled with title "Change the location back to {Country} or run the lookup again to save." when markets differ or `hasData` is false) → `FormDialog` "Save {n} keywords" with optional "Tags" input (comma separated, help "Added to every saved keyword.") → toast "Saved {n} keywords" with action "Open saved keywords" → `/portal/keywords/saved`; "Copy keywords" → toast "{n} keywords copied"; export (Export to Sheets / Download CSV); "Clear" |
| Pages tab | same toolbar pattern with "{total} pages"; filters "Include Page Terms" ("pricing, tools, guides"), "Exclude Page Terms" ("blog, tag, archive"), "Traffic", "Keywords"; columns "Page" (relative path link), "Organic Traffic", "Keywords"; empty "No pages match this search." |
| Competitors tab, idle | text "Find the domains that rank in Google for the same keywords as {displayTarget}." + "Uses the {n} keywords on the current Top Keywords page." + `PricedActionButton` "Find competitors" (`alwaysConfirm`, dialog title "Find SERP competitors", confirm "Find competitors"); disabled with "Load the Top Keywords tab first." when no keyword rows are loaded |
| Competitors tab, results | sort `Select` ("Visibility", "Estimated traffic", "Average position", "Keyword count"); table: Domain (link to `/portal/domain?domain=<d>`; badges "Your site", "Competitor"), "Shared keywords" (`keywords_count` of {n}), "Avg. position", "Visibility" (percent, 1 decimal), "Est. traffic"; row action "Add as competitor" (when allowed) or "Competitor" badge; `ExportMenu`; empty "No competing domains found for these keywords." |

Last-used filters: `useLocalPref("domain-filters:keywords:" + target, schema, EMPTY, { brandKey })` and `"domain-filters:pages:" + target`, saved on Apply and cleared on "Clear" (OpenSEO semantics, §2 item 13). Search tabs `useSearchTabs("domain", brandKey, parseDomainTabInput)` (label `domain` plus a short country code when not the default). Recent searches `useTimestampedSearchHistory("domain", brandKey)`.

Accessibility and phone: inputs labelled; tables keep `aria-sort`; tabs are `role="tablist"`; at 375 px the search card stacks, the tables scroll inside their card, the bulk bar stays fixed above the safe area, no page-level horizontal scroll.

### 6.7 Permissions, privacy, observability

- Members and owners may look up, save, export and add competitors.
- Logs: `[domain] lookup { brandKey, targetHash, scope, rows, cached, ms }`, `[domain] competitors { brandKey, targetHash, keywords, rows, cached }`, where `targetHash = sha256(hostname).slice(0, 12)`. A workspace's research targets are never logged in clear next to its brand key.
- PostHog (F26 names; until F26 merges through `trackDomainEvent` in `src/components/portal/domain/telemetry.ts` (exports `setDomainEventTracker(fn)`; no-op until F26 wires it, F26 §6.2.7), a no-op sink like F13's): `domain_overview:lookup { scope, cached, has_data }`, `domain_overview:tab { tab }`, `keyword:save { source_feature: "domain_overview", keyword_count }`, `domain_overview:competitors { keyword_count, result_count }`, `domain_overview:add_competitor`. No domains in events.

### Deviations from conventions

1. **Inline price approval** for lookups and table pages through F13's `PricedActionButton` (as F13 deviation 2). Competitor searches always use `CostReviewDialog`.
2. **`cacheOnly` reads and live mode** (as F13 deviation 3).

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/server/features/domain/services/domainKeywordFilters.ts` (+ test) | `src/lib/domain/domainKeywordFilters.ts` (+ `.test.ts`) | COPY | Imports F13's `filters.ts`; six cases ported. |
| `openseo:src/server/features/domain/services/domainPagesPage.ts:22-134` | `src/lib/domain/domainPagesFilters.ts` | PORT | Uses F13 `filters.ts` helpers instead of local copies. |
| `openseo:src/server/features/domain/services/domainKeywordMapper.ts` | `src/lib/domain/domainKeywordMapper.ts` | COPY | — |
| `openseo:src/server/features/domain/services/pagination.ts` (+ test) | `src/lib/domain/pagination.ts` (+ `.test.ts`) | COPY | — |
| `openseo:src/server/features/domain/services/DomainService.ts`, `domainKeywordsPage.ts`, `domainPagesPage.ts:136-227` | `src/lib/domain/domainService.ts` | PORT | R2 + `waitUntil` → F01 `cached`/F13 `cachedIf` (writes already run in `keepAlive`); workspace scope; metered F13 Labs client; ranked rows feed `keyword_metrics`. |
| `openseo:src/server/mcp/tools/dataforseo-research-tools.ts:62-67,325-372,560-578,612-620,829-836,1093-1150` | `src/lib/domain/serpCompetitors.ts`, `src/app/api/customer/domain/competitors/route.ts` | PORT | MCP tool → customer route; cache added; own-site and declared flags added. |
| `openseo:src/serverFunctions/domain.ts` | `src/app/api/customer/domain/**/route.ts` | PORT | `requireWorkspace`, priced actions, `cacheOnly`. |
| `openseo:src/types/schemas/domain.ts:41-209` | `src/shared/domain.ts`, `src/lib/domain/domain.contract.ts` | PORT | Strict request schemas; `competitors` tab added. |
| `openseo:src/client/features/domain/{domainRouteState,domainFilterUtils,utils,types,domainSearchValidation}.ts` (+ `domainRouteState.test.ts`, `components/domainResultLinks.test.ts`) | `src/shared/domain.ts` (+ `.test.ts`) | PORT | Next search params; F05 URL helpers; tests ported. |
| `openseo:src/client/features/domain/useDomainFilterPreferences.ts` | `src/components/portal/domain/hooks/useDomainFilterPreferences.ts` | PORT | On F05 `useLocalPref`. |
| `openseo:src/client/features/domain/DomainOverviewPage.tsx`, `components/*`, `hooks/*`, `domainActions.ts`, `mutations.ts` | `src/components/portal/domain/**` | PORT | F04/F05/F06 components; save through F13 without metrics; competitors tab and quick picks added. |
| `openseo:src/client/hooks/useDomainSearchHistory.ts` | `src/components/portal/domain/hooks/useDomainSearchHistory.ts` | PORT | On F05 `useTimestampedSearchHistory`. |

## 8. Implementation plan

### Phase 1 — Domain research API

**Goal:** paid, cached, priced overview, keywords and pages routes.

- [x] **P1.T1 Registration**
  - [x] **P1.T1.S1** *Files:* `src/shared/spend-features.ts` (`"domain.research"`, `"domain.competitors"`; labels "Domain research", "SERP competitor research"), `src/lib/features/names.ts` (`domain_research: { spend: ["domain.research"] as const }`), `src/lib/features/clientFeatures.ts` (append `"domain_research"`), `.env.example` (`FEATURE_DOMAIN_RESEARCH=`, `FEATURE_DOMAIN_RESEARCH_BRANDS=`). *Verify:* `node --test src/lib/features/flags.test.ts src/shared/*.test.ts` → pass; `grep -c "^FEATURE_DOMAIN_RESEARCH=$" .env.example` → 1.
- [x] **P1.T2 Services**
  - [x] **P1.T2.S1** *Files:* `src/lib/domain/domainKeywordFilters.ts`, `domainKeywordFilters.test.ts`, `domainPagesFilters.ts`, `domainPagesFilters.test.ts`, `domainKeywordMapper.ts`, `pagination.ts`, `pagination.test.ts`. *Do:* §6.2; port `domainKeywordFilters.test.ts:4-86` and `pagination.test.ts`; page filters: include/exclude on `page_address`, ranges on `metrics.organic.etv`/`count`, scope slots counted. *Verify:* `node --test src/lib/domain/domainKeywordFilters.test.ts src/lib/domain/domainPagesFilters.test.ts src/lib/domain/pagination.test.ts` → pass (F14-AC-01).
  - [x] **P1.T2.S2** *Files:* `src/lib/domain/domainService.ts`, `domainService.test.ts`, `researchLog.ts`, fixtures `tests/fixtures/f14/labs-*.json`. *Do:* §6.2. Tests with a fake Labs client and F01 memory cache: overview mapping and rounding; no cache write when `organicKeywords` is 0; `subfolder` lookup reuses the hostname entry and echoes scope/display; keywords page offset/order/filters/scope; every page cached; workspace B misses A's entry; `cacheOnly` miss → `null` and zero client calls; metered context has `feature "domain.research"` and `idempotencyKey "domain.research:<requestId>:keywords"`; `upsertMetrics` called with `source "labs_ranked"` only on a fetch. *Verify:* `node --test src/lib/domain/domainService.test.ts` → pass (F14-AC-02, 03, 04, 06).
  - [x] **P1.T2.S3** *Files:* `src/lib/pricing/actions/domain.ts`, `src/lib/pricing/actions/index.ts` (one import), `src/lib/pricing/actions/domain.test.ts`. *Do:* §6.4 table; tests: worked example $0.03012; pages tab line; competitors line; `recent_research` warning; `invalid_target` block. *Verify:* `node --test src/lib/pricing/actions/domain.test.ts` → pass (F14-AC-07 unit half, F14-AC-13 quote half).
- [x] **P1.T3 Routes**
  - [x] **P1.T3.S1** *Files:* `src/app/api/customer/domain/overview/route.ts`, `keywords/route.ts`, `pages/route.ts`, `src/lib/domain/domain.contract.ts`. *Do:* §6.5; research-log append on an overview miss. *Verify:* `node --test src/lib/http/routeContract.test.ts` → pass.
  - [x] **P1.T3.S2** *Files:* `src/lib/domain/domain.route.test.mjs` (hook pattern of `src/lib/customerRoutes.test.hooks.mjs`). Cases: flag off → 404; unknown field → 400; non-Labs location → 400 `invalid_location`; `cacheOnly` miss → `not_cached`, zero spend calls; stale `maxUsd` → 409 `price_changed`; 9 filter conditions → 400 `filters_over_budget`; invalid target → 400 `invalid_target`; spend refusal passes through. *Verify:* `node --test src/lib/domain/domain.route.test.mjs` → pass (F14-AC-04, 05, 07, 15 route half).
  - [x] **P1.T3.S3** *Files:* `src/lib/domain/tools.ts`, `tools.test.ts`. *Verify:* `node --test src/lib/domain/tools.test.ts` → pass.
  - [x] **P1.T3.S4** *Files:* `THIRD_PARTY_NOTICES.md`. *Verify:* `node --test src/lib/platform/thirdPartyNotices.test.mjs` → pass.

**Checkpoint:** full suite `node --import ./src/lib/liveWriteGuardAuto.mjs --test-concurrency=4 --test 'src/**/*.test.mjs' 'src/**/*.test.ts'`, `npm run typecheck`, `npm run build` green. Completes F14-AC-01…07, 13, 15 (route half).

### Phase 2 — Competitors

**Goal:** SERP competitors and the F07 bridge.

- [ ] **P2.T1 Competitor search and F07 bridge**
  - [ ] **P2.T1.S1** *Files:* `src/lib/domain/serpCompetitors.ts`, `serpCompetitors.test.ts`, fixture `labs-serp-competitors.json`. *Do:* §6.2; tests: four sort modes (avg position ascending), exclusion of `www.` and subdomains of the target, `isOwnSite`, `isDeclaredCompetitor`, metered feature `domain.competitors`, cache keep only when rows > 0. *Verify:* `node --test src/lib/domain/serpCompetitors.test.ts` → pass (F14-AC-08).
  - [ ] **P2.T1.S2** *Files:* `src/lib/domain/addCompetitor.ts`, `addCompetitor.test.ts`, `src/app/api/customer/domain/competitors/route.ts`, `competitors/add/route.ts`, `competitors/declared/route.ts`, contracts, `domain.route.test.mjs` (extend: `project_memory` off → add 404 and declared `available:false`; own host → 400 `context_invalid` with F07 copy; competitors without `maxUsd` → 400 `approval_required`; research-log append on a miss). *Verify:* `node --test src/lib/domain/addCompetitor.test.ts src/lib/domain/domain.route.test.mjs src/lib/http/routeContract.test.ts` → pass (F14-AC-09 route half, F14-AC-13).

**Checkpoint:** full suite, typecheck, build. Completes F14-AC-08, 09 (server), 13.

### Phase 3 — Domain page (requires F04, F05, F06, F09 phase 3 and F13 phase 1 UI pieces merged)

**Goal:** `/portal/domain` with overview, keyword and page tables, filters and URL state.

- [ ] **P3.T1 Shared state**
  - [ ] **P3.T1.S1** *Files:* `src/shared/domain.ts`, `src/shared/domain.test.ts`. *Do:* §6.2 module; port `domainRouteState.test.ts:5-70` (scope omission, US fallback for Ads markets, ignoring Ads URL location) and `domainResultLinks.test.ts`; add preset href and filter-condition counting cases. *Verify:* `node --test src/shared/domain.test.ts` → pass (F14-AC-11, F14-AC-12 logic).
- [ ] **P3.T2 Components**
  - [ ] **P3.T2.S1** *Files:* `src/app/portal/domain/page.tsx`, `src/components/portal/domain/{DomainOverviewPage,DomainSearchCard,DomainQuickPicks,DomainOverviewCard,DomainOverviewLoadingState,DomainNotLoadedCard,KeywordsTab,PagesTab,DomainFilterPanel,DomainTableToolbar,DomainKeywordsTable,DomainPagesTable,DomainPageLink}.tsx`, `hooks/{useDomainOverviewQuery,useDomainKeywordsQuery,useDomainPagesQuery,useDomainFilterPreferences,useDomainSearchHistory,useDomainSearchTabs,useDomainLiveMode}.ts`, `src/components/portal/domain/telemetry.ts`, `src/components/app/navigation/items.ts` (entry), `src/lib/query/keys.ts` (five factories). *Do:* §6.6 except the Competitors tab and the bulk save. *Verify:* `npm run build` → exit 0.
  - [ ] **P3.T2.S2** *Files:* `scripts/qa/check-f14-browser.mjs` (Playwright, local app, fixture APIs). B1 flag off; B2 loading `/portal/domain?domain=offcult.in` sends only `cacheOnly: true` requests and shows "Run lookup · up to $0.03"; B3 click → overview + keywords render, cost hint visible, next page sends `maxUsd`; B4 filters apply, URL updates, reload restores last-used filters, over-budget saved filters show the held-back alert; B8 375 px no horizontal scroll. *Verify:* `node scripts/qa/check-f14-browser.mjs --only B1-B4,B8` → "ok 5 scenarios" (F14-AC-05 browser half, F14-AC-12, F14-AC-14 part, F14-AC-15).

**Checkpoint:** full suite, build, browser B1–B4, B8.

### Phase 4 — Save, export, competitors tab and quick picks

**Goal:** the hand-offs to F13, F06 and F07.

- [ ] **P4.T1 Hand-off components and checks**
  - [ ] **P4.T1.S1** *Files:* `src/components/portal/domain/{SaveDomainKeywordsDialog,CompetitorsTab,DomainCompetitorsTable,AddCompetitorButton}.tsx`, `hooks/{useDomainCompetitors,useDeclaredCompetitors}.ts`, `KeywordsTab.tsx`, `PagesTab.tsx` (export menus via `useExportRows`). *Do:* §6.6 remaining rows. *Verify:* `npm run build` → exit 0.
  - [ ] **P4.T1.S2** *Files:* `scripts/qa/check-f14-browser.mjs` (B5 save with tags → POST `/api/customer/keywords/saved` body has no `metrics`, toast; disabled after changing the location; hidden when `keyword_research` off; B6 competitors: `CostReviewDialog` → results → sort by average position; B7 add competitor → toast; button absent when `project_memory` off; quick pick fills input without a request; B9 export CSV filename and headers). *Verify:* `node scripts/qa/check-f14-browser.mjs` → "ok 9 scenarios" (F14-AC-09, 10, 14).

**Checkpoint:** full suite, build, all browser scenarios. Completes F14-AC-09, 10, 14.

## 9. Test plan

| File | Cases | ACs |
|---|---|---|
| `src/lib/domain/domainKeywordFilters.test.ts` | six ported cases + scope slots | 01 |
| `src/lib/domain/domainPagesFilters.test.ts` | page filters, scope slots, budget | 01 |
| `src/lib/domain/pagination.test.ts` | ported | 03 |
| `src/lib/domain/domainService.test.ts` | §8 P1.T2.S2 list | 02, 03, 04, 06, 13 |
| `src/lib/domain/serpCompetitors.test.ts` | sort, exclusion, flags, cache | 08 |
| `src/lib/domain/addCompetitor.test.ts` | F07 call, `added` | 09 |
| `src/lib/pricing/actions/domain.test.ts` | lines, warnings, blocks | 07, 13 |
| `src/shared/domain.test.ts` | ported route state, preset, filter counts | 11, 12 |
| `src/lib/domain/tools.test.ts` | closed inputs | — |
| `src/lib/domain/domain.route.test.mjs` | flags, auth, strict bodies, cacheOnly, prices, budgets, F07 bridge | 04, 05, 07, 09, 15 |
| `scripts/qa/check-f14-browser.mjs` | B1–B9 | 05, 09, 10, 12, 14, 15 |
| `scripts/qa/check-f14-live.mjs` (owner-run) | one overview + one keywords page (India, page size 50) for a brand-owned domain; refuses without `--brand <key> --max-spend-usd 0.10` and an enabled `domain.research` control; prints counts and ledger rows only | — |

Fixtures `tests/fixtures/f14/`: `labs-domain-rank-overview.json`, `labs-domain-rank-overview-empty.json` (`count: 0`), `labs-ranked-keywords.json` (3 rows, `total_count: 312`), `labs-relevant-pages.json`, `labs-serp-competitors.json` (includes the target's `www.` host and a subdomain to prove exclusion). Synthetic, shaped like DataForSEO's public documentation, no account or task ids.

## 10. Rollout and rollback

- **Env (names only):** `FEATURE_DOMAIN_RESEARCH`, `FEATURE_DOMAIN_RESEARCH_BRANDS`.
- **Defaults:** off in production; no `paid_feature_controls` rows for `domain.research` or `domain.competitors`.
- **Migrations:** none.
- **Owner enabling:** enable `domain.research` (and later `domain.competitors`) for an allowlisted workspace in `/ops/costs` with a daily cap (suggested $2) and `maxCallUsd` $0.10; set `FEATURE_DOMAIN_RESEARCH=allowlist` with the brand key; optionally run `scripts/qa/check-f14-live.mjs`.
- **Turn off:** `FEATURE_DOMAIN_RESEARCH=off`, or disable the spend controls (calls refuse with `feature_disabled`).
- **Cleanup (owner request only):** delete provider-cache rows with namespaces `domain.overview`, `domain.keywords_page`, `domain.pages_page`, `domain.competitors`. Competitors added to F07 stay (they are the customer's data).

## 11. Risks and open questions

| # | Risk or question | Default chosen |
|---|---|---|
| 1 | Workspace-scoped caching makes two tenants pay for the same domain. | Accept (privacy of research targets); one constant switches to global if the owner prefers. |
| 2 | Each page, sort or filter change is a paid call (about $0.02). | Cost hint in the toolbar; 12 h cache per combination; live mode means links never spend. |
| 3 | Domain-level overview metrics cover subdomains even for narrower scopes. | Labelled "Whole domain incl. subdomains" (OpenSEO). |
| 4 | Competitor results depend on which keywords are loaded on the Top Keywords page. | The tab states the source ("Uses the {n} keywords on the current Top Keywords page"); page size 100 gives the widest set. |
| 5 | F27's free-tool hand-off lands on a lookup that is not cached for the new workspace. | The not-loaded card offers "Run lookup · up to $0.03"; F27 decides whether to show it or pre-run with approval. |
| 6 | F07 `addCompetitors` caps at 100 competitors. | F07's `context_cap` message is shown as a toast. |

## 12. Definition of done

- [ ] Phases 1–4 merged; every subtask ticked here.
- [ ] F14-AC-01…15 covered by passing tests (§9).
- [ ] Full suite, `npm run typecheck`, `npm run build`, `node scripts/qa/check-f14-browser.mjs` green.
- [ ] `THIRD_PARTY_NOTICES.md` updated; no migration paperwork (no migrations).
- [ ] `features/README.md` status for F14 updated.
- [ ] Owner-run live check result (if run) recorded in the PR.
