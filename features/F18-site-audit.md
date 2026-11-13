# F18 — Site audit crawler (plus Perceev's AEO checks)

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F18 |
| Wave | 3 |
| Comparison rows covered | "Site audit" (OpenSEO: crawler up to 10,000 pages, 30 issue types with fix text, Lighthouse sample, optional JavaScript rendering, live crawled-URL feed. Perceev: "Check owned website", up to 6 requests). The audit also shows customers the "AI crawler access" data (a "We lead" row that is operator-only today); the operator route for that row is not changed. |
| Depends on | **F01** (merged): `requireWorkspace`, `AppError`/`toErrorResponse`/`jsonOk`, `defineJob` (opts `payloadSchema`, `pollAfterSeconds`, `deadlineSeconds`, `maxInvocations`), `enqueueJob` (`singleActiveKey`), `enqueueSystemJob`, `definePeriodic`, `getJobStatus`, `cancelJob`, `jobStepKey`, step presets (`DB_STEP`, `READ_STEP`), `reserveSpend`/`settleSpendBatch`/`releaseSpend`/`metered`, `isFeatureEnabled`, `safeFetch` (with `maxRedirects: 0` per conventions §5.6; `truncate` is added by P1.T1.S3 if F01 lacks it), `f01_touch_updated_at()`, `stableStringify`, route-contract harness, in-memory job and spend stores. **F06**: `DataTable`, `TableBulkActionBar`, `ExportMenu`, `useExportRows`, server export kinds (`src/lib/export/kinds/`). **F04/F05** for UI phases (`PageHeader`, `CardShell`, `NavTabs`, `ConfirmDialog`, `Progress`, `useServerPacedQuery`, `fetchJson`, `keys`). **F09** phase 1 (`definePricedAction`, `requireApprovedPrice`, `recordApproval`) and phase 3 (`CostReviewDialog`, `usePriceQuote`). **F02** phase 1 (`core.ts` `dataforseoPost`, `envelope.ts`, `client.ts` `meter`) and **F03** phase 1 (`dataforseoPricing.lighthouse`, `formatUsd`) for phase 5 only. **F08** P3.T1.S2 (`src/lib/pricing/firecrawl.ts` `firecrawlScrapeUsd()`) for phase 6 only. |
| Blocks | F19 phase 3 (IndexNow tab and page action, hosted by the registries this spec owns), F22 (audit tools), F23 (audit sections in reports), F27 (onboarding starts a free 50-page audit through `startSiteAudit`) |
| Reserved migrations | 125–129. **125** `125_f18_site_audit.sql` (P2). **126** `126_f18_site_audit_functions.sql` (P2). **127** `127_f18_site_audit_compare.sql` (P8, optional). **128** `128_f18_crawler_access.sql` (P9, optional). 129 unused. |
| Feature flags | `FEATURE_SITE_AUDIT` (name `site_audit`, spend `[]`): page, routes, sidebar item, free crawl. `FEATURE_SITE_AUDIT_LIGHTHOUSE` (`site_audit_lighthouse`, spend `["site_audit.lighthouse"]`): the Lighthouse switch. `FEATURE_SITE_AUDIT_RENDER` (`site_audit_render`, spend `["site_audit.render"]`): the Render JavaScript switch. `FEATURE_SITE_AUDIT_CRAWLER_ACCESS` (`site_audit_crawler_access`, spend `[]`): Shopify crawler access (P9). All four in `CLIENT_FEATURES`; all off in production by default (F01 flag semantics). |
| Spend features | `site_audit.lighthouse` ("Site audit Lighthouse checks"), `site_audit.render` ("Site audit JavaScript rendering"). Crawling is free to the customer (our compute). Both ship disabled. |
| OpenSEO reference | `openseo:src/server/workflows/{SiteAuditWorkflow,siteAuditWorkflowPhases,siteAuditWorkflowCrawl,auditStepConfigs,siteAuditStart,site-audit-workflow-helpers}.ts`, `openseo:src/server/features/audit/**`, `openseo:src/server/lib/audit/**`, `openseo:src/shared/{audit-issues,audit-limits,audit-rendering,audit-fetch-class,crawler-access,lighthouse}.ts`, `openseo:src/server/lib/dataforseo/lighthouse.ts`, `openseo:src/server/lib/{dataforseoLighthousePayload,lighthouseStoredPayload,lighthousePayload}.ts`, `openseo:src/client/features/audit/**`, `openseo:src/client/features/lighthouse/issues/**`, `openseo:src/audit-worker.ts`, `openseo:wrangler.audit.jsonc`, `openseo:tests/badseo/**` at `c5f8db1` |

## 1. Summary

Customers crawl their own website (10 to 10,000 pages) and get every technical SEO problem OpenSEO finds, each with an explanation and "How to fix", plus the checks only Perceev makes: which AI crawlers robots.txt lets in (search, assistant and training bots, per page), llms.txt, JSON-LD validity and visible-content consistency, Open Graph tags, hreflang and snippet restrictions. The crawl runs on F01's durable jobs with Postgres in place of OpenSEO's Durable Object, shows a live feed of crawled URLs, can be cancelled, keeps partial results on failure, and offers paid Lighthouse checks and JavaScript rendering only after the customer has seen and approved the price.

## 2. What OpenSEO does (observed)

1. **Orchestration.** A Cloudflare Workflow runs `validate-context` → `resolve-start-url` → discovery → crawl chunks → Lighthouse → `multipage-checks` → `finalize`; failures run `mark-failed` and a `finally` settles rendering credits once (`openseo:src/server/workflows/SiteAuditWorkflow.ts:77-191`, `siteAuditWorkflowPhases.ts:58-113`).
2. **Explicit step budgets.** Start 2 retries/2 min, discovery 2/4 min, crawl chunk 1 retry/5 min, Lighthouse fetch **0 retries** (DataForSEO bills it), render settlement 0 retries, Lighthouse persist 3, DB steps 3/2 min, multipage 2/5 min. The comment records that platform defaults "burned ~65 minutes replaying a doomed step" (`auditStepConfigs.ts:3-63`).
3. **Start URL.** The first step follows up to 5 HEAD redirects at 10 s each, re-validating every hop against the SSRF policy, and anchors the crawl to the final origin (apex → www, .net → .com). Shopify is detected from `powered-by` or an A record in 23.227.38.0/24 (`siteAuditStart.ts:17-58`, `url-policy.ts:195-202`, `:257-311`).
4. **Discovery.** robots.txt is read up to 500 KiB (RFC 9309) and stored as step state, then parsed outside the step so replays use identical rules (`discovery.ts:11-16`, `siteAuditWorkflowPhases.ts:82-85`). Sitemaps: robots-listed plus `/sitemap.xml`, index depth 3, at most 300 documents, 5 at a time, 15 s each, one retry on timeout, shards over 10 MB skipped whole, at most `min(max(maxPages × 20, 500), 50,000)` URLs, and all of them returned so in-sitemap flags survive (`discovery.ts:10-25`, `:284-381`). Redirects are followed by hand, at most 5 hops, each re-checked (`:60-103`).
5. **Scratchpad.** All transient crawl state lives in a per-audit SQLite Durable Object: `frontier` (pending/leased/crawled with `chunk_no`), `page_links` (one JSON array of targets per page) and `page_mirror` (`AuditScratchpad.ts:105-341`, `scratchpad-sql.ts:21-50`). Claims are idempotent per chunk number and refuse a fresh claim for a chunk that already crawled (`AuditScratchpad.ts:150-183`); link-discovered URLs drain before sitemap-only ones, FIFO within each (`:170-173`); a pending sitemap seed takes a link's depth and priority (`scratchpad-sql.ts:60-65`). Link writes stop at a 500 MB storage budget and orphan detection is then skipped (`AuditScratchpad.ts:96-103`, `:263-278`). A 7-day alarm wipes any instance; success destroys it (`:283-309`).
6. **Why a separate worker.** `src/audit-worker.ts` hosts the workflow and the Durable Object so multi-MB Lighthouse payloads and in-flight HTML land on "a small-baseline isolate instead of the app worker's near-limit one"; the app worker reaches it only through bindings and an RPC for delete/erasure (`openseo:src/audit-worker.ts:1-33`, `wrangler.audit.jsonc:3-46`). Everything is shaped by the 128 MB isolate limit.
7. **Crawl chunks.** 200 URLs per chunk, a 90 s soft deadline after which no new fetch starts, persistence in sub-batches of 5 then 25, at most 2 queued persists, at most 500 stored links per page, at most 20,000 newly discovered URLs per batch, feed titles cut to 300 chars (`siteAuditWorkflowCrawl.ts:33-76`). Unfetched leases are released; two zero-progress chunks end the crawl; the adapted window and throttle state are carried across chunks; a cooldown is a durable `sleepUntil` (`:114-180`, `:182-405`). A retried chunk runs with the retry window (`:256-262`).
8. **Rolling window.** Initial 2, min 1, **max 2**, 8 MiB in-flight byte budget; retry window 1/1/1 and 4 MiB; halve when ≥ 1/3 of a batch is troubled (non-ok, recovered 429, ≥ 10 s), grow by 5 only on a clean, mostly fast batch of ≥ 25; always capped by budget ÷ average page bytes (`crawl-window.ts:25-110`). (The architecture note says 5–40, `docs/maintainers/specs/0009-site-audit-crawl-architecture.md:58-61`; the code is authoritative.)
9. **Politeness.** One request start per `intervalMs` per audit (initially 1,000 ms). Each 429 doubles the interval up to 30 s and pauses the origin for `max(interval, Retry-After, 30 s × 2^(n−1))`; more than 3 consecutive refusals or more than 30 minutes of cumulative cooldown stops the crawl; a failed checkpoint stops it (`crawl-throttle.ts:1-116`). So a crawl runs at most about one page per second.
10. **Fetch classes.** `rate_limited` for a final 429; `blocked` for `cf-mitigated`, 401/403, 202, challenge titles on a 2xx, or challenge markers on a 503; `error` for no response (`classify-fetch.ts:16-40`, `shared/audit-fetch-class.ts:5-12`).
11. **Per page.** Manual redirects (each hop is its own row), `Link: rel=canonical` header parsing, HTML read up to 1 MiB, 15 s timeout, user agent `OpenSEO-Audit/1.0`, `isIndexable` from robots meta + `X-Robots-Tag`, `alt=""` counts as present, content hash = sha256 of visible text (`site-audit-workflow-helpers.ts:11-277`, `html-response.ts:3-41`).
12. **Analyzer.** htmlparser2 streaming tokenizer (no DOM) extracting title, meta description, robots meta, OG title/description/image, canonical, **hreflang codes only**, **JSON-LD presence only**, headings, ≤ 1,000 images, ≤ 1,000 deduplicated links, word count and an app-shell heuristic (`page-analyzer.ts:50-283`). OG, hreflang and structured data are captured but **no issue type checks them** (`shared/audit-issues.ts:18-259`).
13. **Issue registry.** 30 types, each `{ severity, title, explanation, howToFix }`: critical — `blocked-page`, `server-error`, `broken-internal-link`, `missing-title`; warning — `javascript-rendering-suspected`, `rate-limited-page`, `crawl-rate-limited`, `broken-page`, `duplicate-title`, `duplicate-meta-description`, `duplicate-content`, `missing-meta-description`, `missing-h1`, `multiple-h1`, `redirect-chain`, `redirect-loop`, `canonical-conflict`, `thin-content`, `images-missing-alt`, `orphan-page`, `no-outgoing-links`; info — `title-too-long`, `title-too-short`, `meta-description-too-long`, `meta-description-too-short`, `heading-order-skip`, `slow-response`, `noindex-page`, `canonicalized-page`, `deep-page` (`audit-issues.ts:18-259`).
14. **Page reporters.** Title 10–60 chars, meta 70–160, thin < 150 words (indexable only), slow > 1,500 ms, deep ≥ 5 clicks; blocked, rate-limited and error pages short-circuit; app shells skip content checks (`issues/page-reporters.ts:27-186`).
15. **Cross-page checks.** Duplicates exclude noindex, canonicalized and app-shell pages and list up to 3 other URLs; a chain is ≥ 2 redirects from a chain head; loops include head-less cycles (`issues/multipage.ts:20-62`, `issues/multipage-checks.ts:9-181`). Broken links (crawled target ≥ 400 with fetch class `ok`, cap 2,000) and orphans (completed crawl, complete link graph, no inbound edge from another page, no redirect to it) run as SQL in the scratchpad (`scratchpad-sql.ts:76-118`).
16. **Lighthouse.** Sample = start page plus one page per URL template, at most 10, only 2xx `ok` pages; mobile and desktop each (`lighthouse.ts:117-169`); DataForSEO `POST /v3/on_page/lighthouse/live/json`, 60 s timeout, no 5xx retry (`dataforseo/lighthouse.ts:18-82`); $0.005 per call (`dataforseo/pricing.ts:111-113`); 5 URLs per wave; paid fetches checkpointed apart from storage writes so a storage retry never repeats a charge (`siteAuditWorkflowPhases.ts:186-286`); compact payload stored in R2 (`lighthouse.ts:94-112`).
17. **JavaScript rendering.** Cloudflare Browser Run first (billed as a full 20 s attempt at $0.09/browser-hour), Context.dev fallback ($0.0025 per credit); rendered HTML must be for the same URL; a worst-case credit lock is taken at start and settled once at the end (`rendered-page.ts:161-202`, `shared/audit-rendering.ts:6-65`, `AuditService.ts:126-134`). Rendered audits are capped at 1,000 pages because the lock lasts at most 24 h (`shared/audit-limits.ts:7-9`).
18. **Limits.** Min 10, default 50, free 50, paid 10,000 pages; free accounts get 2,000 capacity units and 5 running audits; units = pages + Lighthouse checks (20 with Lighthouse) (`audit-limits.ts:3-9`, `audit-capacity.ts:19-65`). Gates run **after** the insert to avoid a check-then-act race (`AuditService.ts:109-125`).
19. **Failures.** A closed error vocabulary (`step_timeout`, `oom`, `cpu_limit`, `db_error`, `step_output_too_large`, `workflow_internal`, `instance_lost`, `unknown`) and `failed_phase` (`audit-errors.ts:11-79`). A lazy reconcile on every status read and a watchdog for audits running over 15 minutes (oldest first, 100 per sweep, 10-minute grace before "instance lost") flip zombie rows to failed; `failAudit` only moves a `running` row (`auditReconciler.ts:25-176`, `AuditRepository.ts:110-141`).
20. **Idempotent writes.** Deterministic row ids from content (`ids.ts:20-24`); pages upsert, issues insert-or-ignore, Lighthouse upsert (`AuditRepository.ts:166-249`, `auditIssueWrites.ts:10-45`).
21. **Live feed.** Crawled URLs are pushed to a KV list (newest first, ≤ 300, 30-minute TTL) (`progress-kv.ts:14-80`); the UI polls it every 1.5 s and the status every 3 s while running (`client/features/audit/AuditDetail.tsx:54-61`, `:257-261`).
22. **UI.** Launch form with URL and "Start Audit", "Max pages", "Include Lighthouse" (copy says "a sample of 20 pages", although the code samples at most 10 pages × 2 devices, `LaunchFormCard.tsx:196-201`), "Render JavaScript" with an estimate (`LaunchFormCard.tsx:40-300`); confirm above 500 pages (`useLaunchController.ts:90-93`, `LaunchView.tsx:49-59`); history table (`AuditHistorySection.tsx:50-149`); detail with phase badge, "N / M pages", live feed, partial-results and bot-protection banners (`AuditDetail.tsx:41-358`, `shared.tsx:160-204`); results with stats strip, Issues/Pages/Performance tabs and Sheets/CSV/JSON export (`results/ResultsView.tsx:36-383`, `results/export.ts:8-157`); issues grouped by severity and sorted by pages affected (`results/IssuesView.tsx:49-74`); Lighthouse issue detail at `audit/issues/$resultId` (`routes/_app/p/$projectId/audit/issues/$resultId.tsx:5-24`, `serverFunctions/lighthouse.ts:15-88`). There is **no Cancel**: only Delete, which terminates the workflow (`AuditService.ts:259-315`). There is no comparison view.
23. **Shopify crawler access.** Three static headers (`Signature-Input`, `Signature`, `Signature-Agent`) bound to one host, sent over https only, never across a redirect to another host, skipped once expired (`shared/crawler-access.ts:13-111`); stored encrypted with a key separate from auth (`CrawlerCredentialService.ts:29-40`), verified against Shopify's key directory at save (`shopifySignature.ts:28-96`), table `crawler_credentials` (`db/pg/app.schema.ts:450-479`).
24. **Fixture site.** `tests/badseo` serves one deliberately broken page per issue with `expectedIssues` typed against the registry; a harness drives the real crawl and issue functions with its own frontier (the production SSRF policy blocks localhost) and checks each page (`tests/badseo/README.md:19-35`, `:85-98`, `src/fixtures/types.ts:17-50`, `scripts/run-audit.ts:1-41`). The coverage line is **printed but does not affect the exit code** (`run-audit.ts:409-422`), and no fixture declares `javascript-rendering-suspected` or `crawl-rate-limited`.

## 3. What Perceev has today

- **R15 "Check owned website"** (technical evidence): `POST /api/customer/repairs/technical_audit` runs `auditOwnedPages` (`src/lib/repairs/technicalAudit.js:201-325`) — at most 6 requests (robots, one sitemap, homepage, sitemap/link pages), via `safeFetch` with a scope guard; `inspectPage` (`:35-200`) records status, redirect trace, meta/X-Robots directives (`noindex`, `none`, `nosnippet`, `max-snippet:0`), `data-nosnippet`, canonical, meaningful text, JSON-LD claims checked against visible text, and per-bot robots verdicts; issue codes `access_denied`, `http_status`, `restrictive_directive`, `data_nosnippet`, `canonical_other_url`, `insufficient_source_text`, `structured_data_requires_review`. Results are appended to the repair workflow store (`src/app/api/customer/repairs/[kind]/route.js:92-98`; migration 029) and shown on `/portal/measurement` in the "Website technical evidence" card (`src/app/portal/measurement/page.jsx:214-249`; restyled on the unmerged `fix/run-scan-unapproved-panel` branch at its lines 303-363). Tests: `src/lib/repairs/r15-technical-evidence.test.mjs`. Backlog R15 has 8 open subtasks (`docs/audits/2026-10-16/REPAIR-BACKLOG.md:893-913`).
- **AI crawler access** (operator only): 41 AI bots with operator, platform and purpose `training`/`search`/`agent` (`src/lib/crawlers/bots.js:29-133`); an RFC 9309 parser with longest-match precedence and prefix agent matching (`src/lib/crawlers/robots.js:54-374`); `GET /api/brands/[brand]/crawlability` with llms.txt HEAD check, SSRF screening and history (`src/app/api/brands/[brand]/crawlability/route.js:103-496`); one failure taxonomy shared by UI surfaces (`src/lib/crawlabilityOutcome.js:91-143`).
- **SSRF:** `src/lib/ssrfGuard.js` (`assertPublicUrl`, `safeFetch` following redirects by hand); F01 adds pinned `src/lib/http/safeFetch.ts`.
- **Firecrawl:** `scrapeSite` (`src/lib/firecrawl.js:144`) requests markdown only; F08 adds `firecrawlScrapeUsd()`.
- **Playwright fleet** (`worker/`): runs on a container host, not on Vercel; it currently probes nothing (`worker/README.md:3-7`) and must not import app code (`:18-25`). It is not a renderer we can call today.
- Missing: any site crawler, page/issue tables, Lighthouse, rendering, `/portal/audit`, `src/components/portal/audit/`.
- **Must not break:** R15's route, module, tests and evidence format; the measurement page markup the portal tests assert on (`src/components/portal/portalRegressions.test.mjs`); the operator crawlability route and its tests (`src/lib/crawlabilitySsrf.route.test.mjs`, `src/lib/crawlabilityTaxonomy.test.mjs`, `src/lib/crawlers/robots.test.mjs`); P0 controls (this feature never calls an answer engine).

**Decision on R15 (recommendation, owner may override in §11):** keep "Check owned website" unchanged as the **quick check** (free, synchronous, six requests, writes repair-workflow evidence that the R15/R16 acceptance path relies on), and make F18 the **full audit**. F18 reuses the same robots evaluator (`src/lib/crawlers/robots.js`) and ports `inspectPage`'s structured-data visibility rule, and a parity test (F18-AC-34) proves that for R15's own fixtures every R15 issue code maps to an F18 issue type, so the two never disagree. P7 adds one sentence to the measurement card pointing to Site Audit. Retiring the R15 button is a later owner decision, once `site_audit` is on for every workspace and the owner re-points R15.1a/2a/3a/3b/5a to F18.

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F18-AC-01 | `normalizeUrl`, `canonicalUrlKey`, `isSameOrigin`, `detectUrlTemplate`, `getOrigin` behave as OpenSEO's on OpenSEO's cases (trailing slash kept, query sorted, fragment dropped, www↔apex and http→https upgrades same-origin). | unit `src/lib/audit/urlUtils.test.ts` |
| F18-AC-02 | `analyzeHtml` extracts every OpenSEO field with OpenSEO's caps, plus hreflang `{lang, href}` pairs, JSON-LD block text (≤ 20 blocks, ≤ 64 KB each), `data-nosnippet` presence; it never builds a DOM. | unit `src/lib/audit/pageAnalyzer.test.ts` (ported cases + new) |
| F18-AC-03 | The issue registry has exactly the 30 OpenSEO types plus the 18 Perceev types of §6.2.2 (48), each with severity, title, explanation, howToFix, category and scope; no copy contains "OpenSEO". | unit `src/shared/audit-issues.test.ts` |
| F18-AC-04 | Page reporters reproduce OpenSEO thresholds and short-circuits and add the Perceev page checks (AI search/agent bots per page, structured data, OG, hreflang self-reference and validity, snippet restriction) only for analysed, `ok`, 2xx HTML pages; app shells skip content and Perceev content checks. | unit `src/lib/audit/issues/pageReporters.test.ts` |
| F18-AC-05 | Cross-page checks reproduce OpenSEO's duplicate and redirect rules and add `hreflang-no-return-link`; app shells are excluded from duplicates. | unit `src/lib/audit/issues/multipage.test.ts` |
| F18-AC-06 | AI-crawler verdicts come from `src/lib/crawlers/robots.js` `evaluateBot` with `AI_BOTS`; a training-bot block never produces a search or agent issue (R15-02); an unreadable or malformed robots.txt produces `robots-txt-unavailable`/`robots-txt-malformed` and **no** bot verdict issues (unverified ≠ open). | unit `src/lib/audit/aiAccess.test.ts` |
| F18-AC-07 | llms.txt: 2xx `text/plain` or `text/markdown` whose first non-empty line starts with `# ` → no issue; 404/410 → `llms-txt-missing`; 2xx HTML or no H1 → `llms-txt-invalid`; network failure or SSRF refusal → recorded `unreachable`, no issue. | unit `src/lib/audit/llmsTxt.test.ts` |
| F18-AC-08 | Crawl window and throttle reproduce every OpenSEO test case (window max raised to 4 and budget to 32 MiB by deliberate deviation; the "never grows beyond two" case becomes "beyond four"). | unit `src/lib/audit/crawlWindow.test.ts`, `crawlThrottle.test.ts` |
| F18-AC-09 | Discovery honours 500 KiB robots, depth 3, 300 docs, 10 MB shards, 15 s per doc, a 150 s total budget (`discoveryTruncated: true` when hit), and returns URLs beyond `maxPages`. | unit `src/lib/audit/discovery.test.ts` |
| F18-AC-10 | Every crawler fetch goes through F01 `safeFetch` with `maxRedirects: 0`; a private-address target is refused and recorded as fetch class `error` with `details.reason = "url_blocked"`, never fetched. | unit `src/lib/audit/fetchPage.test.ts` |
| F18-AC-11 | **Fixture site:** running the real `site_audit.run` handler (memory stores) against `tests/fixtures/site-audit/` yields exactly each fixture's expected issues per page and per site, healthy pages clean, and **fails if any registry issue type has no fixture** (coverage is an assertion, not a log line). | unit `src/lib/audit/fixtureSite.test.ts` |
| F18-AC-12 | Start: `POST /api/customer/audit` validates, enforces owned-host, page limits, one active audit per workspace, ≤ 2 active audits per host, the monthly page allowance, flags, and price approval; returns `202 { auditId, jobId, status: "queued", pollAfterSeconds: 3 }`. | route `src/lib/audit/start.route.test.mjs` |
| F18-AC-13 | Paid options require approval: Lighthouse or rendering without `maxUsd` → 400 `approval_required` with `details.quote`; a quote above `maxUsd` → 409 `price_changed`; a free audit needs no `maxUsd`. | route `start.route.test.mjs`; unit `src/lib/pricing/actions/siteAudit.test.ts` |
| F18-AC-14 | Frontier SQL functions reproduce the scratchpad semantics: chunk-idempotent claims, retried chunk returns its leases, finished chunk number claims nothing, link-before-sitemap FIFO, sitemap seed upgraded by a link, release, abandon. Memory and SQL stores agree on the same scenario. | unit `src/lib/audit/store.test.ts` (memory); DB `scripts/qa/check-f18-db.mjs` |
| F18-AC-15 | Broken-link and orphan SQL match OpenSEO's scratchpad tests (blocked targets ignored, self-links do not rescue, redirect targets not orphans, orphans only when the crawl completed and the link graph is complete). | DB `check-f18-db.mjs` |
| F18-AC-16 | A chunk persists pages and per-page issues in sub-batches with deterministic ids; replaying a chunk step writes no duplicates and does not exceed `maxPages`. | unit `src/lib/audit/crawlPhase.test.ts` |
| F18-AC-17 | A 429 with `Retry-After` pauses the origin and the job sleeps durably with `step.sleep`; a cooldown over 30 minutes stops the crawl and records `crawl-rate-limited`; the audit finishes `partial`. | unit `crawlPhase.test.ts` |
| F18-AC-18 | Cancel: `POST /api/customer/audit/[id]/cancel` calls F01 `cancelJob`; the running chunk stops launching fetches within 5 s; the audit ends `cancelled` with every page crawled so far visible; paid calls already made stay settled. | unit `crawlPhase.test.ts`; route `src/lib/audit/cancel.route.test.mjs`; browser `F18-B04` |
| F18-AC-19 | Failure keeps partial results: a thrown phase marks the audit `failed` with a closed `error_code` and `failed_phase`; results routes still return the pages crawled. | unit `src/lib/audit/job.test.ts`; route `results.route.test.mjs` |
| F18-AC-20 | Reconcile: an audit `running`/`queued` whose job is terminal (or missing for 10 minutes) becomes `failed`/`cancelled` on the next status read or the 15-minute periodic; a completed audit is never flipped. | unit `src/lib/audit/reconcile.test.ts` |
| F18-AC-21 | Live feed: `GET …/feed` returns the newest 50 crawled pages (url, statusCode, title ≤ 300 chars, crawledAt) and `pollAfterSeconds: 1.5` while running, `null` when finished. | route `results.route.test.mjs` |
| F18-AC-22 | Results routes: summary (stats, issue groups with distinct-page counts and "of N pages", AI access, llms.txt, warnings), issues by type (paginated), pages (server-side filters, sort, pagination), performance; all scoped to the caller's workspace (another workspace's audit id → 404). | route `src/lib/audit/results.route.test.mjs` |
| F18-AC-23 | Lighthouse: sample ≤ 10 pages; each URL is one `billed: true, retries: 0` step making mobile + desktop calls through `metered()` (feature `site_audit.lighthouse`); a storage failure after billing never throws; persistence is a separate retryable step; spend never exceeds the approved Lighthouse amount. | unit `src/lib/audit/lighthousePhase.test.ts`, `src/lib/providers/dataforseo/lighthouse.test.ts` |
| F18-AC-24 | Lighthouse detail route returns scores, metrics and issues from the stored compact payload; export modes `full`/`issues`/`category`. | route `results.route.test.mjs`; unit `src/lib/audit/lighthousePayload.test.ts` |
| F18-AC-25 | Rendering: Firecrawl `rawHtml` replaces the body only for HTML `ok` (< 400) or challenged pages; a different final URL or empty HTML is rejected; usage is counted; one F01 hold (`site_audit.render`, worst case, `ttlSeconds` 86,340) is reserved at start and settled once at the end (or on cancel/failure by reconcile) for `min(billed × unit, hold)`; a crawl chunk with rendering is `billed: true, retries: 0`. | unit `src/lib/audit/renderedPage.test.ts`, `crawlPhase.test.ts`, `reconcile.test.ts` |
| F18-AC-26 | Exports: client export of issues/pages/performance (Sheets, CSV, Excel, JSON) through F06 `exportRows`, and server export kinds `site_audit_issues`, `site_audit_pages`, `site_audit_performance` for full lists (≤ 50,000 rows), formula-safe CSV. | unit `src/lib/export/kinds/siteAudit.test.ts` |
| F18-AC-27 | UI: launch form, cost dialog for paid options, > 500-page confirm, history, progress card with phase badge, "N / M pages", 1.5 s feed, Cancel, partial/failed/blocked/cancelled banners, Issues grouped Critical/Warning/Info sorted by pages with "How to fix", Pages and Performance tables, AI access tab, Lighthouse detail page; phone layout without horizontal page scroll. | browser `scripts/qa/check-f18-browser.mjs` (F18-B01–B10) |
| F18-AC-28 | Registries: `src/components/portal/audit/tabs.ts` and `pageActions.ts` export exactly F19 §6.6.3's types; F18 renders `AUDIT_TABS` as `NavTabs` on `/portal/audit` and `/portal/audit/[auditId]` selected by `?tab=`, and `AUDIT_PAGE_ACTIONS` in the pages table bulk bar and row menu, hiding entries whose `flag` is off. | unit `src/components/portal/audit/registries.test.ts`; browser F18-B09 |
| F18-AC-29 | Flags: every route returns 404 `feature_unavailable` when `site_audit` is off; Lighthouse/render options return 403 `feature_disabled` when their flags are off; the sidebar item is hidden when off. | route tests; unit navModel (F04) |
| F18-AC-30 | Retention: audits older than 395 days are deleted with their Storage objects; scratch rows of audits finished more than 7 days ago are deleted; finished audits drop scratch rows at finalize. | DB `check-f18-db.mjs`; unit `src/lib/audit/retention.test.ts` |
| F18-AC-31 | Tenant isolation: customer tables have RLS read policies on `customer_can_access_brand`; scratch tables are service-only; the tenant RLS test covers the four customer tables. | DB `check-f18-db.mjs`; CI customer-database job |
| F18-AC-32 | Tools: `src/lib/audit/tools.ts` exports five F22 tools with closed input schemas and output schemas that parse their handler results. | unit `src/lib/audit/tools.test.ts` |
| F18-AC-33 | No answer-engine call, no `claim_probe_dispatch` use, and no paid provider call outside `metered()` or the F09 render hold: static import test. | unit `src/lib/audit/importGuard.test.ts` |
| F18-AC-34 | R15 parity: for every page fixture in `r15-technical-evidence.test.mjs`, the F18 analyzer + reporters produce the F18 issue types mapped from R15's codes (§6.2.11); R15's tests still pass unchanged. | unit `src/lib/audit/r15Parity.test.ts` |
| F18-AC-35 | (P8, optional) Compare: `GET /api/customer/audit/compare` returns per issue type before/after page counts with new and fixed page lists, and a `comparable: false` warning when page limits or completeness differ. | route `compare.route.test.mjs`; DB `check-f18-db.mjs` |
| F18-AC-36 | (P9, optional) Shopify crawler access: signatures encrypted at rest, never returned, sent only to the exact https host, skipped when expired; the start step detects Shopify and the report shows the Shopify notice. | unit `src/lib/audit/crawlerAccess.test.ts`; route `crawlerAccess.route.test.mjs` |

## 5. Scope

**In scope:** the audit engine (start probe, discovery, crawl, page and cross-page checks, finalize, reconcile, retention) on F01 jobs and Postgres; OpenSEO's 30 issue types and 18 Perceev AEO issue types; Lighthouse on DataForSEO (paid, approved, metered); JavaScript rendering via Firecrawl (paid, approved, held); Cancel; partial results; exports; `/portal/audit`, `/portal/audit/[auditId]`, `/portal/audit/[auditId]/lighthouse/[resultId]`; the audit tab and page-action registries for F19; the fixture site with an asserted coverage check; F22 tool definitions; `startSiteAudit` for F27; optional compare view (P8) and Shopify crawler access (P9).

**Out of scope:** auditing hosts outside the workspace website (§6.5.1 rule; owner may relax with `SITE_AUDIT_ALLOW_ANY_HOST`); IndexNow (F19, a tab here); the operator crawlability route and its history table (unchanged); R15's route and module (unchanged; §3 decision); scheduled audits (no OpenSEO equivalent; F10 may add later); answer-engine collection (P0); billing (not built); Search Console URL inspection (Search Console is a deferred Mixed row); Playwright-fleet rendering (§11 risk 3).

## 6. Design

### 6.1 Data model

#### `supabase/migrations/125_f18_site_audit.sql`

```sql
-- 125: F18 site audit — audits, pages, issues, Lighthouse results, crawl scratch tables (port of OpenSEO's
-- audit.schema.ts and AuditScratchpad SQLite to Postgres). Safe to re-run.

CREATE TABLE IF NOT EXISTS public.site_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  job_id uuid,                                   -- F01 jobs.id; no FK because jobs are pruned after 30 days
  started_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  trigger text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','baseline','tool')),
  requested_url text NOT NULL CHECK (length(requested_url) <= 2048),
  start_url text NOT NULL CHECK (length(start_url) <= 2048),
  start_host text NOT NULL CHECK (start_host ~ '^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$'),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','partial','failed','cancelled')),
  current_phase text NOT NULL DEFAULT 'queued'
    CHECK (current_phase IN ('queued','starting','discovery','crawling','lighthouse','finalizing',
                             'completed','failed','cancelled')),
  max_pages integer NOT NULL CHECK (max_pages BETWEEN 10 AND 10000),
  run_lighthouse boolean NOT NULL DEFAULT false,
  render_javascript boolean NOT NULL DEFAULT false,
  site_platform text CHECK (site_platform IN ('shopify')),
  crawler_credential_id uuid,                    -- P9; FK added by 128
  pages_crawled integer NOT NULL DEFAULT 0 CHECK (pages_crawled >= 0),
  pages_total integer NOT NULL DEFAULT 0 CHECK (pages_total >= 0),
  pages_seen integer NOT NULL DEFAULT 0 CHECK (pages_seen >= 0),
  pages_abandoned integer NOT NULL DEFAULT 0 CHECK (pages_abandoned >= 0),
  crawl_completed boolean,                       -- frontier exhausted before max_pages; NULL until known
  rate_limited boolean NOT NULL DEFAULT false,
  discovery_truncated boolean NOT NULL DEFAULT false,
  link_targets_stored integer NOT NULL DEFAULT 0,
  link_graph_complete boolean NOT NULL DEFAULT true,
  window_hint integer NOT NULL DEFAULT 2 CHECK (window_hint BETWEEN 1 AND 8),
  throttle_state jsonb,
  lighthouse_total integer NOT NULL DEFAULT 0,
  lighthouse_completed integer NOT NULL DEFAULT 0,
  lighthouse_failed integer NOT NULL DEFAULT 0,
  lighthouse_approved_usd numeric(12,6),
  robots_status text CHECK (robots_status IN ('found','missing','error','unreachable','malformed')),
  robots_http_status integer,
  robots_txt text CHECK (robots_txt IS NULL OR octet_length(robots_txt) <= 512000),
  ai_access jsonb,       -- [{name,operator,platform,purpose,status,matchedGroup,reason,unknown}] for the start path
  llms_txt jsonb,        -- {status:'present'|'missing'|'invalid'|'unreachable', httpStatus, contentType, firstLine}
  render_hold_id uuid,
  render_approved_usd numeric(12,6),
  render_attempts integer NOT NULL DEFAULT 0,
  render_billed integer NOT NULL DEFAULT 0,
  render_settled_at timestamptz,
  approved_max_usd numeric(12,6),
  price_quote jsonb,
  error_code text CHECK (error_code IS NULL OR error_code IN
    ('step_timeout','step_attempts_exhausted','billed_step_interrupted','db_error','job_lost','start_failed',
     'start_url_off_site','url_blocked','url_unreachable','no_pages','cancelled','unknown')),
  error_detail text CHECK (error_detail IS NULL OR length(error_detail) <= 500),
  failed_phase text,
  cancel_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN public.site_audits.pages_total IS 'Pages expected: min(frontier seen, max_pages) while running; pages crawled when finished.';
COMMENT ON COLUMN public.site_audits.robots_txt IS 'robots.txt text as read at discovery (≤ 500 KiB, RFC 9309); re-parsed on job replay so rules never change mid-audit.';
CREATE INDEX IF NOT EXISTS site_audits_brand_created_idx ON public.site_audits (brand_key, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS site_audits_one_active_idx ON public.site_audits (brand_key)
  WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS site_audits_active_host_idx ON public.site_audits (start_host)
  WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS site_audits_active_started_idx ON public.site_audits (created_at)
  WHERE status IN ('queued','running');
DROP TRIGGER IF EXISTS site_audits_touch ON public.site_audits;
CREATE TRIGGER site_audits_touch BEFORE UPDATE ON public.site_audits
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.site_audit_pages (
  id uuid PRIMARY KEY,                           -- deterministicUuid(auditId, url)
  audit_id uuid NOT NULL REFERENCES public.site_audits(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  url text NOT NULL CHECK (length(url) <= 2048),
  url_hash bigint GENERATED ALWAYS AS (hashtextextended(url, 0)) STORED,
  status_code integer,
  fetch_class text NOT NULL DEFAULT 'ok' CHECK (fetch_class IN ('ok','blocked','rate_limited','error')),
  redirect_url text CHECK (redirect_url IS NULL OR length(redirect_url) <= 2048),
  title text, meta_description text, canonical_url text, header_canonical_url text,
  robots_meta text, x_robots_tag text, og_title text, og_description text, og_image text,
  h1_count smallint NOT NULL DEFAULT 0, h2_count smallint NOT NULL DEFAULT 0, h3_count smallint NOT NULL DEFAULT 0,
  h4_count smallint NOT NULL DEFAULT 0, h5_count smallint NOT NULL DEFAULT 0, h6_count smallint NOT NULL DEFAULT 0,
  word_count integer NOT NULL DEFAULT 0,
  content_hash text,
  images_total integer NOT NULL DEFAULT 0,
  images_missing_alt integer NOT NULL DEFAULT 0,
  internal_link_count integer NOT NULL DEFAULT 0,
  external_link_count integer NOT NULL DEFAULT 0,
  has_structured_data boolean NOT NULL DEFAULT false,
  structured_data_types text[] NOT NULL DEFAULT '{}',
  hreflang jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{lang, href}] ≤ 50 entries
  is_indexable boolean NOT NULL DEFAULT false,
  crawl_depth integer,                           -- NULL = reached only through the sitemap
  in_sitemap boolean NOT NULL DEFAULT false,
  response_time_ms integer,
  rendered boolean NOT NULL DEFAULT false,
  crawled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_audit_pages_audit_url_key UNIQUE (audit_id, url)
);
CREATE INDEX IF NOT EXISTS site_audit_pages_feed_idx ON public.site_audit_pages (audit_id, crawled_at DESC);
CREATE INDEX IF NOT EXISTS site_audit_pages_hash_idx ON public.site_audit_pages (audit_id, url_hash);
CREATE INDEX IF NOT EXISTS site_audit_pages_redirect_idx ON public.site_audit_pages (audit_id, redirect_url)
  WHERE redirect_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS site_audit_pages_status_idx ON public.site_audit_pages (audit_id, status_code);

CREATE TABLE IF NOT EXISTS public.site_audit_issues (
  id uuid PRIMARY KEY,                           -- deterministicUuid(auditId, pageUrl, issueType, dedupeKey)
  audit_id uuid NOT NULL REFERENCES public.site_audits(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  page_id uuid REFERENCES public.site_audit_pages(id) ON DELETE CASCADE,   -- NULL for site-level issues
  page_url text NOT NULL CHECK (length(page_url) <= 2048),
  issue_type text NOT NULL CHECK (issue_type ~ '^[a-z][a-z0-9-]{1,60}$'),
  severity text NOT NULL CHECK (severity IN ('critical','warning','info')),
  details jsonb CHECK (details IS NULL OR pg_column_size(details) <= 8192),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_audit_issues_type_idx ON public.site_audit_issues (audit_id, issue_type);
CREATE INDEX IF NOT EXISTS site_audit_issues_page_idx ON public.site_audit_issues (page_id);

CREATE TABLE IF NOT EXISTS public.site_audit_lighthouse (
  id uuid PRIMARY KEY,                           -- deterministicUuid(auditId, pageId, strategy)
  audit_id uuid NOT NULL REFERENCES public.site_audits(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES public.site_audit_pages(id) ON DELETE CASCADE,
  strategy text NOT NULL CHECK (strategy IN ('mobile','desktop')),
  performance_score smallint CHECK (performance_score BETWEEN 0 AND 100),
  accessibility_score smallint CHECK (accessibility_score BETWEEN 0 AND 100),
  best_practices_score smallint CHECK (best_practices_score BETWEEN 0 AND 100),
  seo_score smallint CHECK (seo_score BETWEEN 0 AND 100),
  lcp_ms real, cls real, inp_ms real, ttfb_ms real,
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 500),
  payload_path text,                             -- site-audit-lighthouse/<brand>/<audit>/<page>-<strategy>.json
  payload_bytes integer,
  cost_usd numeric(12,6),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_audit_lighthouse_one UNIQUE (audit_id, page_id, strategy)
);
CREATE INDEX IF NOT EXISTS site_audit_lighthouse_audit_idx ON public.site_audit_lighthouse (audit_id);

-- Scratch tables: the Durable Object's frontier and link edges. Service-only; dropped at finalize.
CREATE TABLE IF NOT EXISTS public.site_audit_frontier (
  audit_id uuid NOT NULL REFERENCES public.site_audits(id) ON DELETE CASCADE,
  url text NOT NULL CHECK (length(url) <= 2048),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  depth integer,
  source text NOT NULL CHECK (source IN ('link','sitemap')),
  in_sitemap boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','crawled','abandoned')),
  chunk_no integer,
  PRIMARY KEY (audit_id, url)
);
CREATE INDEX IF NOT EXISTS site_audit_frontier_claim_idx ON public.site_audit_frontier (audit_id, state, source, seq);
CREATE INDEX IF NOT EXISTS site_audit_frontier_chunk_idx ON public.site_audit_frontier (audit_id, chunk_no)
  WHERE chunk_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.site_audit_links (
  audit_id uuid NOT NULL REFERENCES public.site_audits(id) ON DELETE CASCADE,
  page_id uuid NOT NULL,
  url text NOT NULL,
  target_hashes bigint[] NOT NULL,               -- hashtextextended(target_url, 0); ≤ 500 per page
  PRIMARY KEY (audit_id, page_id)
);
COMMENT ON TABLE public.site_audit_links IS 'Internal link edges as 64-bit URL hashes (8 bytes each) instead of URL text, so a 10,000-page audit stays under ~40 MB worst case.';

-- RLS: customers read their workspace's audit data; writes are service-role only (conventions §6.8).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_audits','site_audit_pages','site_audit_issues','site_audit_lighthouse'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key))', t || '_read', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon, authenticated', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['site_audit_frontier','site_audit_links'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

INSERT INTO storage.buckets (id, name, public) VALUES ('site-audit-lighthouse', 'site-audit-lighthouse', false)
ON CONFLICT (id) DO NOTHING;
NOTIFY pgrst, 'reload schema';
```

#### `supabase/migrations/126_f18_site_audit_functions.sql`

```sql
-- 126: F18 site audit functions — atomic start, frontier claims (scratchpad port), finalize link checks,
-- summaries, usage and retention. All service-role only. Safe to re-run.

-- Atomic start: one active audit per workspace, at most p_host_cap active audits per host across workspaces,
-- and a monthly page allowance, checked under the workspace row lock (OpenSEO checks after insert,
-- AuditService.ts:109-125; a row lock gives the same race safety).
CREATE OR REPLACE FUNCTION public.site_audit_create(
  p_id uuid, p_brand_key text, p_started_by uuid, p_trigger text, p_requested_url text, p_start_url text,
  p_start_host text, p_max_pages integer, p_lighthouse boolean, p_render boolean,
  p_month_start timestamptz, p_monthly_cap integer, p_host_cap integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_active uuid; v_host integer; v_used integer;
BEGIN
  PERFORM 1 FROM customer_brands WHERE brand_key = p_brand_key AND is_active FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('created', false, 'reason', 'workspace_not_found'); END IF;
  SELECT id INTO v_active FROM site_audits WHERE brand_key = p_brand_key AND status IN ('queued','running') LIMIT 1;
  IF v_active IS NOT NULL THEN
    RETURN jsonb_build_object('created', false, 'reason', 'audit_already_running', 'activeAuditId', v_active);
  END IF;
  SELECT count(*) INTO v_host FROM site_audits WHERE start_host = p_start_host AND status IN ('queued','running');
  IF v_host >= p_host_cap THEN RETURN jsonb_build_object('created', false, 'reason', 'host_busy'); END IF;
  SELECT coalesce(sum(CASE WHEN status IN ('queued','running') THEN max_pages ELSE pages_crawled END), 0)::integer
    INTO v_used FROM site_audits WHERE brand_key = p_brand_key AND created_at >= p_month_start;
  IF v_used + p_max_pages > p_monthly_cap THEN
    RETURN jsonb_build_object('created', false, 'reason', 'audit_capacity_reached', 'used', v_used, 'cap', p_monthly_cap);
  END IF;
  INSERT INTO site_audits (id, brand_key, started_by, trigger, requested_url, start_url, start_host, max_pages,
                           run_lighthouse, render_javascript, pages_total)
  VALUES (p_id, p_brand_key, p_started_by, p_trigger, p_requested_url, p_start_url, p_start_host, p_max_pages,
          p_lighthouse, p_render, p_max_pages);
  RETURN jsonb_build_object('created', true, 'used', v_used + p_max_pages, 'cap', p_monthly_cap);
END $$;

CREATE OR REPLACE FUNCTION public.site_audit_seed(p_audit_id uuid, p_urls text[], p_source text)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF p_source = 'link' THEN
    INSERT INTO site_audit_frontier (audit_id, url, depth, source, in_sitemap)
    SELECT DISTINCT p_audit_id, u, 0, 'link', false FROM unnest(p_urls) AS u
    ON CONFLICT (audit_id, url) DO NOTHING;
  ELSIF p_source = 'sitemap' THEN
    -- Upsert: a URL already queued (e.g. the start URL) keeps position and depth but gains the sitemap flag
    -- (AuditScratchpad.ts:132-142).
    INSERT INTO site_audit_frontier (audit_id, url, depth, source, in_sitemap)
    SELECT DISTINCT p_audit_id, u, NULL::integer, 'sitemap', true FROM unnest(p_urls) AS u
    ON CONFLICT (audit_id, url) DO UPDATE SET in_sitemap = true;
  ELSE
    RAISE EXCEPTION 'site_audit_seed: invalid source %', p_source;
  END IF;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.site_audit_frontier_stats(p_audit_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'attempted', count(*) FILTER (WHERE state = 'crawled'),
    'pending',   count(*) FILTER (WHERE state = 'pending'),
    'abandoned', count(*) FILTER (WHERE state = 'abandoned'),
    'seen',      count(*))
  FROM site_audit_frontier WHERE audit_id = p_audit_id
$$;

-- Lease the next chunk. Idempotent per chunk number (AuditScratchpad.ts:150-183).
CREATE OR REPLACE FUNCTION public.site_audit_claim_chunk(p_audit_id uuid, p_chunk_no integer, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  PERFORM 1 FROM site_audits WHERE id = p_audit_id FOR UPDATE;   -- serialise claims for one audit
  SELECT coalesce(jsonb_agg(jsonb_build_object('url', f.url, 'depth', f.depth, 'inSitemap', f.in_sitemap)
                            ORDER BY f.source, f.seq), '[]'::jsonb)
    INTO v FROM site_audit_frontier f
   WHERE f.audit_id = p_audit_id AND f.state = 'leased' AND f.chunk_no = p_chunk_no;
  IF jsonb_array_length(v) > 0 THEN RETURN jsonb_build_object('isRetry', true, 'urls', v); END IF;
  IF EXISTS (SELECT 1 FROM site_audit_frontier WHERE audit_id = p_audit_id AND chunk_no = p_chunk_no
             AND state IN ('crawled','abandoned')) THEN
    RETURN jsonb_build_object('isRetry', true, 'urls', '[]'::jsonb);
  END IF;
  IF p_limit <= 0 THEN RETURN jsonb_build_object('isRetry', false, 'urls', '[]'::jsonb); END IF;
  WITH picked AS (
    SELECT url FROM site_audit_frontier
     WHERE audit_id = p_audit_id AND state = 'pending'
     ORDER BY source, seq            -- 'link' sorts before 'sitemap'
     LIMIT p_limit
  ), leased AS (
    UPDATE site_audit_frontier f SET state = 'leased', chunk_no = p_chunk_no
      FROM picked WHERE f.audit_id = p_audit_id AND f.url = picked.url
    RETURNING f.url, f.depth, f.in_sitemap, f.source, f.seq
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('url', url, 'depth', depth, 'inSitemap', in_sitemap)
                            ORDER BY source, seq), '[]'::jsonb) INTO v FROM leased;
  RETURN jsonb_build_object('isRetry', false, 'urls', v);
END $$;

-- Persist one crawled sub-batch's frontier side (AuditScratchpad.recordBatch).
-- p_links: [{"pageId": uuid, "url": text, "targets": [text, ...]}]; p_discovered: [{"url": text, "depth": int|null}]
CREATE OR REPLACE FUNCTION public.site_audit_record_batch(p_audit_id uuid, p_crawled text[], p_links jsonb,
  p_discovered jsonb, p_link_budget integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_stored integer; v_new integer;
BEGIN
  UPDATE site_audit_frontier SET state = 'crawled'
   WHERE audit_id = p_audit_id AND url = ANY (p_crawled) AND state IN ('leased','pending');
  SELECT link_targets_stored INTO v_stored FROM site_audits WHERE id = p_audit_id FOR UPDATE;
  SELECT coalesce(sum(jsonb_array_length(l -> 'targets')), 0)::integer INTO v_new
    FROM jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) l;
  IF v_stored + v_new <= p_link_budget THEN
    INSERT INTO site_audit_links (audit_id, page_id, url, target_hashes)
    SELECT p_audit_id, (l ->> 'pageId')::uuid, l ->> 'url',
           ARRAY(SELECT hashtextextended(t, 0) FROM jsonb_array_elements_text(l -> 'targets') t)
      FROM jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) l
    ON CONFLICT (audit_id, page_id) DO UPDATE SET url = excluded.url, target_hashes = excluded.target_hashes;
    UPDATE site_audits SET link_targets_stored = link_targets_stored + v_new WHERE id = p_audit_id;
  ELSIF v_new > 0 THEN
    UPDATE site_audits SET link_graph_complete = false WHERE id = p_audit_id;
  END IF;
  -- Link discovery: new URLs queue as 'link'; a pending depth-less sitemap seed takes the link's depth and
  -- priority (scratchpad-sql.ts:60-65).
  INSERT INTO site_audit_frontier (audit_id, url, depth, source, in_sitemap)
  SELECT p_audit_id, d.url, d.depth, 'link', false FROM (
    SELECT DISTINCT ON (x ->> 'url') x ->> 'url' AS url, (x ->> 'depth')::integer AS depth
      FROM jsonb_array_elements(coalesce(p_discovered, '[]'::jsonb)) x
     ORDER BY x ->> 'url', (x ->> 'depth')::integer NULLS LAST) d
  ON CONFLICT (audit_id, url) DO UPDATE SET source = 'link', depth = excluded.depth
   WHERE site_audit_frontier.state = 'pending' AND site_audit_frontier.depth IS NULL AND excluded.depth IS NOT NULL;
  RETURN site_audit_frontier_stats(p_audit_id);
END $$;

CREATE OR REPLACE FUNCTION public.site_audit_release(p_audit_id uuid, p_urls text[])
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n integer;
BEGIN
  UPDATE site_audit_frontier SET state = 'pending', chunk_no = NULL
   WHERE audit_id = p_audit_id AND url = ANY (p_urls) AND state = 'leased';
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;

-- A billed (rendering) chunk that failed is never re-fetched: its unpersisted leases are abandoned.
CREATE OR REPLACE FUNCTION public.site_audit_abandon_chunk(p_audit_id uuid, p_chunk_no integer)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n integer;
BEGIN
  UPDATE site_audit_frontier SET state = 'abandoned'
   WHERE audit_id = p_audit_id AND chunk_no = p_chunk_no AND state = 'leased';
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE site_audits SET pages_abandoned = pages_abandoned + n WHERE id = p_audit_id;
  RETURN n;
END $$;

-- Broken internal links: only targets we crawled and saw fail; WAF-blocked targets excluded (scratchpad-sql.ts:67-90).
CREATE OR REPLACE FUNCTION public.site_audit_broken_links(p_audit_id uuid, p_limit integer DEFAULT 2000)
RETURNS TABLE (source_page_id uuid, source_url text, target_url text, target_status integer)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT l.page_id, l.url, t.url, t.status_code
    FROM site_audit_links l
    CROSS JOIN LATERAL unnest(l.target_hashes) AS h(hash)
    JOIN site_audit_pages t ON t.audit_id = l.audit_id AND t.url_hash = h.hash
   WHERE l.audit_id = p_audit_id AND t.status_code >= 400 AND t.fetch_class = 'ok'
   ORDER BY l.page_id, t.url
   LIMIT p_limit
$$;

-- Orphans: live 2xx pages no OTHER crawled page links to and nothing redirects to (scratchpad-sql.ts:92-118).
-- The caller only invokes this when the crawl completed and link_graph_complete is true.
CREATE OR REPLACE FUNCTION public.site_audit_orphan_pages(p_audit_id uuid, p_start_url text)
RETURNS TABLE (page_id uuid, url text)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH inbound AS (
    SELECT DISTINCT h.hash
      FROM site_audit_links l CROSS JOIN LATERAL unnest(l.target_hashes) AS h(hash)
     WHERE l.audit_id = p_audit_id AND h.hash <> hashtextextended(l.url, 0)
  )
  SELECT p.id, p.url FROM site_audit_pages p
   WHERE p.audit_id = p_audit_id AND p.url <> p_start_url AND p.fetch_class = 'ok'
     AND p.status_code BETWEEN 200 AND 299
     AND NOT EXISTS (SELECT 1 FROM inbound i WHERE i.hash = p.url_hash)
     AND NOT EXISTS (SELECT 1 FROM site_audit_pages r WHERE r.audit_id = p_audit_id AND r.redirect_url = p.url)
$$;

-- Distinct pages per issue type (auditSummaryQueries.ts:11-21).
CREATE OR REPLACE FUNCTION public.site_audit_issue_summary(p_audit_id uuid)
RETURNS TABLE (issue_type text, severity text, pages bigint, rows_count bigint)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT issue_type, severity, count(DISTINCT page_url), count(*)
    FROM site_audit_issues WHERE audit_id = p_audit_id GROUP BY issue_type, severity
$$;

CREATE OR REPLACE FUNCTION public.site_audit_destroy_scratch(p_audit_id uuid)
RETURNS void LANGUAGE sql SET search_path = public AS $$
  DELETE FROM site_audit_frontier WHERE audit_id = p_audit_id;
  DELETE FROM site_audit_links WHERE audit_id = p_audit_id;
$$;

-- Retention: audits older than p_audits_before (395 days) and scratch rows of audits finished before
-- p_scratch_before (7 days; the scratchpad alarm, AuditScratchpad.ts:95). Returns deleted audits for Storage cleanup.
CREATE OR REPLACE FUNCTION public.prune_site_audits(p_audits_before timestamptz, p_scratch_before timestamptz,
  p_limit integer DEFAULT 200)
RETURNS TABLE (audit_id uuid, brand_key text)
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  DELETE FROM site_audit_frontier f USING site_audits a
   WHERE f.audit_id = a.id AND a.status NOT IN ('queued','running') AND a.completed_at < p_scratch_before;
  DELETE FROM site_audit_links l USING site_audits a
   WHERE l.audit_id = a.id AND a.status NOT IN ('queued','running') AND a.completed_at < p_scratch_before;
  RETURN QUERY
  WITH old AS (
    SELECT id FROM site_audits WHERE created_at < p_audits_before AND status NOT IN ('queued','running')
     ORDER BY created_at LIMIT p_limit)
  DELETE FROM site_audits s USING old WHERE s.id = old.id RETURNING s.id, s.brand_key;
END $$;

REVOKE ALL ON FUNCTION
  public.site_audit_create(uuid,text,uuid,text,text,text,text,integer,boolean,boolean,timestamptz,integer,integer),
  public.site_audit_seed(uuid,text[],text), public.site_audit_frontier_stats(uuid),
  public.site_audit_claim_chunk(uuid,integer,integer), public.site_audit_record_batch(uuid,text[],jsonb,jsonb,integer),
  public.site_audit_release(uuid,text[]), public.site_audit_abandon_chunk(uuid,integer),
  public.site_audit_broken_links(uuid,integer), public.site_audit_orphan_pages(uuid,text),
  public.site_audit_issue_summary(uuid), public.site_audit_destroy_scratch(uuid),
  public.prune_site_audits(timestamptz,timestamptz,integer)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.site_audit_create(uuid,text,uuid,text,text,text,text,integer,boolean,boolean,timestamptz,integer,integer),
  public.site_audit_seed(uuid,text[],text), public.site_audit_frontier_stats(uuid),
  public.site_audit_claim_chunk(uuid,integer,integer), public.site_audit_record_batch(uuid,text[],jsonb,jsonb,integer),
  public.site_audit_release(uuid,text[]), public.site_audit_abandon_chunk(uuid,integer),
  public.site_audit_broken_links(uuid,integer), public.site_audit_orphan_pages(uuid,text),
  public.site_audit_issue_summary(uuid), public.site_audit_destroy_scratch(uuid),
  public.prune_site_audits(timestamptz,timestamptz,integer)
TO service_role;
NOTIFY pgrst, 'reload schema';
```

#### `supabase/migrations/127_f18_site_audit_compare.sql` (P8, optional)

```sql
-- 127: F18 compare two audits of the same workspace. Safe to re-run.
CREATE OR REPLACE FUNCTION public.site_audit_compare(p_brand_key text, p_base uuid, p_head uuid, p_sample integer DEFAULT 100)
RETURNS TABLE (issue_type text, severity text, base_pages bigint, head_pages bigint,
               new_pages text[], fixed_pages text[])
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH ok AS (
    SELECT 1 FROM site_audits b, site_audits h
     WHERE b.id = p_base AND h.id = p_head AND b.brand_key = p_brand_key AND h.brand_key = p_brand_key),
  b AS (SELECT DISTINCT issue_type, severity, page_url FROM site_audit_issues WHERE audit_id = p_base AND EXISTS (SELECT 1 FROM ok)),
  h AS (SELECT DISTINCT issue_type, severity, page_url FROM site_audit_issues WHERE audit_id = p_head AND EXISTS (SELECT 1 FROM ok)),
  types AS (SELECT issue_type, max(severity) AS severity FROM (SELECT issue_type, severity FROM b UNION ALL SELECT issue_type, severity FROM h) x GROUP BY issue_type)
  SELECT t.issue_type, t.severity,
         (SELECT count(*) FROM b WHERE b.issue_type = t.issue_type),
         (SELECT count(*) FROM h WHERE h.issue_type = t.issue_type),
         ARRAY(SELECT h.page_url FROM h WHERE h.issue_type = t.issue_type
                 AND NOT EXISTS (SELECT 1 FROM b WHERE b.issue_type = h.issue_type AND b.page_url = h.page_url)
               ORDER BY h.page_url LIMIT p_sample),
         ARRAY(SELECT b.page_url FROM b WHERE b.issue_type = t.issue_type
                 AND NOT EXISTS (SELECT 1 FROM h WHERE h.issue_type = b.issue_type AND h.page_url = b.page_url)
               ORDER BY b.page_url LIMIT p_sample)
    FROM types t
$$;
REVOKE ALL ON FUNCTION public.site_audit_compare(text,uuid,uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.site_audit_compare(text,uuid,uuid,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
```

(`max(severity)` on text orders `critical < info < warning`; the route replaces it with the registry severity, so the column is only a fallback for unknown types.)

#### `supabase/migrations/128_f18_crawler_access.sql` (P9, optional)

```sql
-- 128: F18 Shopify crawler-access credentials (port of crawler_credentials, app.schema.ts:450-479). Safe to re-run.
CREATE TABLE IF NOT EXISTS public.site_audit_crawler_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  host text NOT NULL CHECK (host ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),
  provider text NOT NULL DEFAULT 'shopify' CHECK (provider IN ('shopify')),
  encrypted_signature_input text NOT NULL,   -- AES-256-GCM JSON envelope (CRAWLER_ACCESS_ENCRYPTION_KEY)
  encrypted_signature text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  expires_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_audit_crawler_credentials_host_key UNIQUE (brand_key, host)
);
ALTER TABLE public.site_audit_crawler_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.site_audit_crawler_credentials FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.site_audit_crawler_credentials TO service_role;
-- Service-only: the signature is a bot-protection credential and never reaches a browser.
DROP TRIGGER IF EXISTS site_audit_crawler_credentials_touch ON public.site_audit_crawler_credentials;
CREATE TRIGGER site_audit_crawler_credentials_touch BEFORE UPDATE ON public.site_audit_crawler_credentials
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_audits_crawler_credential_fk') THEN
    ALTER TABLE public.site_audits ADD CONSTRAINT site_audits_crawler_credential_fk
      FOREIGN KEY (crawler_credential_id) REFERENCES public.site_audit_crawler_credentials(id) ON DELETE SET NULL;
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
```

`scripts/setup-supabase.mjs` required objects gain `site_audits`, `site_audit_pages`, `site_audit_issues`, `site_audit_lighthouse`, `site_audit_frontier`, `site_audit_links`, every 126 function, and (when applied) `site_audit_compare` and `site_audit_crawler_credentials`. The CI tenant RLS test gains the four customer tables.

### 6.2 Server modules

All server code is TypeScript under `src/lib/**` with relative imports and explicit extensions, erasable syntax only (conventions §5.4, F01 §6.2). Every COPY/PORT file carries the licence header (conventions §2). New dependencies: `htmlparser2@^10` (streaming parser, OpenSEO's choice) and `fast-xml-parser@^5` (sitemaps); added to `package.json` in P1.

#### 6.2.1 File map (`src/lib/audit/` unless stated)

| File | Mode | Exports and behaviour |
|---|---|---|
| `src/shared/audit-issues.ts` | PORT `shared/audit-issues.ts` | `IssueSeverity`, `IssueCategory = "crawl" \| "links" \| "content" \| "indexability" \| "performance" \| "ai_access" \| "structured_data" \| "social" \| "international"`, `IssueScope = "page" \| "site"`, `AUDIT_ISSUE_TYPES` (48 entries, §6.2.2), `AuditIssueType`, `ISSUE_SEVERITY_ORDER`, `getIssueDescriptor(type)`, `ISSUE_CATEGORY_LABELS`. |
| `src/shared/audit-limits.ts` | PORT `shared/audit-limits.ts` | `MIN_AUDIT_PAGES = 10`, `DEFAULT_AUDIT_PAGES = 50`, `MAX_AUDIT_PAGES = 10_000`, `RENDERED_MAX_AUDIT_PAGES = 1_000`, `LARGE_AUDIT_CONFIRM_PAGES = 500`, `LIGHTHOUSE_SAMPLE_MAX = 10`, `AUDIT_MONTHLY_PAGES_DEFAULT = 50_000`, `AUDIT_HOST_CAP = 2`, `clampAuditMaxPages(n?)`, `maxPagesFor(render: boolean, envMax: number)`, `estimatedCrawlMinutes(pages) = Math.max(1, Math.ceil(pages / 60))` (one page per second, §2 fact 9). |
| `src/shared/audit-fetch-class.ts` | COPY | `PAGE_FETCH_CLASSES`, `PageFetchClass`. |
| `src/shared/audit.ts` | new | Client-safe enums and labels: `AUDIT_STATUSES`, `AUDIT_PHASES`, `PHASE_LABELS = { queued: "Queued", starting: "Starting", discovery: "Discovery", crawling: "Crawling", lighthouse: "Lighthouse", finalizing: "Finalizing" }`, `AUDIT_ERROR_COPY` (§6.6.4), `AUDIT_CRAWLER_USER_AGENT = "Mozilla/5.0 (compatible; PerceevAudit/1.0; +https://perceev.xyz)"`, `AUDIT_ROBOTS_TOKEN = "PerceevAudit"`. |
| `src/shared/structured-data-rules.ts` | new | `STRUCTURED_DATA_REQUIRED: Record<string, Array<string \| string[]>>` (§6.2.3); an inner array means "one of". |
| `src/shared/lighthouse.ts` | COPY | `LIGHTHOUSE_CATEGORIES`, `LIGHTHOUSE_CATEGORY_TABS`. |
| `urlUtils.ts` | COPY `server/lib/audit/url-utils.ts` | `normalizeUrl`, `canonicalUrlKey`, `isSameOrigin`, `detectUrlTemplate`, `getOrigin`. |
| `ids.ts` | PORT `ids.ts` | `sha256Hex(text)`; `deterministicUuid(...parts: string[]): string` = sha256 of `parts.join("\|")`, first 32 hex digits formatted `8-4-4-4-12` with the version nibble set to `8` and the variant bits to `10` (a valid RFC 9562 v8 UUID). |
| `classifyFetch.ts` | COPY `classify-fetch.ts` | `classifyFetch(status, mitigated, bodySnippet)`. |
| `htmlResponse.ts` | PORT `html-response.ts` | `MAX_HTML_BYTES = 1_048_576`, `truncateToBytes(text, max)`, `decodeBody(bytes: Uint8Array): string` (UTF-8, replacement on error). |
| `urlPolicy.ts` | PORT subset of `url-policy.ts` | `isCrawlableUrl(url)` (sync: http/https, no credentials, F01 `isBlockedHostName`, and `classifyAddress` from `../ssrfGuard.js` for IP literals); `isOwnedHost(host, websiteHost)` (strip one leading `www.` from both; equal or `host.endsWith("." + base)`); `normalizeStartUrl(input)` (sync, no DNS; adds `https://`, drops the hash, refuses non-http(s) and credentials → `AppError(422,"invalid_url")`; `host:port` is not a scheme); `normalizeAndValidateStartUrl(input, deps)` = `normalizeStartUrl` + F01 `assertPublicUrl` (refusals mapped by `startUrlAppError` to 422 `url_blocked`, or `url_unreachable` for unresolvable names), used for every redirect hop — no second address policy (owner decision 2026-11-12); `resolveStartUrlRedirects(url, deps)` (≤ 5 hops, each `safeFetch(url, { method: "HEAD", maxRedirects: 0, timeoutMs: 10_000 })`; a HEAD that answers 405/501 is retried once as GET with `maxBytes: 1` + `truncate: true`; probe failures fall back to the last good URL, `url-policy.ts:257-311`); returns `{ url, poweredBy }`. |
| `pageAnalyzer.ts` | PORT `page-analyzer.ts` | `analyzeHtml(html, pageUrl, statusCode, responseTimeMs, redirectUrl?)` → `PageAnalysis` (§6.2.3). |
| `types.ts` | PORT `types.ts` | `AuditConfig = { maxPages; lighthouse: boolean; renderJavaScript: boolean; sitePlatform?: "shopify"; crawlerCredentialId?: string }`, `PageLink`, `PageAnalysis`, `CrawledPageResult` (OpenSEO fields + `hreflang`, `structuredData`, `structuredDataTypes`, `dataNosnippet`, `rendered`), `LighthouseResult`, `ClaimedUrl`, `FrontierStats`. |
| `structuredData.ts` | new (rule from `src/lib/repairs/technicalAudit.js:69-103`) | `inspectJsonLd(blocks: string[], visibleText: string): { blocks: Array<{ parseState: "valid" \| "invalid"; types: string[] }>; missingType: number; missingRequired: Array<{ type: string; missing: string[] }>; claimsNotVisible: Array<{ path: string; value: string }> }`. |
| `hreflang.ts` | new | `isValidHreflang(code)` (`/^(x-default\|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}\|\d{3}))?)$/i`), `pageHreflangProblems(page)`, `findMissingReturnLinks(pages)`. |
| `robotsFile.ts` | new | `fetchRobots(origin, deps)` → `{ status: "found" \| "missing" \| "error" \| "unreachable"; httpStatus: number \| null; text: string \| null }` (`safeFetch` GET `/robots.txt`, `maxRedirects: 5`, `maxBytes: 512_000`, `truncate: true`, 10 s; 404/410 → `missing`; other non-2xx → `error`; network/SSRF → `unreachable`); `parseAuditRobots(text)` → `parseRobotsTxt` from `../crawlers/robots.js` (malformed → status `malformed` upstream); `crawlerAllows(parsed, url)` = `evaluateBot(parsed, AUDIT_ROBOTS_TOKEN, pathAndQuery(url)).status !== "blocked"`. |
| `aiAccess.ts` | new (uses `../crawlers/bots.js`, `../crawlers/robots.js`) | `aiAccessRows(parsed, path)` → `AI_BOTS` × `evaluateBot` rows; `blockedAiBots(parsed, path)` → `{ search: string[]; agent: string[]; training: string[] }`. |
| `llmsTxt.ts` | new | `checkLlmsTxt(origin, deps)` → `{ status: "present" \| "missing" \| "invalid" \| "unreachable"; httpStatus; contentType; firstLine }` (GET `/llms.txt`, `maxRedirects: 3`, `maxBytes: 65_536`, `truncate: true`, 8 s). |
| `discovery.ts` | PORT `discovery.ts` | `discoverUrls(origin, maxPages, deps)` → `{ urls: string[]; robots: { status, httpStatus, text }; sitemapDocs: number; truncated: boolean }`. Constants as theirs plus `DISCOVERY_BUDGET_MS = 150_000` (no new sitemap fetch starts after it; `truncated = true`). Sitemap reads `safeFetch(url, { maxRedirects: 5, maxBytes: 10 * 1024 * 1024, timeoutMs: 15_000 })`; `response_too_large` → skipped whole. |
| `crawlWindow.ts` | PORT `crawl-window.ts` | `CRAWL_WINDOW = { initial: 2, min: 1, max: 4, budgetBytes: 32 MiB }`, `RETRY_CRAWL_WINDOW = { initial: 1, min: 1, max: 1, budgetBytes: 8 MiB }` (deviation: Vercel functions have 1–3 GB, not 128 MB), `clampCrawlWindow`, `adjustCrawlWindow` (logic unchanged). |
| `crawlThrottle.ts` | COPY `crawl-throttle.ts` | `createCrawlThrottle(deadlineAt, previous?, persist?, opts?: { initialIntervalMs?: number })` (opts added for tests; production 1,000 ms), `CrawlThrottleState`, `CrawlThrottle`. |
| `fetchPage.ts` | PORT `site-audit-workflow-helpers.ts` | `crawlPage(url, depth, inSitemap, throttle, opts: { access?; render?; renderThrottled?; deps: FetchDeps })` → `CrawledPageResult \| null` (§6.2.4). `FetchDeps = { safeFetch: typeof safeFetch; lookup: (h: string) => Promise<string[]>; now(): number }`; `createCachedLookup(ttlMs = 60_000)` memoises Node DNS answers per hostname so a chunk resolves its host once a minute (SSRF vetting still runs on every request). |
| `issues/pageReporters.ts` | PORT `page-reporters.ts` | `runPageReporters(page, ctx?: { robots: ParsedRobots \| null; robotsUsable: boolean })` → `DetectedIssue[]` (§6.2.5). |
| `issues/multipageChecks.ts` | PORT `multipage-checks.ts` | `findDuplicates`, `findRedirectChainsAndLoops` (unchanged), `findHreflangReturnLinks(pages)` (new). |
| `issues/multipage.ts` | PORT `multipage.ts` | `runMultipageChecks({ auditId, store })` reads slim pages 1,000 at a time and app-shell page ids, returns `{ issues, hasUnreadShells }`. |
| `store.ts` / `memoryStore.ts` | PORT of `AuditScratchpad.ts` + `AuditRepository.ts` | `AuditStore` interface (§6.2.6); `createSqlAuditStore(admin)`; `createMemoryAuditStore()`. |
| `crawlPhase.ts` | PORT `siteAuditWorkflowCrawl.ts` | `runCrawlPhase(ctx, params)`, `runCrawlChunk(input)` (§6.3). |
| `phases.ts` | PORT `siteAuditWorkflowPhases.ts` | `runDiscoveryPhase`, `runSiteChecks`, `runLighthousePhase`, `finalizeAudit`. |
| `job.ts` | PORT `SiteAuditWorkflow.ts`, `auditStepConfigs.ts` | Job kinds and periodics (§6.3); `AUDIT_STEPS` presets. |
| `errors.ts` | PORT `audit-errors.ts` | `AuditPhaseError extends Error { code; phase }`; `classifyAuditFailure(err)` → `{ errorCode, errorDetail }` with codes of the `site_audits.error_code` CHECK (F01 `StepFailedError.code` `step_timeout`/`step_attempts_exhausted`/`billed_step_interrupted` map through; others `unknown`); detail ≤ 500 chars with URL query strings removed. |
| `reconcile.ts` | PORT `auditReconciler.ts` | `reconcileRunningAudit(audit, deps)`, `reconcileStaleAudits(deps)` (§6.3). |
| `lighthouse.ts` | PORT `server/lib/audit/lighthouse.ts` | `selectLighthouseSample(pages, startUrl)` (unchanged rules, ≤ 10), `fetchLighthouseWave(...)`, `failedLighthouseFetch(...)`. |
| `lighthousePayload.ts` | PORT `dataforseoLighthousePayload.ts`, `lighthouseStoredPayload.ts`, `lighthousePayload.ts` | `parseDataforseoLighthousePayload`, `storedLighthousePayloadSchema`, `readStoredLighthousePayload`, `buildLighthouseExportFile` (zod v4; `.passthrough()` → `z.looseObject`). |
| `renderedPage.ts` | PORT `rendered-page.ts` onto Firecrawl | `renderPage(url, { apiKey, usage, fetchImpl? })` → `{ html, status }` (§6.2.9). |
| `service.ts` | PORT `AuditService.ts` | `startSiteAudit(ws, input, deps)`, `getAuditStatus`, `cancelAudit`, `deleteAudit`, `listAudits`, `auditCapabilities` (§6.5). |
| `results.ts` | new | `getAuditFeed`, `getAuditSummary`, `listAuditIssues`, `listAuditPages`, `listAuditPerformance`, `getLighthouseDetail`. |
| `cancel.ts` | new | `createCancelProbe(admin, auditId, ttlMs = 5_000)` → `() => Promise<boolean>` reading `site_audits.cancel_requested_at`. |
| `retention.ts` | new | `pruneSiteAudits(deps)`. |
| `telemetry.ts` | new | `captureAuditEvent(name, props)` → F26 server sink (`src/lib/telemetry/events.ts`) when present, else a no-op that logs nothing. |
| `tools.ts` | new | F22 tool definitions (§6.2.12). |
| `siteAudit.contract.ts` | new | Route contracts for §6.5. |
| `crawlerAccess.ts`, `crawlerAccessCrypto.ts`, `shopifySignature.ts` | PORT (P9) | §6.2.13. |
| `src/lib/providers/dataforseo/lighthouse.ts` | PORT `server/lib/dataforseo/lighthouse.ts` (F02 per-section rule) | `fetchLighthouseResult({ url, strategy })`; `createLighthouseClient() = { live: meter(fetchLighthouseResult, (i) => dataforseoPricing.lighthouse.live({}), "site_audit.lighthouse") }`. |
| `src/lib/pricing/actions/siteAudit.ts` | new | Priced action `site_audit.run` (§6.2.8). |
| `src/lib/export/kinds/siteAudit.ts` | new | F06 export kinds (§6.2.14). |

**Exported for other specs (stable signatures).** `fetchRobots` (`robotsFile.ts`), `aiAccessRows` and `blockedAiBots` (`aiAccess.ts`) and `checkLlmsTxt` (`llmsTxt.ts`) are public exports that F22's `check_ai_crawler_access` tool calls; `startSiteAudit` (`service.ts`, §6.2.7) is the entry point F27 calls for the baseline audit. Renaming or changing these signatures requires updating F22 and F27.

#### 6.2.2 Issue registry

The 30 OpenSEO entries are copied with their severity, title and explanation. In every `howToFix` the user agent `"OpenSEO-Audit"` becomes `"PerceevAudit"`, and the Shopify sentence ("On Shopify, use Crawler access … into OpenSEO under Settings → Crawler access.") is removed (P9's `ShopifyCrawlWarning` gives that advice). `slow-response`'s explanation becomes "The HTML took over 1.5 seconds to arrive. …" because F01 `safeFetch` times the whole response, not the headers (deviation). Categories: `crawl` (blocked-page, rate-limited-page, crawl-rate-limited, javascript-rendering-suspected), `links` (broken-internal-link, broken-page, server-error, redirect-chain, redirect-loop, orphan-page, no-outgoing-links, deep-page), `content` (missing-title, title-too-long, title-too-short, missing-meta-description, meta-description-too-long, meta-description-too-short, missing-h1, multiple-h1, heading-order-skip, thin-content, images-missing-alt, duplicate-title, duplicate-meta-description, duplicate-content), `indexability` (noindex-page, canonicalized-page, canonical-conflict), `performance` (slow-response). Scope `site` only for `crawl-rate-limited`.

The 18 Perceev entries (exact copy):

| Type | Sev. | Category / scope | Title | Explanation | How to fix |
|---|---|---|---|---|---|
| `crawl-blocked-by-robots` | critical | crawl / site | robots.txt blocks crawlers from your homepage | Your robots.txt disallows the start page for general crawlers (the `*` group, which our PerceevAudit crawler follows). Search engines and AI crawlers that obey the same group cannot read it either, so this audit could not check your pages. | If the site should be found, remove or narrow the `Disallow` rule that matches `/` in the `User-agent: *` group, then run the audit again. |
| `ai-search-crawler-blocked` | critical | ai_access / page | AI search crawlers are blocked | robots.txt disallows this page for AI search crawlers (listed below), such as OAI-SearchBot for ChatGPT search, Claude-SearchBot or PerplexityBot. Answer engines that obey robots.txt cannot fetch it to cite it. | If you want this page to appear in AI answers, allow these user agents in robots.txt (for example a `User-agent: OAI-SearchBot` group with `Allow: /`). Blocking training crawlers such as GPTBot is a separate choice and does not affect search crawlers. |
| `ai-agent-crawler-blocked` | warning | ai_access / page | AI assistant fetches are blocked | robots.txt disallows this page for AI assistants that fetch a page when a user asks about it (for example ChatGPT-User, Claude-User or Perplexity-User). Assistants that obey robots.txt will say they cannot open it. | Allow these user agents for pages you want assistants to read. They fetch only on a user's request; they are not training crawlers. |
| `ai-training-crawler-blocked` | info | ai_access / site | AI training crawlers are blocked | robots.txt blocks some AI training crawlers (listed below) from your homepage. That is a legitimate choice and does not stop AI search or assistant crawlers. | No action is needed if this is intended. If you want your content used to train these models, allow the listed user agents. |
| `robots-txt-unavailable` | warning | ai_access / site | robots.txt could not be read | robots.txt answered with an error or did not answer, so we could not tell which crawlers are allowed. Google treats a server error on robots.txt as "crawl nothing" for a while. Crawler access in this report is unverified. | Make `/robots.txt` return 200 with your rules, or 404 if you have none. Then run the audit again. |
| `robots-txt-malformed` | warning | ai_access / site | robots.txt has no valid rules | robots.txt returned content with no recognisable directives (often an HTML page served at /robots.txt). Crawlers treat it as allowing everything, and crawler access in this report is unverified. | Serve a plain-text robots.txt with `User-agent` groups and `Allow`/`Disallow` lines, or return 404 if you have no rules. |
| `llms-txt-missing` | info | ai_access / site | No llms.txt file | The site has no `/llms.txt`. It is an optional, emerging convention that gives AI tools a short guide to your most useful pages; no answer engine is known to require it. | Optionally add a Markdown file at `/llms.txt` starting with `# Your site name`, a one-line summary, and links to your key pages. |
| `llms-txt-invalid` | warning | ai_access / site | llms.txt is not valid Markdown | `/llms.txt` exists but is served as HTML or does not start with a `# ` title line, so tools that read it may ignore it. | Serve `/llms.txt` as `text/plain` or `text/markdown` and start it with a single `# Title` line. |
| `structured-data-invalid` | warning | structured_data / page | Structured data cannot be parsed | A `<script type="application/ld+json">` block on this page is not valid JSON, so search engines and AI tools ignore it. | Fix the JSON syntax (quotes, commas, brackets) and test the page in a structured-data validator. |
| `structured-data-missing-type` | warning | structured_data / page | Structured data has no @type | A JSON-LD object on this page has no `@type`, so nothing can tell what it describes. | Add the schema.org `@type` (for example `Organization`, `Product` or `Article`) to each JSON-LD object. |
| `structured-data-missing-required` | warning | structured_data / page | Structured data is missing key properties | A JSON-LD object lacks properties Google documents as required for its type (listed below). Incomplete markup is usually ignored. | Add the missing properties with values that match what the page shows. Markup helps machines read the page; it does not guarantee rich results or AI citations. |
| `structured-data-not-visible` | warning | structured_data / page | Structured data claims aren't on the page | Some JSON-LD values (names, descriptions, prices, ratings or SKUs, listed below) do not appear in the page's visible text. Search engines may treat markup that contradicts the page as spam. | Make the markup match the visible content, or show the same facts on the page. |
| `no-structured-data` | info | structured_data / page | No structured data | This indexable page has no JSON-LD. Structured data helps search engines and AI tools identify your organisation, products and articles. | Add JSON-LD for what the page is about (for example `Organization` on the homepage, `Product` on product pages, `Article` on posts). |
| `missing-og-tags` | info | social / page | Open Graph tags missing | The page lacks one or more of `og:title`, `og:description` and `og:image` (listed below). Social networks, chat apps and some AI tools use them for link previews. | Add the missing `<meta property="og:…">` tags with a page-specific title, description and an absolute image URL. |
| `hreflang-invalid` | warning | international / page | Invalid hreflang annotation | An `hreflang` value is not a valid language(-region) code or `x-default`, or its `href` is not an absolute http(s) URL (listed below). Search engines ignore invalid annotations. | Use ISO 639-1 language codes with optional ISO 3166-1 region codes (for example `en-GB`) and absolute URLs. |
| `hreflang-missing-self` | info | international / page | hreflang has no self-reference | The page lists language alternates but none points to the page itself. Google expects each page in a set to include itself. | Add an `hreflang` link for this page's own language pointing at its own URL. |
| `hreflang-no-return-link` | warning | international / page | hreflang alternate does not link back | This page lists an alternate that we crawled, but that alternate does not list this page back. Search engines ignore one-way hreflang pairs. | Add the reciprocal `hreflang` link on the alternate page (listed below). |
| `snippet-restricted` | warning | indexability / page | Snippets are restricted | The page limits what can be quoted (`nosnippet`, `max-snippet:0` or `data-nosnippet`, listed below). Search results and AI answers may show no text from it. | Remove the restriction from pages you want quoted, or narrow `data-nosnippet` to the exact text that must not be shown. |

`src/shared/audit-issues.test.ts` asserts 48 keys, valid severities/categories/scopes, non-empty strings, and that no entry contains "OpenSEO".

#### 6.2.3 Analyzer additions (`pageAnalyzer.ts`)

`analyzeHtml` keeps OpenSEO's tokenizer, caps and app-shell heuristic (`page-analyzer.ts:17-283`) and adds, without building a DOM:

- `hreflang: Array<{ lang: string; href: string | null }>` from `<link rel="alternate" hreflang href>` (≤ 50; `href` resolved with `normalizeUrl(href, pageUrl)`); `hreflangTags` (codes) is kept for parity.
- `jsonLdBlocks: string[]`: text inside `<script type="application/ld+json">` (type compared case-insensitively after trimming parameters), captured **before** the non-content suppression check in `ontext`; at most 20 blocks, each cut at 65,536 characters (a cut block is reported `invalid`).
- `dataNosnippet: boolean`: any open tag carrying a `data-nosnippet` attribute outside `<noscript>`.
- Title, meta description, robots meta, OG fields, canonical, headings, images, links and word count are extracted exactly as OpenSEO does.

`inspectJsonLd(blocks, bodyText)` (in `structuredData.ts`): `JSON.parse` each block; collect objects from the root, arrays and `@graph` arrays (depth ≤ 6, ≤ 200 objects); `types` = string or array `@type` values with any `schema.org/` prefix removed; an object (not nested under another typed object's property) without `@type` counts to `missingType`; for each object whose type is a key of `STRUCTURED_DATA_REQUIRED`, missing properties (an empty string, `null` or empty array counts as missing; an inner array means one of) go to `missingRequired`; claims are values of `name`, `description`, `price`, `ratingValue`, `sku` that are strings or numbers (R15's set, `technicalAudit.js:78-90`), and a claim is "not visible" when `bodyText.toLowerCase()` does not include `String(value).toLowerCase().trim()` (claims shorter than 3 characters are ignored; at most 20 reported).

`STRUCTURED_DATA_REQUIRED` (minimum fields Google documents for each rich-result type, read October 2026): `Organization: ["name", "url"]`, `LocalBusiness: ["name", "address"]`, `Product: ["name", ["offers", "review", "aggregateRating"]]`, `Article: ["headline"]`, `NewsArticle: ["headline"]`, `BlogPosting: ["headline"]`, `FAQPage: ["mainEntity"]`, `BreadcrumbList: ["itemListElement"]`, `WebSite: ["name", "url"]`, `Event: ["name", "startDate", "location"]`, `Recipe: ["name", "image"]`, `Review: ["itemReviewed", "author"]`, `JobPosting: ["title", "description", "datePosted", "hiringOrganization"]`, `VideoObject: ["name", "thumbnailUrl", "uploadDate"]`. Only exact type names are checked (subtypes are not inferred).

#### 6.2.4 Fetching a page (`fetchPage.ts`)

PORT of `crawlPage`/`fetchPage` (`site-audit-workflow-helpers.ts:29-277`) with these changes:

1. The request is `deps.safeFetch(url, { method: "GET", headers: { "user-agent": AUDIT_CRAWLER_USER_AGENT, accept: "text/html,application/xhtml+xml", ...crawlerHeadersFor(url, access) }, maxRedirects: 0, maxBytes: MAX_HTML_BYTES, truncate: true, timeoutMs: 15_000 }, { lookup: deps.lookup })`. With `maxRedirects: 0` a 3xx comes back unfollowed with `Location` (conventions §5.6). Non-HTML bodies are still read up to 1 MiB and discarded (`safeFetch` buffers; OpenSEO skipped the read).
2. `responseTimeMs` is the whole `safeFetch` duration (F01 buffers the body), measured with `deps.now()` around the last attempt.
3. An `SsrfBlockedError` (a link that resolves to a private address) produces `emptyPageResult({ fetchClass: "error", statusCode: 0 })` with `blockedReason: "url_blocked"`, stored as `x_robots_tag = NULL` and reported nowhere else; the URL is never requested. `AppError` `response_too_large` cannot occur (truncate mode).
4. The throttle, 429 back-off, challenge detection, render hand-off (`render` only for HTML `ok` < 400, challenged except 401, or Shopify 429 with `renderThrottled`), Link-header canonical, indexability, heading counts, content hash and `structuredClone` detach are unchanged.
5. New fields are filled from the analysis: `hreflang`, `structuredData = inspectJsonLd(jsonLdBlocks, bodyText)` (skipped for app shells), `structuredDataTypes` (unique, ≤ 20), `dataNosnippet`, `rendered`.

#### 6.2.5 Page reporters (`issues/pageReporters.ts`)

OpenSEO's order, thresholds and short-circuits are unchanged (`page-reporters.ts:50-186`). After the "Structure" block, for analysed, `ok`, 2xx HTML pages that are not app shells:

| Check | Issue | `details` |
|---|---|---|
| `ctx.robotsUsable` and `blockedAiBots(ctx.robots, pathAndQuery(url)).search.length > 0` | `ai-search-crawler-blocked` | `{ bots: string[] }` |
| same, `.agent.length > 0` | `ai-agent-crawler-blocked` | `{ bots: string[] }` |
| any parsed JSON-LD block `invalid` | `structured-data-invalid` | `{ blocks: n }` |
| `missingType > 0` | `structured-data-missing-type` | `{ objects: n }` |
| `missingRequired.length > 0` | `structured-data-missing-required` | `{ items: [{ type, missing }] }` (≤ 10) |
| `claimsNotVisible.length > 0` | `structured-data-not-visible` | `{ claims: [{ path, value ≤ 100 chars }] }` |
| `isIndexable && wordCount ≥ 150 && jsonLdBlocks.length === 0` | `no-structured-data` | — |
| `isIndexable` and any of `ogTitle`, `ogDescription`, `ogImage` empty | `missing-og-tags` | `{ missing: ["og:image", …] }` |
| any hreflang entry with invalid code or `href` null/not http(s) | `hreflang-invalid` | `{ entries: [{ lang, href }] }` (≤ 10) |
| hreflang entries exist and none has `href === url` (after `normalizeUrl`) | `hreflang-missing-self` | `{ alternates: n }` |
| robots meta or `X-Robots-Tag` contains `nosnippet` or `max-snippet: ?0` (case-insensitive), or `dataNosnippet` | `snippet-restricted` | `{ sources: ["meta:robots" \| "x-robots-tag" \| "data-nosnippet"] }` |

`ai-*-crawler-blocked` is evaluated for every 2xx `ok` HTML page including app shells (robots rules do not depend on content). `ctx.robotsUsable` is true only for robots status `found` or `missing` (an empty file allows all, `robots.js:289-291`); `error`/`unreachable`/`malformed` produce the site-level issue instead and no bot verdicts (F18-AC-06).

Site-level issues (`pageId: null`, `pageUrl: startUrl`, `dedupeKey: "site"`) are produced by `runSiteChecks` (§6.3): `crawl-blocked-by-robots` (our token blocked for the start path), `ai-training-crawler-blocked` (`details.bots`), `robots-txt-unavailable` (`details.status`, `httpStatus`), `robots-txt-malformed`, `llms-txt-missing`, `llms-txt-invalid` (`details.contentType`, `firstLine` ≤ 100 chars), and, at finalize, `crawl-rate-limited`.

`findHreflangReturnLinks(pages)`: for each `ok` 2xx page A and each hreflang entry `(lang, B)` with `B ≠ A` where B was crawled as `ok` 2xx, report `hreflang-no-return-link` on A with `dedupeKey: B` and `details: { alternate: B, lang }` when B's `hreflang` hrefs do not include A. App-shell pages are skipped.

#### 6.2.6 Store (`store.ts`)

```ts
export type AuditRow = { id: string; brand_key: string; job_id: string | null; status: AuditStatus; current_phase: AuditPhase;
  start_url: string; start_host: string; max_pages: number; run_lighthouse: boolean; render_javascript: boolean;
  site_platform: "shopify" | null; robots_status: RobotsStatus | null; robots_txt: string | null; window_hint: number;
  throttle_state: CrawlThrottleState | null; render_hold_id: string | null; render_approved_usd: number | null;
  render_attempts: number; render_billed: number; render_settled_at: string | null; lighthouse_approved_usd: number | null;
  pages_crawled: number; pages_total: number; pages_abandoned: number; link_graph_complete: boolean;
  cancel_requested_at: string | null; created_at: string; started_at: string | null; completed_at: string | null };
export interface AuditStore {
  getAudit(auditId: string): Promise<AuditRow | null>;
  updateAudit(auditId: string, jobId: string, patch: Partial<AuditRow>): Promise<void>;   // WHERE id AND job_id (fencing as theirs)
  failAudit(auditId: string, info: { errorCode: string; errorDetail: string; failedPhase: string | null }): Promise<boolean>; // only from queued/running
  seedStart(auditId: string, url: string): Promise<void>;
  seedSitemap(auditId: string, urls: string[]): Promise<void>;             // callers pass ≤ 2,000 per call
  claimChunk(auditId: string, chunkNo: number, limit: number): Promise<{ urls: ClaimedUrl[]; isRetry: boolean }>;
  recordBatch(auditId: string, input: { crawledUrls: string[]; links: Array<{ pageId: string; url: string; targets: string[] }>;
    discovered: Array<{ url: string; depth: number | null }> }): Promise<FrontierStats>;
  releaseUrls(auditId: string, urls: string[]): Promise<void>;
  abandonChunk(auditId: string, chunkNo: number): Promise<number>;
  stats(auditId: string): Promise<FrontierStats>;                          // { attempted, pending, abandoned, seen }
  saveThrottle(auditId: string, state: CrawlThrottleState): Promise<void>;
  upsertPages(audit: { id: string; brandKey: string }, pages: CrawledPageResult[]): Promise<void>;
  insertIssues(audit: { id: string; brandKey: string }, issues: DetectedIssue[]): Promise<void>; // insert-or-ignore, 500 per call
  listSlimPages(auditId: string, afterId: string | null, limit: number): Promise<SlimPage[]>;
  shellPageIds(auditId: string): Promise<Set<string>>;
  brokenLinks(auditId: string, cap: number): Promise<BrokenLinkRow[]>;
  orphanPages(auditId: string, startUrl: string): Promise<Array<{ pageId: string; url: string }>>;
  countPagesByFetchClass(auditId: string, fetchClass: PageFetchClass): Promise<number>;
  hasPages(auditId: string): Promise<boolean>;
  lighthouseCandidates(auditId: string): Promise<Array<{ id: string; url: string; statusCode: number; fetchClass: PageFetchClass }>>;
  insertLighthouse(audit: { id: string; brandKey: string }, rows: LighthouseResult[]): Promise<void>;     // upsert on (audit,page,strategy)
  destroyScratch(auditId: string): Promise<void>;
}
```

`createSqlAuditStore(admin)` maps each method to the §6.1 functions or PostgREST calls (`site_audit_pages` upsert `onConflict: "id"`, issues `upsert(rows, { onConflict: "id", ignoreDuplicates: true })` in 500-row batches; PORT of `auditIssueWrites.ts:10-45`). Page text columns are truncated before writing: `title` 1,000, `meta_description` 2,000, OG fields 2,000, `robots_meta`/`x_robots_tag` 500. `createMemoryAuditStore()` implements the same semantics with Maps (used by unit tests and the fixture-site test). `recordBatch` passes `SITE_AUDIT_LINK_BUDGET` (default 3,000,000 targets).

#### 6.2.7 Start rules (`service.ts` `startSiteAudit`)

```ts
export type StartAuditInput = { startUrl?: string; maxPages: number; lighthouse: boolean; renderJavaScript: boolean;
  maxUsd?: number; trigger?: "manual" | "baseline" | "tool" };
export async function startSiteAudit(ws: Workspace, input: StartAuditInput, deps?: StartDeps):
  Promise<{ auditId: string; jobId: string; status: "queued"; pollAfterSeconds: 3; approvedMaxUsd: number | null }>;
```

Order (each refusal is an `AppError` with the §6.5.2 copy):
1. `isFeatureEnabled("site_audit", brandKey)` else 404 `feature_unavailable`. `lighthouse` → `site_audit_lighthouse` else 403 `feature_disabled`; `renderJavaScript` → `site_audit_render` else 403, and `FIRECRAWL_API_KEY` present else 503 `render_unavailable`.
2. `maxPages` within `[10, min(SITE_AUDIT_MAX_PAGES ?? 10,000, 10,000)]` else 422 `page_limit`; with rendering ≤ 1,000 else 422 `render_page_limit`.
3. `normalizeStartUrl(input.startUrl ?? ws.brand.website)`; unless `SITE_AUDIT_ALLOW_ANY_HOST=on`, `isOwnedHost(host, ws.brand.website_host)` else 422 `audit_host_not_owned`.
4. `assertPublicUrl(url)` (`../ssrfGuard.js`): policy refusal → 422 `url_blocked`; unusable (DNS) → 422 `url_unreachable`. The site itself is first contacted by the job (`siteAuditStart.ts:12-16`), so a slow site never delays the response.
5. `requireApprovedPrice("site_audit.run", pricingCtx, { maxPages, lighthouse, renderJavaScript }, input.maxUsd)` (F09). If it returns `source: "implicit"` and `quote.totalUsd > 0` → 400 `approval_required` with `details.quote` (the action is registered with `requireApproval: false` so free audits need no dialog; paid ones always do).
6. `auditId = crypto.randomUUID()`; RPC `site_audit_create(..., p_month_start = first day of the current UTC month, p_monthly_cap = SITE_AUDIT_MONTHLY_PAGES ?? 50,000, p_host_cap = 2)`; `created: false` → 409 with the reason's code.
7. Rendering hold: `reserveSpend({ brandKey, feature: "site_audit.render", estimateUsd: maxPages × firecrawlScrapeUsd(), maxUsd: approvedMaxUsd − lighthouseLineUsd, idempotencyKey: "site_audit:" + auditId + ":render", ttlSeconds: 86_340, subject: { kind: "site_audit", id: auditId } })`. A refusal deletes the audit row and rethrows (402/403/409 via `toErrorResponse`).
8. `enqueueJob("site_audit.run", { auditId }, { brandKey, singleActiveKey: "site_audit:" + brandKey, trigger: input.trigger === "baseline" ? "baseline" : "manual", createdBy: ws.user.id })`. Any error → `releaseSpend(hold, "audit_start_failed")`, delete the row, rethrow (`AuditService.ts:153-164` pattern).
9. Update the row: `job_id`, `render_hold_id`, `render_approved_usd`, `lighthouse_approved_usd` (the quote's Lighthouse line), `approved_max_usd`, `price_quote`. `recordApproval(...)` when `source === "dialog"` (failure logged as `[audit] approval record failed`, not fatal).
10. `captureAuditEvent("site_audit:start", { max_pages, lighthouse, render_js, trigger })`.

`startSiteAudit` is the entry point F27 calls with `{ maxPages: 50, lighthouse: false, renderJavaScript: false, trigger: "baseline" }`.

#### 6.2.8 Priced action (`src/lib/pricing/actions/siteAudit.ts`)

```ts
export const siteAuditInput = z.strictObject({
  maxPages: z.int().min(10).max(10_000).default(50),
  lighthouse: z.boolean().default(false),
  renderJavaScript: z.boolean().default(false),
});
export const siteAuditAction = definePricedAction({
  key: "site_audit.run", feature: "site_audit.render", input: siteAuditInput, requireApproval: false, estimate: estimateSiteAudit });
```

`feature` is the registry's single spend feature field; F18 records both features' spend itself (§6.4). `estimateSiteAudit` returns:
- `lines`: always `{ label: "Crawl up to {maxPages} pages", quantity: maxPages, unitUsd: 0, totalUsd: 0 }`; with Lighthouse `{ label: "Lighthouse checks (up to 10 pages, mobile and desktop)", quantity: 20, unitUsd: LIGHTHOUSE_LIVE_USD, totalUsd: 20 × unit }`; with rendering `{ label: "Pages loaded by a browser service", quantity: maxPages, unitUsd: firecrawlScrapeUsd(), totalUsd: maxPages × unit }`. Sums use F01 integer micro-dollars.
- `totalUsd` = sum; `expectedUsd: null`; `units`: `pages`, `lighthouse_checks`, `rendered_pages`; `monthly: null`.
- `warnings`: `free_crawl` "Crawling is free. Only Lighthouse checks and JavaScript rendering cost money." (always); with Lighthouse `lighthouse_sample` "Lighthouse runs on up to 10 pages, one per page template, so you may pay for fewer than 20 checks."; with rendering `render_unused` "You are charged only for pages the browser service loads. Unused reservation is released when the audit ends."
- `blocked`: `audit_already_running` when the workspace has an active audit ("An audit is already running for this workspace."); `render_page_limit` when rendering and `maxPages > 1,000`.

F18 uses **`site_audit.run`** because Lighthouse is priced by the same action; F09 §6.2.5 lists it under this name.

#### 6.2.9 Lighthouse client and rendering

- `src/lib/providers/dataforseo/lighthouse.ts`: `fetchLighthouseResult({ url, strategy })` = `dataforseoPost("/v3/on_page/lighthouse/live/json", [{ url, for_mobile: strategy === "mobile", categories: ["performance","accessibility","best_practices","seo"] }], { timeoutMs: 60_000 })`, then `assertOk`, `buildTaskBilling(task)` **before** parsing so a malformed payload still carries its cost (`dataforseo/lighthouse.ts:64-81`); parse failure → F01 `ChargedCallError`. A per-process parse lock (`withParseLock`, `:21-33`) is kept so concurrent multi-MB parses never pile up in one function instance. Returns `DataforseoApiResponse<StoredLighthousePayload>`. POST errors follow F02 §6.2.2 (no retries).
- `renderedPage.ts` `renderPage(url, { apiKey, usage, fetchImpl })`: refuses `!isCrawlableUrl(url)` or credentials; `POST https://api.firecrawl.dev/v1/scrape` with `{ url, formats: ["rawHtml"], onlyMainContent: false, waitFor: 1000, timeout: 30000 }`, `Authorization: Bearer <FIRECRAWL_API_KEY>`, `AbortSignal.timeout(35_000)`; response read through `readTextUpTo(…, 8 × MAX_HTML_BYTES)` and parsed with `z.looseObject({ success: z.literal(true), data: z.looseObject({ rawHtml: z.string(), metadata: z.looseObject({ statusCode: z.number().int().optional(), url: z.string().optional(), sourceURL: z.string().optional() }) }) })`; `usableHtml(url, metadata.url ?? metadata.sourceURL ?? url, rawHtml)` as `rendered-page.ts:64-72`; `usage.attempts += 1` always, `usage.billed += 1` when the response is HTTP 200 with `success: true` or the request timed out (ambiguous), never for 4xx; HTTP status ≥ 400 or `classifyFetch(status, false, html) !== "ok"` → throw. Nothing raw is logged; one line `[audit] render { auditId, outcome, httpStatus }`.

#### 6.2.10 Results readers (`results.ts`)

- `getAuditFeed(admin, ws, auditId, limit)`: `site_audit_pages` `select url,status_code,title,crawled_at order by crawled_at desc limit n` (replaces OpenSEO's KV list, `progress-kv.ts`: the page table already holds every crawled row).
- `getAuditSummary(admin, ws, auditId)`: audit row (allowlisted columns), `site_audit_issue_summary`, counts by fetch class, average response time over `ok` pages, Lighthouse averages excluding failures, the stored `ai_access` and `llms_txt`, and flags `siteBlocked` (completed, ≤ 1 page crawled, no `javascript-rendering-suspected`, no rate-limited page; `AuditDetail.tsx:107-118`), `crawlStopped` (`crawl-rate-limited` present), `hasShells`, `unreadRendered` (render on and `error` pages > 0).
- `listAuditIssues(admin, ws, auditId, { type, offset, limit })`: rows ordered by `page_url`; `total` from a count query.
- `listAuditPages(admin, ws, auditId, filters)`: PORT of `AuditResultsTableFilterLogic.ts:76-197` as SQL filters (`ilike` on url/title/meta for `q`; `status`: `ok` 200–299, `redirect` 300–399, `error` ≥ 400, `missing` NULL or 0; numeric ranges; `missingAlt`; `issueType` = `id IN (select page_id from site_audit_issues where audit_id = $1 and issue_type = $2)`); sort columns `url,status_code,title,h1_count,word_count,images_missing_alt,response_time_ms`.
- `listAuditPerformance`: Lighthouse rows joined to page URL/path.
- `getLighthouseDetail(admin, ws, auditId, resultId)`: row → Storage `site-audit-lighthouse` download → `readStoredLighthousePayload` → `{ id, finalUrl, strategy, createdAt, hasIssueDetails, scores, metrics, issues }` (`serverFunctions/lighthouse.ts:46-67`).

#### 6.2.11 R15 parity map (`src/lib/audit/r15Parity.ts`)

| R15 code (`technicalAudit.js`) | F18 issue type(s) |
|---|---|
| `access_denied` (403) | `blocked-page` |
| `http_status` (4xx/5xx) | `broken-page` / `server-error` |
| `restrictive_directive` with `noindex`/`none` | `noindex-page` |
| `restrictive_directive` with `nosnippet`/`max-snippet:0` | `snippet-restricted` |
| `data_nosnippet` | `snippet-restricted` |
| `canonical_other_url` | `canonicalized-page` |
| `insufficient_source_text` (< 150 characters) | `thin-content` (< 150 words; every R15 positive is also an F18 positive) |
| `structured_data_requires_review` (invalid JSON) | `structured-data-invalid` |
| `structured_data_requires_review` (claim not visible) | `structured-data-not-visible` |
| per-bot robots verdicts | `ai-search-crawler-blocked`, `ai-agent-crawler-blocked`, `ai-training-crawler-blocked` |

#### 6.2.12 Registries, tools and registrations

- `src/components/portal/audit/tabs.ts` (owned here; F19 §6.6.3 types verbatim):
  ```ts
  export type AuditTab = { id: string; label: string; flag?: string;
    Panel: ComponentType<{ brandKey: string; auditId: string | null }> };
  export const AUDIT_TABS: AuditTab[] = [{ id: "audit", label: "Site audit", Panel: SiteAuditPanel }];
  ```
  `SiteAuditPanel` renders `LaunchView` when `auditId` is null and `AuditDetail` otherwise. F19 appends `{ id: "indexnow", … }`.
- `src/components/portal/audit/pageActions.ts`:
  ```ts
  export type AuditPageRef = { url: string; statusCode: number | null; indexable: boolean | null };
  export type AuditPageAction = { id: string; label: string; flag?: string; icon?: LucideIcon;
    eligible(page: AuditPageRef): boolean;
    Dialog: ComponentType<{ brandKey: string; auditId: string; pages: AuditPageRef[]; onClose(): void }> };
  export const AUDIT_PAGE_ACTIONS: AuditPageAction[] = [];
  ```
- `src/lib/audit/tools.ts` (F07 §6.2.8 shape, handler ctx `{ admin, brand, userId }`):
  - `run_site_audit`: "Start a crawl of this workspace's website (10–10,000 pages) that checks technical SEO, AI-crawler access in robots.txt, llms.txt, structured data, Open Graph and hreflang. Free without Lighthouse or JavaScript rendering; those are paid: get a price estimate first and pass the approved maxUsd. One audit runs at a time." Input `z.strictObject({ maxPages: z.int().min(10).max(10000).default(50), lighthouse: z.boolean().default(false), renderJavaScript: z.boolean().default(false), maxUsd: z.number().positive().max(1000).optional() })`; output `z.looseObject({ auditId: z.uuid(), status: z.string() })`; handler → `startSiteAudit(..., trigger "tool")`.
  - `get_site_audit_status`: input `{ auditId?: uuid }` (latest when absent); output status, phase, pages crawled/total, Lighthouse counts, error code.
  - `get_site_audit_issues`: input `{ auditId?: uuid; severity?: enum; issueType?: string; limit: 1..200 default 50 }`; output issue groups with title, severity, pages, howToFix and up to `limit` URLs per group.
  - `get_site_audit_pages`: input `{ auditId?: uuid; issueType?: string; status?: enum; limit: 1..200 default 50 }`; output page rows.
  - `list_site_audits`: input `{ limit: 1..50 default 10 }`; output history rows.
- `src/shared/spend-features.ts`: `SPEND_FEATURES` gains `"site_audit.lighthouse"`, `"site_audit.render"`; `SPEND_FEATURE_LABELS` gains "Site audit Lighthouse checks", "Site audit JavaScript rendering".
- `src/lib/features/names.ts`: `site_audit: { spend: [] as const }`, `site_audit_lighthouse: { spend: ["site_audit.lighthouse"] as const }`, `site_audit_render: { spend: ["site_audit.render"] as const }`, `site_audit_crawler_access: { spend: [] as const }` (P9). `src/lib/features/clientFeatures.ts` appends the four names.
- `src/lib/jobs/kinds.ts`: `import "../audit/job.ts";`.
- `src/components/app/navigation/items.ts`: group `site`, `{ id: "site-audit", label: "Site Audit", href: "/portal/audit", icon: ScanSearch, flag: "site_audit" }` (conventions §12).
- Telemetry names (F26 registers them in `src/lib/telemetry/events.ts`; until it exists, `src/components/portal/audit/telemetry.ts` (exports `setAuditEventTracker(fn)`; no-op until F26 wires it, F26 §6.2.7) `trackAuditEvent` and `src/lib/audit/telemetry.ts` (exports `setAuditServerTracker(fn)`; no-op until F26 wires it, F26 §6.2.7) are no-op sinks): client `site_audit:launch_open {}`, `site_audit:large_confirm { pages }`, `site_audit:cancel {}`, `site_audit:delete {}`, `site_audit:lighthouse_open { strategy }`, `site_audit:compare_open {}`, `site_audit:view_change { view }`; server `site_audit:start { max_pages, lighthouse, render_js, trigger }`, `site_audit:complete { status, pages_crawled, pages_total, crawl_completed, pages_blocked, pages_rate_limited, pages_abandoned, lighthouse, render_js, error_code, failed_phase }`.
- Route contracts: `src/lib/audit/siteAudit.contract.ts` exports `contracts` for every §6.5 route.

#### 6.2.13 Shopify crawler access (P9, optional)

PORT of `shared/crawler-access.ts` (unchanged pure helpers: `crawlerHeadersFor`, `normalizeCrawlerHost`, `parseSignatureExpiry`, `isCrawlerAccessExpired`, `SHOPIFY_SIGNATURE_AGENT`), `shopifySignature.ts` (key directory fetch through `safeFetch`, 5 s, Ed25519 verify with Node `crypto.subtle`; an unreachable directory never blocks a save), and `CrawlerCredentialService.ts` (list/save/delete/resolve/open). Encryption: `crawlerAccessCrypto.ts`, AES-256-GCM with key `CRAWLER_ACCESS_ENCRYPTION_KEY` (64 hex chars), AAD `crawler:<brandKey>:<host>:<field>`, the PATTERN of `src/lib/gsc/oauthCrypto.js`; a separate key because the crawler handles untrusted sites (`CrawlerCredentialService.ts:29-31`). Decryption happens only inside the crawl step and the decrypted headers are never returned, stored in step outputs, logged or sent to Firecrawl. `resolveAuditStart` sets `site_platform = "shopify"` when a credential exists, `powered-by` contains "shopify", or `isShopifyHost` (A record in 23.227.38.0/24 via `deps.lookup`).

#### 6.2.14 Export kinds (`src/lib/export/kinds/siteAudit.ts`, F06)

| Kind | Params | `maxRows` | CSV headers |
|---|---|---|---|
| `site_audit_issues` | `z.strictObject({ auditId: z.uuid(), issueType: z.string().max(64).optional() })` | 50,000 | `Severity, Issue, URL, Details, How to fix` (OpenSEO `export.ts:8`) |
| `site_audit_pages` | `z.strictObject({ auditId: z.uuid() })` | 10,000 | `URL, Status, Fetch result, Title, H1, Words, Images, Missing alt, Response time (ms), Depth, In sitemap, Indexable, Structured data types` |
| `site_audit_performance` | `z.strictObject({ auditId: z.uuid() })` | 20 | `URL, Device, Performance, Accessibility, Best practices, SEO, LCP (ms), CLS, INP (ms), TTFB (ms), Error` |

`load` checks the audit belongs to `brandKey` (else 422 `no_rows`). `filename`: `exportFilename([brandKey, "site-audit", host, kindSuffix]) + "." + format`. JSON: `{ exportedAt, brandKey, audit: { id, startUrl, startedAt, status }, rows }`. The client also exports the visible table through `useExportRows` (`feature: "audit_issues" | "audit_pages" | "audit_performance"`, as OpenSEO).

### 6.3 Jobs

Job kind `site_audit.run` (`src/lib/audit/job.ts`), payload `z.strictObject({ auditId: z.uuid() })`, options `{ pollAfterSeconds: 3, deadlineSeconds: 21_600, maxInvocations: 600, leaseSeconds: 300 }`. Steps run in order; names are stable (replay memoisation). A crawl runs at about one page per second (§2 fact 9): 50 pages ≈ 1 minute, 10,000 pages ≈ 3 hours; each tick invocation (240 s) fits one 150 s crawl chunk, then self-continues.

| # | Step name | Options | Work | Output (< 64 KB) |
|---|---|---|---|---|
| 1 | `validate` | `DB_STEP` | Row exists, `job_id` matches, status `queued` → set `running`, phase `starting`, `started_at` | `{ maxPages, lighthouse, render, startUrl }` |
| 2 | `resolve-start` | `{ timeoutMs: 90_000, retries: 2 }` | `resolveStartUrlRedirects`; final host must pass `isOwnedHost` (else `AuditPhaseError("start_url_off_site")`); Shopify detection (P9); `updateAudit(start_url, start_host, site_platform)` | `{ startUrl, origin, sitePlatform }` |
| 3 | `discover` | `{ timeoutMs: 200_000, retries: 1 }` | phase `discovery`; `discoverUrls(origin, maxPages)`; robots text, status and HTTP status written to the row (`malformed` when `parseRobotsTxt(text).malformed`); seeds start URL (if `crawlerAllows`) and sitemap URLs (same-origin, crawlable, allowed) in batches of 2,000; `pages_total = min(seeded, maxPages)`, phase `crawling` | `{ seededCount, discoveryTruncated }` |
| 4 | `site-checks` | `{ timeoutMs: 60_000, retries: 2 }` | `checkLlmsTxt`; `aiAccessRows(robots, startPath)` → `ai_access`; site-level issues (§6.2.5) | `{ siteIssues: n }` |
| 5…n | `crawl-chunk-<k>` | without rendering `{ timeoutMs: 150_000, retries: 1 }`; with rendering `{ timeoutMs: 150_000, retries: 0, billed: true }` | §6.3.1 | `{ attemptedInChunk, attempted, pending, seen, endWindow, rateLimited, throttleState, resumeAt, finishedAt, renderUsage, cancelled }` |
| — | `crawl-abandon-<k>` | `DB_STEP` | only after `crawl-chunk-<k>` failed (`StepFailedError`): `abandonChunk`; three abandoned chunks end the crawl phase with `crawlFailed` | `{ abandoned }` |
| — | `crawl-cooldown-<k>` | `step.sleep` | when `resumeAt` is set: `ceil((resumeAt − finishedAt) / 1000)` seconds (from the step output, so replays sleep the same step) | — |
| — | `lighthouse-select` | `DB_STEP` | when Lighthouse: phase `lighthouse`; `selectLighthouseSample` over `lighthouseCandidates`; `lighthouse_total = 2 × n` | `{ pages: [{ id, url }] }` (≤ 10) |
| — | `lighthouse-wave-<w>` | `{ timeoutMs: 140_000, retries: 0, billed: true }` | up to 5 URLs × mobile + desktop concurrently through `createLighthouseClient().live` (`metered`, feature `site_audit.lighthouse`, `idempotencyKey: jobStepKey(ctx, step) + ":" + pageId + ":" + strategy`, `jobId`); before the wave, `spent + calls × LIGHTHOUSE_LIVE_USD > lighthouse_approved_usd + 0.000001` skips the wave with error message "Lighthouse budget reached"; each result's compact payload uploaded to Storage inside the step with 2 in-process attempts; an upload failure keeps the scores and sets `error_message = "Report details could not be stored."`; the step never throws after a paid call | `{ results: LighthouseResult[] }` (≤ 10, no payloads) |
| — | `lighthouse-persist-<w>` | `DB_STEP` | `insertLighthouse`; counters | `{ completed, failed }` |
| — | `multipage-checks` | `{ timeoutMs: 200_000, retries: 2 }` | phase `finalizing`; integrity guard (pages claimed but none stored → `AuditPhaseError("db_error")`); `runMultipageChecks`; `brokenLinks(2,000)`; `orphanPages` only when `crawl.completed && link_graph_complete && !hasUnreadShells`; `crawl-rate-limited` when rate limited; `insertIssues` | `{ issueCount }` |
| — | `finalize` | `DB_STEP` | status `partial` if rate limited, cancelled-in-chunk, or `pages_abandoned > 0`, else `completed`; `pages_total = pages_crawled`; `crawl_completed`; `completed_at`; `site_audit:complete` event | `{ status }` |
| — | `settle-render` | `{ timeoutMs: 60_000, retries: 0 }` | when `render_hold_id`: `UPDATE … SET render_settled_at = now() WHERE id = $1 AND render_settled_at IS NULL RETURNING`; if updated, `settleSpendBatch(holdId, [{ provider: "firecrawl", endpoint: "/v1/scrape", units: render_billed, actualUsd: min(render_billed × unit, render_approved_usd), costSource: "price_table" }])` | `{ settled }` |
| — | `cleanup` | `DB_STEP` | `destroyScratch` | — |

Failure path: the handler wraps steps 2–`finalize` in `try/catch`. Only `StepFailedError` (F01) and `AuditPhaseError` are caught; any other error (including F01's internal yield/cancel signals) is rethrown untouched. On a caught error: `mark-failed` (`DB_STEP`: `failAudit` with `classifyAuditError`, `failed_phase = current_phase`, event `site_audit:complete { status: "failed" }`), then `settle-render`, then the handler throws `AppError(500, errorCode, "The site audit failed.")` so the job ends `failed`. Scratch rows are kept 7 days for debugging (OpenSEO's alarm window).

#### 6.3.1 Crawl chunk (`runCrawlChunk`)

PORT of `siteAuditWorkflowCrawl.ts:182-487`, with `getAuditScratchpad` replaced by the store:

1. `previousThrottle = audit.throttle_state ?? input.throttleState`; `claimLimit = min(200, maxPages − attemptedBefore)`; `claimChunk(chunkNo, claimLimit)`; deadline `now + 90_000`; retry → `nextRequestAt = max(next, now + interval)` and `RETRY_CRAWL_WINDOW`.
2. Throttle persist callback = `store.saveThrottle`; a failed save marks `checkpointFailed`, which stops the chunk and fails the step (`:224-237`).
3. Robots for discovery = `parseAuditRobots(audit.robots_txt)` (the row is written once in `discover` and never changed, so reading it outside a step is deterministic). Page reporter context `{ robots, robotsUsable }`.
4. Launch loop as theirs (window, `MAX_QUEUED_PERSIST_BATCHES = 2`, first sub-batch 5 then 25) plus a cancel probe: every 5 s `createCancelProbe` is awaited; when true no new fetch starts, in-flight fetches finish, the queue is flushed and the output has `cancelled: true`.
5. `persistCrawledPages`: deterministic page ids, `runPageReporters(page, ctx)`, `upsertPages`, `insertIssues`, `recordBatch` (≤ 500 stored link targets per page, ≤ 20,000 discovered per sub-batch, `shouldQueueCrawlLink` = same origin + `isCrawlableUrl` + `crawlerAllows`), `updateAudit({ pages_crawled: attempted, pages_total: min(seen, maxPages), pages_seen: seen })`, `ctx.progress(attempted, min(seen, maxPages), "Crawling pages")`.
6. Unattempted and deferred URLs are released; the output carries stats, `endWindow`, `throttleState`, `resumeAt` (`pausedUntil` when in the future), `finishedAt = now`, `renderUsage` (also added to `render_attempts`/`render_billed` on the row in the same persist write, so a later failure still settles what was used).

`runCrawlPhase` loop: as `:114-180` (`pending > 0 && attempted < maxPages`; rate limited → stop; resume sleep; two zero-progress chunks → stop), plus: `cancelled` → stop (the next step boundary raises F01's cancellation); a failed chunk → `crawl-abandon-<k>`.

#### 6.3.2 Other job kinds and periodics

| Kind / periodic | Trigger | Steps | Result |
|---|---|---|---|
| periodic `site_audit.reconcile` (900 s) | F01 `definePeriodic` | `enqueueSystemJob("site_audit.reconcile", {}, { dedupeKey: "site_audit.reconcile:" + floor(now / 900 s) })` | — |
| `site_audit.reconcile` | system | `reconcile` (`DB_STEP`): `reconcileStaleAudits` — up to 100 audits `queued`/`running` created more than 15 minutes ago, oldest first | `{ checked, flipped }` |
| periodic `site_audit.retention` (86,400 s) | F01 | `enqueueSystemJob("site_audit.retention", {}, { dedupeKey: "site_audit.retention:" + YYYY-MM-DD })` | — |
| `site_audit.retention` | system | `prune-1`…`prune-20` (`DB_STEP`): `prune_site_audits(now − 395 days, now − 7 days, 200)` while 200 rows were deleted; `storage-<n>` (`READ_STEP`): remove `site-audit-lighthouse/<brand>/<audit>/` objects of deleted audits, 100 per call | `{ audits, objects }` |

`reconcileRunningAudit(audit, deps)` (PORT of `auditReconciler.ts:49-93`): `job_id` null and older than 10 minutes → `failed`/`job_lost`; `getJobStatus(job_id)` `failed` → `failed` with the job's error code mapped by `classifyAuditFailure`; `cancelled` → `cancelled` (`error_code = "cancelled"`); job row missing (pruned) and older than 10 minutes → `failed`/`job_lost`; transient read errors → no change. Every flip uses `failAudit`'s guard (only from `queued`/`running`), then settles the render hold with the same guarded update as `settle-render`. `getAuditStatus` calls it lazily for active audits (`AuditService.ts:175-184`).

### 6.4 Provider calls and cost

| Call | Endpoint / target | Request | Cost and estimate | Metering | Retries | Fixture |
|---|---|---|---|---|---|---|
| Page, robots, sitemap, llms.txt, redirect probe | customer website via F01 `safeFetch` | §6.2.4; UA `PerceevAudit/1.0` | free | none | crawl politeness only (429 back-off, `crawl-throttle.ts`); sitemap 1 retry on timeout | `tests/fixtures/site-audit/` (served locally) |
| Lighthouse | DataForSEO `POST /v3/on_page/lighthouse/live/json` | `{ url, for_mobile, categories }` | `LIGHTHOUSE_LIVE_USD` = 0.005 per call (F03; DataForSEO fixtures show $0.00425 billed, `pricing.ts:111-113`); provider-reported `task.cost` settles | F02 `meter` → F01 `metered`, feature `site_audit.lighthouse`, one call per hold | 0 (billed) | `tests/fixtures/site-audit/dataforseo/lighthouse-mobile.json`, `lighthouse-desktop.json` (synthetic, the response shape of `dataforseoLighthousePayload.ts:21-46`), `lighthouse-task-error.json` (task status 40501 with cost), `lighthouse-malformed.json` |
| JS rendering | Firecrawl `POST https://api.firecrawl.dev/v1/scrape` | §6.2.9 | `firecrawlScrapeUsd()` (F08; default $0.005) per billed scrape | one F01 hold per audit (`site_audit.render`, worst case `maxPages × unit`, `ttlSeconds` 86,340), settled once at `min(billed × unit, hold)` with `costSource: "price_table"` (F09 §6.2.5 row for F18) | 0 (chunk is billed) | `tests/fixtures/site-audit/firecrawl/render-ok.json`, `render-other-url.json`, `render-empty.json`, `render-402.json` |
| Shopify key directory (P9) | `https://shopify.com/.well-known/http-message-signatures-directory` | GET | free | none | 0 | `tests/fixtures/site-audit/shopify/directory.json` |

No provider cache: every audit is a fresh measurement. Lighthouse payloads are stored per audit in the private bucket `site-audit-lighthouse` (compact `StoredLighthousePayload`, typically under 200 KB). Live QA: `scripts/qa/check-f18-live.mjs --brand <key> --max-spend-usd 0.02 [--lighthouse]` runs a 10-page audit of the brand's own site, optionally with Lighthouse on the homepage only; owner-run only, refuses without the flag and an enabled `paid_feature_controls` row.

### 6.5 API routes

Common to all routes under `src/app/api/customer/audit/`: `requireWorkspace` (members and owners unless stated); `isFeatureEnabled("site_audit", brandKey)` false → 404 `feature_unavailable` "This page is not available for your workspace yet."; `toErrorResponse`; `Cache-Control: no-store`; `export const dynamic = "force-dynamic"`; an `auditId` that is not a UUID or not in the caller's workspace → 404 `audit_not_found` "Audit not found."; database errors → 503 `audit_unavailable` "Site audits are unavailable right now. Please retry."; common 400 `invalid_request`/`invalid_json`, 401/403/404/503 from `requireWorkspace`. Contracts in `src/lib/audit/siteAudit.contract.ts`.

#### 6.5.1 `GET /api/customer/audit`

Query `z.strictObject({ brand_key: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })`. Response:

```json
{ "audits": [ { "id": "6f1d2c3b-0a4e-4b8f-9c1d-2e3f4a5b6c7d", "startUrl": "https://offcult.in/", "status": "completed",
    "pagesCrawled": 48, "pagesTotal": 48, "maxPages": 50, "lighthouse": true, "renderJavaScript": false,
    "createdAt": "2026-10-22T09:00:00.000Z", "completedAt": "2026-10-22T09:01:12.000Z", "issueCounts": { "critical": 2, "warning": 11, "info": 30 } } ],
  "capabilities": { "lighthouse": true, "render": false, "renderReason": "flag_off", "maxPages": 10000,
    "renderedMaxPages": 1000, "monthlyPagesUsed": 48, "monthlyPagesCap": 50000, "defaultUrl": "https://offcult.in/" } }
```

`renderReason`: `null` | `"flag_off"` | `"not_configured"`. `issueCounts` is `null` for audits that are not finished.

#### 6.5.2 `POST /api/customer/audit`

Body `z.strictObject({ brand_key: z.string().max(200).optional(), startUrl: z.string().trim().min(1).max(2048).optional(), maxPages: z.int().min(10).max(10000).default(50), lighthouse: z.boolean().default(false), renderJavaScript: z.boolean().default(false), maxUsd: z.number().positive().max(1000).optional() })`. `maxDuration = 30`. Response **202**:

```json
{ "auditId": "6f1d2c3b-0a4e-4b8f-9c1d-2e3f4a5b6c7d", "jobId": "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90",
  "status": "queued", "pollAfterSeconds": 3, "approvedMaxUsd": 0.35 }
```

| Status | Code | Message (exact) |
|---|---|---|
| 404 | `feature_unavailable` | "This page is not available for your workspace yet." |
| 403 | `feature_disabled` | "This feature is not enabled for your workspace." (Lighthouse/render flag off, or F01 spend refusal) |
| 503 | `render_unavailable` | "JavaScript rendering isn't available right now." |
| 422 | `page_limit` | "Choose from 10 to {max} pages." |
| 422 | `render_page_limit` | "Audits that render JavaScript are limited to 1,000 pages." |
| 422 | `invalid_url` | "Enter a full website address, for example https://example.com." |
| 422 | `audit_host_not_owned` | "Site audits run on your workspace website ({host}) and its subdomains." |
| 422 | `url_blocked` | "That address cannot be fetched." |
| 422 | `url_unreachable` | "We couldn't find that website. Check the address and try again." |
| 400 | `approval_required` | F09 copy, `details.quote` |
| 409 | `price_changed` | F09 copy, `details.approvedMaxUsd`, `details.quote` |
| 409 | `audit_already_running` | "An audit is already running for this workspace." `details.activeAuditId` |
| 409 | `host_busy` | "Another audit of {host} is running. Try again when it finishes." |
| 409 | `audit_capacity_reached` | "This workspace has used {used} of its {cap} audit pages this month. Lower the page limit or wait until next month." |
| 402 | `daily_cap` / `workspace_cap` | F01 copy |
| 409 | `job_already_running` | F01 copy (mapped to `audit_already_running`) |
| 503 | `spend_unavailable` | F01 copy |

Idempotency: one active audit per workspace (`site_audits_one_active_idx` + `singleActiveKey`); a double click yields one audit and one 409.

#### 6.5.3 `GET /api/customer/audit/[auditId]`

Response (lazy reconcile first):

```json
{ "id": "6f1d…", "startUrl": "https://offcult.in/", "status": "running", "currentPhase": "crawling",
  "pagesCrawled": 23, "pagesTotal": 50, "lighthouseTotal": 0, "lighthouseCompleted": 0, "lighthouseFailed": 0,
  "renderJavaScript": false, "lighthouse": false, "cancelRequested": false, "errorCode": null, "failedPhase": null,
  "createdAt": "2026-10-22T09:00:00.000Z", "startedAt": "2026-10-22T09:00:02.000Z", "completedAt": null,
  "pollAfterSeconds": 3 }
```

`pollAfterSeconds`: 3 while `queued`/`running`, else `null`.

#### 6.5.4 `GET /api/customer/audit/[auditId]/feed`

Query `{ limit: 1..100 default 50 }`. Response `{ "entries": [ { "url": "https://offcult.in/about", "statusCode": 200, "title": "About Offcult", "crawledAt": "2026-10-22T09:00:41.120Z" } ], "pollAfterSeconds": 1.5 }` (`null` once finished).

#### 6.5.5 `GET /api/customer/audit/[auditId]/summary`

```json
{ "audit": { "id": "6f1d…", "startUrl": "https://offcult.in/", "status": "completed", "pagesCrawled": 48, "pagesSeen": 61,
    "maxPages": 50, "crawlCompleted": false, "lighthouse": true, "renderJavaScript": false, "sitePlatform": null,
    "createdAt": "…", "completedAt": "…" },
  "stats": { "averageResponseMs": 412, "pagesBlocked": 0, "pagesRateLimited": 0, "pagesAbandoned": 0, "pagesUnread": 0,
    "lighthouse": { "tests": 20, "failed": 1, "avgPerformance": 71, "avgSeo": 92, "avgAccessibility": 88 } },
  "issueGroups": [ { "issueType": "ai-search-crawler-blocked", "severity": "critical", "category": "ai_access", "scope": "page",
      "pages": 48, "rows": 48 } ],
  "aiAccess": { "robotsStatus": "found", "rows": [ { "name": "OAI-SearchBot", "operator": "OpenAI", "platform": "ChatGPT Search",
      "purpose": "search", "status": "blocked", "matchedGroup": "*", "reason": "The wildcard (*) group disallows / (Disallow: /)." } ] },
  "llmsTxt": { "status": "missing", "httpStatus": 404, "contentType": null, "firstLine": null },
  "flags": { "siteBlocked": false, "crawlStopped": false, "hasShells": false, "unreadRendered": false, "linkGraphComplete": true,
    "discoveryTruncated": false } }
```

#### 6.5.6 `GET /api/customer/audit/[auditId]/issues`

Query `z.strictObject({ type: z.string().regex(/^[a-z][a-z0-9-]{1,60}$/), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(100) })`. Response `{ "issueType": "broken-internal-link", "total": 3, "rows": [ { "id": "…", "pageId": "…", "pageUrl": "https://offcult.in/blog", "details": { "targetUrl": "https://offcult.in/old", "targetStatus": 404 } } ] }`.

#### 6.5.7 `GET /api/customer/audit/[auditId]/pages`

Query (strict; all optional): `q` (≤ 200), `status` (`all|ok|redirect|error|missing`), `fetchClass` (`all|ok|blocked|rate_limited|error`), `minWords`, `maxWords`, `minResponseMs`, `maxResponseMs` (non-negative ints), `missingAlt` (`all|yes|no`), `issueType`, `sort` (`url|status|title|h1|words|images|speed`, default `url`), `dir` (`asc|desc`, default `asc`), `offset` (default 0), `limit` (1–200, default 100). Response `{ "total": 48, "rows": [ { "id": "…", "url": "…", "statusCode": 200, "fetchClass": "ok", "redirectUrl": null, "title": "…", "metaDescription": "…", "h1Count": 1, "wordCount": 812, "imagesTotal": 6, "imagesMissingAlt": 0, "responseTimeMs": 380, "crawlDepth": 1, "inSitemap": true, "isIndexable": true, "structuredDataTypes": ["Organization"], "issueCount": 2, "rendered": false } ] }`.

#### 6.5.8 `GET /api/customer/audit/[auditId]/performance`

Response `{ "rows": [ { "id": "…", "pageId": "…", "pageUrl": "https://offcult.in/", "pagePath": "/", "strategy": "mobile", "performanceScore": 62, "accessibilityScore": 88, "bestPracticesScore": 96, "seoScore": 92, "lcpMs": 3120.5, "cls": 0.04, "inpMs": 180, "ttfbMs": 410, "errorMessage": null, "hasDetails": true } ] }`.

#### 6.5.9 Lighthouse detail and export

- `GET /api/customer/audit/[auditId]/lighthouse/[resultId]` → `{ "id": "…", "finalUrl": "https://offcult.in/", "strategy": "mobile", "createdAt": "…", "hasIssueDetails": true, "scores": { … }, "metrics": { … }, "issues": [ { "category": "performance", "auditKey": "render-blocking-resources", "title": "…", "description": "…", "score": 0.3, "displayValue": "…", "impactMs": 820, "impactBytes": null, "severity": "critical", "items": ["…"] } ] }`. No payload stored → 404 `lighthouse_details_unavailable` "This Lighthouse run was saved without details."
- `GET …/lighthouse/[resultId]/export?mode=full|issues|category&category=performance|accessibility|best-practices|seo` → `{ "filename": "perceev-offcult-in-lighthouse-mobile.json", "content": "…" }` (PORT `buildLighthouseExportFile`, `lighthousePayload.ts:80-123`); `mode=category` without `category` → 400.

#### 6.5.10 Cancel and delete

- `POST /api/customer/audit/[auditId]/cancel` (body `z.strictObject({ brand_key? })`): active audit → set `cancel_requested_at`, `cancelJob(job_id)` (job not found → reconcile flips the row now) → **202** `{ "status": "cancelling" }`; finished audit → 200 `{ "status": "<status>" }` (idempotent).
- `DELETE /api/customer/audit/[auditId]` (owner, or the member who started it; else 403 `owner_required`): active → 409 `audit_running` "Cancel the audit before deleting it."; else delete the row (cascades) and remove the Storage prefix best-effort (failures logged, swept by retention) → 200 `{ "deleted": true }`.

#### 6.5.11 Compare (P8) and crawler access (P9)

- `GET /api/customer/audit/compare?base=<uuid>&head=<uuid>` → `{ "base": { id, createdAt, pagesCrawled, maxPages, crawlCompleted }, "head": { … }, "comparable": true, "warnings": [], "rows": [ { "issueType": "missing-h1", "severity": "warning", "basePages": 9, "headPages": 4, "newPages": ["…"], "fixedPages": ["…"] } ] }`. Both audits finished and of the same `start_host`, else 422 `audits_not_comparable` "Choose two finished audits of the same site." `comparable: false` with warning `coverage_differs` "These audits crawled different numbers of pages ({a} and {b}), so some changes may come from coverage, not fixes." when `pages_crawled` differ by more than 10 % or either crawl was incomplete.
- `GET /api/customer/audit/crawler-access` → `{ "credentials": [ { "id", "host", "provider": "shopify", "createdAt", "expiresAt" } ] }`; `POST` body `z.strictObject({ host: z.string().max(253), signatureInput: z.string().min(1).max(4096), signature: z.string().min(1).max(4096) })` → 201 `{ credential }` or 422 `signature_wrong_domain` "This signature was made for {signedHost}. Create one for {host} in Shopify." / `signature_invalid` "This doesn't look like a complete Shopify crawler signature. Copy both values again."; `DELETE /api/customer/audit/crawler-access/[id]` → 200. Owner only; flag `site_audit_crawler_access`; key missing → 503 `crawler_access_unavailable`.

### 6.6 UI

Built from F04 (`PageHeader`, `BackLink`, `CardShell`, `Card`, `Alert`, `Badge`, `Button`, `Switch`, `Input`, `Field`, `Progress`, `Spinner`, `Skeleton`/`SkeletonPage`/`SkeletonTableRows`, `Tabs`, `SegmentedToggle`, `ConfirmDialog`, `RowActionsMenu`, `Tooltip`, `EmptyState`, `QueryError`, `NotFound`, `MetricsTable`), F05 (`fetchJson`, `useWorkspace`, `useServerPacedQuery`, `useUrlSearchState`, `keys`), F06 (`DataTable`, `DataTableTabs`, `TableBulkActionBar`, `TablePagination`, `SortableHeader`, `ExternalUrlCell`, `ExportMenu`, `useExportRows`, `useServerExport`) and F09 (`CostReviewDialog`, `usePriceQuote`). Components live in `src/components/portal/audit/`; hooks in `src/components/portal/audit/hooks/`. Money with F03 `formatUsd`. Query keys (`src/lib/query/keys.ts`): `siteAudits(brandKey)`, `siteAuditCapabilities(brandKey)`, `siteAudit(auditId)`, `siteAuditFeed(auditId)`, `siteAuditSummary(auditId)`, `siteAuditIssues(auditId, type, offset)`, `siteAuditPages(auditId, filtersHash)`, `siteAuditPerformance(auditId)`, `siteAuditLighthouse(resultId)`, `siteAuditCompare(base, head)`.

#### 6.6.1 Routes, navigation and tabs

| Path | File | Renders |
|---|---|---|
| `/portal/audit` | `src/app/portal/audit/page.tsx` | `AuditPage auditId={null}` |
| `/portal/audit/[auditId]` | `src/app/portal/audit/[auditId]/page.tsx` | `AuditPage auditId={params.auditId}` |
| `/portal/audit/[auditId]/lighthouse/[resultId]` | `…/lighthouse/[resultId]/page.tsx` | `LighthouseIssuesScreen` (P5) |
| `/portal/audit/compare` | `src/app/portal/audit/compare/page.tsx` | `CompareView` (P8) |

Sidebar: "Site Audit" in My Site (§6.2.12); `/portal/audit/*` lights it (prefix match). `features.site_audit !== true` → F04 `NotFound`. `AuditPage` layout (OpenSEO `LaunchView.tsx:30-32`): `px-4 py-4 md:px-6 md:py-6 pb-24 md:pb-8`, inner `mx-auto max-w-7xl space-y-4`. Page tabs: `AUDIT_TABS` filtered by `features[flag]`, rendered with F04 `Tabs` (`TabsList` + `TabsTrigger`) bound to `?tab=` through `useUrlSearchState` (default `audit`); the tab strip is hidden when only one tab is visible. The selected tab's `Panel` receives `{ brandKey, auditId }`. Results views inside the audit panel use `?view=issues|pages|performance|ai` (default `issues`) and page filters use their own params, so F19's `?tab=` stays the page-level switch.

#### 6.6.2 Launch view (`launch/LaunchView.tsx`, PORT of `LaunchView.tsx`, `LaunchFormCard.tsx`, `useLaunchController.ts`, `AuditHistorySection.tsx`)

`PageHeader title="Site Audit" description="Crawl your website for technical SEO problems and see what AI crawlers can read."`

**Start card** (`CardShell title="Start new audit"`): a 12-column grid on `lg` (URL input `lg:col-span-9`, button `lg:col-span-3`), stacked below.

| Element | Copy and behaviour |
|---|---|
| URL input | `aria-label="Site URL"`, placeholder `https://{website_host}`, prefilled with `capabilities.defaultUrl`; empty on submit → field error "Please enter a URL." |
| Start button | "Start audit"; pending "Starting…" |
| Max pages box | Label "Max pages"; number input `w-28`, digits only, committed on blur with `clampMaxPagesInput` (`launch/types.ts:22-27`); description "Enter any value from 10 to {limit}." plus " Audits that render JavaScript are limited to 1,000 pages." when rendering is on; second line "{used} of {cap} audit pages used this month." |
| Lighthouse box (shown when `capabilities.lighthouse`) | `Switch` "Include Lighthouse" (title "Lighthouse measures page speed, accessibility and SEO."); when on: "We test up to 10 pages, one per page template, on mobile and desktop: up to 20 checks, at most {formatUsd(20 × 0.005)}." |
| Render box (shown when `features.site_audit_render`) | `Switch` "Render JavaScript" (title "Loads each page in a browser before auditing it. Slower."); disabled with "JavaScript rendering isn't available right now." when `renderReason === "not_configured"`; when on: "Up to {formatUsd(maxPages × unit)} for up to {maxPages} pages. Each page is loaded by a browser service; you pay only for pages it loads." |
| Cost note (always) | muted: "Crawling is free. Lighthouse and JavaScript rendering cost money; you'll see the price before the audit starts." |

Submit flow: validate → if `maxPages > 500`, `ConfirmDialog` title "Start a large audit?", body "You're about to crawl {n} pages. At about one page per second this takes about {estimatedCrawlMinutes(n)} minutes. Continue?", confirm "Continue" (`useLaunchController.ts:90-93` pattern) → if Lighthouse or rendering is on, `CostReviewDialog` (title "Start site audit", confirm "Start audit", pending "Starting…", `usePriceQuote({ brandKey, action: "site_audit.run", input: { maxPages, lighthouse, renderJavaScript } })`, detail = the quote lines) and its `onConfirm(maxUsd)` posts with `maxUsd`; otherwise post directly. Success → `toast.success("Audit started")`, invalidate `siteAudits`, `router.push("/portal/audit/" + auditId)`. `409 price_changed` stays in the dialog (F09 states). Other errors → `Alert variant="destructive"` under the form with the API `error`; `audit_already_running` adds a link "Open the running audit" → `/portal/audit/{details.activeAuditId}`.

**History** (`launch/AuditHistoryTable.tsx`, F06 `DataTable` in a `TableCard` with toolbar title "Previous audits"): columns Date (`MMM d, yyyy`), URL (truncate, title attr), Status (`StatusBadge`: Running with spinner / Done / Partial / Failed / Cancelled / Queued), Pages ("{crawled} of {total}" while running, crawled when finished), Issues (`SeverityBadge` counts, critical/warning only, "—" when unfinished), Lighthouse ("Yes" `Badge outline`), actions ("View" button → detail; `RowActionsMenu` "Delete audit" for the owner or starter; P8 adds a "Compare" checkbox column). Refetch every 5 s while any row is `queued`/`running` (`useLaunchController.ts:58-66`). Loading: `SkeletonTableRows rows={5} columns={6}`. Error: `QueryError` "Couldn't load your audits." + Retry. Empty: `EmptyState icon={ScanSearch} title="No audits yet" description="A 50-page audit takes about a minute."`. Delete → `ConfirmDialog` "Delete this audit?" / "Its pages, issues and Lighthouse reports are removed. This can't be undone." / "Delete audit"; success toast "Audit deleted".

#### 6.6.3 Audit detail (`AuditDetail.tsx`, PORT of `AuditDetail.tsx:41-358`)

Header: `BackLink href="/portal/audit"` "All audits"; `h1` = start host (`text-2xl font-semibold tracking-tight`) with `StatusBadge` when not running; sub-line "Site audit · Started {MMM d, h:mm a}" plus " · JavaScript rendered" when rendering was on.

Data: `useServerPacedQuery` on `siteAudit(auditId)` (`isActive` = queued/running, `pollAfterSeconds` from the body, `floorSeconds: 3`); on the active → finished transition it invalidates `siteAudits`, summary, pages and performance. `CrawlFeed` uses `useServerPacedQuery` on `siteAuditFeed(auditId)` with `floorSeconds: 1.5, fallbackSeconds: 1.5`, enabled only while active. Results queries are enabled once finished (completed, partial, failed or cancelled — failed audits keep partial results, `AuditDetail.tsx:67-74`).

| State | Content (exact copy) |
|---|---|
| Loading | `SkeletonPage` |
| Load error | `BackLink` + `QueryError` "We could not load this audit. It may have been deleted." with "Retry" |
| Queued | `ProgressCard`: title "Waiting to start", badge "Queued", indeterminate `Progress`, label "Your audit starts within a minute." |
| Starting / discovery | title "Finding pages", badge "Starting"/"Discovery", label "Reading robots.txt and sitemaps…" |
| Crawling | title (with `Spinner`) "Crawling pages", badge "Crawling", `Progress` with label "{crawled} / {total} pages" and percent; below, `CrawlFeed` card "Crawled pages ({n})" with action "Updated {time}"; rows: `HttpStatusBadge`, pathname (truncate, `title` = full URL), title text (`hidden md:block`, max 260 px); newest row highlighted with `bg-primary/5 animate-in fade-in slide-in-from-top-1` (`AuditDetail.tsx:318-357`); `max-h-[400px] overflow-y-auto` |
| Lighthouse | title "Running Lighthouse checks", badge "Lighthouse", label "{done} / {total} checks" + " ({failed} failed)" when > 0 |
| Finalizing | title "Checking pages", badge "Finalizing", label "Finding duplicates, broken links and orphan pages…" |
| Cancel (any active state) | `ProgressCard` action `Button variant="outline" size="sm"` "Cancel audit" → `ConfirmDialog` "Cancel this audit?" / "Pages crawled so far stay in the report. Checks already paid for are still charged." / confirm "Cancel audit" / cancel "Keep running" |
| Cancelling | badge "Cancelling…", the Cancel button disabled with a spinner, progress frozen |
| Completed | `StatusBadge` "Done"; banners that apply; results |
| Partial | `StatusBadge` "Partial"; the banner for each reason |
| Failed, 0 pages | `Alert destructive` title "This audit stopped before it crawled any pages." body "Run a new audit to try again. If it keeps happening, contact Perceev support." and `Code: {errorCode}` (`font-mono text-xs`) |
| Failed with pages | `Alert warning` "This audit stopped early after {n} page(s)." / "The results below cover everything crawled before it stopped. Run a new audit to try again." |
| Cancelled | `Alert` (info) "You cancelled this audit after {n} page(s)." / "The results below cover what was crawled before you cancelled." (0 pages: title "You cancelled this audit before it crawled any pages." and no results) |
| `start_url_off_site` | `Alert destructive` "Your site redirects to {host}, which isn't this workspace's website." / "Update the workspace website, or audit that site from a workspace that owns it." |

Result banners (`AuditBanners.tsx`, PORT of `ResultsView.tsx:96-138`, `RenderingWarnings.tsx`, `shared.tsx:160-204`), each an `Alert` with `ShieldAlert`:

| Condition | Title | Body |
|---|---|---|
| `flags.siteBlocked` | "This site's bot protection blocked our crawler." | `BotProtectionAdvice` |
| issue `crawl-blocked-by-robots` | "robots.txt blocks crawlers from your homepage, so we couldn't audit it." | "Remove or narrow the rule in the `User-agent: *` group that disallows `/`, then run the audit again." |
| blocked pages > 0 and not site-blocked | "Bot protection blocked our crawler on {n} page(s)." | `BotProtectionAdvice` |
| `crawlStopped` | "The crawl stopped early because of the site's rate limit." | "The requested cooldown was longer than the audit allows, so some URLs were left unvisited. This report is incomplete. Run the audit again after the limit resets, or ask the site owner to allow the PerceevAudit crawler." |
| rate-limited pages > 0, not stopped | "The site rate limited us on {n} page(s)." | "Pages that returned 429 Too Many Requests could not be audited. …(same last sentence)" |
| `pagesAbandoned > 0` | "{n} page(s) weren't crawled because a crawl step failed." | "We never repeat a paid page load, so these pages were skipped. Run a new audit to include them." |
| `discoveryTruncated` | "We stopped reading sitemaps after 150 seconds." | "Some pages listed only in your sitemaps may be missing from this audit." |
| `hasShells` | "Some pages may need JavaScript to show their content." | rendered: "They were still loading after rendering, so we couldn't check them." else: "Turn on Render JavaScript and run the audit again to check them." |
| rendered and `pagesUnread > 0` | "We couldn't read {n} page(s)." | "To see them, open Pages and filter Crawl result by Failed." |
| `!linkGraphComplete` | "This site has more internal links than we store." | "Orphan pages weren't checked in this audit." |

`BotProtectionAdvice`: "Allow the PerceevAudit user agent in your firewall or bot-protection settings (on Cloudflare: a WAF custom rule that skips bot protection when the user agent contains "PerceevAudit"), then run the audit again." Prefixed "Rendering couldn't get past it. " when the audit rendered; suffixed " Or turn on Render JavaScript and run it again." when it did not and rendering is available.

**Stats strip** (`StatsStrip.tsx`, PORT of `ResultsView.tsx:264-378`, `MetricsTable` in `max-w-xl` card): "Pages crawled" → `{crawled}` with sub "of {seen} found" when `pagesSeen > pagesCrawled` (honest denominator); "Issues found" → total rows with severity badges; "Average response time" → "{ms} ms" ("—" when no `ok` page); with Lighthouse: "Lighthouse tests", "Lighthouse performance", "Lighthouse SEO", "Lighthouse accessibility" (score colour bands ≥ 90 / 50–89 / < 50; "—" when null, never 0), "Lighthouse failures".

**Results card** (`results/ResultsView.tsx`): `DataTableTabs` with "Issues ({rows})", "Pages ({crawled})", "Performance ({n})" (only when Lighthouse rows exist), "AI access"; actions `ExportMenu actions={["sheets","csv","excel","json"]}` exporting the active view's loaded rows through `useExportRows`, plus scope "All rows (download)" using `useServerExport` with the matching F06 kind when the total exceeds the loaded rows.

- **Issues** (`IssuesView.tsx`, PORT of `IssuesView.tsx:15-260`): `SegmentedToggle` "All" / "AI & structured data" (categories `ai_access`, `structured_data`, `social`, `international`) / "Technical SEO" (the rest); sections Critical, Warning, Info (`SeverityBadge` + count), groups sorted by severity then pages affected; a row shows the title and "{n} of {crawled} pages" (page scope) or "Site-wide" (site scope); expanding shows the explanation, "How to fix: …", and the affected URL list (first 100 from the issues route, `max-h-[320px]`), each URL a `SafeExternalLink` with a details line (`IssueDetails`: broken link "Links to {targetUrl} ({targetStatus})"; AI bots "Blocked for: {bots}"; duplicates "Same as: {otherUrls}"; redirect "Hops: a → b → c"; structured data "Missing on {type}: {missing}"; others `key: value · …`), then "…and {n} more. Export the issues for the full list." Empty: `EmptyState variant="plain"` "No issues found." / "We checked {crawled} pages and found nothing to fix." Filtered empty: "No issues in this group." + button "Show all issues".
- **Pages** (`PagesTable.tsx`, PORT of `PagesTable.tsx` and `AuditResultsTableFilters.tsx`): server-side `DataTable` with columns URL (path, `ExternalUrlCell`), Status (`HttpStatusBadge`; plus "Blocked"/"Rate limited"/"Failed" badge for non-ok fetch classes), Title, H1, Words, Images ("{missing} of {total} missing alt"), Speed ("{ms} ms"), Issues; "Filters" toggle with search ("Search URL, title or description"), Status, Crawl result, Words min/max, Response time min/max (ms), Missing alt; `TablePagination` (100 per page); row selection → `TableBulkActionBar` with each visible `AUDIT_PAGE_ACTIONS` entry (eligible pages only; ineligible count shown by the action's dialog) and "Export selected"; row menu: "Open page" and the same actions. Filtered empty: `EmptyState` filtered kind "No pages match these filters." + "Clear filters".
- **Performance** (`PerformanceTable.tsx`, PORT of `ResultsTables.tsx`): columns URL, Device, Status ("OK"/"Failed" with the error in a tooltip), Perf, A11y, SEO, LCP ("{s} s"), CLS, INP ("{ms} ms"), TTFB ("{ms} ms"), Issues (link "View" → Lighthouse detail when `hasDetails`).
- **AI access** (`AiAccessView.tsx`, PATTERN of `src/components/dashboard/CrawlabilityView.jsx`): `CardShell title="AI crawler access"` description "What your robots.txt lets each AI crawler fetch on {host}. Allowed doesn't mean a crawler visits or cites you." Status line: robots `found` → "robots.txt found."; `missing` → "No robots.txt, so every crawler is allowed."; `error`/`unreachable`/`malformed` → `Alert warning` "We couldn't read robots.txt, so these results are unverified." Summary: "{a} of {b} AI search crawlers can read your homepage." Filter `SegmentedToggle` "All" / "Search" / "Assistants" / "Training"; table columns Crawler (mono), Operator, Used for, Purpose, Access (`Badge`: "Allowed" success, "Allowed here, restricted elsewhere" warning, "Blocked" destructive, "Unverified" outline), Rule (`matchedGroup` with the reason in a `Tooltip`). Below, `CardShell title="llms.txt"`: present → "Found at /llms.txt: “{firstLine}”"; missing → "No /llms.txt. It's optional; no answer engine is known to require it."; invalid → `Alert warning` "/llms.txt is served as {contentType} or has no # title line, so tools may ignore it."; unreachable → "We couldn't check /llms.txt."

#### 6.6.4 Lighthouse detail (P5, PORT of `client/features/lighthouse/issues/*`)

`BackLink href="/portal/audit/{auditId}?view=performance"` "Back to audit"; title "{path} · {Mobile|Desktop}"; score summary (four scores, colour bands, "—" for null); metrics `MetricsTable` (FCP, LCP, TBT, CLS, Speed Index, TTI, INP, Server response); category tabs All/Performance/Accessibility/Best practices/SEO via `?category=`; issue rows (severity badge, title, display value, impact, expandable description and items); `ExportMenu` "Download full report (JSON)", "Download issues (JSON)", "Download this category (JSON)". States: loading `SkeletonPage`; error `QueryError` "Couldn't load this Lighthouse report." + Retry; no details "This Lighthouse run was saved without issue details. Run a new audit to see them."; empty category "No issues in this category."

#### 6.6.5 Compare (P8)

History rows get a "Compare" checkbox (max 2, same host); a "Compare 2 audits" button → `/portal/audit/compare?base=<older>&head=<newer>`. `PageHeader title="Compare audits"` description "{host}: {base date} → {head date}". `coverage_differs` → `Alert warning` with the route copy. Table: Issue, Severity, Before (pages), After (pages), Change (+n red / −n green / "No change"), expandable "New ({n})" and "Fixed ({n})" URL lists (first 100). States: loading skeleton; error `QueryError` "Couldn't compare these audits." + Retry; 422 → `Alert destructive` with the message and a link "Back to audits".

#### 6.6.6 Crawler access (P9)

`CardShell title="Shopify crawler access"` inside the audit panel's launch view (owner only, flag `site_audit_crawler_access`): text "Shopify limits crawlers it doesn't recognise. Create a crawler signature in Shopify (Online Store → Preferences → Crawler access) for {host}, then paste both values here."; fields "Signature-Input", "Signature" (`Textarea`, monospace), "Save"; list of saved hosts with "Expires {date}" or "No expiry", "Remove". `ShopifyCrawlWarning` (PORT of `ShopifyCrawlWarning.tsx`) replaces the generic bot/rate-limit banners when `sitePlatform === "shopify"`, with the steps when no live signature exists and "Run the audit again" when one does.

#### 6.6.7 Accessibility and phone

Progress uses `role="progressbar"` with `aria-valuenow`; the phase label sits in an `aria-live="polite"` region; the feed list is `aria-live="off"` (it changes every 1.5 s). Severity is conveyed by text and icon, not colour alone. Switches have labels; dialogs return focus to their trigger. Below 640 px: the start form stacks, option boxes stack, tables scroll inside their cards (`overflow-x-auto`), the feed hides titles, the results tabs scroll horizontally, and dialogs use F04 `DialogContent fullScreenOnMobile`. No horizontal page scroll (browser check F18-B10).

### 6.7 Permissions, privacy, observability

- Members and owners: start, view, cancel, export. Delete: the owner or the member who started the audit. Crawler access: owner only. Paid options require the flags and enabled `paid_feature_controls` rows; spend caps apply (F01).
- Only the workspace website and its subdomains can be audited (§6.2.7 step 3); every request is SSRF-checked (conventions §6.7); the crawler identifies itself (`PerceevAudit/1.0`), obeys robots.txt for its own token and the `*` group, and paces itself at about one request per second per audit, with at most two concurrent audits per host.
- Stored data: public page metadata (titles, descriptions, headings counts, links as hashes), robots.txt text and issue rows, retained 395 days; scratch rows deleted at finalize or within 7 days; Lighthouse payloads in the private bucket, deleted with the audit. No page HTML or body text is stored.
- Logs (no URLs except the start host, no HTML, headers, cookies, signatures or provider bodies): `[audit] start brand=<key> audit=<id> pages=<n> lighthouse=<bool> render=<bool>`, `[audit] chunk audit=<id> chunk=<k> attempted=<n> pending=<n> window=<w>`, `[audit] finish audit=<id> status=<s> pages=<n> code=<error_code>`, `[audit] render audit=<id> outcome=<ok|fallback|error> http=<status>`, `[audit] reconcile audit=<id> from=<status> to=<status> code=<code>`.
- PostHog event names: §6.2.12.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/server/workflows/SiteAuditWorkflow.ts` | `src/lib/audit/job.ts` | PORT | Cloudflare Workflow → F01 `defineJob`; `withPgClient` dropped; `finally` settlement → `settle-render` step plus reconcile; PostHog via the F26 sink. |
| `openseo:src/server/workflows/auditStepConfigs.ts` | `src/lib/audit/job.ts` (`AUDIT_STEPS`) | PORT | Timeouts capped at F01's 230 s; chunk 150 s; billed steps `retries: 0`. |
| `openseo:src/server/workflows/siteAuditStart.ts` | `src/lib/audit/phases.ts` (`resolveAuditStart`) | PORT | Owned-host check added; credential lookup per workspace (P9). |
| `openseo:src/server/workflows/siteAuditWorkflowPhases.ts` | `src/lib/audit/phases.ts` | PORT | Scratchpad → store; Lighthouse waves are sequential steps of ≤ 5 URLs; storage inside the billed step guarded; hreflang return links; site checks step. |
| `openseo:src/server/workflows/siteAuditWorkflowCrawl.ts` | `src/lib/audit/crawlPhase.ts` | PORT | DO RPC → `AuditStore`; cancel probe; `step.sleepUntil` → `step.sleep(seconds)` from step output; billed chunk when rendering; abandon on failure. |
| `openseo:src/server/workflows/site-audit-workflow-helpers.ts` | `src/lib/audit/fetchPage.ts` | PORT | `fetch(redirect: manual)` → F01 `safeFetch({ maxRedirects: 0, truncate: true })`; SSRF refusals recorded as `error`; new analysis fields. |
| `openseo:src/server/features/audit/AuditScratchpad.ts`, `scratchpad-sql.ts` | `supabase/migrations/126_f18_site_audit_functions.sql`, `src/lib/audit/{store,memoryStore}.ts` | PORT | SQLite DO → Postgres tables + functions; link targets as `hashtextextended` hashes; storage budget → target-count budget; alarm → retention job. |
| `openseo:src/server/features/audit/repositories/{AuditRepository,auditIssueWrites,auditSummaryQueries}.ts` | `src/lib/audit/store.ts`, `126` (`site_audit_issue_summary`) | PORT | Drizzle → PostgREST/RPC; deterministic UUIDs. |
| `openseo:src/server/features/audit/services/AuditService.ts` | `src/lib/audit/service.ts` | PORT | Tiers/Autumn → owned-host, monthly allowance, host cap, F09 approval, F01 hold; delete never terminates (Cancel first). |
| `openseo:src/server/features/audit/services/audit-capacity.ts`, `src/shared/audit-limits.ts` | `src/shared/audit-limits.ts` | PORT | Free/paid tiers replaced by env limits. |
| `openseo:src/server/features/audit/services/auditReconciler.ts` | `src/lib/audit/reconcile.ts` | PORT | Workflow instance status → F01 `getJobStatus`; also settles render holds. |
| `openseo:src/server/lib/audit/audit-errors.ts` | `src/lib/audit/errors.ts` | PORT | Cloudflare codes → F01 step codes. |
| `openseo:src/server/lib/audit/crawl-window.ts` (+ test) | `src/lib/audit/crawlWindow.ts` (+ test) | PORT | Max 4, 32 MiB budget (Vercel memory). |
| `openseo:src/server/lib/audit/crawl-throttle.ts` (+ test) | `src/lib/audit/crawlThrottle.ts` (+ test) | COPY | `initialIntervalMs` option for tests and `SITE_AUDIT_REQUEST_INTERVAL_MS`. |
| `openseo:src/server/lib/audit/discovery.ts` (+ tests) | `src/lib/audit/discovery.ts` (+ test) | PORT | `fetch` → `safeFetch`; `robots-parser` → `src/lib/crawlers/robots.js`; 150 s budget. |
| `openseo:src/server/lib/audit/url-policy.ts` (+ test) | F01 `src/lib/http/{safeFetch,hostPolicy}.ts`, `src/lib/audit/urlPolicy.ts` | PORT | DoH lookups → F01 pinned DNS; `isShopifyHost` via injected lookup. |
| `openseo:src/server/lib/audit/url-utils.ts` (+ test) | `src/lib/audit/urlUtils.ts` (+ test) | COPY | — |
| `openseo:src/server/lib/audit/classify-fetch.ts`, `src/shared/audit-fetch-class.ts` | `src/lib/audit/classifyFetch.ts`, `src/shared/audit-fetch-class.ts` | COPY | — |
| `openseo:src/server/lib/audit/html-response.ts` | `src/lib/audit/htmlResponse.ts` | PORT | Byte reading moved into `safeFetch` truncate mode. |
| `openseo:src/server/lib/audit/ids.ts` | `src/lib/audit/ids.ts` | PORT | 36-char hex → RFC 9562 v8 UUID. |
| `openseo:src/server/lib/audit/page-analyzer.ts` (+ test) | `src/lib/audit/pageAnalyzer.ts` (+ test) | PORT | Adds hreflang hrefs, JSON-LD bodies, `data-nosnippet`. |
| `openseo:src/server/lib/audit/types.ts` | `src/lib/audit/types.ts` | PORT | `lighthouseStrategy` → boolean `lighthouse`; new fields. |
| `openseo:src/server/lib/audit/issues/{page-reporters,multipage,multipage-checks}.ts` (+ tests) | `src/lib/audit/issues/*` (+ tests) | PORT | Perceev checks added; DB reads via store. |
| `openseo:src/shared/audit-issues.ts` | `src/shared/audit-issues.ts` | PORT | Branding removed, Shopify sentence removed, categories/scopes, 18 new types. |
| `openseo:src/server/lib/audit/progress-kv.ts` | `src/lib/audit/results.ts` (`getAuditFeed`) | PATTERN | Feed read from `site_audit_pages` ordered by `crawled_at`. |
| `openseo:src/server/lib/audit/lighthouse.ts` (+ test) | `src/lib/audit/lighthouse.ts` (+ test) | PORT | R2 → Storage bucket `site-audit-lighthouse`; waves; budget guard. |
| `openseo:src/server/lib/dataforseo/lighthouse.ts` (+ test) | `src/lib/providers/dataforseo/lighthouse.ts` (+ test) | PORT | F02 `dataforseoPost` + `meter`; `DataforseoChargedTaskError` → F01 `ChargedCallError`. |
| `openseo:src/server/lib/{dataforseoLighthousePayload,lighthouseStoredPayload,lighthousePayload}.ts` (+ tests) | `src/lib/audit/lighthousePayload.ts` (+ test) | PORT | zod v4. |
| `openseo:src/serverFunctions/{audit,lighthouse}.ts`, `src/types/schemas/{audit,lighthouse}.ts` | `src/app/api/customer/audit/**/route.ts`, `src/lib/audit/siteAudit.contract.ts` | PORT | Server functions → JSON routes; strict schemas. |
| `openseo:src/server/lib/audit/rendered-page.ts` (+ test), `rendering-policy.ts`, `src/shared/audit-rendering.ts` | `src/lib/audit/renderedPage.ts` (+ test), `src/lib/pricing/actions/siteAudit.ts` | PORT | Browser Run/Context.dev → Firecrawl `rawHtml`; credits → one F01 hold. |
| `openseo:src/server/lib/audit/rendering-billing.ts` | `src/lib/audit/job.ts` (`settle-render`), `reconcile.ts` | PATTERN | Autumn lock → `reserveSpend`/`settleSpendBatch`. |
| `openseo:src/shared/crawler-access.ts` (+ test), `src/server/features/audit/services/{CrawlerCredentialService,shopifySignature}.ts` (+ tests), `repositories/CrawlerCredentialRepository.ts` | `src/lib/audit/{crawlerAccess,crawlerAccessCrypto,shopifySignature}.ts` (+ tests) | PORT | Better Auth crypto → AES-256-GCM with `CRAWLER_ACCESS_ENCRYPTION_KEY`; per workspace instead of per organisation. |
| `openseo:src/audit-worker.ts`, `wrangler.audit.jsonc` | — | PATTERN | Lesson only: memory isolation; on Vercel the tick function is shared, so we bound in-flight bytes and keep the Lighthouse parse lock. |
| `openseo:src/server/mcp/tools/{site-audit-tools,site-audit-cleanup-tools}.ts` | `src/lib/audit/tools.ts` | PATTERN | Tool names and descriptions rewritten for F22. |
| `openseo:src/client/features/audit/AuditDetail.tsx`, `shared.tsx` | `src/components/portal/audit/{AuditDetail,ProgressCard,CrawlFeed,AuditBanners,shared}.tsx` | PORT | Cancel added; Next routing; F05 server-paced polling; desktop-crawler links dropped. |
| `openseo:src/client/features/audit/launch/*` | `src/components/portal/audit/launch/*` | PORT | Plans/upgrade → allowance line; F09 cost dialog; Lighthouse copy corrected (10 pages × 2). |
| `openseo:src/client/features/audit/results/*` | `src/components/portal/audit/results/*` | PORT | Server-side pages table; category toggle; AI access tab; F06 export. |
| `openseo:src/client/features/lighthouse/issues/*` | `src/components/portal/audit/lighthouse/*` | PORT | Next routing. |
| `openseo:src/routes/_app/p/$projectId/audit/{index,issues/$resultId}.tsx` | `src/app/portal/audit/**/page.tsx` | PORT | Search params → path segments and `?tab`/`?view`. |
| `openseo:tests/badseo/**` | `tests/fixtures/site-audit/**`, `src/lib/audit/fixtureSite.test.ts` | PATTERN | Node `http` server, virtual hosts for site-level fixtures, coverage asserted. |

## 8. Implementation plan

Branches `feat/f18-site-audit-p<N>`. Every new COPY/PORT file gets the licence header and a `THIRD_PARTY_NOTICES.md` line in the same PR. Test command abbreviation: `NT` = `node --import ./src/lib/liveWriteGuardAuto.mjs --test`.

### Phase 1 — Engine core and fixture site (no database)
**Goal:** every pure piece of the crawler and checks exists and passes OpenSEO's ported tests plus the Perceev checks.

- [x] **P1.T1 Shared modules and fetch layer**
  - [x] **P1.T1.S1** *Files:* `package.json`, `package-lock.json`. *Do:* `npm install htmlparser2@^10 fast-xml-parser@^5`. *Verify:* `node -e "import('htmlparser2').then(()=>import('fast-xml-parser')).then(()=>console.log('ok'))"` → `ok`.
  - [x] **P1.T1.S2** *Files:* `src/shared/{audit-issues,audit-limits,audit-fetch-class,audit,structured-data-rules,lighthouse}.ts`, `src/shared/audit-issues.test.ts`, `src/shared/audit-limits.test.ts`. *Do:* §6.2.1–6.2.3 registries and constants. Tests: 48 types, valid enums, no "OpenSEO", `clampAuditMaxPages` (undefined → 50, 5 → 10, 20,000 → 10,000), `estimatedCrawlMinutes(500) === 9`. *Verify:* `NT src/shared/audit-issues.test.ts src/shared/audit-limits.test.ts` → pass (F18-AC-03).
  - [x] **P1.T1.S3** *Files:* `src/lib/http/safeFetch.ts`, `src/lib/http/safeFetch.test.ts` (F01 files; only if F01 lacks the option). *Do:* add `truncate?: boolean` to `safeFetch` init: when true, reading stops at `maxBytes`, the body is returned cut and the result gains `truncated: true`, instead of throwing `response_too_large`; every SSRF check unchanged. Assert `maxRedirects: 0` returns a 3xx with `Location` (conventions §5.6). *Verify:* `NT src/lib/http/safeFetch.test.ts` → pass.
  - [x] **P1.T1.S4** *Files:* `src/lib/audit/{urlUtils,ids,classifyFetch,htmlResponse,urlPolicy}.ts`, `urlUtils.test.ts`, `ids.test.ts`, `urlPolicy.test.ts`. *Do:* §6.2.1; port `url-utils.test.ts:10-59` cases; `deterministicUuid("a","b")` stable and matches `/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`; `isOwnedHost("blog.offcult.in","offcult.in") === true`, `("offcult.in.evil.com","offcult.in") === false`, `("www.offcult.in","offcult.in") === true`; `isCrawlableUrl("http://169.254.169.254/")` false; redirect probe with an injected `safeFetch` (301 → 301 → 200, a hop to `127.0.0.1` refused). *Verify:* `NT src/lib/audit/urlUtils.test.ts src/lib/audit/ids.test.ts src/lib/audit/urlPolicy.test.ts` → pass (F18-AC-01).
- [x] **P1.T2 Analysis and checks**
  - [x] **P1.T2.S1** *Files:* `src/lib/audit/{types,pageAnalyzer}.ts`, `pageAnalyzer.test.ts`. *Do:* §6.2.3; port every case of `openseo:src/server/lib/audit/page-analyzer.test.ts` (the cheerio-parity cases become fixed expected values); add: hreflang pairs with relative href, ld+json capture with uppercase type and parameters, 21st block ignored, 70 KB block reported invalid, `data-nosnippet` inside `<noscript>` ignored. *Verify:* `NT src/lib/audit/pageAnalyzer.test.ts` → pass (F18-AC-02).
  - [x] **P1.T2.S2** *Files:* `src/lib/audit/{structuredData,hreflang}.ts`, `structuredData.test.ts`, `hreflang.test.ts`. *Do:* §6.2.3, §6.2.5. Cases: invalid JSON; `@graph` with untyped object; `Product` with `name` only → missing `offers|review|aggregateRating`; `https://schema.org/Organization` type prefix stripped; visible-claim check incl. R15's "Unobserved product" case; hreflang codes `en`, `en-GB`, `zh-Hant-TW`, `x-default` valid, `english`, `en_GB` invalid; return-link detection A↔B ok, A→B one-way flagged, B not crawled ignored. *Verify:* `NT src/lib/audit/structuredData.test.ts src/lib/audit/hreflang.test.ts` → pass.
  - [x] **P1.T2.S3** *Files:* `src/lib/audit/{robotsFile,aiAccess,llmsTxt}.ts`, `robotsFile.test.ts`, `aiAccess.test.ts`, `llmsTxt.test.ts`. *Do:* injected `safeFetch`. Cases: robots 200/404/500/timeout/SSRF refusal → found/missing/error/unreachable/unreachable; 600 KB robots truncated to 512,000 bytes; HTML robots → malformed; `GPTBot Disallow: /` + `OAI-SearchBot Allow: /` → training blocked, search open (R15-02); `User-agent: *\nDisallow: /` → every bot blocked and `crawlerAllows` false; llms.txt 200 text/markdown "# Offcult" → present; 200 text/html → invalid; 200 text/plain without "# " → invalid; 404 → missing; network error → unreachable. *Verify:* `NT src/lib/audit/robotsFile.test.ts src/lib/audit/aiAccess.test.ts src/lib/audit/llmsTxt.test.ts` → pass (F18-AC-06, F18-AC-07).
  - [x] **P1.T2.S4** *Files:* `src/lib/audit/issues/{pageReporters,multipageChecks}.ts`, `pageReporters.test.ts`, `multipageChecks.test.ts`. *Do:* §6.2.5; port all cases of `page-reporters.test.ts` and the pure cases of `multipage.test.ts`; add one case per Perceev page check, the app-shell skip, and "robots unusable → no bot issues". *Verify:* `NT src/lib/audit/issues/` → pass (F18-AC-04, F18-AC-05).
- [x] **P1.T3 Crawling primitives**
  - [x] **P1.T3.S1** *Files:* `src/lib/audit/{crawlWindow,crawlThrottle}.ts`, `crawlWindow.test.ts`, `crawlThrottle.test.ts`. *Do:* port `crawl-window.test.ts:52-81` (max 4) and every case of `crawl-throttle.test.ts:11-177` with fake timers (`node:test` `mock.timers`). *Verify:* `NT src/lib/audit/crawlWindow.test.ts src/lib/audit/crawlThrottle.test.ts` → pass (F18-AC-08).
  - [x] **P1.T3.S2** *Files:* `src/lib/audit/discovery.ts`, `discovery.test.ts`. *Do:* port `discovery.test.ts:14-36`; add sitemap index depth 3 stop, 301st document not fetched, 11 MB shard skipped, off-origin sitemap ignored, 150 s budget (injected clock) → `truncated: true`. *Verify:* `NT src/lib/audit/discovery.test.ts` → pass (F18-AC-09).
  - [x] **P1.T3.S3** *Files:* `src/lib/audit/fetchPage.ts`, `fetchPage.test.ts`. *Do:* §6.2.4. Cases: 200 HTML analysed; 301 recorded with `redirectUrl` and no follow; 429 then 200 with `Retry-After: 1` (`rateLimited: true`); 403 → blocked; 200 Cloudflare challenge title → blocked; private-address link → `error` with `blockedReason: "url_blocked"` and the injected fetch never called; 2 MB page truncated to 1 MiB; PDF → `isHtml: false`; lookup cache resolves the host once for 3 fetches. *Verify:* `NT src/lib/audit/fetchPage.test.ts` → pass (F18-AC-10).
- [x] **P1.T4 Fixture site**
  - [x] **P1.T4.S1** *Files:* `tests/fixtures/site-audit/{types,registry,sites,server,fixtureFetch}.ts`, `tests/fixtures/site-audit/fixtures/{head-tags,content,indexability,http-status,redirects,performance,structure,kitchen-sink,ai-access,structured-data,social,international,javascript}.ts`, `tests/fixtures/site-audit/README.md`. *Do:* PATTERN of `tests/badseo`: `Fixture = { path; extraPaths?; site?: SiteId; name; expectedIssues: AuditIssueType[]; support?; inSitemap?; linkedFromCatalog?; handler(ctx): Response | Promise<Response> }`; `SITES` (virtual hosts) = `main` (robots allows all except `User-agent: GPTBot\nDisallow: /`, `User-agent: OAI-SearchBot\nDisallow: /ai/search-blocked`, `User-agent: ChatGPT-User\nDisallow: /ai/agent-blocked`; no llms.txt; expected site issues `ai-training-crawler-blocked`, `llms-txt-missing`), `llmsbad` (llms.txt served as HTML → `llms-txt-invalid`), `robots500` (robots 500 → `robots-txt-unavailable`), `robotshtml` (HTML robots → `robots-txt-malformed`), `closed` (`User-agent: *\nDisallow: /` → `crawl-blocked-by-robots`, zero pages), `throttled` (every page 429 with `Retry-After: 7200` → `crawl-rate-limited`, `rate-limited-page`); each non-main site's homepage is otherwise clean and has a valid llms.txt. One page per page-level issue type (all 30 OpenSEO page types as badseo, plus `/js/app-shell` → `javascript-rendering-suspected`, `/ai/search-blocked`, `/ai/agent-blocked`, `/data/invalid-json`, `/data/no-type`, `/data/missing-required`, `/data/not-visible`, `/data/none`, `/social/no-og`, `/intl/invalid`, `/intl/no-self`, `/intl/one-way-a` (+ `/intl/one-way-b`), `/snippet/nosnippet`). Shared chrome is issue-neutral: valid JSON-LD `WebPage`, full OG tags, no headings or images, unique titles and descriptions. `server.ts` starts `node:http` on `127.0.0.1:0` and dispatches by the `x-fixture-site` header; `fixtureFetch(baseUrl)` returns a `fetchImpl` that rewrites `http://<site>.audit.test/<path>` to the local port with that header, and `fixtureLookup` answers `93.184.216.34` for `*.audit.test` so F01's SSRF vetting passes without reaching the network. *Verify:* `NT tests/fixtures/site-audit/registry.test.ts` → pass (unique paths, every handler responds).
  - [x] **P1.T4.S2** *Files:* `tests/fixtures/site-audit/registry.test.ts`. *Do:* static coverage: the union of `expectedIssues` over fixtures and every site's `expectedSiteIssues` equals `Object.keys(AUDIT_ISSUE_TYPES)`; the test **fails** listing any uncovered type. *Verify:* `NT tests/fixtures/site-audit/registry.test.ts` → pass.

**Checkpoint:** `NT 'src/lib/audit/**/*.test.ts' 'src/shared/audit-*.test.ts' tests/fixtures/site-audit/registry.test.ts` → pass; `npm run typecheck` → exit 0; `npm run build` → exit 0. ACs: 01–10 (unit halves), coverage half of 11.

### Phase 2 — Database, store and job
**Goal:** a free audit runs end to end on F01 jobs against the fixture site and against Postgres.

- [x] **P2.T1 Migrations**
  - [x] **P2.T1.S1** *Files:* `supabase/migrations/125_f18_site_audit.sql`, `supabase/migrations/126_f18_site_audit_functions.sql`. *Do:* §6.1 verbatim. *Verify:* `node scripts/qa/check-f18-db.mjs --only schema` → "125/126 applied twice without error".
  - [x] **P2.T1.S2** *Files:* `scripts/setup-supabase.mjs`, `.github/workflows/ci.yml`. *Do:* add the six tables and every 126 function to the required-objects list; add `site_audits`, `site_audit_pages`, `site_audit_issues`, `site_audit_lighthouse` to the customer-database tenant RLS test. *Verify:* `grep -c "site_audit_" scripts/setup-supabase.mjs` → ≥ 18 (6 tables + 12 functions); `node --test src/lib/migrationsRunner.test.mjs src/lib/migrationsLedger.test.mjs` → pass.
  - [x] **P2.T1.S3** *Files:* `README.md` (rows `125_f18_site_audit` "Site audit tables: audits, pages, issues, Lighthouse results and crawl scratch tables (frontier, link hashes); private bucket site-audit-lighthouse." and `126_f18_site_audit_functions` "Site audit functions: atomic start with workspace, host and monthly limits; chunk-idempotent frontier claims; broken-link and orphan checks; issue summary; retention."), `docs/OPERATOR_LEDGER.md` § C ("apply 125 and 126 before deploying F18 phase 2"), `docs/PROD_MIGRATIONS.md` (two bullets with pre-check `select to_regclass('public.site_audits')` and applied-check). *Verify:* `node --test src/lib/docStatus.test.mjs src/lib/migrationsRunner.test.mjs` → pass.
- [x] **P2.T2 Store**
  - [x] **P2.T2.S1** *Files:* `src/lib/audit/{store,memoryStore}.ts`, `store.test.ts`. *Do:* §6.2.6; memory store mirrors every SQL rule. Cases: port `AuditScratchpad.test.ts:69-255` (broken links once, blocked targets ignored, row limit order, orphan rules, self-link, redirect target, sitemap seed takes link depth) plus claim idempotency (retry returns the same leases; crawled chunk number claims nothing; limit 0), release, abandon, link budget sets `link_graph_complete = false`. *Verify:* `NT src/lib/audit/store.test.ts` → pass (F18-AC-14, F18-AC-15 memory half).
  - [x] **P2.T2.S2** *Files:* `scripts/qa/check-f18-db.mjs`. *Do:* the `check-repair-workflows.mjs` pattern (loopback Postgres, DB name ending `_qa`): apply F01 040–043 and 125/126 to a fresh DB; run the store scenario of P2.T2.S1 through `createSqlAuditStore` with a service-role client and assert identical results to the memory store; `site_audit_create` races (two concurrent creates → one `created`, one `audit_already_running`; third workspace on the same host after two active → `host_busy`; monthly cap); RLS: a member of workspace A selecting B's audit rows gets 0 rows; scratch tables return permission denied for `authenticated`; `prune_site_audits` deletes old audits and scratch of finished audits only. *Verify:* `node scripts/qa/check-f18-db.mjs` → "F18 DB checks: all passed" (F18-AC-14, -15, -30, -31).
- [x] **P2.T3 Job**
  - [x] **P2.T3.S1** *Files:* `src/lib/audit/{errors,cancel,crawlPhase,phases,job,reconcile,retention,telemetry}.ts`, `src/lib/jobs/kinds.ts` (one import line). *Do:* §6.3 with the Lighthouse phase returning immediately when `run_lighthouse` is false (P5 fills it) and rendering disabled (P6). *Verify:* `npm run typecheck` → exit 0.
  - [x] **P2.T3.S2** *Files:* `src/lib/audit/crawlPhase.test.ts`, `job.test.ts`, `reconcile.test.ts`, `retention.test.ts`. *Do:* F01 in-memory job store + memory audit store + `fixtureFetch`. Cases: port `siteAuditWorkflowCrawl.test.ts:149-345` (spacing across chunks, ≤ window in flight, slower pacing retained, durable 10-minute sleep then retry, replay of the same cooldown, cooldown saved before failure, checkpoint failure stops, four refusals stop, Retry-After over budget stops without sleeping); replaying a chunk writes no duplicates; `maxPages` never exceeded; cancel probe true → `cancelled: true` and F01 cancellation at the next step; a thrown `AuditPhaseError` → `mark-failed`, audit `failed` with `failed_phase`, partial pages kept; reconcile flips for job failed/cancelled/missing > 10 min and never flips `completed`; retention prunes. *Verify:* `NT src/lib/audit/crawlPhase.test.ts src/lib/audit/job.test.ts src/lib/audit/reconcile.test.ts src/lib/audit/retention.test.ts` → pass (F18-AC-16, -17, -18 unit, -19, -20, -30 unit).
- [x] **P2.T4 Fixture-site end to end**
  - [x] **P2.T4.S1** *Files:* `src/lib/audit/fixtureSite.test.ts`. *Do:* start the fixture server; for each site run `site_audit.run` to completion through F01's in-memory runner (throttle interval 0 ms through the `initialIntervalMs` dep; the 250 ms minimum applies only when parsing `SITE_AUDIT_REQUEST_INTERVAL_MS`; `maxPages` 200); per page, compare page-level issue types (rows with `pageId`) to `expectedIssues` (exact set; info-severity extras are **not** tolerated); per site compare site-level types to `expectedSiteIssues`; healthy pages (`/`, catalog, support) clean; final assertion: every registry type was observed at least once across all sites. *Verify:* `NT src/lib/audit/fixtureSite.test.ts` → pass (F18-AC-11).

**Checkpoint:** `NT 'src/lib/audit/**/*.test.ts'` → pass; `node scripts/qa/check-f18-db.mjs` → all passed; `npm run build` → exit 0. ACs: 11, 14–20, 30, 31.

### Phase 3 — API, flags, pricing and tools
**Goal:** customers (and F22/F27) can start, follow, cancel, read, export and delete audits through routes.

- [x] **P3.T1 Registrations**
  - [x] **P3.T1.S1** *Files:* `src/shared/spend-features.ts`, `src/lib/features/names.ts`, `src/lib/features/clientFeatures.ts`, `.env.example` (`FEATURE_SITE_AUDIT=`, `FEATURE_SITE_AUDIT_BRANDS=`, `FEATURE_SITE_AUDIT_LIGHTHOUSE=`, `FEATURE_SITE_AUDIT_LIGHTHOUSE_BRANDS=`, `FEATURE_SITE_AUDIT_RENDER=`, `FEATURE_SITE_AUDIT_RENDER_BRANDS=`, `FEATURE_SITE_AUDIT_CRAWLER_ACCESS=`, `FEATURE_SITE_AUDIT_CRAWLER_ACCESS_BRANDS=`, `SITE_AUDIT_MAX_PAGES=`, `SITE_AUDIT_MONTHLY_PAGES=`, `SITE_AUDIT_ALLOW_ANY_HOST=`, `SITE_AUDIT_LINK_BUDGET=`, `SITE_AUDIT_REQUEST_INTERVAL_MS=`, `CRAWLER_ACCESS_ENCRYPTION_KEY=`). *Do:* §6.2.12. *Verify:* `NT src/lib/features/flags.test.ts src/shared/spend-features.test.ts` → pass; `grep -c "^FEATURE_SITE_AUDIT=$" .env.example` → 1.
  - [x] **P3.T1.S2** *Files:* `src/lib/pricing/actions/siteAudit.ts`, `siteAudit.test.ts`, `src/lib/pricing/actions/index.ts` (one import). *Do:* §6.2.8 (Lighthouse and Firecrawl unit prices read through F03/F08 helpers; until P5/P6 merge, tests inject them). Cases: free audit total 0; Lighthouse 0.10; render 50 pages × 0.005 = 0.25; both 0.35; render 1,001 pages → blocked `render_page_limit`; active audit → blocked. *Verify:* `NT src/lib/pricing/actions/siteAudit.test.ts` → pass (F18-AC-13 unit half).
- [x] **P3.T2 Service and routes**
  - [x] **P3.T2.S1** *Files:* `src/lib/audit/{service,results}.ts`, `src/lib/audit/siteAudit.contract.ts`. *Do:* §6.2.7, §6.2.10, §6.5 contracts with response examples. *Verify:* `NT src/lib/http/routeContract.test.ts` → pass.
  - [x] **P3.T2.S2** *Files:* `src/app/api/customer/audit/route.ts`, `src/app/api/customer/audit/[auditId]/route.ts`, `…/[auditId]/feed/route.ts`, `…/[auditId]/summary/route.ts`, `…/[auditId]/issues/route.ts`, `…/[auditId]/pages/route.ts`, `…/[auditId]/performance/route.ts`, `…/[auditId]/cancel/route.ts`. *Do:* §6.5.1–6.5.8, §6.5.10. *Verify:* `npm run build` → exit 0.
  - [x] **P3.T2.S3** *Files:* `src/lib/audit/start.route.test.mjs`, `results.route.test.mjs`, `cancel.route.test.mjs`. *Do:* hook pattern of `src/lib/customerRoutes.test.hooks.mjs` with memory stores. Start: every error row of §6.5.2 (flag off 404, page limits, off-host 422, private IP 422 `url_blocked`, approval_required with quote, price_changed, already running with `activeAuditId`, host_busy, capacity, spend refusal 402), success 202 shape; results: another workspace's id → 404, pagination, filters, feed `pollAfterSeconds` 1.5 then null; cancel: 202 then idempotent 200; delete: running → 409, owner/starter only, success removes rows. *Verify:* `NT src/lib/audit/start.route.test.mjs src/lib/audit/results.route.test.mjs src/lib/audit/cancel.route.test.mjs` → pass (F18-AC-12, -13, -18 route, -19 route, -21, -22, -29).
- [ ] **P3.T3 Exports, tools, guards**
  - [ ] **P3.T3.S1** (deferred — needs F06 phase 3; owner decision) *Files:* `src/lib/export/kinds/siteAudit.ts`, `siteAudit.test.ts`, `src/lib/export/kinds/index.ts` (register three kinds). *Do:* §6.2.14; CSV formula-safety case (`=HYPERLINK(...)` title → prefixed `'`). *Verify:* `NT src/lib/export/kinds/siteAudit.test.ts` → pass (F18-AC-26 server half).
  - [x] **P3.T3.S2** *Files:* `src/lib/audit/tools.ts`, `tools.test.ts`. *Do:* §6.2.12; closed inputs (`z.toJSONSchema(input, { io: "input" }).additionalProperties === false`), outputs parse handler results from memory stores. *Verify:* `NT src/lib/audit/tools.test.ts` → pass (F18-AC-32).
  - [x] **P3.T3.S3** *Files:* `src/lib/audit/importGuard.test.ts`. *Do:* scan `src/lib/audit/**` and `src/app/api/customer/audit/**`: no import of `providers/dataforseo/answers`, `claim_probe_dispatch`, `enginePipeline`, `scanWorker`, `gemini`, `llm/`; `renderedPage.ts` and `providers/dataforseo/lighthouse.ts` are the only modules that call external providers. *Verify:* `NT src/lib/audit/importGuard.test.ts` → pass (F18-AC-33).

**Checkpoint:** `NT 'src/lib/audit/**/*.test.*' src/lib/export/kinds/siteAudit.test.ts src/lib/pricing/actions/siteAudit.test.ts` → pass; `npm run build` → exit 0. ACs: 12, 13, 18, 19, 21, 22, 26 (server), 29, 32, 33.

### Phase 4 — UI (requires F04, F05, F06 and F09 phase 3 merged)
**Goal:** the customer can run and read an audit in `/portal/audit`.

- [ ] **P4.T1 Registries and plumbing**
  - [x] **P4.T1.S1** *Files:* `src/components/portal/audit/{tabs,pageActions,telemetry}.ts`, `src/components/portal/audit/registries.test.ts`, `src/lib/query/keys.ts`, `src/components/app/navigation/items.ts`. *Do:* §6.2.12, §6.6 keys; test that the exported types compile against a sample F19-shaped entry (`satisfies AuditTab`) and that `AUDIT_TABS[0].id === "audit"`. *Verify:* `NT src/components/portal/audit/registries.test.ts` → pass; `npm run typecheck` → exit 0 (F18-AC-28 unit half).
- [ ] **P4.T2 Launch and history**
  - [x] **P4.T2.S1** *Files:* `src/app/portal/audit/page.tsx`, `src/components/portal/audit/{AuditPage,SiteAuditPanel,shared}.tsx`, `launch/{LaunchView,LaunchFormCard,AuditHistoryTable,types}.ts(x)`, `launch/useLaunchController.ts`, `hooks/{useAuditList,useStartAudit,useDeleteAudit}.ts`. *Do:* §6.6.1–6.6.2. *Verify:* `npm run build` → exit 0.
- [ ] **P4.T3 Detail**
  - [x] **P4.T3.S1** *Files:* `src/app/portal/audit/[auditId]/page.tsx`, `src/components/portal/audit/{AuditDetail,ProgressCard,CrawlFeed,AuditBanners}.tsx`, `hooks/{useAuditStatus,useAuditFeed,useCancelAudit}.ts`. *Do:* §6.6.3 states and banners. *Verify:* `npm run build` → exit 0.
- [ ] **P4.T4 Results**
  - [x] **P4.T4.S1** *Files:* `src/components/portal/audit/results/{ResultsView,StatsStrip,IssuesView,IssueDetails,PagesTable,PagesFilters,PerformanceTable,AiAccessView,export}.ts(x)`, `hooks/{useAuditSummary,useAuditIssues,useAuditPages,useAuditPerformance}.ts`. *Do:* §6.6.3 results card; `export.ts` PORT of `results/export.ts` with Perceev headers. *Verify:* `npm run build` → exit 0.
- [ ] **P4.T5 Browser checks**
  - [x] **P4.T5.S1** *Files:* `scripts/qa/check-f18-browser.mjs`, `tests/fixtures/site-audit/api/*.json` (route responses recorded from the fixture-site run). *Do:* Playwright from `worker/node_modules/playwright` against `npm run dev` with fixture APIs: **B01** launch form defaults and validation ("Please enter a URL."); **B02** > 500 pages confirm dialog copy; **B03** Lighthouse on → cost dialog shows "Up to $0.10" and posts `maxUsd`; **B04** running audit shows phase badge, "23 / 50 pages", feed rows appear within 2 s, Cancel → "Cancelling…" → cancelled banner; **B05** failed with pages → "This audit stopped early after 12 pages."; **B06** issues grouped Critical/Warning/Info, sorted by pages, expand shows "How to fix:"; **B07** pages filters → filtered empty state → Clear filters; **B08** AI access tab shows "Blocked" for OAI-SearchBot on the `closed` site fixture; **B09** an injected `AUDIT_TABS`/`AUDIT_PAGE_ACTIONS` test entry renders as a tab and in the bulk bar, hidden when its flag is off; **B10** 375 px viewport: no horizontal page scroll on launch, detail and results. *Verify:* `node scripts/qa/check-f18-browser.mjs` → "F18 browser: 10/10 passed" (F18-AC-27, -28).

**Checkpoint:** `npm run build` → exit 0; `node scripts/qa/check-f18-browser.mjs` → 10/10; `node --test src/components/portal/` → pass (existing portal tests unchanged). ACs: 26 (client), 27, 28.

### Phase 5 — Lighthouse (requires F02 phase 1 and F03 phase 1)
**Goal:** approved, metered Lighthouse checks with a detail page.

- [ ] **P5.T1 Provider and payload**
  - [ ] **P5.T1.S1** *Files:* `src/lib/providers/dataforseo/lighthouse.ts`, `lighthouse.test.ts`, `tests/fixtures/site-audit/dataforseo/{lighthouse-mobile,lighthouse-desktop,lighthouse-task-error,lighthouse-malformed}.json`. *Do:* §6.2.9; port `openseo:src/server/lib/dataforseo/lighthouse.test.ts`; cases: success settles provider cost; task error with cost → `ChargedCallError` settled; malformed payload → `ChargedCallError` with the billed cost; 5xx → `AmbiguousCallError` (settled at estimate); no retry on any POST. *Verify:* `NT src/lib/providers/dataforseo/lighthouse.test.ts` → pass.
  - [ ] **P5.T1.S2** *Files:* `src/lib/audit/{lighthouse,lighthousePayload}.ts`, `lighthouse.test.ts`, `lighthousePayload.test.ts`. *Do:* port `lighthouse.test.ts:22-123`, `lighthousePayload.test.ts`, `lighthouseStoredPayload.test.ts`, `dataforseoLighthousePayload.test.ts`. *Verify:* `NT src/lib/audit/lighthouse.test.ts src/lib/audit/lighthousePayload.test.ts` → pass (F18-AC-24 unit half).
- [ ] **P5.T2 Phase**
  - [ ] **P5.T2.S1** *Files:* `src/lib/audit/phases.ts`, `src/lib/audit/lighthousePhase.test.ts`. *Do:* §6.3 Lighthouse rows. Cases: port `siteAuditWorkflowPhases.test.ts:110-196` (persistence retry does not replay paid calls; one failed wave keeps sibling results); budget guard skips a wave; Storage failure keeps scores with the error message; step definitions are `billed: true, retries: 0`. *Verify:* `NT src/lib/audit/lighthousePhase.test.ts` → pass (F18-AC-23).
- [ ] **P5.T3 Detail UI and routes**
  - [ ] **P5.T3.S1** *Files:* `src/app/api/customer/audit/[auditId]/lighthouse/[resultId]/route.ts`, `…/export/route.ts`, `src/app/portal/audit/[auditId]/lighthouse/[resultId]/page.tsx`, `src/components/portal/audit/lighthouse/{LighthouseIssuesScreen,LighthouseIssuesParts,LighthouseIssueRow,LighthouseIssuesSummary,types,utils}.ts(x)`, cases added to `results.route.test.mjs` and `check-f18-browser.mjs` (**B11** detail page renders scores and filters by category). *Do:* §6.5.9, §6.6.4. *Verify:* `NT src/lib/audit/results.route.test.mjs` → pass; `node scripts/qa/check-f18-browser.mjs` → 11/11 (F18-AC-24).

**Checkpoint:** all P5 tests pass; `npm run build` → exit 0. ACs: 23, 24.

### Phase 6 — JavaScript rendering (requires F08 P3.T1.S2)
**Goal:** approved rendering through Firecrawl under one held budget.

- [ ] **P6.T1 Renderer and hold**
  - [ ] **P6.T1.S1** *Files:* `src/lib/audit/renderedPage.ts`, `renderedPage.test.ts`, `tests/fixtures/site-audit/firecrawl/{render-ok,render-other-url,render-empty,render-402}.json`. *Do:* §6.2.9; port the relevant cases of `rendered-page.test.ts` (different final URL rejected, empty HTML rejected, usage counted for failures that bill). *Verify:* `NT src/lib/audit/renderedPage.test.ts` → pass.
  - [ ] **P6.T1.S2** *Files:* `src/lib/audit/{service,crawlPhase,job,reconcile}.ts`, cases in `crawlPhase.test.ts`, `reconcile.test.ts`, `start.route.test.mjs`. *Do:* hold at start (§6.2.7 step 7), billed chunk options, abandon on failure, render usage persisted per sub-batch, `settle-render` and reconcile settlement guarded by `render_settled_at`. Cases: port `siteAuditWorkflowCrawl.test.ts:308-345` (usage summed across chunks; throttled Shopify pages rendered instead of waiting when rendering); a failed rendered chunk → pages abandoned, audit `partial`; cancel → settled once at `min(billed × unit, hold)`. *Verify:* `NT src/lib/audit/crawlPhase.test.ts src/lib/audit/reconcile.test.ts src/lib/audit/start.route.test.mjs` → pass (F18-AC-25).
- [ ] **P6.T2 UI**
  - [ ] **P6.T2.S1** *Files:* `src/components/portal/audit/launch/LaunchFormCard.tsx`, `AuditBanners.tsx`, browser case **B12** (render switch shows the estimate; disabled copy when not configured). *Verify:* `node scripts/qa/check-f18-browser.mjs` → 12/12.

- [ ] **P6.T3 Live check script**
  - [ ] **P6.T3.S1** *Files:* `scripts/qa/check-f18-live.mjs`. *Do:* owner-run only (§6.4): refuses without `--brand <key>` and `--max-spend-usd <n>` (≤ 0.10) and unless the relevant `paid_feature_controls` rows are enabled for that brand; starts a 10-page audit of the brand's own website through `startSiteAudit` (`--lighthouse` adds Lighthouse on the start page only; `--render` renders the 10 pages), waits for completion through `getAuditStatus`, and prints status, pages crawled, issue counts per severity, Lighthouse checks and settled spend; never prints HTML, page text, tokens or provider bodies. *Verify:* `node scripts/qa/check-f18-live.mjs` (no args) → exits 1 with "Refusing: pass --brand <key> and --max-spend-usd <n>".

**Checkpoint:** P6 tests pass; `npm run build` → exit 0. ACs: 25.

### Phase 7 — R15 parity and cross-link
**Goal:** R15 and F18 never disagree; the measurement card points to the full audit.

- [ ] **P7.T1** *Files:* `src/lib/audit/r15Parity.ts`, `r15Parity.test.ts`. *Do:* §6.2.11; for each HTML fixture in `src/lib/repairs/r15-technical-evidence.test.mjs`, run `inspectPage` and F18 `analyzeHtml` + `runPageReporters`, map R15 codes through `R15_TO_F18`, assert every mapped type is present. *Verify:* `NT src/lib/audit/r15Parity.test.ts src/lib/repairs/r15-technical-evidence.test.mjs` → pass (F18-AC-34).
- [ ] **P7.T2** *Files:* `src/app/portal/measurement/page.jsx`. *Do:* change the "Website technical evidence" card `description` string to "Checks up to six owned-page requests. Search indexing and AI inclusion remain separate facts. For a full crawl with AI-crawler checks, open Site Audit." No other change. *Verify:* `node --test src/components/portal/portalRegressions.test.mjs` → pass.

**Checkpoint:** R15 tests unchanged and passing. AC: 34.

### Phase 8 — Compare two audits (optional)
- [ ] **P8.T1** *Files:* `supabase/migrations/127_f18_site_audit_compare.sql`, `scripts/setup-supabase.mjs`, `README.md`, `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`, `scripts/qa/check-f18-db.mjs` (compare group). *Do:* §6.1 127; paperwork row "127_f18_site_audit_compare — Compares issue pages between two audits of one workspace." *Verify:* `node scripts/qa/check-f18-db.mjs` → all passed; `node --test src/lib/docStatus.test.mjs src/lib/migrationsRunner.test.mjs` → pass.
- [ ] **P8.T2** *Files:* `src/app/api/customer/audit/compare/route.ts`, `src/lib/audit/compare.ts`, `compare.route.test.mjs`, `src/app/portal/audit/compare/page.tsx`, `src/components/portal/audit/compare/CompareView.tsx`, history "Compare" column, browser **B13**. *Do:* §6.5.11, §6.6.5. *Verify:* `NT src/lib/audit/compare.route.test.mjs` → pass; browser 13/13 (F18-AC-35).

### Phase 9 — Shopify crawler access (optional)
- [ ] **P9.T1** *Files:* `supabase/migrations/128_f18_crawler_access.sql`, paperwork files as P8.T1 (row "128_f18_crawler_access — Encrypted Shopify crawler-access signatures per workspace host."), `src/lib/audit/{crawlerAccess,crawlerAccessCrypto,shopifySignature}.ts` + tests, `tests/fixtures/site-audit/shopify/directory.json`. *Do:* §6.2.13; port `crawler-access.test.ts`, `CrawlerCredentialService.test.ts`, `AuditService.crawlerAccess.test.ts` cases (host-bound, https only, expired skipped, wrong-domain twin detection, decryption failure crawls unsigned). *Verify:* `NT src/lib/audit/crawlerAccess.test.ts` → pass.
- [ ] **P9.T2** *Files:* `src/app/api/customer/audit/crawler-access/route.ts`, `…/crawler-access/[id]/route.ts`, `crawlerAccess.route.test.mjs`, `src/components/portal/audit/crawlerAccess/{CrawlerAccessCard,ShopifyCrawlWarning}.tsx`, `phases.ts`/`crawlPhase.ts` wiring. *Do:* §6.5.11, §6.6.6; signatures never in responses, logs, step outputs or Firecrawl requests (assert with a spy). *Verify:* `NT src/lib/audit/crawlerAccess.route.test.mjs` → pass (F18-AC-36).

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `src/shared/audit-issues.test.ts`, `audit-limits.test.ts` | registry shape, 48 types, no OpenSEO copy, limits | 03 |
| `src/lib/audit/urlUtils.test.ts`, `ids.test.ts`, `urlPolicy.test.ts` | ported URL cases, UUID v8, owned host, redirect probe | 01 |
| `src/lib/audit/pageAnalyzer.test.ts` | ported analyzer cases + new captures | 02 |
| `src/lib/audit/structuredData.test.ts`, `hreflang.test.ts` | JSON-LD validity, types, required, visibility; hreflang codes and return links | 04, 05 |
| `src/lib/audit/robotsFile.test.ts`, `aiAccess.test.ts`, `llmsTxt.test.ts` | robots states, AI bot verdicts, llms.txt states | 06, 07 |
| `src/lib/audit/issues/*.test.ts` | ported reporters and multipage, Perceev checks | 04, 05 |
| `src/lib/audit/crawlWindow.test.ts`, `crawlThrottle.test.ts` | ported window and throttle cases | 08 |
| `src/lib/audit/discovery.test.ts` | ported + limits and budget | 09 |
| `src/lib/audit/fetchPage.test.ts` | redirects unfollowed, SSRF, truncation, classes | 10 |
| `tests/fixtures/site-audit/registry.test.ts` | static coverage | 11 |
| `src/lib/audit/fixtureSite.test.ts` | end-to-end issues per page and site, observed coverage | 11 |
| `src/lib/audit/store.test.ts`, `scripts/qa/check-f18-db.mjs` | frontier semantics, link checks, create races, RLS, retention | 14, 15, 30, 31 |
| `src/lib/audit/crawlPhase.test.ts`, `job.test.ts`, `reconcile.test.ts`, `retention.test.ts` | chunks, throttle, cancel, failure, reconcile, render settlement | 16–20, 25, 30 |
| `src/lib/audit/start.route.test.mjs`, `results.route.test.mjs`, `cancel.route.test.mjs` | every route and error code | 12, 13, 18, 19, 21, 22, 24, 29 |
| `src/lib/pricing/actions/siteAudit.test.ts` | quotes and blocks | 13 |
| `src/lib/providers/dataforseo/lighthouse.test.ts`, `src/lib/audit/lighthouse*.test.ts` | billing classes, sample, waves, budget | 23, 24 |
| `src/lib/audit/renderedPage.test.ts` | Firecrawl shapes and usage | 25 |
| `src/lib/export/kinds/siteAudit.test.ts` | export kinds, formula safety | 26 |
| `src/components/portal/audit/registries.test.ts` | F19 types | 28 |
| `src/lib/audit/tools.test.ts`, `importGuard.test.ts`, `r15Parity.test.ts` | tools, P0 fence, R15 parity | 32, 33, 34 |
| `src/lib/audit/compare.route.test.mjs`, `crawlerAccess*.test.ts` | optional phases | 35, 36 |
| `scripts/qa/check-f18-browser.mjs` | B01–B13 | 27, 28 |

Fixtures are synthetic and written by hand in the providers' documented shapes; nothing is recorded from customer sites. The fixture site runs on loopback and is reached through the injected `fetchImpl`/`lookup` seam, so no test touches the network (conventions §6.5). The owner-run `scripts/qa/check-f18-live.mjs` may record a real Firecrawl and Lighthouse response for the owner's own site, with page text replaced by "Lorem" before it is committed.

## 10. Rollout and rollback

- **Env (names only):** `FEATURE_SITE_AUDIT`, `FEATURE_SITE_AUDIT_BRANDS`, `FEATURE_SITE_AUDIT_LIGHTHOUSE`, `FEATURE_SITE_AUDIT_LIGHTHOUSE_BRANDS`, `FEATURE_SITE_AUDIT_RENDER`, `FEATURE_SITE_AUDIT_RENDER_BRANDS`, `FEATURE_SITE_AUDIT_CRAWLER_ACCESS`, `FEATURE_SITE_AUDIT_CRAWLER_ACCESS_BRANDS`, `SITE_AUDIT_MAX_PAGES` (default 10,000), `SITE_AUDIT_MONTHLY_PAGES` (default 50,000), `SITE_AUDIT_ALLOW_ANY_HOST` (default off), `SITE_AUDIT_LINK_BUDGET` (default 3,000,000), `SITE_AUDIT_REQUEST_INTERVAL_MS` (default 1,000, minimum 250), `CRAWLER_ACCESS_ENCRYPTION_KEY` (P9). Existing: `FIRECRAWL_API_KEY`, `FIRECRAWL_SCRAPE_USD` (F08), `DATAFORSEO_API_KEY` (F02).
- **Migration order:** F01 040–043 → 125 → 126 (before deploying P2) → 127 (P8) → 128 (P9). All additive.
- **Enabling (owner):** 1) apply 125/126; 2) `FEATURE_SITE_AUDIT=allowlist` with the first workspace in `FEATURE_SITE_AUDIT_BRANDS`; run a 50-page audit of the owner's site and read the report; 3) `on` when satisfied; 4) Lighthouse: run `scripts/qa/check-f18-live.mjs --lighthouse --max-spend-usd 0.02`, then enable `paid_feature_controls('site_audit.lighthouse')` and `FEATURE_SITE_AUDIT_LIGHTHOUSE`; 5) rendering: confirm the Firecrawl plan price (`FIRECRAWL_SCRAPE_USD`), run the live check with rendering on 10 pages, then enable `paid_feature_controls('site_audit.render')` and `FEATURE_SITE_AUDIT_RENDER`.
- **Turning it off:** set the flag `off`: routes return 404, the sidebar hides, and the crawl phase checks `isFeatureEnabled("site_audit", brandKey)` before every chunk and ends running audits as `cancelled`. Disabling a paid feature control refuses new paid audits (403) and stops Lighthouse waves of running audits (the wave's `metered()` call is refused; the audit finishes with failed checks). Data stays until retention deletes it.
- **Cleanup:** none required. To remove the feature entirely, drop the tables in reverse order and empty the `site-audit-lighthouse` bucket (owner decision; no script shipped).

## 11. Risks and open questions

| # | Risk / question | Default chosen |
|---|---|---|
| 1 | Firecrawl's `rawHtml` and `metadata.statusCode`/`url` field names are from its v1 docs as we recall them, not verified against a live response. | Fixtures follow that shape; P6 must not be enabled until the owner-run live check (§6.4) confirms it; the parser is `z.looseObject`, so extra fields are harmless and a missing `rawHtml` fails closed (page left unrendered, not billed). |
| 2 | Firecrawl price per scrape. | F08's `FIRECRAWL_SCRAPE_USD` default 0.005; the hold uses it, the customer sees "up to". |
| 3 | Rendering with our Playwright fleet would avoid a vendor, but the fleet runs nowhere today and cannot run on Vercel. | Firecrawl now; a later spec can add a fleet renderer behind `renderPage`. |
| 4 | OpenSEO audits any URL; we restrict to the workspace website. | Owned host + subdomains; `SITE_AUDIT_ALLOW_ANY_HOST=on` relaxes it (owner decision). |
| 5 | At about one request per second, 10,000 pages take about 3 hours. | Keep OpenSEO's politeness; job deadline 6 h; `SITE_AUDIT_REQUEST_INTERVAL_MS` (≥ 250) lets the owner speed up audits of their own sites. |
| 6 | The F01 tick runs up to 4 jobs in one function instance; a crawl chunk plus a Lighthouse parse could press memory. | In-flight HTML ≤ 32 MiB per audit, one Lighthouse parse at a time per instance; if memory errors appear, ask F01 for a per-kind tick lane. |
| 7 | Database size on small Supabase plans: a 10,000-page audit is roughly 30–40 MB of rows. | 50,000 pages per workspace per month, 395-day retention, scratch dropped at finalize. Owner may lower the allowance. |
| 8 | Action name `site_audit.run` (covers rendering and Lighthouse). | Resolved: F09 §6.2.5 uses `site_audit.run`. |
| 9 | F01 `safeFetch` may lack `truncate` and times the whole response. | P1.T1.S3 adds `truncate` additively; slow-response copy says "to arrive". Requested addition to conventions §5. |
| 10 | Structured-data required-property rules change over time. | Table dated October 2026 in `src/shared/structured-data-rules.ts`; issue copy promises no rich results or citations. |
| 11 | `hashtextextended` collisions in link checks. | 64-bit hashes; probability negligible at 3 M targets; a collision can only add a false broken link to an existing failing page. |
| 12 | Severity of `ai-search-crawler-blocked` (critical) may alarm a customer who blocks AI search on purpose. | Keep critical (this product exists to be found by answer engines); the explanation says how to keep blocking training separately. |
| 13 | Retiring R15's "Check owned website". | Keep it (§3 decision); owner decides retirement after F18 is on for all workspaces. |
| 14 | F01 handlers must rethrow F01's internal yield/cancel signals. | Catch only `StepFailedError` and `AuditPhaseError`; a test asserts a yield passes through (`job.test.ts`). |
| 15 | Lighthouse waves are sequential steps (one step per ≤ 5 URLs) instead of OpenSEO's parallel steps. | ≤ 2 waves, about 2 minutes; parallel `step.do` is not part of F01's contract. |

## 12. Definition of done

- [ ] Phases 1–7 merged (8 and 9 if the owner chooses); every subtask ticked here.
- [ ] F18-AC-01…34 covered by passing tests (35–36 when P8/P9 ship).
- [ ] `npm run build` green; full suite green; `node scripts/qa/check-f18-db.mjs` and `node scripts/qa/check-f18-browser.mjs` pass.
- [ ] Migration paperwork for 125, 126 (and 127, 128) in `README.md`, `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`; `THIRD_PARTY_NOTICES.md` lists every COPY/PORT path.
- [ ] `features/README.md` status updated.
- [ ] Owner-run live check result recorded (Lighthouse and rendering) before their flags are enabled.

## Deviations from conventions

1. **Crawl window** max 4 and 32 MiB (OpenSEO 2 and 8 MiB): Vercel functions have far more memory than a 128 MB isolate.
2. **Response time** includes the body download (F01 `safeFetch` buffers); issue copy adjusted.
3. **Owned-host restriction** (OpenSEO audits any URL).
4. **Rendering** is held as one F01 reservation and settled once (F09 §6.2.5 row for F18), not wrapped per call in `metered()`; a crawl chunk that renders is billed (`retries: 0`) and a failed one abandons its unpersisted pages instead of re-rendering them.
5. **Lighthouse waves** run as sequential steps of up to 5 URLs.
6. **Priced action** registered with `requireApproval: false`; the start route itself refuses a paid audit without `maxUsd` (free audits need no dialog).
7. **Link edges** stored as 64-bit URL hashes; **live feed** read from the pages table instead of a KV list; **row ids** are deterministic UUID v8.
8. `src/shared/structured-data-rules.ts` and the 18 new issue types are Perceev additions, not ports.
