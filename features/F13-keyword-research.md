# F13 — Keyword research and saved keywords

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F13 |
| Wave | 2 |
| Comparison rows covered | "Keyword research" (OpenSEO: volume, trend, CPC, difficulty, intent, local volume, saved lists with tags. Perceev: none) |
| Depends on | F01 (merged): `requireWorkspace`, `AppError`/`toErrorResponse`, `metered`, `cached`, `defineJob`/`enqueueJob`/`definePeriodic`, `isFeatureEnabled`, `llmObject`, `estimateLlmUsd`, `f01_touch_updated_at()`, route-contract harness. F02 phase 2 (merged): `core.ts`, `envelope.ts`, `client.ts` (`meter`, `DataforseoCallContext`, `createDataforseoClient().serp.live`), `serp.ts`. F03 phase 1: `src/lib/pricing/dataforseo.ts`. F07 phase 1: `appendResearch`, `findRecentResearch`, `getProjectContext`. F09 phase 1: `definePricedAction`, `requireApprovedPrice`, `/api/customer/price/estimate`. UI phases (P4–P8) also need F04, F05, F06 merged. P7 needs F08 phase 1 (`addWorkspaceQuestion`). |
| Blocks | F14 (Labs client, research primitives, save service), F16 (research-scope primitives from P1), F15 and F17 (location lists, SERP location search from P8), F21 (keyword-clustering skill reuses P6), F22 (keyword tools), F27 (location options) |
| Reserved migrations | 100–104. **100** `100_f13_saved_keywords.sql`, **101** `101_f13_keyword_metrics.sql`, **102** `102_f13_saved_keyword_functions.sql`. 103–104 unused. |
| Feature flag | `FEATURE_KEYWORD_RESEARCH` (feature name `keyword_research`, spend `["keywords.research"]`): pages, routes and sidebar items. `FEATURE_KEYWORD_CLUSTERING` (name `keyword_clustering`, spend `["keywords.clustering"]`): "Group into topics". Both in `CLIENT_FEATURES`. Off in production by default. |
| Spend features | `keywords.research` ("Keyword research"), `keywords.serp` ("SERP analysis"), `keywords.metrics_refresh` ("Keyword stats refresh"), `keywords.clustering` ("Keyword topic grouping"). All ship disabled (no `paid_feature_controls` row). |
| OpenSEO reference | `openseo:src/serverFunctions/keywords.ts`, `openseo:src/server/features/keywords/**`, `openseo:src/server/lib/dataforseo/{labs,google-ads,keyword-metrics,serp,serp-locations,filters,researchScopeFilters}.ts`, `openseo:src/server/lib/{domainUtils,r2-cache}.ts`, `openseo:src/db/app.schema.ts:90-208`, `openseo:src/types/{keywords.ts,schemas/keywords.ts}`, `openseo:src/shared/{keyword-locations,saved-keyword-tags,tag-colors,researchScope,serp-location-search}.ts`, `openseo:src/client/features/{keywords,saved-keywords}/**`, `openseo:src/routes/_app/p/$projectId/{keywords,saved}.tsx`, `openseo:.agents/skills/keyword-clustering/SKILL.md` (read as data) at `c5f8db1` |

## 1. Summary

Customers get OpenSEO's keyword research inside Perceev: type a keyword, pick a country (and optionally a city), and see related keyword ideas with volume, 12-month trend, CPC, competition, difficulty and intent, next to the live Google results for the selected keyword. Good ideas are saved to a per-workspace list with tags, bulk actions, export, a stats refresh, an AI "Group into topics" action, and a "Track as a question" bridge into AI-visibility measurement. Every paid call is priced before it runs, metered, capped and logged in project memory so research is not bought twice; public market data is cached across workspaces so tenants never pay twice for the same lookup.

## 2. What OpenSEO does (observed)

1. **Server surface.** Ten server functions: research, save, list, export, bulk tag update, tag rename/recolour, tag delete, remove, refresh metrics and SERP analysis, each behind project middleware; market comes from `resolveMarket(data, project)` (`openseo:src/serverFunctions/keywords.ts:26-135`, `openseo:src/shared/keyword-locations.ts:716-727`).
2. **Research input** (`openseo:src/types/schemas/keywords.ts:28-46`): `keywords` 1–200 strings, optional `locationCode`/`languageCode`, optional `locationName` (city/county/region, ≤ 200), `resultLimit` 150/300/500 (default 150), `mode` `auto|related|suggestions|ideas` (default `auto`), `clickstream` (default false, "doubles the DataForSEO request cost"), `groupKeywords` (default false).
3. **Normalisation.** Keywords are trimmed, lowercased and de-duplicated; only the first is the seed (`research/research.ts:263-271`, `research/helpers.ts:5-7`). The client sends one keyword per search tab (`KeywordResearchPage.tsx:136-158`).
4. **Provider routing.** `getKeywordDataProvider(locationCode)` returns `google_ads` for the 49 countries Labs does not cover and `labs` otherwise (`keyword-locations.ts:55-64`, `:842-862`; 143 countries in `LOCATION_OPTIONS`, `:66-537`). For Ads countries mode is forced to `auto` and clickstream/grouping off; a local request forces clickstream off, so equivalent requests share one cache entry (`research.ts:272-283`).
5. **Auto mode** blends phrase-match suggestions and category ideas, each with `ceil(limit/2)`, run with `Promise.allSettled` because "each call meters its own DataForSEO spend … throwing while the sibling call is mid-flight can drop its billing write" (`research.ts:98-142`). Rows are interleaved without duplicates (`helpers.ts:9-32`). When fewer than 5 non-seed rows come back, `related` (depth 3) is fetched and interleaved, `usedFallback: true` (`selection.ts:12-20`, `research.ts:149-167`).
6. **Labs request bodies** (`openseo:src/server/lib/dataforseo/labs.ts:147-236`): related `depth: 3`, `ignore_synonyms`, `include_clickstream_data` default false, `include_serp_info: false`; suggestions `include_seed_keyword: true`, `exact_match: false`; ideas `keywords: [seed]`, `closely_variants: false`. `ignoreSynonyms = !groupKeywords` (`research.ts:91`).
7. **Row mapping** prefers the clickstream-normalised block when present, maps the monthly trend, and normalises intent to `informational|commercial|transactional|navigational|unknown` (`research/research-data.ts:28-63`, `helpers.ts:34-42`). Google Ads rows scale `competition_index` 0–100 to 0–1 and have no difficulty or intent (`research-data.ts:65-100`).
8. **Google Ads** (`openseo:src/server/lib/dataforseo/google-ads.ts:34-104`): a keyword Ads rejects (> 80 chars, > 10 words, symbols or emoji) fails the whole task, so it is skipped; `keywords_for_keywords` sorts by volume and is truncated to the limit (no limit parameter); `search_volume` takes `location_name` for a city.
9. **Cache.** Results are cached 24 h under `kw:research` v5 keyed by organisation, project, keywords, market, limit, mode, `depth: 3`, clickstream, grouping and `locationName`; a cached result is used only when it has rows and parses its schema (`research.ts:44-74`, `:209-229`, `:291-299`; `openseo:src/server/lib/r2-cache.ts:7-10`, `:21-71`).
10. **Metrics persistence.** National result rows are upserted into the per-project `keyword_metrics` fire-and-forget; local rows are never persisted (`research.ts:231-256`, `:330-334`).
11. **Local volume.** The area must be a city, county or region in the country's registry, checked before any paid call (`UNKNOWN_LOCATION`, `research/local-volume.ts:15-38`). National research runs (cached as usual), its rows are persisted, then one Google Ads `search_volume` call replaces volume, trend, CPC and competition; a keyword Ads does not return gets nulls, "never the national numbers" (`research.ts:338-373`, `local-volume.ts:40-77`). The UI notes "Local volume adds ~$0.09 per search" (`openseo:src/shared/billing.ts:39`, `page/KeywordAreaField.tsx:40-53`). Registry: free `GET /v3/serp/google/locations/{iso}`, city/county/municipality/DMA/region rows only, cached 30 days (`openseo:src/server/lib/dataforseo/serp-locations.ts:14-112`).
12. **Metrics for a list** (`openseo:src/server/lib/dataforseo/keyword-metrics.ts:19-257`): batches of 700, Labs `keyword_overview` or Ads `search_volume` by country, local merge of Ads volume with national Labs difficulty/intent, explicit null rows so stale numbers cannot survive.
13. **SERP analysis** (`research/serp.ts:14-141`): Google organic live advanced; only `type === "organic"` items are mapped (rank, title, URL, domain, description, ETV, backlinks info); 12 h cache whose key excludes depth and whose value records it, so a depth-100 snapshot answers depth-20 requests; an empty deeper crawl never evicts a good snapshot; depth is 20 or 100 only (`schemas/keywords.ts:212-223`; `openseo:src/server/lib/dataforseo/serp.ts:20-32`, `:90-127`).
14. **Prices** (`openseo:src/server/lib/dataforseo/pricing.ts:84-92`, `:166-180`, `:231-253`, `:282-289`; `openseo:src/shared/rank-tracking.ts:16-25`, `:69-91`): Labs $0.012 per task + $0.00012 per row, doubled with clickstream; Google Ads live $0.09 flat; SERP live $0.002 first page + $0.0015 per extra page of 10, ×5 for search operators.
15. **Tables** (`openseo:src/db/app.schema.ts:90-208`): `saved_keywords` unique `(project, keyword, location, language)`; `saved_keyword_tags` unique `(project, normalized_name)` with optional palette `color`; `saved_keyword_tag_assignments` unique `(saved_keyword_id, tag_id)` with a tag index; `keyword_metrics` unique `(project, keyword, location, language)` holding volume, CPC, competition, difficulty, intent, monthly searches JSON and `fetched_at`.
16. **Repository** (`repositories/KeywordResearchRepository.ts:61-310`): metric upsert on conflict; save with `ON CONFLICT DO NOTHING` then re-select; filters (search, include/exclude terms as LIKE with escaping, numeric ranges, tag `EXISTS`), sort by one column plus id, total count, page.
17. **Tags** (`repositories/SavedKeywordTagsRepository.ts:21-403`, `openseo:src/shared/saved-keyword-tags.ts:1-35`, `openseo:src/shared/tag-colors.ts:1-58`): names trimmed with internal whitespace collapsed, normalised lower-case, de-duplicated; add, replace (keep only the given tags) and remove; rename/recolour; delete refuses a tag still attached ("Tag is attached to N keywords. Remove the tag from those keywords first.", `research/saved-keywords.ts:276-284`); eight palette keys.
18. **Save** accepts optional client-supplied metrics and upserts them (`saved-keywords.ts:34-110`); replace mode requires tags (`schemas/keywords.ts:75-88`).
19. **Refresh** (`research/refresh-metrics.ts:10-75`): every saved keyword, grouped by market, `fetchKeywordMetricsForList`, upserts in chunks of 100; UI confirms "This fetches new volume, difficulty, and CPC for every saved keyword in this project. Each keyword uses credits." (`saved-keywords/SavedKeywordsHeader.tsx:59-72`).
20. **Research page.** Master–detail: keywords table (3/5) and a panel with "Search Trends" (last 12 months, Recharts area) and "SERP Analysis" (2/5); below `md` two tabs "Keywords ({n})" / "SERP Analysis" (`page/KeywordResearchResults.tsx:44-307`, `components/DisplayPrimitives.tsx:28-93`). Overview strip shows keyword, score badge, Vol, CPC, Comp, intent (`components/KeywordUi.tsx:12-47`). Approximate-match notice in non-auto modes (`KeywordResearchResults.tsx:96-104`, `state/useKeywordOverviewState.ts:22-37`).
21. **SERP card** (`components/SerpAnalysisCard.tsx:59-200`): columns "#" and "Page" (title link only for `http(s)` via `safeHttpUrl`), export, pagination whose "next" past the loaded rows reads "Load top 100", "Show top 20" after a failed deep crawl, empty copy "No SERP details available for this keyword yet." The hook never retries or refetches a billed SERP automatically (`hooks/useKeywordSerpAnalysis.ts:9-153`).
22. **Search bar and options** (`page/KeywordResearchSearchBar.tsx:28-150`, `page/KeywordSearchOptions.tsx:23-122`): textarea (Enter submits, Shift+Enter adds a line, up to 5 keywords), country select, optional city, an "Options" dialog with "Results", "Keyword source" (Auto, Phrase match, Category ideas, People also search for), "Clickstream-refined volumes", "Group keywords"; Ads countries show "Keyword data for this country comes from Google Ads — search volume, CPC, and trends are available, but difficulty and intent are not."
23. **Client filtering** (`hooks/useKeywordFiltering.ts:12-116`, `keywordResearchTypes.ts:11-78`): include terms all must match, exclude any, intent multi-select, numeric ranges with null treated as 0; filters persisted per project in local storage (`hooks/useLocalKeywordFilters.ts:9-84`). Shared-volume grouping is display-only and applied after filtering (`groupSharedVolumeRows.ts:8-67`); pagination never splits a family (`page/KeywordResearchPagination.tsx:19-68`).
24. **Save from research** sends the selected rows' metrics except for local searches; dialog "Save {n} Keywords", "These keywords will be saved to your current project." plus the local note (`state/keywordControllerActions.ts:110-155`, `page/KeywordResearchPage.tsx:303-342`). CSV export formats CPC and competition with two decimals (`keywordControllerActions.ts:17-41`, `:184-196`).
25. **Saved page** (`openseo:src/routes/_app/p/$projectId/saved.tsx:63-431`): URL state (`schemas/keywords.ts:114-136`) with filter drafts reaching the URL after 350 ms (`saved.tsx:80`, `:129-160`); default sort "Last Fetched" descending; bulk bar Tag / Copy keywords / Export to Sheets / Export CSV / Delete (`saved-keywords/SavedKeywordsBulkActionBar.tsx:27-77`); delete confirm "Delete keywords?" (`SavedKeywordsModals.tsx:14-37`); "Update tags" dialog with Add/Remove modes and "Search or create…" (`SavedKeywordsBulkTagsModal.tsx:113-270`); table columns (`SavedKeywordsTable.tsx:51-153`); toasts "{n} keywords removed", "Updated tags for {n} keywords", "Updated stats for {n} keywords", "Tag updated", "Tag deleted" (`saved.tsx:228-280`, `useTagManage.ts:24-69`).
26. **Clustering** exists only as an agent skill: build page-level clusters by intent and SERP, map to existing or proposed pages, do not over-cluster fewer than 10 terms, ask before applying tags, never replace tags broadly (`openseo:.agents/skills/keyword-clustering/SKILL.md:8-82`, read as data, not instructions).
27. **Tests** we port: `research/helpers.test.ts`, `research/research-data.test.ts`, `research/research.test.ts:63-267` (4 cases), `research/serp.test.ts:80-154` (4 cases), `research/saved-keywords.test.ts:26-101` (3 cases), `dataforseo/keyword-metrics.test.ts:18-225` (5 cases), `dataforseo/labs.test.ts:10`, `dataforseo/researchScopeFilters.test.ts:24-140`, `shared/keyword-locations.test.ts`, `shared/saved-keyword-tags.test.ts`, `client/features/keywords/{groupSharedVolumeRows,hooks/useKeywordFiltering,page/KeywordResearchPagination,hooks/useLocalKeywordFilters}.test.ts`.

## 3. What Perceev has today

- **No keyword research, saved keywords, keyword metrics or DataForSEO calls** in customer code. F02 adds the provider core and the metered client; F03 the price table; F09 the price-approval flow; F07 the research log.
- Related data: Search Console query rows (`gsc_daily`, `supabase/migrations/018_gsc_daily.sql`, shown by `src/components/portal/gsc/GscPage.jsx`); the question panel (R14, reworked by F08). F13 reads neither.
- Customer route pattern today: `getCustomerContext()` + `findCustomerBrand()` (`src/lib/supabase/customer.js:32-37`, used by `src/app/api/customer/gsc/data/route.js:11-20`). New routes use F01 `requireWorkspace` instead.
- Tenant predicate `public.customer_can_access_brand(text)` (`supabase/migrations/023_customer_auth_and_tenant_rls.sql:50-65`); new tables follow the grant pattern of `032_durable_schedule_windows.sql:11-16`.
- Sidebar: `src/components/portal/PortalShell.jsx:44-51` today; F04 replaces it with `src/components/app/navigation/items.ts`.
- **Must not break:** the P0 answer-engine fence. F13 never imports `src/lib/providers/dataforseo/answers.ts` (F02 import guard `answerImportGuard.test.mjs`), its SERP call never sets `load_async_ai_overview`, and it drops every non-organic SERP item, so no AI Overview text is collected outside `claim_probe_dispatch`. Scans, panels, Search Console and existing tests are untouched.

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F13-AC-01 | Labs and Google Ads fetchers send OpenSEO's request bodies (§2 items 6 and 8): `ignore_synonyms` from the input, `include_clickstream_data` false unless asked, `include_serp_info` false, related `depth` 3, suggestions `include_seed_keyword` true and `exact_match` false, ideas `closely_variants` false, Ads ideas `sort_by: "search_volume"` truncated to the limit, Ads volume with `location_name` when local. | unit `src/lib/providers/dataforseo/labs.test.ts`, `google-ads.test.ts` |
| F13-AC-02 | `fetchKeywordMetricsForList` passes OpenSEO's five cases: clickstream preference, Ads routing with competition 0–1, Ads-rejected keywords skipped, batches of 700, local Ads volume merged with national Labs difficulty. | unit `src/lib/providers/dataforseo/keyword-metrics.test.ts` |
| F13-AC-03 | Every entry of `createLabsClient()` and `createGoogleAdsClient()` reserves through F02 `meter` with an estimate > 0 taken from F03 `dataforseoPricing`; no provider file defines a price; no file under `src/lib/keywords/` imports `answers.ts`. | unit `labs.test.ts` "every entry is priced"; F02 `noPrices.test.mjs`, `answerImportGuard.test.mjs` |
| F13-AC-04 | Auto mode runs suggestions and ideas with `ceil(limit/2)` each through `Promise.allSettled`, interleaves them, falls back to related when fewer than 5 non-seed rows return (`usedFallback: true`), and reports `source: "blended"`. When one leg fails, both legs' holds are settled or released before the route answers and the route returns `502 research_unavailable`. | unit `src/lib/keywords/research.test.ts` |
| F13-AC-05 | For a Google-Ads-only country the request is normalised to auto / no clickstream / no grouping, one `keywords_for_keywords` call is made, and rows have `keywordDifficulty: null` and `intent: "unknown"`; two requests differing only in ignored options share one cache entry. | unit `research.test.ts` |
| F13-AC-06 | Research results are cached in F01's provider cache with `scope: "global"` for 24 h. A second identical request from another workspace makes zero metered calls and returns the same rows. Results with no rows are never cached. | unit `research.test.ts`; route `keywords.route.test.mjs` |
| F13-AC-07 | National research rows (from a fetch, not a cache hit) are upserted into the shared `keyword_metrics` table through `upsert_keyword_metrics` without delaying the response; local rows are never upserted; a write failure is logged and does not fail the request. The save route accepts no metrics from the client (a `metrics` field is a `400 invalid_request`). | unit `research.test.ts`; route test; DB group `metrics` |
| F13-AC-08 | Priced action `keywords.research.run` (requireApproval **true**) quotes the lines of §6.4 exactly; without `maxUsd` the route returns `400 approval_required` with the quote; with `maxUsd` below the fresh quote it returns `409 price_changed`; in both cases nothing is reserved or called. | unit `src/lib/pricing/actions/keywords.test.ts`; route test |
| F13-AC-09 | `cacheOnly: true` never reserves spend and never calls DataForSEO: a cached result is returned with `status: "ok"`, a miss returns `200 { status: "not_cached" }`. Opening `/portal/keywords?q=…` uses `cacheOnly`, so a link or reload never spends. | route test; browser B2 |
| F13-AC-10 | A research cache miss appends a research-log entry with `appendResearch(kind "keywords.research", researchKey "<seed>|<location>|<language>|<area or ''>")` and summary `Keyword research for "<seed>" in <Country>: <n> keywords.`; a cache hit appends nothing. The quote carries warning `recent_research` when `findRecentResearch` finds an entry within 90 days. | unit `research.test.ts`; `keywords.test.ts` |
| F13-AC-11 | SERP analysis accepts depth 20 or 100, maps organic items only, never sends `load_async_ai_overview`, caches globally 12 h per depth, serves a cached depth-100 snapshot for a depth-20 request, never caches an empty crawl (returns `reason: "no_organic_results"`), and prices operator keywords ×5. | unit `src/lib/keywords/serp.test.ts` |
| F13-AC-12 | Migrations 100–102 create the saved-keyword tables with RLS; a member reads only their workspace's rows; composite foreign keys make a cross-workspace tag assignment impossible; `keyword_metrics` is unreadable by `authenticated`; caps of 5,000 saved keywords and 200 tags roll the whole call back. | DB `scripts/qa/check-f13-db.mjs` groups `schema`, `rls`, `caps`; `tests/customer-uat.sql` |
| F13-AC-13 | Save normalises and de-duplicates keywords, appends or replaces tags (replace without tags → `400 invalid_request`), returns the saved ids, and is idempotent for repeated keywords. | unit `savedKeywords.test.ts` (ported cases); DB group `save` |
| F13-AC-14 | The saved list filters (search, include/exclude terms, volume/CPC/difficulty ranges, tag ids or names), sorts by one column with unknown values last in both directions, paginates (50/100/250) and returns the total and every tag with its keyword count; an unknown tag name returns zero rows without querying keywords. | DB group `list`; unit `savedKeywords.test.ts` |
| F13-AC-15 | Bulk tag add/remove, rename (`409 tag_name_taken` on a clash), recolour (palette keys only) and delete (`409 tag_in_use` with OpenSEO's message while attached) behave as §2 item 17; bulk remove deletes only the caller's rows (≤ 2,000 ids). | DB groups `tags`, `remove`; route test |
| F13-AC-16 | "Update keyword stats" (`keywords.metrics_refresh.run`, approval required) runs as job `keywords.refresh_metrics`: only keywords whose metrics are older than 7 days (or missing) are bought, in batches of up to 700 per market, each batch a billed single-attempt step; progress is reported; a failed batch makes the job `partial`; a second start while one runs returns `409 job_already_running`. | unit `src/lib/keywords/refreshMetrics.test.ts`; DB group `refresh` |
| F13-AC-17 | Export returns up to 5,000 rows for the current filters with `truncated` set when more match; the CSV has OpenSEO's headers plus "Tags" and "Fetched At", formula-safe via F06. | route test; unit `src/shared/keywords.test.ts` |
| F13-AC-18 | "Group into topics" (`keywords.clustering.run`, 10–500 selected keywords, approval required) runs job `keywords.cluster`, which makes one `llmObject` call, assigns every keyword to exactly one topic (unknown or repeated indexes dropped, leftovers in "Unsorted"), and returns a proposal; nothing is tagged until the customer applies it, and applying only adds tags. | unit `src/lib/keywords/clustering.test.ts`; route test |
| F13-AC-19 | "Track as a question" calls F08 `addWorkspaceQuestion` with `origin: "manual"` and `sourceRef { kind: "keyword", keyword, locationCode, languageCode }`, reports created / already tracked / restored, maps `question_limit` and `topic_limit`, and never changes an approved panel. The control shows only when `question_curation` is on. | unit `src/lib/keywords/trackQuestion.test.ts`; browser B9 |
| F13-AC-20 | Local volume: an area not in the country registry is refused (`409 unknown_location`) before any paid call; localised rows carry Ads numbers or null, never national; national rows are persisted even when they came from the cache. | unit `src/lib/keywords/localVolume.test.ts` (ported cases) |
| F13-AC-21 | `/portal/keywords` and `/portal/keywords/saved` render every state in §6.6 with its exact copy, price every paid button before the click, and show no horizontal scroll at 375 px. | browser `scripts/qa/check-f13-browser.mjs` B1–B22 |
| F13-AC-22 | With `keyword_research` off, the sidebar items are hidden, the pages show "This page is not available for your workspace yet.", and every route returns `404 feature_unavailable`; a disabled spend control returns F01's `403 feature_disabled`. | route test; browser B1 |
| F13-AC-23 | `LOCATION_OPTIONS` (143 countries, alphabetical, unique codes) and `LABS_LOCATION_OPTIONS` satisfy F04's `readonly LocationOption[]`; `defaultLocationForHost("offcult.in")` is 2356 and an unknown TLD is 2840. | unit `src/shared/keyword-locations.test.ts`; `npm run typecheck` |
| F13-AC-24 | Workspace B cannot read, tag, export, refresh, cluster or delete workspace A's saved keywords through any F13 route. | route `keywords.route.test.mjs` "tenant isolation" |

## 5. Scope

**In scope:** DataForSEO Labs and Google Ads section clients; shared research primitives used by F14 and F16 (research scope, DataForSEO filter builders, target parsing, cache helpers, `ResearchScopeSelect`, `SearchCard`, `PricedActionButton`); keyword research with auto/manual modes, clickstream, grouping, local volume; SERP analysis; global market-data cache and shared `keyword_metrics`; saved keywords with tags, filters, bulk actions, export, stats refresh; "Group into topics"; "Track as a question"; priced actions, spend features, flags, contracts, research-log writes, tools for F22; pages `/portal/keywords` and `/portal/keywords/saved`; location option lists for F04's pickers; SERP location search for F15/F17.

**Out of scope:** domain research (F14), backlinks (F16), rank tracking and keyword import from saved lists (F15), local SEO grid (F17), the agent skill packaging of clustering (F21), the assistant (F22), keyword suggestions from Search Console (not planned), manual entry of saved keywords without research (OpenSEO has none), keyword-level AI Overview presence (F15, inside the P0 fence). Deferred Mixed rows (stable question set, competitors on the tracking side) are not touched: "Track as a question" only adds a library question through F08; panel approval stays F08's.

## 6. Design

### 6.1 Data model

Three migration files. All DDL is idempotent. Customer tables follow conventions §6.8 and the F07 grant pattern. Functions are `SET search_path = public`, revoked from `PUBLIC, anon, authenticated` and granted to `service_role` only.

#### `supabase/migrations/100_f13_saved_keywords.sql`

```sql
-- F13: saved keywords, tags and tag assignments.
-- Port of openseo:src/db/app.schema.ts:90-169 (project -> workspace brand_key).
CREATE TABLE IF NOT EXISTS public.saved_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  keyword text NOT NULL CHECK (keyword = btrim(keyword) AND length(keyword) BETWEEN 1 AND 200),
  location_code integer NOT NULL CHECK (location_code BETWEEN 1000 AND 9999999),
  language_code text NOT NULL CHECK (language_code ~ '^[a-z]{2,3}(-[A-Za-z]{2,4})?$'),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_keywords_unique_market UNIQUE (brand_key, keyword, location_code, language_code),
  CONSTRAINT saved_keywords_brand_id UNIQUE (brand_key, id)
);
COMMENT ON COLUMN public.saved_keywords.keyword IS 'Trimmed, lower-cased in src/lib/keywords/helpers.ts normalizeKeyword before insert.';
CREATE INDEX IF NOT EXISTS saved_keywords_brand_created_idx ON public.saved_keywords (brand_key, created_at DESC, id);
CREATE INDEX IF NOT EXISTS saved_keywords_market_idx ON public.saved_keywords (keyword, location_code, language_code);

CREATE TABLE IF NOT EXISTS public.saved_keyword_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 64),
  normalized_name text NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 64),
  color text CHECK (color IS NULL OR color IN ('slate','rose','amber','lime','emerald','sky','violet','fuchsia')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_keyword_tags_unique_name UNIQUE (brand_key, normalized_name),
  CONSTRAINT saved_keyword_tags_brand_id UNIQUE (brand_key, id)
);
COMMENT ON COLUMN public.saved_keyword_tags.color IS 'Palette key from src/shared/tag-colors.ts; NULL = colour derived from the id at render time.';

-- brand_key is repeated so RLS needs no join; the composite foreign keys make a
-- cross-workspace assignment impossible.
CREATE TABLE IF NOT EXISTS public.saved_keyword_tag_assignments (
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  saved_keyword_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (saved_keyword_id, tag_id),
  CONSTRAINT saved_keyword_tag_assignments_keyword_fk FOREIGN KEY (brand_key, saved_keyword_id)
    REFERENCES public.saved_keywords(brand_key, id) ON DELETE CASCADE,
  CONSTRAINT saved_keyword_tag_assignments_tag_fk FOREIGN KEY (brand_key, tag_id)
    REFERENCES public.saved_keyword_tags(brand_key, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS saved_keyword_tag_assignments_tag_idx ON public.saved_keyword_tag_assignments (tag_id);

DROP TRIGGER IF EXISTS saved_keyword_tags_touch ON public.saved_keyword_tags;
CREATE TRIGGER saved_keyword_tags_touch BEFORE UPDATE ON public.saved_keyword_tags
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['saved_keywords','saved_keyword_tags','saved_keyword_tag_assignments'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS f13_member_read ON public.%I', t);
    EXECUTE format('CREATE POLICY f13_member_read ON public.%I FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key))', t);
  END LOOP;
END $$;
```

#### `supabase/migrations/101_f13_keyword_metrics.sql`

```sql
-- F13: shared keyword market data. Public DataForSEO metrics per keyword and
-- national market. Holds no tenant data and no brand_key (deviation, see
-- "Deviations from conventions"). Service role only; customers read metrics
-- only through routes that join them onto their own saved keywords.
CREATE TABLE IF NOT EXISTS public.keyword_metrics (
  keyword text NOT NULL CHECK (keyword = btrim(keyword) AND length(keyword) BETWEEN 1 AND 200),
  location_code integer NOT NULL CHECK (location_code BETWEEN 1000 AND 9999999),
  language_code text NOT NULL CHECK (language_code ~ '^[a-z]{2,3}(-[A-Za-z]{2,4})?$'),
  search_volume integer CHECK (search_volume IS NULL OR search_volume >= 0),
  cpc numeric(12,4) CHECK (cpc IS NULL OR cpc >= 0),
  competition numeric(6,5) CHECK (competition IS NULL OR competition BETWEEN 0 AND 1),
  keyword_difficulty smallint CHECK (keyword_difficulty IS NULL OR keyword_difficulty BETWEEN 0 AND 100),
  intent text CHECK (intent IS NULL OR intent IN ('informational','commercial','transactional','navigational','unknown')),
  monthly_searches jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(monthly_searches) = 'array' AND jsonb_array_length(monthly_searches) <= 48),
  source text NOT NULL CHECK (source IN ('labs','google_ads','labs_ranked')),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (keyword, location_code, language_code)
);
COMMENT ON COLUMN public.keyword_metrics.source IS 'labs = keyword_overview or research rows; google_ads = Ads search volume; labs_ranked = partial row from F14 ranked keywords (volume, CPC, difficulty only).';
CREATE INDEX IF NOT EXISTS keyword_metrics_fetched_idx ON public.keyword_metrics (fetched_at);

ALTER TABLE public.keyword_metrics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.keyword_metrics FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.keyword_metrics TO service_role;

-- Batch upsert. Partial sources never erase richer stored fields.
CREATE OR REPLACE FUNCTION public.upsert_keyword_metrics(p_rows jsonb) RETURNS integer
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 1000 THEN
    RAISE EXCEPTION 'keyword_metrics_invalid:rows';
  END IF;
  INSERT INTO keyword_metrics AS m (keyword, location_code, language_code, search_volume, cpc, competition,
      keyword_difficulty, intent, monthly_searches, source, fetched_at)
  SELECT DISTINCT ON (r.keyword, r.location_code, r.language_code)
         r.keyword, r.location_code, r.language_code, r.search_volume, r.cpc, r.competition,
         r.keyword_difficulty, r.intent, coalesce(r.monthly_searches, '[]'::jsonb), r.source, now()
    FROM jsonb_to_recordset(p_rows) AS r(keyword text, location_code integer, language_code text,
         search_volume integer, cpc numeric, competition numeric, keyword_difficulty smallint,
         intent text, monthly_searches jsonb, source text)
  ON CONFLICT (keyword, location_code, language_code) DO UPDATE SET
    search_volume = excluded.search_volume,
    cpc = excluded.cpc,
    competition = CASE WHEN excluded.source = 'labs_ranked' THEN m.competition ELSE excluded.competition END,
    keyword_difficulty = coalesce(excluded.keyword_difficulty, m.keyword_difficulty),
    intent = CASE WHEN excluded.source = 'labs_ranked' THEN m.intent ELSE coalesce(excluded.intent, m.intent) END,
    monthly_searches = CASE WHEN jsonb_array_length(excluded.monthly_searches) = 0
                            THEN m.monthly_searches ELSE excluded.monthly_searches END,
    source = CASE WHEN excluded.source = 'labs_ranked' THEN m.source ELSE excluded.source END,
    fetched_at = now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- Retention: metrics older than p_before that no workspace has saved.
CREATE OR REPLACE FUNCTION public.prune_keyword_metrics(p_before timestamptz, p_limit integer) RETURNS integer
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM keyword_metrics m WHERE (m.keyword, m.location_code, m.language_code) IN (
    SELECT k.keyword, k.location_code, k.language_code FROM keyword_metrics k
     WHERE k.fetched_at < p_before
       AND NOT EXISTS (SELECT 1 FROM saved_keywords s WHERE s.keyword = k.keyword
                         AND s.location_code = k.location_code AND s.language_code = k.language_code)
     LIMIT greatest(1, least(p_limit, 10000)));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.upsert_keyword_metrics(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_keyword_metrics(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_keyword_metrics(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_keyword_metrics(timestamptz, integer) TO service_role;
```

Note: `prune_keyword_metrics` names `saved_keywords` only inside its PL/pgSQL body, resolved at call time, so 101 applies cleanly before 100 exists (phase 2 ships 101; phase 3 ships 100 and 102 and registers the retention periodic). In a full deploy the numbering applies 100 first.

#### `supabase/migrations/102_f13_saved_keyword_functions.sql`

```sql
-- F13: atomic saved-keyword operations (port of the repository logic in
-- openseo:src/server/features/keywords/repositories/*.ts). Keyword and tag
-- normalisation happen in TypeScript; these functions trust normalised input.
CREATE OR REPLACE FUNCTION public.f13_like_escape(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT replace(replace(replace(p, '\', '\\'), '%', '\%'), '_', '\_') $$;

-- p_tags: [{"name": "Oversized tees", "normalized": "oversized tees"}]
CREATE OR REPLACE FUNCTION public.f13_upsert_tags(p_brand text, p_tags jsonb) RETURNS uuid[]
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF jsonb_typeof(p_tags) IS DISTINCT FROM 'array' OR jsonb_array_length(p_tags) > 60 THEN
    RAISE EXCEPTION 'saved_keywords_invalid:tags';
  END IF;
  INSERT INTO saved_keyword_tags(brand_key, name, normalized_name)
    SELECT p_brand, t->>'name', t->>'normalized' FROM jsonb_array_elements(p_tags) t
  ON CONFLICT (brand_key, normalized_name) DO NOTHING;
  IF (SELECT count(*) FROM saved_keyword_tags WHERE brand_key = p_brand) > 200 THEN
    RAISE EXCEPTION 'saved_keywords_cap:tags';
  END IF;
  RETURN (SELECT coalesce(array_agg(id ORDER BY normalized_name), '{}') FROM saved_keyword_tags
           WHERE brand_key = p_brand
             AND normalized_name IN (SELECT t->>'normalized' FROM jsonb_array_elements(p_tags) t));
END $$;

CREATE OR REPLACE FUNCTION public.save_keywords(p_brand text, p_keywords text[], p_location integer,
  p_language text, p_tags jsonb DEFAULT '[]'::jsonb, p_tag_mode text DEFAULT 'append', p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_ids uuid[]; v_created integer; v_tag_ids uuid[];
BEGIN
  IF p_tag_mode NOT IN ('append','replace') THEN RAISE EXCEPTION 'saved_keywords_invalid:tag_mode'; END IF;
  IF p_tag_mode = 'replace' AND jsonb_array_length(coalesce(p_tags,'[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'saved_keywords_invalid:replace_requires_tags';
  END IF;
  IF coalesce(array_length(p_keywords, 1), 0) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'saved_keywords_invalid:keywords';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM customer_brands WHERE brand_key = p_brand AND is_active) THEN
    RAISE EXCEPTION 'saved_keywords_invalid:brand';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('f13_saved_keywords:' || p_brand));
  INSERT INTO saved_keywords(brand_key, keyword, location_code, language_code, created_by)
    SELECT p_brand, k, p_location, p_language, p_actor FROM unnest(p_keywords) AS k
  ON CONFLICT ON CONSTRAINT saved_keywords_unique_market DO NOTHING;
  GET DIAGNOSTICS v_created = ROW_COUNT;
  IF (SELECT count(*) FROM saved_keywords WHERE brand_key = p_brand) > 5000 THEN
    RAISE EXCEPTION 'saved_keywords_cap:keywords';
  END IF;
  SELECT coalesce(array_agg(id ORDER BY keyword), '{}') INTO v_ids FROM saved_keywords
   WHERE brand_key = p_brand AND location_code = p_location AND language_code = p_language
     AND keyword = ANY(p_keywords);
  IF jsonb_array_length(coalesce(p_tags,'[]'::jsonb)) > 0 THEN
    v_tag_ids := f13_upsert_tags(p_brand, p_tags);
    INSERT INTO saved_keyword_tag_assignments(brand_key, saved_keyword_id, tag_id)
      SELECT p_brand, s, t FROM unnest(v_ids) s CROSS JOIN unnest(v_tag_ids) t
    ON CONFLICT DO NOTHING;
    IF p_tag_mode = 'replace' THEN
      DELETE FROM saved_keyword_tag_assignments
       WHERE brand_key = p_brand AND saved_keyword_id = ANY(v_ids) AND NOT (tag_id = ANY(v_tag_ids));
    END IF;
  END IF;
  RETURN jsonb_build_object('savedKeywordIds', to_jsonb(v_ids), 'created', v_created);
END $$;

CREATE OR REPLACE FUNCTION public.f13_filtered_saved_keywords(p_brand text, p_filters jsonb)
RETURNS TABLE (id uuid, keyword text, location_code integer, language_code text, created_at timestamptz,
  search_volume integer, cpc numeric, competition numeric, keyword_difficulty smallint, intent text,
  monthly_searches jsonb, fetched_at timestamptz)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT s.id, s.keyword, s.location_code, s.language_code, s.created_at,
         m.search_volume, m.cpc, m.competition, m.keyword_difficulty, m.intent, m.monthly_searches, m.fetched_at
    FROM saved_keywords s
    LEFT JOIN keyword_metrics m
      ON m.keyword = s.keyword AND m.location_code = s.location_code AND m.language_code = s.language_code
   WHERE s.brand_key = p_brand
     AND (nullif(btrim(coalesce(p_filters->>'search', '')), '') IS NULL
          OR lower(s.keyword) LIKE '%' || f13_like_escape(lower(btrim(p_filters->>'search'))) || '%' ESCAPE '\')
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(p_filters->'includeTerms', '[]'::jsonb)) AS t(term)
                      WHERE btrim(t.term) <> ''
                        AND lower(s.keyword) NOT LIKE '%' || f13_like_escape(lower(btrim(t.term))) || '%' ESCAPE '\')
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(p_filters->'excludeTerms', '[]'::jsonb)) AS t(term)
                      WHERE btrim(t.term) <> ''
                        AND lower(s.keyword) LIKE '%' || f13_like_escape(lower(btrim(t.term))) || '%' ESCAPE '\')
     AND (p_filters->>'minVolume' IS NULL OR m.search_volume >= (p_filters->>'minVolume')::integer)
     AND (p_filters->>'maxVolume' IS NULL OR m.search_volume <= (p_filters->>'maxVolume')::integer)
     AND (p_filters->>'minCpc' IS NULL OR m.cpc >= (p_filters->>'minCpc')::numeric)
     AND (p_filters->>'maxCpc' IS NULL OR m.cpc <= (p_filters->>'maxCpc')::numeric)
     AND (p_filters->>'minDifficulty' IS NULL OR m.keyword_difficulty >= (p_filters->>'minDifficulty')::integer)
     AND (p_filters->>'maxDifficulty' IS NULL OR m.keyword_difficulty <= (p_filters->>'maxDifficulty')::integer)
     AND (jsonb_array_length(coalesce(p_filters->'tagIds', '[]'::jsonb)) = 0 OR EXISTS (
          SELECT 1 FROM saved_keyword_tag_assignments a
           WHERE a.saved_keyword_id = s.id
             AND a.tag_id IN (SELECT x::uuid FROM jsonb_array_elements_text(p_filters->'tagIds') AS x)))
$$;

CREATE OR REPLACE FUNCTION public.list_saved_keywords(p_brand text, p_filters jsonb DEFAULT '{}'::jsonb,
  p_sort text DEFAULT 'fetchedAt', p_order text DEFAULT 'desc', p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE v_total integer; v_rows jsonb; v_tags jsonb;
BEGIN
  IF p_sort NOT IN ('createdAt','keyword','searchVolume','cpc','competition','keywordDifficulty','fetchedAt')
     OR p_order NOT IN ('asc','desc') OR p_limit NOT BETWEEN 1 AND 5000 OR p_offset < 0 THEN
    RAISE EXCEPTION 'saved_keywords_invalid:list';
  END IF;
  SELECT count(*) INTO v_total FROM f13_filtered_saved_keywords(p_brand, p_filters);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'keyword', f.keyword, 'locationCode', f.location_code, 'languageCode', f.language_code,
      'createdAt', f.created_at, 'searchVolume', f.search_volume, 'cpc', f.cpc, 'competition', f.competition,
      'keywordDifficulty', f.keyword_difficulty, 'intent', f.intent,
      'monthlySearches', coalesce(f.monthly_searches, '[]'::jsonb), 'fetchedAt', f.fetched_at,
      'tags', coalesce((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name,
                          'normalizedName', t.normalized_name, 'color', t.color) ORDER BY t.normalized_name)
                          FROM saved_keyword_tag_assignments a JOIN saved_keyword_tags t ON t.id = a.tag_id
                         WHERE a.saved_keyword_id = f.id), '[]'::jsonb)
    ) ORDER BY f.ord), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT x.*, row_number() OVER (ORDER BY
        CASE WHEN p_sort = 'keyword' AND p_order = 'asc' THEN x.keyword END ASC,
        CASE WHEN p_sort = 'keyword' AND p_order = 'desc' THEN x.keyword END DESC,
        CASE WHEN p_sort = 'searchVolume' AND p_order = 'asc' THEN x.search_volume END ASC NULLS LAST,
        CASE WHEN p_sort = 'searchVolume' AND p_order = 'desc' THEN x.search_volume END DESC NULLS LAST,
        CASE WHEN p_sort = 'cpc' AND p_order = 'asc' THEN x.cpc END ASC NULLS LAST,
        CASE WHEN p_sort = 'cpc' AND p_order = 'desc' THEN x.cpc END DESC NULLS LAST,
        CASE WHEN p_sort = 'competition' AND p_order = 'asc' THEN x.competition END ASC NULLS LAST,
        CASE WHEN p_sort = 'competition' AND p_order = 'desc' THEN x.competition END DESC NULLS LAST,
        CASE WHEN p_sort = 'keywordDifficulty' AND p_order = 'asc' THEN x.keyword_difficulty END ASC NULLS LAST,
        CASE WHEN p_sort = 'keywordDifficulty' AND p_order = 'desc' THEN x.keyword_difficulty END DESC NULLS LAST,
        CASE WHEN p_sort = 'fetchedAt' AND p_order = 'asc' THEN x.fetched_at END ASC NULLS LAST,
        CASE WHEN p_sort = 'fetchedAt' AND p_order = 'desc' THEN x.fetched_at END DESC NULLS LAST,
        CASE WHEN p_sort = 'createdAt' AND p_order = 'asc' THEN x.created_at END ASC,
        CASE WHEN p_sort = 'createdAt' AND p_order = 'desc' THEN x.created_at END DESC,
        x.id ASC) AS ord
      FROM f13_filtered_saved_keywords(p_brand, p_filters) AS x
     ORDER BY ord LIMIT p_limit OFFSET p_offset
  ) AS f;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'normalizedName', t.normalized_name,
      'color', t.color, 'keywordCount', (SELECT count(*) FROM saved_keyword_tag_assignments a WHERE a.tag_id = t.id))
      ORDER BY t.normalized_name), '[]'::jsonb) INTO v_tags
    FROM saved_keyword_tags t WHERE t.brand_key = p_brand;
  RETURN jsonb_build_object('rows', v_rows, 'totalCount', v_total, 'tags', v_tags);
END $$;

CREATE OR REPLACE FUNCTION public.update_saved_keyword_tags(p_brand text, p_ids uuid[],
  p_add jsonb DEFAULT '[]'::jsonb, p_remove uuid[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_ids uuid[]; v_add uuid[] := '{}'; v_added jsonb := '[]'::jsonb; v_removed_ids uuid[] := '{}'; v_removed integer := 0;
BEGIN
  IF coalesce(array_length(p_ids, 1), 0) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'saved_keywords_invalid:ids'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('f13_saved_keywords:' || p_brand));
  SELECT coalesce(array_agg(id), '{}') INTO v_ids FROM saved_keywords WHERE brand_key = p_brand AND id = ANY(p_ids);
  IF jsonb_array_length(coalesce(p_add, '[]'::jsonb)) > 0 AND cardinality(v_ids) > 0 THEN
    v_add := f13_upsert_tags(p_brand, p_add);
    INSERT INTO saved_keyword_tag_assignments(brand_key, saved_keyword_id, tag_id)
      SELECT p_brand, s, t FROM unnest(v_ids) s CROSS JOIN unnest(v_add) t
    ON CONFLICT DO NOTHING;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'normalizedName', normalized_name,
        'color', color) ORDER BY normalized_name), '[]'::jsonb)
      INTO v_added FROM saved_keyword_tags WHERE id = ANY(v_add);
  END IF;
  IF cardinality(coalesce(p_remove, '{}')) > 0 AND cardinality(v_ids) > 0 THEN
    SELECT coalesce(array_agg(id), '{}') INTO v_removed_ids FROM saved_keyword_tags
     WHERE brand_key = p_brand AND id = ANY(p_remove);
    DELETE FROM saved_keyword_tag_assignments
     WHERE brand_key = p_brand AND saved_keyword_id = ANY(v_ids) AND tag_id = ANY(v_removed_ids);
    GET DIAGNOSTICS v_removed = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('taggedCount', cardinality(v_ids), 'addedTags', v_added,
    'removedTagIds', to_jsonb(v_removed_ids), 'removedAssignments', v_removed);
END $$;

-- FOR UPDATE on the tag blocks a concurrent assignment insert (FK takes KEY SHARE),
-- so "in use" cannot race with a cascade delete (OpenSEO guard, SavedKeywordTagsRepository.ts:382-391).
CREATE OR REPLACE FUNCTION public.delete_saved_keyword_tag(p_brand text, p_tag uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  PERFORM 1 FROM saved_keyword_tags WHERE brand_key = p_brand AND id = p_tag FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  SELECT count(*) INTO v_count FROM saved_keyword_tag_assignments WHERE tag_id = p_tag;
  IF v_count > 0 THEN RETURN jsonb_build_object('status', 'in_use', 'assignmentCount', v_count); END IF;
  DELETE FROM saved_keyword_tags WHERE brand_key = p_brand AND id = p_tag;
  RETURN jsonb_build_object('status', 'deleted');
END $$;

CREATE OR REPLACE FUNCTION public.remove_saved_keywords(p_brand text, p_ids uuid[]) RETURNS integer
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  IF coalesce(array_length(p_ids, 1), 0) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'saved_keywords_invalid:ids'; END IF;
  DELETE FROM saved_keywords WHERE brand_key = p_brand AND id = ANY(p_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.f13_like_escape(text)', 'public.f13_upsert_tags(text, jsonb)',
    'public.save_keywords(text, text[], integer, text, jsonb, text, uuid)',
    'public.f13_filtered_saved_keywords(text, jsonb)',
    'public.list_saved_keywords(text, jsonb, text, text, integer, integer)',
    'public.update_saved_keyword_tags(text, uuid[], jsonb, uuid[])',
    'public.delete_saved_keyword_tag(text, uuid)', 'public.remove_saved_keywords(text, uuid[])'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
```

Error mapping (in `src/lib/keywords/repository.ts`): `saved_keywords_cap:keywords` → `AppError(409, "saved_keywords_limit", "A workspace can save up to 5,000 keywords. Delete some first.")`; `saved_keywords_cap:tags` → `AppError(409, "tag_limit", "A workspace can have up to 200 tags. Delete unused tags first.")`; `saved_keywords_invalid:*` → `AppError(400, "invalid_request", "These keywords could not be saved.")`; `23505` on `saved_keyword_tags_unique_name` → `AppError(409, "tag_name_taken", "Another tag already has this name.")`; any other database error → `AppError(503, "keywords_unavailable", "Saved keywords are unavailable. Please retry.")`.

**Required objects** (`scripts/setup-supabase.mjs` `EXPECTED_OBJECTS`, `scripts/setup-supabase.mjs:61-96` pattern):

```js
"100_f13_saved_keywords.sql": [
  {kind:"table",name:"saved_keywords"}, {kind:"table",name:"saved_keyword_tags"},
  {kind:"table",name:"saved_keyword_tag_assignments"},
],
"101_f13_keyword_metrics.sql": [
  {kind:"table",name:"keyword_metrics"}, {kind:"function",name:"upsert_keyword_metrics"},
  {kind:"function",name:"prune_keyword_metrics"},
],
"102_f13_saved_keyword_functions.sql": [
  {kind:"function",name:"save_keywords"}, {kind:"function",name:"list_saved_keywords"},
  {kind:"function",name:"update_saved_keyword_tags"}, {kind:"function",name:"delete_saved_keyword_tag"},
  {kind:"function",name:"remove_saved_keywords"}, {kind:"function",name:"f13_filtered_saved_keywords"},
],
```

**Tenant RLS test** (`tests/customer-uat.sql`, appended before the final `ROLLBACK`/`COMMIT` of the file, using the two workspaces it already creates):

```sql
INSERT INTO public.saved_keywords(id, brand_key, keyword, location_code, language_code) VALUES
 ('13000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','oversized tees',2356,'en'),
 ('13000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','oversized tees',2356,'en');
INSERT INTO public.saved_keyword_tags(id, brand_key, name, normalized_name) VALUES
 ('13100000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','Tees','tees'),
 ('13100000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','Tees','tees');
INSERT INTO public.saved_keyword_tag_assignments(brand_key, saved_keyword_id, tag_id) VALUES
 ('10000000-0000-0000-0000-000000000001','13000000-0000-0000-0000-000000000001','13100000-0000-0000-0000-000000000001');
DO $$ BEGIN
  BEGIN
    INSERT INTO public.saved_keyword_tag_assignments(brand_key, saved_keyword_id, tag_id) VALUES
     ('10000000-0000-0000-0000-000000000001','13000000-0000-0000-0000-000000000001','13100000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'Cross-workspace tag assignment was allowed';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
INSERT INTO public.keyword_metrics(keyword, location_code, language_code, search_volume, source)
VALUES ('oversized tees', 2356, 'en', 8100, 'labs');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.saved_keywords) <> 1 OR (SELECT count(*) FROM public.saved_keyword_tags) <> 1
     OR (SELECT count(*) FROM public.saved_keyword_tag_assignments) <> 1
    THEN RAISE EXCEPTION 'Saved keywords leaked across tenants'; END IF;
  BEGIN
    PERFORM count(*) FROM public.keyword_metrics;
    RAISE EXCEPTION 'keyword_metrics is readable by customers';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
```

**Migration paperwork** (conventions §8): `README.md` migration table rows; `docs/OPERATOR_LEDGER.md` § C additive list; `docs/PROD_MIGRATIONS.md` one bullet each. Migration 101 ships with the research API (subtask P2.T2.S3, since research writes metrics); 100 and 102 ship with saved keywords (subtask P3.T1.S4).

### 6.2 Server modules

All server modules are TypeScript under `src/lib/**` with relative imports and explicit `.ts` extensions (conventions §5.4). Every COPY/PORT file starts with the licence header (conventions §2).

#### 6.2.1 DataForSEO section clients (`src/lib/providers/dataforseo/`, F02 rule: "sections owned by other specs live in their own files")

| File | Mode | Exports |
|---|---|---|
| `labs.ts` | COPY `openseo:src/server/lib/dataforseo/labs.ts:1-396` (whole file, including the domain functions F14 uses) | Types `LabsMonthlySearch`, `LabsKeywordInfo`, `LabsKeywordDataItem`, `KeywordOverviewItem`, `RelevantPagesItem`, `DomainRankedKeywordItem`, `SerpCompetitorItem` (exported here; private in theirs), `DataforseoLabsItemType`; fetchers `fetchRelatedKeywords`, `fetchKeywordSuggestions`, `fetchKeywordIdeas`, `fetchDomainRankOverview`, `fetchRankedKeywords`, `fetchRelevantPages`, `fetchKeywordOverview`, `fetchSerpCompetitors` with identical inputs and bodies; zod v4 `.passthrough()` → `z.looseObject`; imports `dataforseoPost` from `./core.ts` and `assertOk`, `buildTaskBilling`, `parseTaskItems` from `./envelope.ts`. **Added:** `export function createLabsClient(deps?: { meter?: typeof meter })` (below). |
| `google-ads.ts` | COPY `google-ads.ts:1-104` | `AdsKeywordItem`, `AdsKeywordIdeaItem`, `isAdsKeyword`, `fetchAdsSearchVolume`, `fetchAdsKeywordIdeas`. **Added:** `createGoogleAdsClient(deps?)`. |
| `keyword-metrics.ts` | PORT `keyword-metrics.ts:1-257` | `fetchAdsSearchVolumeForKeywords`, `KEYWORD_METRICS_BATCH_SIZE = 700`, `KeywordMetricRow`, `fetchKeywordMetricsForList(client, params)`. Change: `creditFeature` is replaced by `call: (tag: string) => DataforseoCallContext` so every metered call gets its own idempotency key (`tag` = `"batch-<i>:labs"` or `"batch-<i>:ads"`); `client` is `{ labs: Pick<LabsClient["labs"], "keywordOverview">; ads: Pick<GoogleAdsClient, "adsSearchVolume"> }`. |
| `filters.ts` | COPY `filters.ts:1-89` | `FilterClause`, `escapeLikeTerm`, `parseFilterTerms`, `collectNumericRange`, `buildIncludeOrGroup`, `assertFilterConditionBudget` (throws `AppError(400, "filters_over_budget", "Too many filter conditions (N of 8 max).")`), `joinClauses`. Used by F14 and F16. |
| `researchScopeFilters.ts` | COPY `researchScopeFilters.ts:1-173` | `ScopeFilter`, `countExpressionConditions`, `buildBacklinksScopeFilter`, `prependScopeClauses`, `buildRankedKeywordsScopeFilter`, `buildRelevantPagesScopeFilter`. Used by F14 and F16. |
| `serp-locations.ts` (P8) | PORT `serp-locations.ts:1-112` | `SerpLocationResult`, `fetchSerpLocationsForCountry(iso, deps?)`: free `dataforseoGet("/v3/serp/google/locations/" + iso)`, same included types, cached through F01 `cached({ namespace: "dataforseo.serp_locations", version: 1, keyParts: [iso], ttlSeconds: 2592000, scope: "global", schema })` (KV → provider cache; bodies over 256 KB go to Storage, F01). Not metered (free, F02 §6.2.1 GET rule: 2 retries). |

```ts
// labs.ts (added at the end)
import { meter, type DataforseoCallContext } from "./client.ts";
import { dataforseoPricing } from "../../pricing/dataforseo.ts";
export function createLabsClient(deps?: { meter?: typeof meter }) {
  const m = deps?.meter ?? meter;
  return {
    keywords: {
      related: m(fetchRelatedKeywords, (i) => dataforseoPricing.keywords.related({ limit: i.limit, includeClickstreamData: i.includeClickstreamData }), "keywords.research"),
      suggestions: m(fetchKeywordSuggestions, (i) => dataforseoPricing.keywords.suggestions({ limit: i.limit, includeClickstreamData: i.includeClickstreamData }), "keywords.research"),
      ideas: m(fetchKeywordIdeas, (i) => dataforseoPricing.keywords.ideas({ limit: i.limit, includeClickstreamData: i.includeClickstreamData }), "keywords.research"),
    },
    labs: {
      keywordOverview: m(fetchKeywordOverview, (i) => dataforseoPricing.labs.keywordOverview({ keywords: i.keywords, includeClickstreamData: i.includeClickstreamData }), null),
      serpCompetitors: m(fetchSerpCompetitors, (i) => dataforseoPricing.labs.serpCompetitors({ limit: i.limit }), null),
    },
    domain: {
      rankOverview: m(fetchDomainRankOverview, () => dataforseoPricing.domain.rankOverview({}), null),
      rankedKeywords: m(fetchRankedKeywords, (i) => dataforseoPricing.domain.rankedKeywords({ limit: i.limit }), null),
      relevantPages: m(fetchRelevantPages, (i) => dataforseoPricing.domain.relevantPages({ limit: i.limit }), null),
    },
  };
}
export type LabsClient = ReturnType<typeof createLabsClient>;
// google-ads.ts (added at the end)
export function createGoogleAdsClient(deps?: { meter?: typeof meter }) {
  const m = deps?.meter ?? meter;
  return {
    adsIdeas: m(fetchAdsKeywordIdeas, () => dataforseoPricing.keywords.adsIdeas({}), "keywords.research"),
    adsSearchVolume: m(fetchAdsSearchVolume, () => dataforseoPricing.keywords.adsSearchVolume({}), null),
  };
}
export type GoogleAdsClient = ReturnType<typeof createGoogleAdsClient>;
```

The estimator argument objects follow F03's local input types for these entries; if F03's local type for an entry is `{}` the call passes `{}`. Entries with `null` default feature require `ctx.feature` (F02 throws `AppError(500, "spend_feature_required")` otherwise): `keywordOverview` is called with `keywords.metrics_refresh`, `adsSearchVolume` with `keywords.research` (local volume) or `keywords.metrics_refresh`, and the `domain.*`/`serpCompetitors` entries by F14 with its own features.

SERP analysis uses F02's metered `createDataforseoClient().serp.live(ctx, input)` with `ctx.feature = "keywords.serp"`; F13 adds no SERP fetcher.

#### 6.2.2 Shared research primitives (used by F14 and F16)

| File | Mode | Exports |
|---|---|---|
| `src/shared/researchScope.ts` | COPY `openseo:src/shared/researchScope.ts` | `isValidDomainHost` (uses `tldts`), `RESEARCH_SCOPES`, `ResearchScope`, `researchScopeSchema`, `RESEARCH_SCOPE_LABELS`, `RESEARCH_SCOPE_DESCRIPTIONS`, `RESEARCH_SCOPE_EXAMPLES`, `ResearchTarget`, `isScopeAllowedForInput`, `defaultScopeForPath`, `defaultScopeForInput`, `toScopeSearchParam`, `parseResearchTarget`, `RESEARCH_SCOPE_FILTER_SLOTS`, `BACKLINKS_SUBFOLDER_FILTER_CONDITIONS`, the host-matching helpers below line 198. **Added:** `export const MAX_DATAFORSEO_FILTER_CONDITIONS = 8;` (theirs lives in `openseo:src/types/schemas/domain.ts:71`). |
| `src/lib/research/target.ts` | PORT `openseo:src/server/lib/domainUtils.ts:1-70` | `parseResearchTargetOrThrow(input, scope?)` → `AppError(400, "invalid_target", parsed.message)`; `toRelativePath(url)`; `normalizeDomainInput(input, includeSubdomains)` → `AppError(400, "invalid_target", "Enter a valid domain like example.com")`. |
| `src/lib/research/cache.ts` | new (PATTERN of `serp.ts:94-137`, `DomainService.ts:66-117`) | `class CacheOnlyMiss extends Error {}`; `export async function peekCached<T>(i: CachedInput<T>): Promise<{ value: T; fetchedAt: string } \| null>` = `cached(i, () => Promise.reject(new CacheOnlyMiss()))`, returning `null` on `CacheOnlyMiss` (a hit never calls the fetcher; a miss writes nothing). `export async function cachedIf<T>(i: CachedInput<T>, fetcher: () => Promise<T>, keep: (v: T) => boolean): Promise<{ value: T; hit: boolean; fetchedAt: string }>`: wraps `fetcher` so that a value failing `keep` is thrown inside a private `SkipCache` carrying the value; `cachedIf` catches it and returns `{ value, hit: false, fetchedAt: now }` without writing. `CachedInput<T>` = the first parameter of F01 `cached`. |
| `src/lib/research/providerErrors.ts` | new | `export function toResearchError(err: unknown, o: { unavailableCode: string; unavailableMessage: string }): unknown`: returns `err` unchanged for `SpendRefused`, `AppError` codes not starting `dataforseo_`, and `CacheOnlyMiss`; `dataforseo_invalid_field` → `AppError(422, "research_invalid", "DataForSEO could not use this input. Try a different keyword or market.")`; `dataforseo_not_configured` → `AppError(503, "research_not_configured", "Research data is not configured yet. Contact Perceev support.")`; every other `UnbilledCallError`, `ChargedCallError`, `AmbiguousCallError` or `dataforseo_*` error → `AppError(502, o.unavailableCode, o.unavailableMessage, { details: { providerCode } })`. |
| `src/components/app/ResearchScopeSelect.tsx` | COPY `openseo:src/client/components/ResearchScopeSelect.tsx` | `ResearchScopeSelect({ value, onChange, disabledReason?, className?, "aria-label"? })` on F04 `select`. |
| `src/components/app/SearchCard.tsx` | COPY `openseo:src/client/components/SearchCard.tsx` | `SearchCard`, `SearchInput`. |
| `src/components/app/cost/PricedActionButton.tsx` | new | §6.6.4. |

#### 6.2.3 Shared keyword modules (`src/shared/`, client-safe, node-testable)

| File | Mode | Exports |
|---|---|---|
| `keyword-locations.ts` | COPY `openseo:src/shared/keyword-locations.ts:1-862` | All exports (`DEFAULT_LOCATION_CODE = 2840`, `formatLocationLabel`, `getIsoCountryCode`, `LOCATION_OPTIONS` (143), `SERP_LANGUAGE_OPTIONS`, `LABS_LOCATION_OPTIONS`, `LOCATIONS`, `getLanguageCode`, `resolveMarket`, `isLanguageServedForLocation`, `resolveLabsMarket`, `isSupportedLanguageCode`, `getLanguageOptions`, `resolveKeywordDataLanguage`, `isSupportedLocationCode`, `isLabsLocationCode`, `getKeywordDataProvider`). **Added:** `export function defaultLocationForHost(host: string): number` — suffix match on the host without `www.`: `.in` 2356, `.co.uk`/`.uk` 2826, `.com.au`/`.au` 2036, `.ca` 2124, `.sg` 2702, `.ae` 2784, anything else 2840; `export function workspaceMarket(brand: { website_host: string }): { locationCode: number; languageCode: string }` → `{ locationCode: defaultLocationForHost(host), languageCode: getLanguageCode(code) }`. These lists are the `options` for F04's `LocationSelect`/`CountryCombobox` (`LocationOption = { code, label, shortLabel }`; extra fields are allowed). |
| `keywords.ts` | PORT `openseo:src/types/keywords.ts` + `keywordResearchTypes.ts` | `KeywordIntent`, `KEYWORD_INTENT_ORDER`, `INTENT_LABELS` (from `IntentBadge.tsx:28-35`), `MonthlySearch`, `KeywordResearchRow`, `ResearchSource = "related"\|"suggestions"\|"ideas"\|"google_ads"\|"blended"`, `KeywordMode`, `RESULT_LIMITS = [150, 300, 500]`, `MAX_KEYWORDS_PER_SUBMIT = 5`, `SavedKeywordRow` (OpenSEO shape minus `projectId`), `SavedKeywordTag`, `SavedKeywordTagSummary`, `SerpResultItem`, `SAVED_KEYWORD_PAGE_SIZES = [50, 100, 250]`, `SAVED_KEYWORDS_CAP = 5000`, `SAVED_KEYWORD_TAGS_CAP = 200`, `METRICS_FRESH_DAYS = 7`, `keywordResearchHeaders(locationName?)`, `KEYWORD_RESEARCH_HEADERS`, `SAVED_KEYWORD_EXPORT_HEADERS`, `keywordResearchExportRow(row)`, `savedKeywordExportRow(row)`, `formatCentsForCsv(rows)` (ported from `keywordControllerActions.ts:17-41`, `:184-196` and `savedKeywordsUtils.ts:6-24`). |
| `keyword-filtering.ts` | PORT `hooks/useKeywordFiltering.ts:12-72`, `keywordResearchTypes.ts:11-78`, `groupSharedVolumeRows.ts`, `page/KeywordResearchPagination.tsx:19-32`, `utils.ts:21-45` | `KeywordFilterValues`, `EMPTY_FILTERS`, `parseIntentFilter`, `toggleIntentFilter`, `parseTerms`, `applyKeywordFiltersAndSort` (remeda `sortBy` replaced by a stable comparator; nulls treated as `-1` for sorting and `0` for ranges, as theirs), `groupSharedVolumeRows`, `KeywordResearchDisplayRow`, `keywordResearchPageEnds`, `lastTwelveMonths`, `formatNumber` (null → "—"), `formatCompactNumber`. |
| `saved-keyword-tags.ts` | COPY | `normalizeSavedKeywordTag`, `normalizeSavedKeywordTags`, `parseSavedKeywordTagInput`. |
| `tag-colors.ts` | COPY | `TAG_COLOR_KEYS`, `TagColorKey`, `resolveTagColor`, `tagChipClass`, `tagDotClass`, `tagSwatchClass`. The `tag-chip-<color>` classes are added to `src/styles/app-theme.css` (F04 file) by P5. |
| `saved-keywords-filters.ts` | COPY `saved-keywords/savedKeywordsFilterTypes.ts` | `SavedKeywordsFilterValues`, `EMPTY_SAVED_KEYWORDS_FILTERS`, `AppliedSavedKeywordsFilters`, `compileSavedKeywordsFilters`, `countActiveSavedKeywordsFilters`. |
| `serp-location-search.ts` (P8) | COPY `openseo:src/shared/serp-location-search.ts` | `REGION_ABBREVIATIONS`, `rankSerpLocations(query, all, iso)`. |

#### 6.2.4 Keyword services (`src/lib/keywords/`)

| File | Mode | Exports and behaviour |
|---|---|---|
| `helpers.ts` | COPY `research/helpers.ts` | `normalizeKeyword`, `interleaveRows`, `normalizeIntent`. |
| `selection.ts` | COPY `research/selection.ts` | `MIN_NON_SEED_FOR_AUTO = 5`, `countNonSeedKeywords`. |
| `researchData.ts` | PORT `research/research-data.ts` | `mapKeywordDataItems`, `mapAdsKeywordItems`, `fetchResearchRowsBySource(params, deps)`, `fetchGoogleAdsResearchRows(params, deps)`. `params` replace `creditFeature` with `call: DataforseoCallContext`; `deps = { labs: LabsClient; ads: GoogleAdsClient }`. |
| `research.ts` | PORT `research/research.ts:1-373` | `researchResultSchema` (theirs, `:44-70`, `z.looseObject`), `RESEARCH_CACHE = { namespace: "keywords.research", version: 1, ttlSeconds: 86400, scope: "global" }`, `researchCacheInput(input)`, `research(input: ResolvedResearchInput, deps: ResearchDeps): Promise<{ result: ResearchResult; fetched: boolean }>`, `ResearchDeps = { labs; ads; upsertMetrics(rows, market): Promise<void>; assertLocalLocation(code, name): Promise<void>; requestId: string; maxUsd: number; brandKey: string; keepAlive }`. Behaviour = §2 items 3–11 with: cache through `cachedIf(RESEARCH_CACHE + keyParts, fetch, (r) => r.rows.length > 0)`; legs use idempotency keys `keywords.research:<requestId>:<leg>` (`suggestions`, `ideas`, `related`, `ads_ideas`, `local_volume`); `upsertMetrics` is passed to `keepAlive`, never awaited, only for national rows from a fetch; `researchLocal` awaits `upsertMetrics` for the national rows as theirs (`:356-359`). |
| `localVolume.ts` (P8) | PORT `research/local-volume.ts` | `assertLocalResearchLocation(locationCode, locationName, deps?)` → `AppError(409, "unknown_location", "\"<label>\" is not a city, county, or region we can find in <Country>.")`; `localizeResearchRows(rows, params, deps)`. |
| `serp.ts` | PORT `research/serp.ts:1-141` | `runSerpRequest(ws: Workspace, i: { keyword; locationCode?; languageCode?; locationName?; depth: 20 \| 100; maxUsd?: number; requestId: string; cacheOnly: boolean }): Promise<{ items; cached; fetchedAt; depth }>` — the whole body of `POST /api/customer/keywords/serp` after auth and parsing (market, `requireApprovedPrice("keywords.serp.run")`, `cached` + metered `serp.live`); the route is a thin wrapper and F22's `get_serp_results` tool calls it directly. `serpCacheInput(input, depth)` = `{ namespace: "keywords.serp", version: 1, keyParts: [keyword, locationCode, languageCode, locationName ?? null, depth], ttlSeconds: 43200, scope: "global", schema: serpResultSchema }`; `mapOrganicSerpItems(items)` (theirs, `:50-66`); `getSerpAnalysis(input, deps): Promise<SerpAnalysisResult & { cached: boolean; fetchedAt: string }>`. Depth 20: `peekCached(serpCacheInput(input, 100))` first, then `cachedIf(serpCacheInput(input, 20), fetch, items.length > 0)`; depth 100: `cachedIf(serpCacheInput(input, 100), …)`. `fetch` = `serp.live({ brandKey, feature: "keywords.serp", idempotencyKey: "keywords.serp:<requestId>", maxUsd }, { keyword, locationCode, languageCode, locationName, depth })` from F02 (no `load_async_ai_overview`); an empty organic list returns `reason: "no_organic_results"` uncached. |
| `market.ts` | new | `resolveResearchMarket(body: { locationCode?; languageCode? }, brand): { locationCode; languageCode; provider: "labs" \| "google_ads"; country: string }` = `resolveMarket(body, workspaceMarket(brand))` then `resolveKeywordDataLanguage`; unknown location code → `AppError(400, "invalid_location", "This country is not supported.")`. `researchKey({ seed, locationCode, languageCode, locationName })` = `` `${seed}|${locationCode}|${languageCode}|${locationName ?? ""}` ``. |
| `metricsStore.ts` | new | `upsertKeywordMetrics(admin, rows: KeywordMetricUpsert[]): Promise<void>` — de-duplicates by key, chunks of 500, `rpc("upsert_keyword_metrics", { p_rows })`, up to 3 attempts 250 ms apart, logs `[keywords] metrics upsert failed { rows }` and never throws; `KeywordMetricUpsert = { keyword; location_code; language_code; search_volume; cpc; competition; keyword_difficulty; intent; monthly_searches; source }`. |
| `repository.ts` | PORT `repositories/KeywordResearchRepository.ts` + `SavedKeywordTagsRepository.ts` onto §6.1 functions | `createSavedKeywordsRepository(admin)` → `{ save(i), list(i), listAllForExport(i), updateTags(i), renameTag(i), recolorTag(i), deleteTag(i), remove(i), tagIdsByNames(brandKey, names), staleMarkets(brandKey, before), staleBatch(brandKey, market, before, startedAt, offset, limit) }`, mapping errors as in §6.1. `memoryRepository.ts` implements the same interface in memory for unit tests. |
| `savedKeywords.ts` | PORT `research/saved-keywords.ts` | `saveKeywords(repo, i: { brandKey; keywords; locationCode; languageCode; tags?; tagMode?; actorUserId })` (normalise + de-dupe; tags through `normalizeSavedKeywordTags`; no metrics), `getSavedKeywords(repo, i)` (tag names → ids via `tagIdsByNames`; empty name match → `{ rows: [], totalCount: 0, tags }`), `exportSavedKeywords(repo, i)` (limit 5,000, `truncated`), `updateSavedKeywordTags`, `updateSavedKeywordTag`, `deleteSavedKeywordTag` (`in_use` → `AppError(409, "tag_in_use", "Tag is attached to N keyword(s). Remove the tag from those keywords first.")` with OpenSEO's pluralisation; `not_found` → `AppError(404, "tag_not_found", "Tag not found.")`), `removeSavedKeywords`. |
| `refreshMetrics.ts` | PORT `research/refresh-metrics.ts` as a job | §6.3. |
| `clustering.ts` | new (PATTERN of `SKILL.md:43-82`) | `CLUSTER_SYSTEM` prompt, `clusterOutputSchema`, `buildClusterPrompt(keywords, contextMarkdown)`, `validateClusters(output, n)`, `estimateClusterPromptChars(keywords)`. §6.3. |
| `trackQuestion.ts` | new | `trackKeywordAsQuestion(admin, i: { brandKey; userId; keyword; text; topic?; locationCode; languageCode }, deps?: { add?: typeof addWorkspaceQuestion })` → `addWorkspaceQuestion(admin, { brandKey, text, origin: "manual", createdBy: userId, topic, sourceRef: { kind: "keyword", keyword, locationCode, languageCode } })`. |
| `jobs.ts` | new | Registers §6.3 job kinds and the periodic; imported by `src/lib/jobs/kinds.ts` (`import "../keywords/jobs.ts";`). |
| `keywords.contract.ts` | new | `export const contracts: RouteContract[]` for every §6.5 route. |
| `tools.ts` | new | Tool definitions for F22 (§6.2.6). |

**Origin decision for "Track as a question":** `manual`. F08 maps `prompt_research` to panel origin `search_questions`, meaning a question taken verbatim from a question dataset (F08 §6.2.3). Here the customer writes the question (prefilled with the keyword) in a dialog, which is what `manual` records; `sourceRef { kind: "keyword", … }` keeps where it came from, the same pattern F11 uses for Prompt Explorer.

#### 6.2.5 Priced actions (`src/lib/pricing/actions/keywords.ts`, registered by one import line in `src/lib/pricing/actions/index.ts`)

| Key | Feature | Input (`z.strictObject`) | `requireApproval` | Estimate (lines, exact labels) |
|---|---|---|---|---|
| `keywords.research.run` | `keywords.research` | `{ keyword: z.string().trim().min(1).max(200), locationCode?: int>0, languageCode?: string(2..8), locationName?: string(1..200), resultLimit: 150\|300\|500 = 150, mode: auto\|related\|suggestions\|ideas = auto, clickstream: bool = false, groupKeywords: bool = false }` | **true** (F09 §6.2.5) | After OpenSEO's normalisation (§2 item 4): Labs auto → "Phrase-match ideas" `keywords.suggestions({limit: ceil(L/2), cs})`, "Category ideas" `keywords.ideas({limit: ceil(L/2), cs})`, "Related keywords (only if the first two find fewer than 5)" `keywords.related({limit: L, cs})`; Labs manual → one line "Keyword ideas" for the chosen source with `limit: L`; Ads country → "Keyword ideas from Google Ads" `keywords.adsIdeas({})`; with `locationName` → plus "Local volume for <area>" `keywords.adsSearchVolume({})`; always "Top 20 Google results for “<seed>”" `serp.live({ depth: 20, keyword: seed })`. `expectedUsd` = total minus the related line (Labs auto) else total. Units `[{ key: "results", label: "keyword ideas", count: L }]`. Warnings: `cache_note` "Searching the same keyword, market and options again within 24 hours is free."; `ads_only` (Ads country) "Keyword data for this country comes from Google Ads: no difficulty or intent."; `recent_research` when `findRecentResearch(admin, { brandKey, kind: "keywords.research", researchKey })` returns an entry: "You researched this on <entryDate>: <summary> Results older than 24 hours are bought again." Blocked: `unknown_location` (P8, registry check, message as §6.2.4). |
| `keywords.serp.run` | `keywords.serp` | `{ keyword: string(1..200), locationCode?, languageCode?, locationName?, depth: 20\|100 = 20 }` | false | "Top <depth> Google results" `serp.live({ depth, keyword })`. Warning `cache_note` "Results for the same keyword and market are reused for 12 hours." |
| `keywords.metrics_refresh.run` | `keywords.metrics_refresh` | `{}` | true | One line per market with stale keywords (metrics missing or older than 7 days, `repo.staleMarkets`): Labs → "<n> keywords in <Country> (<b> request(s))" totalUsd = Σ over batches `labs.keywordOverview({ keywords: batch })`; Ads → same label, b × `keywords.adsSearchVolume({})`. Units `stale`, `fresh`. Blocked: `nothing_to_refresh` "Every saved keyword was updated in the last 7 days."; `refresh_running` "Keyword stats are already updating." (active job with `singleActiveKey`). |
| `keywords.clustering.run` | `keywords.clustering` | `{ savedKeywordIds: z.array(z.uuid()).min(1).max(500) }` | true | "AI topic grouping for <n> keywords" = `estimateLlmUsd(model, estimateClusterPromptChars(rows) + 4000, 8000, env)` (`model` = F01 helper model). Blocked: `too_few_keywords` "Select at least 10 keywords to group into topics." (fewer than 10 of the ids belong to the workspace). |

Quotes are F09 `PriceQuote`s; `priceVersion` comes from F03. Each paid route calls `requireApprovedPrice(key, ctx, input, body.maxUsd)` before reserving anything and passes `approvedMaxUsd` as `maxUsd` to every metered call.

#### 6.2.6 Tools for F22 (`src/lib/keywords/tools.ts`)

Same shape as F07 §6.2.8 (`name, description, input, output, handler`); F22 registers them.

```ts
export const listSavedKeywordsTool = {
  name: "list_saved_keywords",
  description: "List this workspace's saved keywords with volume, CPC, difficulty, intent and tags. Filter by tag names or text. Free.",
  input: z.strictObject({ tagNames: z.array(z.string().min(1).max(64)).max(20).optional(), search: z.string().max(200).optional(),
    sort: z.enum(["searchVolume","keywordDifficulty","cpc","keyword","fetchedAt"]).default("searchVolume"), limit: z.int().min(1).max(250).default(100) }),
  output: z.looseObject({ rows: z.array(z.looseObject({})), totalCount: z.int() }),
  handler: async (ctx: { admin: SupabaseClient; brand: WorkspaceBrand; userId: string }, input) => …,
};
export const saveKeywordsTool = {
  name: "save_keywords",
  description: "Save keywords to this workspace's list, optionally adding tags (append only). Free. Ask the user before tagging broadly.",
  input: z.strictObject({ keywords: z.array(z.string().min(1).max(200)).min(1).max(100), tags: z.array(z.string().min(1).max(64)).max(5).optional(),
    locationCode: z.int().positive().optional() }),
  output: z.looseObject({ savedKeywordIds: z.array(z.string()), created: z.int() }),
  handler: async (ctx, input) => …,
};
export const researchKeywordsTool = {
  name: "research_keywords",
  description: "Buy keyword ideas for one seed keyword in one country (DataForSEO). Paid: call the price estimate first and pass the approved maxUsd. Results are cached for 24 hours.",
  input: z.strictObject({ keyword: z.string().min(1).max(200), locationCode: z.int().positive().optional(), resultLimit: z.union([z.literal(150), z.literal(300), z.literal(500)]).default(150), maxUsd: z.number().positive().max(10) }),
  output: z.looseObject({ rows: z.array(z.looseObject({})), source: z.string(), cached: z.boolean() }),
  handler: async (ctx, input) => …,   // same code path as the research route, mode "auto", requestId = crypto.randomUUID()
};
```

### 6.3 Jobs

Registered in `src/lib/keywords/jobs.ts`; step presets from F01 `stepConfigs.ts`.

**`keywords.refresh_metrics`** (`defineJob`, `payloadSchema = z.strictObject({ approvedMaxUsd: z.number().positive(), requestedBy: z.uuid() })`, `pollAfterSeconds: 5`, `deadlineSeconds: 3600`). Enqueued by the refresh route with `singleActiveKey = "keywords.refresh:" + brandKey`, `trigger: "manual"`, `createdBy`.

| Step | Preset | Does | Output |
|---|---|---|---|
| `plan` | `DB_STEP` | `startedAt = new Date().toISOString()`; `before = startedAt − 7 days`; `repo.staleMarkets(brandKey, before, startedAt)` → per market `{ locationCode, languageCode, stale, fresh }` counting saved keywords created before `startedAt` whose metrics are missing or have `fetched_at < before` **or** `fetched_at >= startedAt` ("stale at start", so the set stays stable while batches update it). | `{ startedAt, markets: [{ locationCode, languageCode, stale, batches }], fresh }` |
| `batch:<loc>:<lang>:<i>` (one per batch) | `SINGLE_ATTEMPT` (`billed: true`, retries 0, 120 s) | Re-reads the i-th slice (`offset = i × 700`, `limit 700`, ordered by keyword) of the stale-at-start set; `fetchKeywordMetricsForList({ labs, ads }, { keywords, locationCode, languageCode, call: (tag) => ({ brandKey, feature: "keywords.metrics_refresh", idempotencyKey: jobStepKey(ctx, "batch:<loc>:<lang>:<i>") + ":" + tag, maxUsd: approvedMaxUsd, jobId }) })`; then `upsertKeywordMetrics` (its own 3 in-process attempts) inside the same step so the bought data is stored before the step completes. | `{ requested: n, updated: m, estimateUsd }` |
| `log` | `DB_STEP` | `appendResearch(admin, { brandKey, kind: "keywords.metrics_refresh", summary: "Updated stats for <m> saved keywords.", jobId, author: "user", actorUserId: requestedBy })`. | — |

Before each batch the handler sums the batch estimates already completed; if that sum plus the next batch's estimate exceeds `approvedMaxUsd`, it stops and finishes `partial` with `result.stoppedFor = "over_approved_max"`. A `StepFailedError` from a batch is caught: the job continues with the next batch and finishes `partial`. `progress(done, total, "Updating keyword stats")` after every batch. Result: `{ updated, requested, skippedFresh, failedBatches, totalBatches }`; status `completed` when `failedBatches = 0`.

**`keywords.cluster`** (`payloadSchema = z.strictObject({ savedKeywordIds: z.array(z.uuid()).min(10).max(500), approvedMaxUsd: z.number().positive(), requestedBy: z.uuid() })`, `pollAfterSeconds: 3`, `deadlineSeconds: 600`). `singleActiveKey = "keywords.cluster:" + brandKey`.

| Step | Preset | Does | Output |
|---|---|---|---|
| `cluster` | `LONG_PAID_STEP` (`billed`, retries 0, 220 s) | Read the keywords (id, keyword, volume, difficulty, intent) filtered by `brand_key` in id order; read memory with F07 `getProjectContext` and `renderProjectContextMarkdown` truncated to 3,500 characters (empty when F07 has nothing); `llmObject({ brandKey, feature: "keywords.clustering", schema: clusterOutputSchema, system: CLUSTER_SYSTEM, prompt: buildClusterPrompt(rows, context), maxUsd: approvedMaxUsd, idempotencyKey: jobStepKey(ctx, "cluster"), maxOutputTokens: 8000, timeoutMs: 180000 })`; `validateClusters`. | `{ clusters: [{ name, intent, priority, targetPage, rationale, savedKeywordIds }], unsorted: string[], model, usd }` (≤ 64 KB: ids only) |
| `log` | `DB_STEP` | `appendResearch(kind "keywords.clustering", summary "Grouped <n> keywords into <k> topics.")`. | — |

`clusterOutputSchema = z.strictObject({ clusters: z.array(z.strictObject({ name: z.string().min(1).max(64), intent: z.enum(["informational","commercial","transactional","navigational","mixed"]), priority: z.enum(["high","medium","low"]), targetPage: z.string().max(300).nullable(), rationale: z.string().max(300), keywordIndexes: z.array(z.int().min(0)).min(1) })).min(1).max(60) })`. The prompt lists keywords as `<index> | <keyword> | vol <n or "unknown"> | kd <n or "unknown"> | <intent>`. `CLUSTER_SYSTEM` (exact): "You group search keywords into page-level topics for one website. Put keywords together only when one page could satisfy all of them: same searcher intent and buyer stage. Similar words do not guarantee the same topic. Name each topic in 2–5 plain words. Use every keyword index exactly once. If a page from the site context fits a topic, give its URL as targetPage; otherwise use null. Do not invent volumes." `validateClusters`: indexes outside `[0, n)` and repeats after their first use are dropped; empty clusters are removed; unassigned indexes go to `unsorted`; names are trimmed, whitespace-collapsed and de-duplicated case-insensitively by appending " (2)". With fewer than 10 rows the route refuses before enqueueing (OpenSEO guardrail).

**`keywords.metrics_retention`** (`definePeriodic`, every 86,400 s): `rpc("prune_keyword_metrics", { p_before: now − 400 days, p_limit: 5000 })`; logs `[keywords.retention] pruned=N`. Free work.

Job status is read through F01 `GET /api/customer/jobs/[jobId]?brand_key=` and F05 `useJobStatus`.

### 6.4 Provider calls and cost

| Use | Endpoint | Body | Response used | Estimator (F03 `src/lib/pricing/dataforseo.ts`) | Cache | Spend feature | Fixtures (`tests/fixtures/f13/`) |
|---|---|---|---|---|---|---|---|
| Phrase-match ideas | `POST /v3/dataforseo_labs/google/keyword_suggestions/live` | §2 item 6 | `result[0].items[]` | `keywords.suggestions` = (0.012 + 0.00012 × limit) × (2 if clickstream) | `keywords.research` v1, 24 h, global | `keywords.research` | `labs-keyword-suggestions.json` |
| Category ideas | `POST /v3/dataforseo_labs/google/keyword_ideas/live` | §2 item 6 | `result[0].items[]` | `keywords.ideas` (same formula) | same entry | `keywords.research` | `labs-keyword-ideas.json` |
| Related fallback | `POST /v3/dataforseo_labs/google/related_keywords/live` | depth 3 | `result[0].items[].keyword_data` | `keywords.related` | same entry | `keywords.research` | `labs-related-keywords.json` |
| Ads-country ideas | `POST /v3/keywords_data/google_ads/keywords_for_keywords/live` | `keywords:[seed], location_code, language_code, sort_by` | `result[]` | `keywords.adsIdeas` = 0.09 | same entry | `keywords.research` | `ads-keywords-for-keywords.json` |
| Local volume | `POST /v3/keywords_data/google_ads/search_volume/live` | `keywords[] (Ads-valid only), location_name, language_code` | `result[]` | `keywords.adsSearchVolume` = 0.09 | local key in the same namespace | `keywords.research` | `ads-search-volume-local.json` |
| Metrics refresh | `POST /v3/dataforseo_labs/google/keyword_overview/live` (Labs) or `…/google_ads/search_volume/live` (Ads) | ≤ 700 keywords | `result[0].items[]` / `result[]` | `labs.keywordOverview` = 0.012 + 0.00012 × n; Ads 0.09 per batch | stored in `keyword_metrics` (7-day freshness) | `keywords.metrics_refresh` | `labs-keyword-overview.json`, `ads-search-volume.json` |
| SERP analysis | `POST /v3/serp/google/organic/live/advanced` (F02 `fetchLiveSerp`) | `keyword, location_code\|location_name, language_code, device desktop, os windows, depth 20\|100` — **never** `load_async_ai_overview` | `result[0].items[]` where `type === "organic"` | `serp.live` = 0.002 + 0.0015 × (pages − 1), × 5 with a search operator | `keywords.serp` v1, 12 h, global, per depth | `keywords.serp` | `serp-organic-live.json` (organic + one `ai_overview` + one `people_also_ask` item), `serp-organic-empty.json` (40501, cost 0.002) |
| Area registry (P8) | `GET /v3/serp/google/locations/{iso}` | — | `result[]` (location_code, location_name, location_type) | free | `dataforseo.serp_locations` v1, 30 days, global | none | `serp-locations-in.json` (20 rows) |
| Topic grouping | OpenRouter via F01 `llmObject` | system + prompt | structured object | F01 `estimateLlmUsd` | none | `keywords.clustering` | `llm-cluster.json` |
| Error shapes | — | — | — | — | — | — | `labs-invalid-field.json` (40501 Invalid Field, cost 0), `labs-balance-40200.json` |

**Worked example** (Offcult, India, "oversized t shirt", defaults): suggestions 0.012 + 75 × 0.00012 = $0.021; ideas $0.021; related fallback 0.012 + 150 × 0.00012 = $0.030; SERP top 20 $0.0035. Quote total **$0.0755**, expected $0.0455. A repeat within 24 h from any workspace costs $0.

**Cache scope decision.** Keyword research results, SERP snapshots and `keyword_metrics` are **global**: they are public market data that does not depend on who asks, so two workspaces researching the same seed and market pay once per TTL (OpenSEO keys per organisation and project, `research.ts:215-228`, so its tenants pay twice). The trade-off: a request that returns instantly at $0 tells a workspace that someone researched the same seed, market and options in the last 24 hours (never who); and a bad provider answer is shared until it expires, which we limit by never caching empty results and validating every cached value with its schema. Everything tenant-specific stays **workspace** scoped or tenant-owned: saved keywords, tags, the research log, clustering proposals (no cache), and F14/F16 lookups of chosen domains (their specs explain why).

**Fixtures** are synthetic JSON shaped like DataForSEO's public documentation: no account ids, task ids replaced by `"00000000-0000-0000-0000-000000000000"`, costs set to the documented prices. They are never recorded in CI. If the owner wants a real shape, `scripts/qa/check-f13-live.mjs --record <dir outside the repo>` writes trimmed responses that a developer copies after removing ids.

### 6.5 API routes

All routes: `src/app/api/customer/keywords/**/route.ts`; `requireWorkspace(request)` (brand from `?brand_key=`, F05 `withBrand`); `isFeatureEnabled("keyword_research", brandKey)` false → `AppError(404, "feature_unavailable", "This page is not available for your workspace yet.")`; bodies `z.strictObject` (unknown fields → `400 invalid_request`); responses `z.looseObject`; `toErrorResponse`; `Cache-Control: no-store`; members and owners. Contracts in `src/lib/keywords/keywords.contract.ts`. Common error codes on every route: `invalid_request`, `unauthenticated`, `cross_site`, `workspace_not_found`, `membership_unavailable`, `auth_not_configured`, `storage_unavailable`, `feature_unavailable`, `internal_error`. Paid routes add `feature_disabled`, `daily_cap`, `workspace_cap`, `over_approved_max`, `spend_unavailable`, `duplicate_paid_call`, `approval_required` (research only), `price_changed`, `research_unavailable`, `research_invalid`, `research_not_configured`.

**`POST /api/customer/keywords/research`** — `maxDuration = 60`.

```ts
export const researchBody = z.strictObject({
  keyword: z.string().trim().min(1).max(200),
  locationCode: z.int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  locationName: z.string().trim().min(1).max(200).optional(),
  resultLimit: z.union([z.literal(150), z.literal(300), z.literal(500)]).default(150),
  mode: z.enum(["auto", "related", "suggestions", "ideas"]).default("auto"),
  clickstream: z.boolean().default(false),
  groupKeywords: z.boolean().default(false),
  cacheOnly: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
  requestId: z.uuid(),
});
```

Order: workspace → flag → body → market (`resolveResearchMarket`) → if `cacheOnly`: `peekCached` → `status "ok"` or `status "not_cached"` (no approval, no spend) → `requireApprovedPrice("keywords.research.run", ctx, priceInput, body.maxUsd)` → `recent = findRecentResearch(...)` → `research(...)` (errors through `toResearchError` with code `research_unavailable`, message "Keyword data is unavailable right now. Please retry.") → when fetched: `appendResearch(...)` awaited, failure logged → respond.

Response 200 example:

```json
{ "status": "ok",
  "rows": [ { "keyword": "oversized t shirt", "searchVolume": 74000, "trend": [ { "year": 2026, "month": 9, "searchVolume": 74000 } ],
              "cpc": 0.41, "competition": 1, "keywordDifficulty": 38, "intent": "transactional" } ],
  "source": "blended", "usedFallback": false,
  "market": { "locationCode": 2356, "languageCode": "en", "locationName": null, "provider": "labs", "country": "India" },
  "cached": false, "fetchedAt": "2026-10-21T09:30:00.000Z",
  "recent": null, "provenance": { "gateway": "dataforseo" } }
```

`cacheOnly` miss: `{ "status": "not_cached", "rows": [], "market": { … }, "cached": false, "recent": null, "provenance": { "gateway": "dataforseo" } }`. Additional errors: `409 unknown_location`, `400 invalid_location`.

**`POST /api/customer/keywords/serp`** — `maxDuration = 60`. Body `z.strictObject({ keyword: z.string().trim().min(1).max(200), locationCode?, languageCode?, locationName?, depth: z.union([z.literal(20), z.literal(100)]).default(20), cacheOnly: z.boolean().default(false), maxUsd?, requestId: z.uuid() })`. `requireApprovedPrice("keywords.serp.run", …)` unless `cacheOnly`. Errors through `toResearchError` with `serp_unavailable` "Search results are unavailable right now. Please retry.". Response:

```json
{ "status": "ok", "requestedKeyword": "oversized t shirt", "depth": 20,
  "items": [ { "rank": 1, "title": "Oversized T-Shirts for Men", "url": "https://example.in/oversized", "domain": "example.in",
               "description": "…", "etv": 5120.4, "estimatedPaidTrafficCost": null, "referringDomains": 312, "backlinks": 2210,
               "isNew": false, "rankChange": null } ],
  "cached": true, "fetchedAt": "2026-10-21T09:30:02.000Z", "provenance": { "gateway": "dataforseo" } }
```

Empty crawl: `{ "status": "ok", "items": [], "reason": "no_organic_results", … }`.

**`GET /api/customer/keywords/saved`** — query `z.strictObject({ brand_key: z.string().min(1).max(200), q?: string(≤200), include?: string(≤500), exclude?: string(≤500), minVol?, maxVol?, minCpc?, maxCpc?, minKd?, maxKd? (z.coerce.number().min(0)), tags?: string (comma-separated uuids, ≤ 50), tagNames?: string (comma-separated, ≤ 50), page: z.coerce.number().int().positive().default(1), size: z.coerce.number().pipe(z.union([z.literal(50), z.literal(100), z.literal(250)])).default(50), sort: enum = "fetchedAt", order: asc|desc = "desc" })`. `include`/`exclude` are split with `parseTerms` (comma or plus). Response:

```json
{ "rows": [ { "id": "4c0e…", "keyword": "oversized t shirt", "locationCode": 2356, "languageCode": "en",
              "createdAt": "2026-10-20T10:00:00Z", "searchVolume": 74000, "cpc": 0.41, "competition": 1,
              "keywordDifficulty": 38, "intent": "transactional", "monthlySearches": [], "fetchedAt": "2026-10-20T09:59:00Z",
              "tags": [ { "id": "9a1…", "name": "Tees", "normalizedName": "tees", "color": null } ] } ],
  "totalCount": 1, "page": 1, "pageSize": 50,
  "tags": [ { "id": "9a1…", "name": "Tees", "normalizedName": "tees", "color": null, "keywordCount": 1 } ] }
```

**`POST /api/customer/keywords/saved`** — body `z.strictObject({ keywords: z.array(z.string().trim().min(1).max(200)).min(1).max(500), locationCode?, languageCode?, tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(), tagMode: z.enum(["append","replace"]).default("append") }).refine(replace ⇒ tags.length > 0, "Replacement tags are required when tagMode is replace.")`. Response `{ "savedKeywordIds": ["…"], "created": 3 }`. Errors `409 saved_keywords_limit`, `409 tag_limit`, `503 keywords_unavailable`. Idempotent: repeated keywords return their existing ids.

**`POST /api/customer/keywords/saved/remove`** — `{ savedKeywordIds: z.array(z.uuid()).min(1).max(2000) }` → `{ "deletedCount": 2 }`.

**`POST /api/customer/keywords/saved/tags`** — `{ savedKeywordIds: z.array(z.uuid()).min(1).max(2000), addTags?: z.array(z.string().trim().min(1).max(64)).max(20), removeTagIds?: z.array(z.uuid()).max(50) }` refined "Add or remove at least one tag." → `{ "taggedCount": 2, "addedTags": [ … ], "removedTagIds": [], "removedAssignments": 0 }`. Errors `409 tag_limit`.

**`PATCH /api/customer/keywords/tags/[tagId]`** — `{ name?: z.string().trim().min(1).max(64), color?: z.enum(TAG_COLOR_KEYS).nullable() }` refined "Provide a name or color to update." → `{ "tag": { "id": "…", "name": "Tees", "normalizedName": "tees", "color": "sky" } }`. Errors `404 tag_not_found`, `409 tag_name_taken`.

**`DELETE /api/customer/keywords/tags/[tagId]`** → `{ "deleted": true }`. Errors `404 tag_not_found`, `409 tag_in_use`.

**`GET /api/customer/keywords/saved/export`** — the list query without `page`/`size` → `{ "rows": [ … ≤ 5000 ], "totalCount": 5200, "truncated": true }`.

**`POST /api/customer/keywords/saved/refresh`** — `{ maxUsd: z.number().positive().max(1000).optional() }` → `requireApprovedPrice("keywords.metrics_refresh.run", ctx, {}, maxUsd)` → `enqueueJob("keywords.refresh_metrics", { approvedMaxUsd, requestedBy }, { brandKey, singleActiveKey, trigger: "manual", createdBy })` → `recordApproval(… subject { kind: "job", id: jobId })` → `202 { "jobId": "…", "status": "queued", "pollAfterSeconds": 5 }`. Errors `409 nothing_to_refresh`, `409 refresh_running`, `409 job_already_running`, `400 approval_required`, `409 price_changed`.

**`POST /api/customer/keywords/cluster`** — flag `keyword_clustering` (404 when off); `{ savedKeywordIds: z.array(z.uuid()).min(10).max(500), maxUsd? }` → price approval → enqueue `keywords.cluster` → `202 { jobId, status: "queued", pollAfterSeconds: 3 }`. Errors `409 too_few_keywords`, `409 job_already_running`, price codes.

**`POST /api/customer/keywords/cluster/apply`** — `{ jobId: z.uuid(), clusters: z.array(z.strictObject({ name: z.string().trim().min(1).max(64), savedKeywordIds: z.array(z.uuid()).min(1).max(500) })).min(1).max(60) }`. Reads the job (must be kind `keywords.cluster`, same `brand_key`, status `completed`; else `404 job_not_found` / `409 job_not_ready`); every id must appear in that job's proposal (`400 invalid_request` otherwise). For each cluster, `update_saved_keyword_tags(add [name])`. → `{ "taggedCount": 148, "tags": [ { "id": "…", "name": "Oversized tees" } ] }`. Errors `409 tag_limit`.

**`POST /api/customer/keywords/track-question`** — needs `question_curation` on (else `404 feature_unavailable`); `{ keyword: string(1..200), text: z.string().trim().min(2).max(1500), topic: z.string().trim().min(1).max(100).optional(), locationCode: z.int().positive(), languageCode: z.string().min(2).max(8) }` → `{ "question": { "id": "…", "text": "Which brands make the best oversized t-shirts in India?", "status": "active", "topic": "General" }, "created": true, "revived": false }`. Errors from F08: `409 question_limit`, `409 topic_limit`, `409 question_duplicate`, `503 questions_unavailable`.

**`GET /api/customer/keywords/locations`** (P8) — query `{ brand_key, country: /^[a-z]{2}$/, q: string(1..100) }` → `{ "locations": [ { "locationName": "Mumbai,Maharashtra,India", "displayLabel": "Mumbai, Maharashtra, India", "locationType": "City" } ] }` (≤ 20, `rankSerpLocations`). Free; error `503 locations_unavailable` "Locations could not be loaded. Please retry.". Gate: available when **any** of `keyword_research`, `rank_tracking` or `local_seo` is enabled for the workspace (F15 and F17 reuse this route); otherwise 404 `feature_unavailable`.

### 6.6 UI

Built from F04 (`PageHeader`, `PageFrame`, `EmptyState`, `ErrorState`, `QueryError`, `SkeletonPresets`, `FormDialog`, `ConfirmDialog`, `HelpLabel`, `LocationSelect`, `SegmentedToggle`, `ChartAxes`, `ui/*`), F05 (`fetchJson`, `withBrand`, `keys`, `useUrlSearchState`, `useDebouncedFilters`, `useLocalPref`, `useJobStatus`, search tabs, `RecentSearches`, `useTimestampedSearchHistory`), F06 (`DataTable`, `DataTableToolbar`, `DataTableFilterPanel`, `TableBulkActionBar`, `TablePagination`, `SortableHeader`, `ScoreBadge`, `ExportMenu`, `useExportRows`) and F09 (`usePriceQuote`, `CostReviewDialog`). Money via F03 `formatUsd`. Unknown numbers render "—" (never 0).

#### 6.6.1 Navigation and flags

`src/components/app/navigation/items.ts`: group `research` → `{ id: "keywords", label: "Keywords", href: "/portal/keywords", icon: Search, flag: "keyword_research" }`; group `site` → `{ id: "saved-keywords", label: "Saved Keywords", href: "/portal/keywords/saved", icon: Bookmark, flag: "keyword_research" }`. `src/lib/features/clientFeatures.ts` appends `"keyword_research"`, `"keyword_clustering"`. `src/lib/theme/theme.ts` needs no change (`/portal` is an app surface). Query keys added to `src/lib/query/keys.ts`: `keywordResearch(brandKey, inputKey)`, `keywordSerp(brandKey, inputKey)`, `savedKeywords(brandKey, inputKey)`, `keywordLocations(brandKey, iso, q)`.

Flag off (`features.keyword_research !== true`): both pages render `EmptyState` title "This page is not available for your workspace yet." description "Ask Perceev support to turn on keyword research." and nothing else.

#### 6.6.2 `/portal/keywords` (`src/app/portal/keywords/page.tsx` → `src/components/portal/keywords/research/KeywordResearchPage.tsx`)

PORT of OpenSEO's research page (§2 items 20–24). URL state (`useUrlSearchState` with `keywordsSearchSchema` ported from `schemas/keywords.ts:229-257`): `q`, `loc`, `locName`, `kLimit`, `mode`, `cs`, `grp`, `sort` (default `searchVolume`), `order` (default `desc`). Table filters live in local storage per workspace (`useLocalPref("keyword-filters", filterValuesSchema, EMPTY_FILTERS, { brandKey })`). Preferred country per workspace: `useLocalPref("keyword-location", z.int(), workspaceMarket(brand).locationCode, { brandKey })`. Search tabs: `useSearchTabs("keywords", brandKey, parseKeywordTabInput)` (label `keyword` or `keyword · City`). Recent searches: `useTimestampedSearchHistory("keywords", brandKey)`.

Layout (desktop ≥ xl): `PageHeader` title "Keyword Research", description "Discover keyword ideas, search demand, and ranking opportunities.", back button "Recent searches" once searched → search card → tab strip → results grid: left 3/5 keywords (overview strip + table), right 2/5 "Search Trends" card + "SERP Analysis" card. `md`–`xl`: SERP panel above the table. Below `md`: `Tabs` "Keywords ({n})" / "SERP Analysis"; trend chart and overview strip hidden (theirs).

Search card: textarea placeholder "Enter a keyword" (`aria-label` "Keywords"; Enter submits; Shift+Enter new line; up to 5 lines → one tab each); `LocationSelect options={LOCATION_OPTIONS}`; (P8) city combobox placeholder "City (optional)" with title "Get search volume for one city, county, or region. Leave empty for the whole country."; "Options" button → `FormDialog` "Search options" with "Results" (150/300/500 results), "Keyword source" (Auto, Phrase match, Category ideas, People also search for), "Clickstream-refined volumes" (help "Google reports one combined volume for similar keywords. This estimates each keyword's own volume. Costs 2x."), "Group keywords"; Ads countries disable the last three with "Not available for countries served from Google Ads data."; primary `PricedActionButton` label "Search" (action `keywords.research.run`, input from the form for the first keyword). Under the card: Ads info `Alert` "Keyword data for this country comes from Google Ads — search volume, CPC, and trends are available, but difficulty and intent are not."; with a city selected (P8) the muted note "Local volume adds up to {formatUsd(adsSearchVolume estimate)} per search."; quote warnings (`recent_research`, `cache_note`) as muted lines.

States:

| State | Shown |
|---|---|
| No `q` | `RecentSearches` (title = keyword, subtitle = country or city) with empty title "Enter a keyword to get started" and description "Search for any keyword to see volume, difficulty, CPC, and related keyword ideas." |
| `q` in URL, `cacheOnly` request pending | `KeywordResearchLoadingState` (PORT; skeleton mirrors the layout) |
| `q` in URL, not cached | `Card`: title "Results for “{q}” are not loaded", body "Running this search buys fresh keyword data.", `PricedActionButton` "Run search" |
| Running a paid search | loading skeleton; the button shows a spinner and "Searching…" |
| Error | `ErrorState` with the API message and "Retry" (no Retry for `unknown_location`, `research_invalid`); spend refusals render F05 `SpendRefusedError` |
| Price changed (409) | `CostReviewDialog` in its "The price changed" state (F09 copy) |
| No rows | `EmptyState` icon `Globe`, title "Not enough keyword data for this query yet", description "We could not find keyword opportunities for “{seed}” in {country}." |
| Results | toolbar: filter toggle, count "Showing {n} keywords" / "Showing {n} of {total} keywords" / "{k} selected", `ExportMenu` (sheets, csv); approximate-match `Alert` "No exact match for “{seed}”. Showing closest related keywords instead." (non-auto modes); table columns select, Keyword (child rows of a shared-volume family indented, title "{kw}: matching reported volume with {parent}. Shared volumes may overlap."), Volume, CPC (help "Cost per click in USD."), Comp. (help "Paid-search competition from Google Ads (0-1): higher means more advertisers bidding."), Score (help "Organic ranking difficulty (0-100): higher means harder to reach Google's top 10."), Intent badge; row click selects the keyword for the overview strip, trend and SERP; pagination 50/100/300/500 keeping families together |
| Filters panel | "Include Terms" (placeholder "audit, checker, template"), "Exclude Terms" ("jobs, salary, course"), ranges "Search Volume", "CPC (USD)", "Difficulty", intent multi-select; filtered-empty → F06 "No results match these filters" with "Clear filters" |
| Bulk bar (selection) | "Save Keywords", export menu (Export to Sheets / Export CSV), "Clear" |
| Save dialog | `FormDialog` title "Save {n} keywords"; body "These keywords will be saved to this workspace."; local search adds "Saved keywords show national metrics. The local volume for {area} is not saved."; buttons "Cancel", "Save" (pending spinner); success toast "Saved {n} keywords" |
| Overview strip | keyword, `ScoreBadge`, "Vol", "CPC" (`$0.41`), "Comp", intent badge; (P7) button "Track as a question" when `features.question_curation === true` |
| Search Trends card | "Search Trends" + range label "Oct 2025 - Sep 2026" (or "Last 12 available months"); hidden when the trend is empty |
| SERP card | title "SERP Analysis: {keyword}", subtitle "{n} organic results"; muted line "Each new keyword's results cost up to {formatUsd(serp quote)}. Results are reused for 12 hours."; empty "No SERP details available for this keyword yet." + "Try clicking another keyword to load data."; not loaded (cache-only miss before live mode) "Google results for “{keyword}” are not loaded." + `PricedActionButton` "Load results"; pagination 10 per page; next past loaded rows reads "Load top 100 · up to {price}"; deep-crawl failure → "Show top 20"; error → "Retry" |

Paid-call rules in the client (PORT of `useKeywordSerpAnalysis.ts:62-70`, `useKeywordResearchData.ts:147-162`): research and SERP queries use `retry: false`, `refetchOnWindowFocus: false`, `refetchOnReconnect: false`; a new `requestId` (`crypto.randomUUID()`) per execution. **Live mode:** the page starts with `liveMode = false`; every research and SERP query is then sent with `cacheOnly: true`, and a miss shows its not-loaded state with its own priced button. The first click on any priced button sets `liveMode = true` for this page instance (reset when the workspace changes); from then on row clicks and SERP paging run directly with `cacheOnly: false` and `maxUsd` from their shown quote. The seed's SERP is requested after a successful search with `maxUsd` = the SERP line of the research quote. Loading a URL therefore never spends.

#### 6.6.3 `/portal/keywords/saved` (`src/app/portal/keywords/saved/page.tsx` → `src/components/portal/keywords/saved/SavedKeywordsPage.tsx`)

PORT of `saved.tsx` and `client/features/saved-keywords/*`. URL state (`useUrlSearchState`): `include`, `exclude`, `minVol`, `maxVol`, `minCpc`, `maxCpc`, `minKd`, `maxKd`, `tags` (comma-separated ids), `sort` (default `fetchedAt`), `order` (default `desc`), `page` (1), `size` (50); filter drafts reach the URL after 350 ms through `useDebouncedFilters` (page reset). Query `keys.savedKeywords(brandKey, stableStringify(query))` with `placeholderData: keepPreviousData` (workspace-scoped key, so a workspace switch never shows the old list).

| State | Shown |
|---|---|
| Header | `PageHeader` title "Saved Keywords", description "Save keyword ideas from research, organize them with tags, and revisit when you're ready to act."; actions "Update keyword stats" (outline, `RefreshCw`; disabled when 0 keywords or a refresh runs) and `ExportMenu` (sheets, csv) for the filtered list |
| Loading | `SkeletonTableRows` inside the table card |
| Error, no data | `QueryError` "Failed to load saved keywords." with Retry; the table is not rendered (theirs, `saved.tsx:334-336`) |
| Error with data | error card above the stale table |
| Empty (no filters) | `EmptyState` "No saved keywords yet" / "Use Keyword Research to find and save keywords." + button "Open Keyword Research" → `/portal/keywords` |
| Filtered empty | F06 filtered empty with "Clear filters" (clears filters and tags) |
| Table | select, Keyword, Volume, CPC (`$0.41`), Competition, Difficulty (`ScoreBadge`), Intent, Tags (chips; "—" when none), Last Fetched (local date; "—" when never), row menu "Track as a question" (P7, flag), "Copy keyword", "Delete"; pagination 50/100/250 |
| Toolbar | filter toggle with count; tag filter popover (search, checkboxes with counts, manage row: rename inline, colour swatches, delete with `InlineConfirm`) |
| Bulk bar | "Tag", export menu ("Copy keywords", "Export to Sheets", "Export CSV"), (P6) "Group into topics" (disabled with tooltip "Select at least 10 keywords." under 10), "Delete" (danger), "Clear" |
| Delete confirm | `ConfirmDialog` "Delete keywords?" body "This will permanently delete {n} saved keyword(s)." button "Delete {n} keyword(s)" (destructive); toast "{n} keyword(s) removed" |
| Tag dialog | PORT `SavedKeywordsBulkTagsModal`: title "Update tags", description "Changes apply to {n} selected keyword(s).", segmented "Add tags ({k})" / "Remove tags ({k})", search "Search or create…", "Create “{name}”", empty "No tags yet. Type a name above to create one." / "No tags match that search.", remove mode "{k} tag(s) will be removed", buttons "Cancel" / "Apply"; toast "Updated tags for {n} keyword(s)"; `409 tag_limit` → inline `Alert` with the API message |
| Tag manage toasts | "Tag updated", "Tag deleted", error fallback "Could not delete tag. Detach it from all keywords and try again." |
| Refresh | `CostReviewDialog` title "Update keyword stats", confirm "Update stats", pending "Starting…", detail "Fetches new volume, difficulty, and CPC for saved keywords not updated in the last 7 days. Keywords updated recently are skipped for free."; while running the header shows "Updating keyword stats… {done} of {total} requests" (`aria-live="polite"`); on finish toast "Updated stats for {updated} keyword(s)" plus " · {skippedFresh} already up to date" when > 0; `partial` → warning toast "Updated {updated} keywords. Some requests failed; try again later." |

#### 6.6.4 `PricedActionButton` (`src/components/app/cost/PricedActionButton.tsx`, P1)

```ts
export function PricedActionButton(p: {
  label: string; pendingLabel: string; brandKey: string; action: string; input: unknown;
  enabled?: boolean; pending: boolean; onRun(maxUsd: number): void;
  dialogThresholdUsd?: number;     // default 0.25
  alwaysConfirm?: boolean;         // default false; true forces CostReviewDialog (actions with requireApproval)
  dialogTitle: string; confirmLabel: string;
  variant?: "default" | "outline"; className?: string;
}): JSX.Element;
```

Uses F09 `usePriceQuote({ brandKey, action, input }, { enabled })` with `input` debounced 350 ms. Label "{label} · up to {formatUsd(totalUsd)}" when ready; "{label}" with a spinner and disabled while the first quote loads; disabled with the blocked message below (`text-destructive text-xs`) when `blocked`; disabled with "Price unavailable. Retry" link when the quote fails. A click calls `onRun(quote.totalUsd)` directly when `alwaysConfirm` is false, `totalUsd ≤ dialogThresholdUsd` and the quote has no warning other than `cache_note`/`recent_research`; otherwise it opens F09's `CostReviewDialog` (title `dialogTitle`, confirm `confirmLabel`). A `409 price_changed` from the run is handed to the dialog by the caller (`priceChanged` prop of `CostReviewDialog`).

#### 6.6.5 Group into topics (P6, `src/components/portal/keywords/saved/GroupTopicsDialog.tsx`)

Bulk action → `CostReviewDialog` (title "Group into topics", confirm "Group keywords", detail "One AI call groups the selected keywords into page-level topics. Nothing is tagged until you apply it.") → `202` → dialog (`Dialog fullScreenOnMobile`) polls `useJobStatus`:

| State | Content |
|---|---|
| queued/running | `Spinner` + "Grouping {n} keywords into topics…" |
| failed | `Alert` destructive "Grouping failed. You were charged only for the AI call that ran." + "Close" |
| completed | one row per topic: checkbox (checked), editable name `Input` (`aria-label` "Topic name"), intent badge, priority badge, "{k} keywords" with an expand toggle listing them, target page (link) or "New page"; an "Unsorted ({u})" row, unchecked by default; note "Tags are added. Existing tags stay." ; buttons "Cancel" / "Apply tags to {t} topics" |
| applying | primary shows spinner "Applying…" |
| done | toast "Tagged {n} keywords in {t} topics"; dialog closes; list refreshes |

#### 6.6.6 Track as a question (P7, `src/components/portal/keywords/TrackQuestionDialog.tsx`)

`FormDialog` title "Track as a question"; field "Question" (textarea prefilled with the keyword, helper "Write it the way a buyer would ask an AI assistant, for example “Which brands make the best oversized t-shirts in India?”"); optional "Topic"; buttons "Cancel" / "Add question". Results: created → toast "Question added. Approve your panel in Questions to start tracking it." with action "Open Questions" → `/portal/measurement`; existing → toast "This question is already in your list."; revived → toast "Question restored from your archive."; `question_limit`/`topic_limit` → inline `Alert` with the API message.

#### 6.6.7 Accessibility and phone

Search textarea and every icon button have labels; sortable headers expose `aria-sort` (F06); the SERP and trend panels are `section`s with headings; price updates announce through `aria-live="polite"`. At 375 px: one column, tabs for Keywords/SERP, tables scroll inside their card, the bulk bar is fixed above the safe area, no page-level horizontal scroll.

### 6.7 Permissions, privacy, observability

- Members and owners may research, save, tag, export, refresh, group and track. No owner-only actions.
- Logs (never keyword text, never provider bodies): `[keywords] research { brandKey, provider, mode, rows, cached, ms }`, `[keywords] serp { brandKey, depth, items, cached }`, `[keywords] metrics upsert failed { rows }`, job logs from F01. `keyword_metrics` holds only public provider data.
- PostHog events (names registered in F26's `src/lib/telemetry/events.ts`; until F26 merges they go through `trackKeywordEvent` in `src/components/portal/keywords/telemetry.ts`, a no-op sink that F26 wires with `setKeywordEventTracker`): `keyword_research:search_complete { location_code, search_mode, clickstream, local, result_count, cached }`, `keyword_research:serp_open`, `keyword:save { source_feature: "keyword_research", keyword_count }`, `saved_keywords:bulk_remove { count }`, `saved_keywords:bulk_tag { count }`, `saved_keywords:refresh_start { stale }`, `keywords:cluster_apply { topics, keywords }`, `keywords:track_question { created }`. No keyword text in any event.

### Deviations from conventions

1. **`keyword_metrics` has no `brand_key`** (conventions §6.8). It holds public market data shared by all workspaces so nobody pays twice. It has RLS enabled with no customer policy and no `authenticated` grant; routes read it only joined onto the caller's own saved keywords. Clients can never write it (the save route rejects metrics).
2. **Inline price approval** for interactive lookups (`PricedActionButton`): a quote at or under $0.25 is approved by clicking a button that shows the price, instead of always opening `CostReviewDialog` (F09 §6.2.5). F08's question research uses the same inline pattern. Bulk and job actions always open the dialog.
3. **`cacheOnly` reads**: paid lookup routes also serve free cache-only reads so links and reloads never spend.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/server/lib/dataforseo/labs.ts` (+ `labs.test.ts`) | `src/lib/providers/dataforseo/labs.ts` (+ `.test.ts`) | COPY | zod v4 `z.looseObject`; relative imports; added `createLabsClient` on F02 `meter` with F03 estimators. |
| `openseo:src/server/lib/dataforseo/google-ads.ts` | `src/lib/providers/dataforseo/google-ads.ts` (+ `.test.ts`) | COPY | Added `createGoogleAdsClient`. |
| `openseo:src/server/lib/dataforseo/keyword-metrics.ts` (+ test) | `src/lib/providers/dataforseo/keyword-metrics.ts` (+ `.test.ts`) | PORT | `creditFeature` → per-call `DataforseoCallContext` factory. Five cases ported. |
| `openseo:src/server/lib/dataforseo/filters.ts` | `src/lib/providers/dataforseo/filters.ts` | COPY | `AppError(400, "filters_over_budget")`. |
| `openseo:src/server/lib/dataforseo/researchScopeFilters.ts` (+ test) | `src/lib/providers/dataforseo/researchScopeFilters.ts` (+ `.test.ts`) | COPY | — |
| `openseo:src/server/lib/dataforseo/serp-locations.ts` | `src/lib/providers/dataforseo/serp-locations.ts` | PORT | KV → F01 provider cache (global, 30 days); in-isolate fill coalescing kept via F01 single-flight. |
| `openseo:src/server/lib/domainUtils.ts` | `src/lib/research/target.ts` | PORT | `AppError(400, "invalid_target")`. |
| `openseo:src/server/lib/r2-cache.ts` (cache-if-data and depth guards in `serp.ts:94-137`, `DomainService.ts:66-117`) | `src/lib/research/cache.ts` | PATTERN | `peekCached`, `cachedIf` on F01 `cached`. |
| `openseo:src/shared/researchScope.ts` | `src/shared/researchScope.ts` | COPY | Adds `MAX_DATAFORSEO_FILTER_CONDITIONS`. Requires `tldts` `^7.0.25` (MIT). |
| `openseo:src/shared/keyword-locations.ts` (+ tests) | `src/shared/keyword-locations.ts` (+ `.test.ts`) | COPY | Adds `defaultLocationForHost`, `workspaceMarket`. |
| `openseo:src/shared/saved-keyword-tags.ts` (+ test), `tag-colors.ts` | `src/shared/saved-keyword-tags.ts` (+ `.test.ts`), `src/shared/tag-colors.ts` | COPY | — |
| `openseo:src/shared/serp-location-search.ts` | `src/shared/serp-location-search.ts` | COPY | — |
| `openseo:src/types/keywords.ts`, `openseo:src/client/features/keywords/keywordResearchTypes.ts`, `state/keywordControllerActions.ts:17-41,184-196`, `saved-keywords/savedKeywordsUtils.ts` | `src/shared/keywords.ts` | PORT | Types and export rows in one client-safe module; no `projectId`. |
| `openseo:src/client/features/keywords/{hooks/useKeywordFiltering,groupSharedVolumeRows,utils}.ts`, `page/KeywordResearchPagination.tsx:19-32` (+ tests) | `src/shared/keyword-filtering.ts` (+ `.test.ts`) | PORT | remeda replaced; tests ported. |
| `openseo:src/client/features/saved-keywords/savedKeywordsFilterTypes.ts` | `src/shared/saved-keywords-filters.ts` | COPY | — |
| `openseo:src/server/features/keywords/services/research/helpers.ts`, `selection.ts` (+ test) | `src/lib/keywords/helpers.ts`, `selection.ts` (+ `helpers.test.ts`) | COPY | — |
| `openseo:src/server/features/keywords/services/research/research-data.ts` (+ test) | `src/lib/keywords/researchData.ts` (+ `.test.ts`) | PORT | Clients injected; call contexts. |
| `openseo:src/server/features/keywords/services/research/research.ts` (+ test) | `src/lib/keywords/research.ts` (+ `.test.ts`) | PORT | Global F01 cache via `cachedIf`; metered legs with idempotency keys; `keepAlive` persistence into shared `keyword_metrics`; single seed keyword. |
| `openseo:src/server/features/keywords/services/research/local-volume.ts` | `src/lib/keywords/localVolume.ts` (+ `.test.ts`) | PORT | `AppError(409, "unknown_location")`. |
| `openseo:src/server/features/keywords/services/research/serp.ts` (+ test) | `src/lib/keywords/serp.ts` (+ `.test.ts`) | PORT | Depth in the key plus a depth-100 peek for depth-20 requests (same observable behaviour); empty crawls uncached via `cachedIf`. |
| `openseo:src/server/features/keywords/services/research/saved-keywords.ts` (+ test) | `src/lib/keywords/savedKeywords.ts` (+ `.test.ts`) | PORT | Client metrics dropped; errors as AppError. |
| `openseo:src/server/features/keywords/services/research/refresh-metrics.ts` | `src/lib/keywords/refreshMetrics.ts` | PORT | Becomes job `keywords.refresh_metrics`; skips fresh (7 days); billed single-attempt batch steps. |
| `openseo:src/server/features/keywords/repositories/{KeywordResearchRepository,SavedKeywordTagsRepository}.ts` | `supabase/migrations/102_*.sql`, `src/lib/keywords/repository.ts`, `memoryRepository.ts` | PORT | D1 chunking dropped (Postgres arrays); atomic SQL functions; nulls last. |
| `openseo:src/db/app.schema.ts:90-208` | `supabase/migrations/100_*.sql`, `101_*.sql` | PORT | `project_id` → `brand_key`; composite FKs; `keyword_metrics` shared. |
| `openseo:src/types/schemas/keywords.ts` | `src/lib/keywords/keywords.contract.ts`, `src/lib/pricing/actions/keywords.ts` | PORT | Strict request schemas; single `keyword`; `cacheOnly`, `requestId`, `maxUsd` added. |
| `openseo:src/serverFunctions/keywords.ts`, `serp-locations.ts` | `src/app/api/customer/keywords/**/route.ts` | PORT | Server functions → JSON routes with `requireWorkspace`. |
| `openseo:src/client/features/keywords/**` (page, components, hooks, state) | `src/components/portal/keywords/research/**` | PORT | Next routing, F05 URL state and search tabs, F06 tables, F09 pricing; billing UI replaced by spend refusals. |
| `openseo:src/client/features/saved-keywords/**`, `openseo:src/routes/_app/p/$projectId/saved.tsx` | `src/components/portal/keywords/saved/**` | PORT | Same. |
| `openseo:src/client/components/{ResearchScopeSelect,SearchCard,SerpLocationCombobox}.tsx`, `usePrewarmSerpLocations.ts` | `src/components/app/{ResearchScopeSelect,SearchCard}.tsx`, `src/components/portal/keywords/research/{SerpLocationCombobox,usePrewarmSerpLocations}.tsx` | COPY | — |
| `openseo:.agents/skills/keyword-clustering/SKILL.md` | `src/lib/keywords/clustering.ts` | PATTERN | Ideas only (intent over lexical similarity, < 10 guard, ask before tagging, append-only tags). Not copied text. |

## 8. Implementation plan

### Phase 1 — Research foundation (provider sections and shared primitives)

**Goal:** the metered Labs and Google Ads clients and the research primitives that F13, F14 and F16 build on.

- [x] **P1.T1 Provider sections**
  - [x] **P1.T1.S1** *Files:* `src/lib/providers/dataforseo/labs.ts`, `labs.test.ts`, fixtures `tests/fixtures/f13/labs-*.json`. *Do:* §6.2.1; port `labs.test.ts:10` ("sends ignoreSynonyms … as ignore_synonyms") and add body assertions for related/suggestions/ideas/overview with an injected `fetchImpl` through F02 `core.ts` options; "every entry is priced" walks `createLabsClient({ meter: spyMeter })` and asserts each estimator returns > 0 for `{ limit: 1, keywords: ["x"] }`. *Verify:* `node --test src/lib/providers/dataforseo/labs.test.ts` → pass (F13-AC-01, F13-AC-03).
  - [x] **P1.T1.S2** *Files:* `google-ads.ts`, `google-ads.test.ts`, fixtures `ads-*.json`. *Do:* port; tests for `isAdsKeyword` (81 chars, 11 words, `!`, emoji rejected), truncation to `limit`, `location_name` vs `location_code`. *Verify:* `node --test src/lib/providers/dataforseo/google-ads.test.ts` → pass (F13-AC-01).
  - [x] **P1.T1.S3** *Files:* `keyword-metrics.ts`, `keyword-metrics.test.ts`. *Do:* PORT and translate the five cases of `keyword-metrics.test.ts:18-225` (vitest → `node:test` + `assert`). *Verify:* `node --test src/lib/providers/dataforseo/keyword-metrics.test.ts` → pass (F13-AC-02).
  - [x] **P1.T1.S4** *Files:* `filters.ts`, `researchScopeFilters.ts`, `researchScopeFilters.test.ts`. *Do:* COPY; port the seven cases of `researchScopeFilters.test.ts:24-140`. *Verify:* `node --test src/lib/providers/dataforseo/researchScopeFilters.test.ts` → pass.
- [x] **P1.T2 Shared primitives**
  - [x] **P1.T2.S1** *Files:* `package.json`, `package-lock.json` (add `"tldts": "^7.0.25"`), `src/shared/researchScope.ts`, `src/shared/researchScope.test.ts`, `src/lib/research/target.ts`, `target.test.ts`. *Do:* §6.2.2; tests: `parseResearchTarget("https://www.Example.com/blog/")` → scope `subfolder`, path `/blog`; `example.por` rejected; credentials rejected; `toRelativePath`. *Verify:* `npm ci && node --test src/shared/researchScope.test.ts src/lib/research/target.test.ts` → pass.
  - [x] **P1.T2.S2** *Files:* `src/lib/research/cache.ts`, `cache.test.ts`, `src/lib/research/providerErrors.ts`, `providerErrors.test.ts`. *Do:* §6.2.2 with F01 `cached` injected (memory cache deps). Cases: `peekCached` hit returns value without fetcher; miss returns null and writes nothing; `cachedIf` keep=false returns value, `hit:false`, nothing written, next call fetches again; error mapping table. *Verify:* `node --test src/lib/research/cache.test.ts src/lib/research/providerErrors.test.ts` → pass.
  - [x] **P1.T2.S3** *Files:* `src/shared/keyword-locations.ts`, `keyword-locations.test.ts`, `src/shared/keywords.ts`, `keywords.test.ts`, `src/shared/keyword-filtering.ts`, `keyword-filtering.test.ts`, `src/shared/saved-keyword-tags.ts`, `saved-keyword-tags.test.ts`, `src/shared/tag-colors.ts`, `src/shared/saved-keywords-filters.ts`. *Do:* §6.2.3; port the cited tests verbatim; add `defaultLocationForHost` cases (`offcult.in` → 2356, `shop.example.co.uk` → 2826, `example.com` → 2840) and a CSV row test for `savedKeywordExportRow` + `formatCentsForCsv`. *Verify:* `node --test src/shared/keyword-locations.test.ts src/shared/keywords.test.ts src/shared/keyword-filtering.test.ts src/shared/saved-keyword-tags.test.ts` → pass (F13-AC-17 unit half, F13-AC-23).
  - [x] **P1.T2.S4** *Files:* `src/components/app/ResearchScopeSelect.tsx`, `src/components/app/SearchCard.tsx`, `src/components/app/cost/PricedActionButton.tsx`, `src/shared/location-options.typecheck.ts` (`const a: readonly LocationOption[] = LOCATION_OPTIONS; const b: readonly LocationOption[] = LABS_LOCATION_OPTIONS;`). *Do:* §6.2.2, §6.6.4. *Verify:* `npm run typecheck` → exit 0; `npm run build` → exit 0 (F13-AC-23 type half).
  - [x] **P1.T2.S5** *Files:* `THIRD_PARTY_NOTICES.md`. *Do:* append every P1 COPY/PORT path. *Verify:* `node --test src/lib/platform/thirdPartyNotices.test.mjs` → pass.

**Checkpoint:** full suite `node --import ./src/lib/liveWriteGuardAuto.mjs --test-concurrency=4 --test 'src/**/*.test.mjs' 'src/**/*.test.ts'` passes; `npm run typecheck` and `npm run build` exit 0; F02's `noPrices.test.mjs` and `answerImportGuard.test.mjs` pass. Completes F13-AC-01, 02, 03, 23.

### Phase 2 — Keyword research and SERP API

**Goal:** paid, priced, cached research and SERP routes.

- [x] **P2.T1 Registration**
  - [x] **P2.T1.S1** *Files:* `src/shared/spend-features.ts` (`SPEND_FEATURES` gains `"keywords.research"`, `"keywords.serp"`, `"keywords.metrics_refresh"`, `"keywords.clustering"`; `SPEND_FEATURE_LABELS` gains "Keyword research", "SERP analysis", "Keyword stats refresh", "Keyword topic grouping"), `src/lib/features/names.ts` (`keyword_research: { spend: ["keywords.research"] as const }`, `keyword_clustering: { spend: ["keywords.clustering"] as const }`), `src/lib/features/clientFeatures.ts` (append both), `.env.example` (`FEATURE_KEYWORD_RESEARCH=`, `FEATURE_KEYWORD_RESEARCH_BRANDS=`, `FEATURE_KEYWORD_CLUSTERING=`, `FEATURE_KEYWORD_CLUSTERING_BRANDS=`). *Verify:* `node --test src/lib/features/flags.test.ts src/shared/*.test.ts` → pass; `grep -c "^FEATURE_KEYWORD_RESEARCH=$" .env.example` → 1.
- [x] **P2.T2 Shared metrics table (migration 101)**
  - [x] **P2.T2.S1** *Files:* `supabase/migrations/101_f13_keyword_metrics.sql`. *Do:* §6.1 verbatim. `prune_keyword_metrics` names `saved_keywords` only inside its PL/pgSQL body, which PostgreSQL resolves when it runs; its periodic is registered in P3 after migration 100 exists. *Verify:* in a loopback `_qa` database: `for f in supabase/migrations/*.sql; do psql -X -v ON_ERROR_STOP=1 -f "$f"; done` twice → exit 0 both times.
  - [x] **P2.T2.S2** *Files:* `scripts/setup-supabase.mjs` (the `101_f13_keyword_metrics.sql` entry of §6.1), `tests/customer-uat.sql` (the `keyword_metrics` insert and the `insufficient_privilege` check of the §6.1 block). *Verify:* `node --test src/lib/migrationsRunner.test.mjs src/lib/migrationsLedger.test.mjs` → pass; the CI customer-database commands (`.github/workflows/ci.yml:34-46`) against local Postgres 16 → exit 0.
  - [x] **P2.T2.S3** *Files:* `README.md` (row `101_f13_keyword_metrics` "Shared keyword market metrics (no tenant data) with batch upsert and retention."), `docs/OPERATOR_LEDGER.md` § C (append `101_f13_keyword_metrics`: "apply before deploying F13 phase 2"), `docs/PROD_MIGRATIONS.md` (one bullet: table, service-only grants, two functions). *Verify:* `node --test src/lib/docStatus.test.mjs src/lib/migrationsRunner.test.mjs` → pass.
  - [x] **P2.T2.S4** *Files:* `scripts/qa/check-f13-db.mjs` (pattern `scripts/qa/check-repair-workflows.mjs:13-18`: loopback, DB name ending `_qa`) with group `metrics` (upsert coalesce rules for `labs_ranked`, an empty `monthly_searches` keeps the stored series, duplicate keys in one batch, `authenticated` denied). *Verify:* `node scripts/qa/check-f13-db.mjs --group metrics` → "ok 1 group".
- [x] **P2.T3 Services**
  - [x] **P2.T3.S1** *Files:* `src/lib/keywords/helpers.ts`, `selection.ts`, `helpers.test.ts`, `researchData.ts`, `researchData.test.ts`. *Do:* COPY/PORT; port `helpers.test.ts` and `research-data.test.ts`. *Verify:* `node --test src/lib/keywords/helpers.test.ts src/lib/keywords/researchData.test.ts` → pass.
  - [x] **P2.T3.S2** *Files:* `src/lib/keywords/market.ts`, `metricsStore.ts`, `research.ts`, `research.test.ts`. *Do:* §6.2.4. Tests (fake clients, memory cache, fake `metered` recording holds): port `research.test.ts:63-140` (shared-volume keywords stay filterable through research and cache); auto blend uses `ceil(L/2)` per leg and interleaves; fallback when < 5 non-seed; suggestions rejects while ideas resolves → both settled before the throw; Ads country one call and normalised key; second request from another `brandKey` → zero client calls; empty rows not cached; `upsertMetrics` called through `keepAlive` with `source "labs"` for a fetch and never on a hit. *Verify:* `node --test src/lib/keywords/research.test.ts` → pass (F13-AC-04, 05, 06, 07 unit half).
  - [x] **P2.T3.S3** *Files:* `src/lib/keywords/serp.ts`, `serp.test.ts`, fixtures `serp-organic-live.json`, `serp-organic-empty.json`. *Do:* port the four `serp.test.ts:80-154` cases (local area case lands in P8 as `skip` until then); add: request body has no `load_async_ai_overview` key; `ai_overview`/`people_also_ask` items dropped; `"site:x.com shoes"` reserves 5× (F03 estimator spy). *Verify:* `node --test src/lib/keywords/serp.test.ts` → pass (F13-AC-11).
  - [x] **P2.T3.S4** *Files:* `src/lib/pricing/actions/keywords.ts` (`keywords.research.run`, `keywords.serp.run`), `src/lib/pricing/actions/index.ts` (one import), `src/lib/pricing/actions/keywords.test.ts`. *Do:* §6.2.5; tests: worked example totals $0.0755 and expected $0.0455; clickstream doubles Labs lines; Ads country one $0.09 line plus SERP; `recent_research` warning text from a stubbed `findRecentResearch`. *Verify:* `node --test src/lib/pricing/actions/keywords.test.ts` → pass (F13-AC-08 unit half, F13-AC-10 quote half).
- [x] **P2.T4 Routes**
  - [x] **P2.T4.S1** *Files:* `src/app/api/customer/keywords/research/route.ts`, `src/app/api/customer/keywords/serp/route.ts`, `src/lib/keywords/keywords.contract.ts`. *Do:* §6.5; research-log append via F07 `appendResearch` on a miss. *Verify:* `node --test src/lib/http/routeContract.test.ts` → pass.
  - [x] **P2.T4.S2** *Files:* `src/lib/keywords/keywords.route.test.mjs` (hook pattern of `src/lib/customerRoutes.test.hooks.mjs`, extended to stub `requireWorkspace`, `isFeatureEnabled`, the clients and F09). Cases: flag off → 404 `feature_unavailable`; unknown body field → 400; no `maxUsd` → 400 `approval_required` and zero spend calls; low `maxUsd` → 409 `price_changed`; `cacheOnly` miss → 200 `not_cached` and zero spend calls; hit from another workspace → `cached: true`; provider 40501 invalid field → 422 `research_invalid`; spend refusal passes through. *Verify:* `node --test src/lib/keywords/keywords.route.test.mjs` → pass (F13-AC-06, 08, 09, 22 route half).
  - [x] **P2.T4.S3** *Files:* `src/lib/keywords/tools.ts` (`researchKeywordsTool` only), `tools.test.ts`. *Do:* §6.2.6; test closed input schema and output parse. *Verify:* `node --test src/lib/keywords/tools.test.ts` → pass.
  - [x] **P2.T4.S4** *Files:* `THIRD_PARTY_NOTICES.md`. *Verify:* `node --test src/lib/platform/thirdPartyNotices.test.mjs` → pass.


**Checkpoint:** full suite, typecheck, build; `node scripts/qa/check-f13-db.mjs --group metrics` → "ok 1 group"; CI customer-database job green. Completes F13-AC-04…11 (except the local part of 11), F13-AC-07, and the route half of 22.

### Phase 3 — Saved keywords database and API

**Goal:** saved keywords with tags, list, export and stats refresh.

- [x] **P3.T1 Migrations**
  - [x] **P3.T1.S1** *Files:* `supabase/migrations/100_f13_saved_keywords.sql`, `102_f13_saved_keyword_functions.sql`. *Do:* §6.1 verbatim. *Verify:* in a loopback `_qa` database: `for f in supabase/migrations/*.sql; do psql -X -v ON_ERROR_STOP=1 -f "$f"; done` twice → exit 0 both times (idempotent).
  - [x] **P3.T1.S2** *Files:* `scripts/setup-supabase.mjs` (the `100_…` and `102_…` entries of §6.1). *Verify:* `node --test src/lib/migrationsRunner.test.mjs src/lib/migrationsLedger.test.mjs` → pass.
  - [x] **P3.T1.S3** *Files:* `tests/customer-uat.sql` (the saved-keyword part of the §6.1 block). *Verify:* the CI job's commands (`.github/workflows/ci.yml:34-46`) against a local Postgres 16 → exit 0 (F13-AC-12 RLS half).
  - [x] **P3.T1.S4** *Files:* `README.md` (rows `100_f13_saved_keywords` "Saved keywords, tags and tag assignments per workspace." and `102_f13_saved_keyword_functions` "Atomic save, list, tag and remove functions for saved keywords."), `docs/OPERATOR_LEDGER.md` § C (append both names: "apply 100 and 102 in order before deploying F13 phase 3"), `docs/PROD_MIGRATIONS.md` (one bullet per file). *Verify:* `node --test src/lib/docStatus.test.mjs src/lib/migrationsRunner.test.mjs` → pass.
  - [x] **P3.T1.S5** *Files:* `scripts/qa/check-f13-db.mjs` (extend the P2 harness). Groups: `schema` (objects exist, grants), `rls` (member reads own rows only; `keyword_metrics` denied), `caps` (5,001st keyword and 201st tag roll back), `save` (append/replace, idempotent ids), `list` (each filter, nulls last both directions, tag filter, totals, tag counts), `tags` (add/remove, rename clash 23505, delete `in_use` vs `deleted`), `remove`, `metrics` (from P2), `prune` (old unsaved pruned, saved kept). *Verify:* `node scripts/qa/check-f13-db.mjs` → "ok 9 groups" (F13-AC-12…15 DB half).
- [x] **P3.T2 Services and routes**
  - [x] **P3.T2.S1** *Files:* `src/lib/keywords/repository.ts`, `memoryRepository.ts`, `savedKeywords.ts`, `savedKeywords.test.ts`. *Do:* §6.2.4; port the three cases of `saved-keywords.test.ts:26-101`; add: `metrics` never forwarded; tag name filter with no match → empty without a list call; `tag_in_use` message pluralisation. *Verify:* `node --test src/lib/keywords/savedKeywords.test.ts` → pass (F13-AC-13, 14, 15 unit half).
  - [x] **P3.T2.S2** *Files:* `src/app/api/customer/keywords/saved/route.ts` (GET, POST), `saved/remove/route.ts`, `saved/tags/route.ts`, `saved/export/route.ts`, `tags/[tagId]/route.ts` (PATCH, DELETE); contracts appended to `keywords.contract.ts`. *Verify:* `node --test src/lib/http/routeContract.test.ts` → pass.
  - [x] **P3.T2.S3** *Files:* `src/lib/keywords/refreshMetrics.ts`, `jobs.ts` (`keywords.refresh_metrics` and the periodic `keywords.metrics_retention`), `src/lib/jobs/kinds.ts` (one import), `src/lib/pricing/actions/keywords.ts` (`keywords.metrics_refresh.run`), `src/app/api/customer/keywords/saved/refresh/route.ts`, `refreshMetrics.test.ts`. *Do:* §6.3 with F01 `memoryStore` jobs and spend deps. Tests: only stale keywords requested; batches of 700 per market; step names stable; a failing batch → `partial` and later batches still run; over-approved guard stops; second enqueue → 409; progress calls. *Verify:* `node --test src/lib/keywords/refreshMetrics.test.ts` → pass (F13-AC-16).
  - [x] **P3.T2.S4** *Files:* `src/lib/keywords/keywords.route.test.mjs` (extend). Cases: save rejects `metrics`; workspace B cannot list/tag/remove/export A's ids (empty or 0 counts); `409 tag_in_use`; export `truncated`; refresh `202` shape. *Verify:* `node --test src/lib/keywords/keywords.route.test.mjs` → pass (F13-AC-07 route half, 17, 24).
  - [x] **P3.T2.S5** *Files:* `src/lib/keywords/tools.ts` (`listSavedKeywordsTool`, `saveKeywordsTool`), `tools.test.ts`. *Verify:* `node --test src/lib/keywords/tools.test.ts` → pass.

**Checkpoint:** full suite; `node scripts/qa/check-f13-db.mjs` → "ok 9 groups"; CI customer-database job green; typecheck; build. Completes F13-AC-12…17, 24.

### Phase 4 — Research page (requires F04, F05, F06 and F09 phase 3 merged)

**Goal:** `/portal/keywords` with OpenSEO's master–detail UI.

**Owner-approved phase note:** Add only the /portal/keywords navigation item in this phase; the Saved Keywords navigation item and city picker remain deferred to Phase 5 and P8.T1.S3.

- [x] **P4.T1 Page and components**
  - [x] **P4.T1.S1** *Files:* `src/app/portal/keywords/page.tsx`, `src/components/portal/keywords/research/{KeywordResearchPage,KeywordResearchSearchBar,KeywordSearchOptions,KeywordResearchResults,KeywordResearchTable,KeywordResearchPagination,KeywordResearchFilters,KeywordResearchEmptyState,KeywordResearchLoadingState,KeywordNotLoadedCard,SerpAnalysisCard,OverviewStats,AreaTrendChart,IntentBadge,SaveKeywordsDialog}.tsx`, `research/hooks/{useKeywordResearchController,useKeywordResearchData,useKeywordSerpAnalysis,useKeywordSearchTabs,useKeywordHistory}.ts`, `src/components/portal/keywords/telemetry.ts`. *Do:* §6.6.2. *Verify:* `npm run build` → exit 0.
  - [x] **P4.T1.S2** *Files:* `src/components/app/navigation/items.ts` (one Phase 4 research-page entry, §6.6.1; Saved Keywords navigation deferred to Phase 5 by owner-approved note), `src/lib/query/keys.ts` (four factories). *Verify:* `node --test src/components/app/navigation/navModel.test.ts` → pass (F04 test; the research-page item appears only when `features.keyword_research === true`).
- [x] **P4.T2 Browser checks**
  - [x] **P4.T2.S1** *Files:* `scripts/qa/check-f13-browser.mjs` (Playwright from `worker/node_modules/playwright`; local app with fixture API responses for features, price estimate, research, serp, saved). Scenarios: B1 flag off → no sidebar items and the unavailable copy; B2 load `?q=oversized+t+shirt` → only a `cacheOnly: true` research request (network log), "not loaded" card with "Run search · up to $0.08"; B3 click → research POST carries `maxUsd 0.0755` and a `requestId`, results render, seed SERP requested once; B4 row click → SERP for that keyword, overview strip updates; B5 filters + approximate notice + filtered empty + Clear filters; B6 save dialog → toast "Saved 3 keywords"; B7 `409 price_changed` → dialog "The price changed"; B8 375 px → `document.documentElement.scrollWidth <= 375`, tabs switch panels. *Verify:* `node scripts/qa/check-f13-browser.mjs --only B1-B8` → "ok 8 scenarios" (F13-AC-09 browser half, F13-AC-21 part, F13-AC-22).

**Checkpoint:** full suite, build, `check-f13-browser.mjs --only B1-B8`. Completes F13-AC-09, 21 (research page), 22.

### Phase 5 — Saved keywords page

**Goal:** `/portal/keywords/saved` with tags, bulk actions, export and refresh.

- [x] **P5.T1 Page**
  - [x] **P5.T1.S1** *Files:* `src/app/portal/keywords/saved/page.tsx`, `src/components/portal/keywords/saved/{SavedKeywordsPage,SavedKeywordsHeader,SavedKeywordsTable,SavedKeywordsFilters,SavedKeywordsFilterPanel,SavedKeywordsTagFilter,ManageTagRow,TagChip,SavedKeywordsBulkActionBar,SavedKeywordsBulkTagsModal,SavedKeywordsModals,RefreshStatsStatus}.tsx`, `saved/hooks/{useSavedKeywordsQuery,useSavedKeywordsExport,useTagManage,useRefreshStats}.ts`, `src/styles/app-theme.css` (eight `.tag-chip-<color>` rules from OpenSEO's stylesheet, light and dark). *Do:* §6.6.3. *Verify:* `npm run build` → exit 0.
- [x] **P5.T2 Browser checks**
  - [x] **P5.T2.S1** *Files:* `scripts/qa/check-f13-browser.mjs` (B19–B22; B9–B17 belong to phase 4 and B18 to phase 8). B19 typing "tee" in Include Terms updates the URL once after 350 ms (two keystrokes inside the window → one navigation); B20 bulk tag add/remove toasts; delete confirm and toast; B21 refresh: dialog → `202` → progress text → finish toast; B22 tag delete `409` toast copy and empty/filtered-empty states. *Verify:* `node scripts/qa/check-f13-browser.mjs --only B19-B22` → "ok 4 scenarios" (F13-AC-21).

**Checkpoint:** full suite, build, `check-f13-browser.mjs`. Completes F13-AC-21.

### Phase 6 — Group into topics

**Goal:** an in-app, priced, review-then-apply clustering action.

- [x] **P6.T1 Server**
  - [x] **P6.T1.S1** *Files:* `src/lib/keywords/clustering.ts`, `clustering.test.ts`, fixture `llm-cluster.json`. *Do:* §6.3. Tests: out-of-range and repeated indexes dropped; unassigned → `unsorted`; duplicate names get " (2)"; prompt contains "unknown" for null volume and no keyword appears twice; estimate grows with keyword length. *Verify:* `node --test src/lib/keywords/clustering.test.ts` → pass.
  - [x] **P6.T1.S2** *Files:* `src/lib/keywords/jobs.ts` (`keywords.cluster`), `src/lib/pricing/actions/keywords.ts` (`keywords.clustering.run`), `src/app/api/customer/keywords/cluster/route.ts`, `cluster/apply/route.ts`, contracts, `keywords.route.test.mjs` (flag `keyword_clustering` off → 404; 9 ids → 409 `too_few_keywords`; apply with an id not in the proposal → 400; apply on a running job → 409 `job_not_ready`; apply adds tags only). *Verify:* `node --test src/lib/keywords/keywords.route.test.mjs src/lib/http/routeContract.test.ts` → pass (F13-AC-18).
- [x] **P6.T2 UI**
  - [x] **P6.T2.S1** *Files:* `src/components/portal/keywords/saved/GroupTopicsDialog.tsx`, `SavedKeywordsBulkActionBar.tsx`, `scripts/qa/check-f13-browser.mjs` (B13: < 10 selected → disabled with tooltip; 12 selected → dialog → running → proposal → rename one topic, uncheck one → apply → toast "Tagged 9 keywords in 2 topics"). *Verify:* `node scripts/qa/check-f13-browser.mjs --only B13` → "ok 1 scenario".

**Checkpoint:** full suite, build, browser B13. Completes F13-AC-18.

### Phase 7 — Track as a question (requires F08 phase 1 merged)

**Goal:** bridge keywords into the AI-visibility question library.

- [x] **P7.T1 Service, route and dialog**
  - [x] **P7.T1.S1** *Files:* `src/lib/keywords/trackQuestion.ts`, `trackQuestion.test.ts`, `src/app/api/customer/keywords/track-question/route.ts`, contract. *Do:* §6.2.4; tests with an injected `add`: arguments (`origin "manual"`, `sourceRef`), `created`/`revived` passthrough, `question_limit` passthrough; route: `question_curation` off → 404. *Verify:* `node --test src/lib/keywords/trackQuestion.test.ts src/lib/keywords/keywords.route.test.mjs` → pass (F13-AC-19).
  - [x] **P7.T1.S2** *Files:* `src/components/portal/keywords/TrackQuestionDialog.tsx`, `research/OverviewStats.tsx`, `saved/SavedKeywordsTable.tsx`, `scripts/qa/check-f13-browser.mjs` (B24 — the spec first said B14, which phase 4 already uses for SERP pagination: button hidden when `question_curation` off; created toast with "Open Questions"; existing toast). *Verify:* `node scripts/qa/check-f13-browser.mjs --only B24` → "ok 1 scenario".

**Checkpoint:** full suite, build, browser B14. Completes F13-AC-19.

### Phase 8 — Local (city) volume

**Goal:** volume, CPC and competition for one city, county or region.

- [x] **P8.T1 Area registry, local research and city picker**
  - [x] **P8.T1.S1** *Files:* `src/lib/providers/dataforseo/serp-locations.ts`, `serp-locations.test.ts`, `src/shared/serp-location-search.ts`, `serp-location-search.test.ts`, fixture `tests/fixtures/f13/serp-locations-in.json`. *Do:* §6.2.1; tests: only included types kept; cached globally; ranking "mumbai" puts "Mumbai,Maharashtra,India" first. *Verify:* `node --test src/lib/providers/dataforseo/serp-locations.test.ts src/shared/serp-location-search.test.ts` → pass.
  - [x] **P8.T1.S2** *Files:* `src/lib/keywords/localVolume.ts`, `localVolume.test.ts`, `research.ts` (local branch), research and SERP routes (default `assertLocalLocation`), `keywords.route.test.mjs` (409 before any paid call), `src/lib/pricing/actions/keywords.ts` (local line and `unknown_location` block, injectable registry) and `keywords.test.ts`. *Do:* port `research.test.ts:180-267` (three local cases) into `localVolume.test.ts`. *Verify:* `node --test src/lib/keywords/localVolume.test.ts src/lib/keywords/research.test.ts src/lib/keywords/serp.test.ts src/lib/pricing/actions/keywords.test.ts` → pass (F13-AC-20).
  - [x] **P8.T1.S3** *Files:* `src/app/api/customer/keywords/locations/route.ts`, `src/lib/keywords/locations.route.test.mjs`, contract, `src/components/portal/keywords/research/{SerpLocationCombobox,usePrewarmSerpLocations,KeywordAreaField}.tsx`, `KeywordResearchSearchBar.tsx`, `SaveKeywordsDialog.tsx`, `hooks/useKeywordResearchController.ts`, `scripts/qa/check-f13-browser.mjs` (B18 — B15 was already taken: typing "mum" lists Mumbai; selecting it shows "Local volume adds up to $0.09 per search.", the run sends `locationName`, and the save dialog note). Gate is `keyword_research` OR `local_seo`; `rank_tracking` joins when F15 registers that flag. *Verify:* `node scripts/qa/check-f13-browser.mjs --only B18` → "ok 1 scenario"; `node --test src/lib/http/routeContract.test.ts` → pass.
  - [x] **P8.T1.S4** *Files:* `THIRD_PARTY_NOTICES.md`. *Verify:* `node --test src/lib/platform/thirdPartyNotices.test.mjs` → pass.

**Checkpoint:** full suite, build, all browser scenarios `node scripts/qa/check-f13-browser.mjs` → "ok 22 scenarios" (B1–B22 once phase 5 is in). Completes F13-AC-20.

## 9. Test plan

| File | Cases | ACs |
|---|---|---|
| `src/lib/providers/dataforseo/labs.test.ts` | request bodies, `ignore_synonyms`, every entry priced | 01, 03 |
| `src/lib/providers/dataforseo/google-ads.test.ts` | Ads validity, truncation, local `location_name` | 01 |
| `src/lib/providers/dataforseo/keyword-metrics.test.ts` | five ported cases | 02 |
| `src/lib/providers/dataforseo/researchScopeFilters.test.ts` | seven ported cases | (F14, F16) |
| `src/lib/providers/dataforseo/serp-locations.test.ts` | types filter, cache, ranking | 20 |
| `src/shared/researchScope.test.ts`, `src/lib/research/target.test.ts` | parsing, scopes, errors | (F14, F16) |
| `src/lib/research/cache.test.ts`, `providerErrors.test.ts` | peek, cache-if, error mapping | 06, 09, 11 |
| `src/shared/keyword-locations.test.ts` | ported cases + host defaults | 23 |
| `src/shared/keyword-filtering.test.ts` | ported filtering, grouping, pagination, persistence-migration cases | 21 (logic) |
| `src/shared/keywords.test.ts`, `saved-keyword-tags.test.ts` | export rows, CSV cents, tag normalisation | 17 |
| `src/lib/keywords/helpers.test.ts`, `researchData.test.ts` | ported | 04 |
| `src/lib/keywords/research.test.ts` | §8 P2.T3.S2 list | 04–07, 10 |
| `src/lib/keywords/serp.test.ts` | ported + no AIO flag + organic only + operator ×5 | 11 |
| `src/lib/keywords/localVolume.test.ts` | three ported local cases | 20 |
| `src/lib/keywords/savedKeywords.test.ts` | ported + no metrics + empty tag match | 13–15 |
| `src/lib/keywords/refreshMetrics.test.ts` | stale only, batches, partial, guard, single active | 16 |
| `src/lib/keywords/clustering.test.ts` | validation, prompt, estimate | 18 |
| `src/lib/keywords/trackQuestion.test.ts` | F08 call arguments and results | 19 |
| `src/lib/pricing/actions/keywords.test.ts` | quote lines, warnings, blocks | 08, 10, 16, 18 |
| `src/lib/keywords/tools.test.ts` | closed inputs, outputs | — |
| `src/lib/keywords/keywords.route.test.mjs` | flags, auth, strict bodies, approval, cacheOnly, isolation, errors | 06–09, 15, 17, 18, 19, 22, 24 |
| `scripts/qa/check-f13-db.mjs` | nine groups | 12–16 |
| `tests/customer-uat.sql` | tenant reads, cross-tenant FK, metrics denied | 12 |
| `scripts/qa/check-f13-browser.mjs` | B1–B22 | 09, 19, 20, 21, 22 |
| `scripts/qa/check-f13-live.mjs` (owner-run) | one research (India, 150, auto) + one SERP; refuses without `--brand <key> --max-spend-usd 0.15` and enabled `keywords.research`/`keywords.serp` controls; prints counts and ledger rows only | — |

Fixtures: `tests/fixtures/f13/` as listed in §6.4, synthetic, no live recording in CI (conventions §6.5).

## 10. Rollout and rollback

- **Env (names only):** `FEATURE_KEYWORD_RESEARCH`, `FEATURE_KEYWORD_RESEARCH_BRANDS`, `FEATURE_KEYWORD_CLUSTERING`, `FEATURE_KEYWORD_CLUSTERING_BRANDS`. Uses F02's `DATAFORSEO_API_KEY` and F01's `LLM_API_KEY`/`LLM_HELPER_MODEL`.
- **Defaults:** flags off in production; no `paid_feature_controls` rows for the four spend features (fail closed).
- **Migration order:** 101 with phase 2; 100 then 102 with phase 3; a deploy that includes both applies 100, 101, 102 in numeric order. All after F01's (040–044) and F07's (070). No backfill.
- **Owner enabling steps:** (1) apply migrations; (2) in `/ops/costs` (F03/F01) enable `keywords.research` and `keywords.serp` for one workspace allowlist with a daily cap (suggested $2) and `maxCallUsd` $0.50; (3) set `FEATURE_KEYWORD_RESEARCH=allowlist` and `FEATURE_KEYWORD_RESEARCH_BRANDS=<key>`; (4) optionally run `scripts/qa/check-f13-live.mjs`; (5) later enable `keywords.metrics_refresh` and `keywords.clustering` (+ `FEATURE_KEYWORD_CLUSTERING`).
- **Turn off:** set `FEATURE_KEYWORD_RESEARCH=off` (pages and routes disappear) or disable a spend control (paid calls refuse with `feature_disabled`; saved keywords stay readable while the flag is on).
- **Cleanup (owner request only):** `drop table saved_keyword_tag_assignments, saved_keyword_tags, saved_keywords, keyword_metrics cascade;` and the functions of 101–102; delete provider-cache rows with namespaces `keywords.research`, `keywords.serp`, `dataforseo.serp_locations`.

## 11. Risks and open questions

| # | Risk or question | Default chosen |
|---|---|---|
| 1 | Global caching reveals that someone researched the same seed and market recently. | Accept for keyword data (public market data, no identity). Owner can switch `RESEARCH_CACHE.scope` and the SERP cache to `"workspace"` in one constant each. |
| 2 | F03's local input types for the Labs/Ads/domain estimators may differ from the argument objects in §6.2.1. | Bind to F03's actual types in P1; the "every entry is priced" test guards it. |
| 3 | DataForSEO prices are OpenSEO's September 2026 constants. | F02's bake-off verifies; F03 owns the numbers; quotes follow automatically. |
| 4 | `workspaceMarket` guesses the country from the website's TLD (most `.com` sites default to the US). | The country picker is remembered per workspace in local storage; a server-side workspace market setting can come later (F27 onboarding is the natural place). |
| 5 | Very large saved lists (5,000) make "Update keyword stats" a long job. | Batches of 700, 7-day freshness skip, progress, partial results; cap 5,000 per workspace. |
| 6 | Clustering quality depends on the helper model. | Proposal is reviewed before any tag is written; unsorted bucket; F21 can later replace the prompt with the skill. |
| 7 | `serp-locations.ts`, `keyword-locations.ts` and the locations route are useful to F15 and F17, which are written in parallel. | F13 owns them (P1, P8); F15/F17 import them. |
| 8 | JS `toLowerCase` and Postgres `lower()` differ for a few non-ASCII characters in search filters. | Keywords are stored lower-cased by JS; only filter matching uses SQL `lower`, so a rare miss affects a filter, not stored data. |
| 9 | F16 depends on P1's shared primitives although README lists F16 as depending on F02 and F06 only. | README should add "F13 (phase 1)" to F16's dependencies (requested). |

## 12. Definition of done

- [x] Phases 1–8 merged; every subtask ticked in this file.
- [x] F13-AC-01…24 covered by passing tests (§9).
- [ ] `npm test` (widened glob), `npm run typecheck`, `npm run build`, `node scripts/qa/check-f13-db.mjs`, `node scripts/qa/check-f13-browser.mjs` green; CI customer-database job green.
- [x] Migration paperwork (README, OPERATOR_LEDGER § C, PROD_MIGRATIONS) and `THIRD_PARTY_NOTICES.md` updated.
- [x] `features/README.md` status for F13 updated.
- [ ] Owner-run live check result (if run) recorded in the PR or `docs/OPERATOR_LEDGER.md`.
