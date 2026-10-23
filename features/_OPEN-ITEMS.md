# Open items: cross-spec fixes and owner decisions

>
>
> **Status: LIVE.** Written 23 October 2026 after all 27 specs were drafted. Part A is the work list for the consistency pass. Part B lists every decision the specs need from the owner, each with the default the specs already assume. Delete an item when it is resolved.

## Part A — Cross-spec fixes (consistency pass)

Later specs asked earlier ones for small changes. Shared names are already fixed in `00-CONVENTIONS.md` §5.1–5.8 and §12; these items bring each spec's own text in line.

**Applied 23 October 2026.** All 24 fixes are in the spec texts (by hand, no agent). The wider cross-check of every spec against every other was not run; the owner chose to skip it for now. Kept below as a record of what changed.

| # | Spec to edit | Change | Asked by |
|---|---|---|---|
| A1 | F01 | Pin `@types/react@^19` (not 18) in the TypeScript setup phase. | F04 |
| A2 | F01, F03 | Add the migration paperwork subtasks (repository `README.md` migration table, `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`). | F04 |
| A3 | F01 | `safeFetch`: `maxRedirects: 0` returns the 3xx unfollowed with `Location`; `truncate: true` returns a cut body with `truncated: true`. | F19, F18 |
| A4 | F01 | Optional `ctx.cancelRequested()` in the job context. | F18 |
| A5 | F01 | Accept one-line telemetry/email hooks in `reserveSpend`, `toErrorResponse`, `requireWorkspace` and the job runner (call `src/lib/telemetry/context.ts`). | F25, F26 |
| A6 | F02 | Confirm `meter(fetcher, estimate, defaultFeature)` and `DataforseoCallContext` shapes; list the section files other specs port: `labs`, `google-ads`, `keyword-metrics`, `filters`, `researchScopeFilters`, `serp-locations`, `backlinks`, `backlinksTarget` (F13/F16), `business` (F17), Lighthouse (F18). | F13, F17, F18 |
| A7 | F02, F04 | `src/shared/safe-url.ts` is the same file in both; note "second PR keeps it unchanged". | F04 |
| A8 | F03 | Add Claude to `PERCEEV_ENGINE_PROVIDERS` and make the provider route-aware; DataForSEO rows use `cost_source: "gateway"`. | F02 |
| A9 | F03 | Sync inner-joins `scan_jobs`, so the explore mapping never fires; note that F11 writes explore ledger rows itself with the same `source_ref`. | F11 |
| A10 | F03 | Confirm estimator input shapes: `{limit, includeClickstreamData}`, `{keywords, includeClickstreamData}`, `{dateFrom, dateTo}`, `{}` (F13); `business.*({limit|depth|includeOtherSources})`, `serp.localTaskPost({locationCoordinates})`, `labs.keywordOverview({keywords})` (F17). | F13, F17 |
| A11 | F03 | Add `usage_page` to `CLIENT_FEATURES` and give the Usage nav item that `flag`. | F04 |
| A12 | F09 | Read `price_review` from `/api/customer/features`, not a new overview field; apply tracker edits to F05's `postStart`; cost dialog uses `DialogContent fullScreenOnMobile`. | F04, F05 |
| A13 | F09 | Add to the §6.2.5 priced-action table: `keywords.research.run`, `keywords.serp.run`, `keywords.metrics_refresh.run`, `keywords.clustering.run`, `domain.lookup.run`, `domain.keywords.page`, `domain.pages.page`, `domain.competitors.run`, `backlinks.lookup.run`, `backlinks.page`, `backlinks.expand_domain`, `backlinks.snapshots.track`, the F15 and F17 action keys, `site_audit.run` (rename of `site_audit.render.run`), `content.draft.run`, `ai_visibility.explore.run`, `ai_visibility.schedule.save`. | F10, F11, F13–F18, F22 |
| A14 | F09 | Document the inline-approval rule (quote ≤ USD 0.25 via `PricedActionButton`; bulk and jobs always use the dialog). | F13 |
| A15 | F09 | `startCustomerScan` is extracted from the scan route as a pure move; `recordApproval` accepts subject kind `assistant_approval`. | F22 |
| A16 | F10 | `ScheduleField` gains optional `allowManual`, `dailyNote`; confirm column names `managed_by`, `customer_updated_at`. | F15, F27 |
| A17 | F11 | Import from `src/lib/questions/workspaceQuestions.ts`; origin `manual` with `sourceRef { kind: "explore_run", id }`; event names in `prompt_explorer:*` form. | F08, F26 |
| A18 | F12 | Use F08's `normalize_question_text` definition (collapse whitespace, trim, lowercase); flip `QUESTION_HISTORY_AVAILABLE` to `true` in phase 3; event names in `question_history:*` form. | F08, F26 |
| A19 | F13 | Gate `/api/customer/keywords/locations` on `keyword_research` OR `rank_tracking` OR `local_seo`; expose `runSerpRequest` for tools. | F15, F17, F22 |
| A20 | F14 | Expose `runSerpCompetitorsRequest` for tools. | F22 |
| A21 | F18 | Export `fetchRobots`, `aiAccessRows`, `blockedAiBots`, `checkLlmsTxt` for tools; expose `startSiteAudit` for F27. | F22, F27 |
| A22 | F20 | Confirm `Ga4ConnectionCard` props `brandKey`, `returnTo`, `onConnectClick`. | F27 |
| A23 | F08 | Optionally export `saveQuestionSettings`. | F27 |
| A24 | All event-emitting specs | Each sink module exports a `set…Tracker` setter; event names use `area:action`. | F26 |

## Part B — Decisions for the owner

Each item states the default the specs already assume. **23 October 2026: the owner accepted every default.** B9 and B5 were answered explicitly (below); B39's model falls back to `LLM_HELPER_MODEL` and B46 keeps the `<ref>.supabase.co` domain. Items marked **Action** still need you to do something outside the code. Items marked **Action** need you to do something outside the code.

### Spend and platform

| # | Question | Default |
|---|---|---|
| B1 | Production per-answer reservation `SCAN_PROBE_RESERVATION_USD`: the P0 handoff records USD 0.20; code defaults to 1. Quotes read the live value. | 0.20 (accepted) |
| B2 | Set default workspace daily/monthly spend caps before any paid feature is enabled? | Yes; start rank tracking at USD 3/day, local SEO at USD 1/day |
| B3 | The normal AI scan ships enabled (exception to "paid ships disabled"); collection stays behind the pause and allowlist. | Yes |
| B4 | Content Studio costs stay off the Usage page in v1. | Yes |
| B5 | **Action:** confirm the Supabase plan has Vault, the "Before User Created" Auth hook and Turnstile captcha. | **Resolved 23 Oct 2026:** owner is on the Free plan; Supabase docs list Vault, the Before User Created hook and Turnstile captcha on Free. No fallback needed. |

### DataForSEO and AI visibility

| # | Question | Default |
|---|---|---|
| B6 | Bake-off budget: USD 12 same-day head-to-head, or about USD 5 reusing the 20 October run for current providers. | USD 12 |
| B7 | Go thresholds: ≥ 95% India acceptance, ≥ 90% answered, ≤ 2× price table, 9 of 10 correct on manual review. | As stated |
| B8 | Lower the per-answer reservation after a "go" to match DataForSEO's price. | Yes |
| B9 | Accept the third-party-terms risk of capturing ChatGPT and Gemini consumer-app answers through a provider. | **Decided 23 Oct 2026: accepted by owner** |
| B10 | While dispatch is paused, only the allowlisted workspace can use Prompt Explorer. | Yes |
| B11 | Questions match case-insensitively (OpenSEO is case-sensitive). | Yes |
| B12 | First scan after setup is offered with a price, never started automatically. | Offer |
| B13 | Setup pre-selects about 30 questions. | Yes |
| B14 | Members (not only owners) approve question sets and edit project memory; only owners turn on schedules. | Yes |
| B15 | Prompt Research (US-English dataset) stays behind its own switch. | Yes |
| B16 | Customer scheduling limited to the QA workspace until the R11 seven-day soak passes (soak needs your allowlist approval). | Yes |

### Classic SEO

| # | Question | Default |
|---|---|---|
| B17 | Do Ahrefs' terms allow showing their free Domain Rating in a paid product? | Feature off until checked |
| B18 | Cache scope: shared for keyword market data, per-workspace for domain and backlink lookups. | Yes |
| B19 | One-click approval limit USD 0.25. | Yes |
| B20 | With no market set, guess country from the site's domain ending (`.in` → India). | Yes |
| B21 | Build the stored backlink-history phase. | Yes, optional last phase |
| B22 | Limits: 5,000 saved keywords, 200 tags, stats refresh skips keywords updated in the last 7 days. | Yes |
| B23 | Rank tracking detects loaded-later AI Overviews (would run under the pause/allowlist controls). | No |
| B24 | Allow tracking competitor domains' rankings. | Yes |
| B25 | Keep the Business Profile Q&A tab (Google is scaling it back). | Keep, with a switch to hide |
| B26 | Keep IndexNow submission from audit pages (OpenSEO omitted it). | Keep, with safeguards |

### Site audit and Google

| # | Question | Default |
|---|---|---|
| B27 | Audits limited to the workspace's own website and subdomains. | Yes, env switch to relax |
| B28 | When to retire the old "Check owned website" quick check. | Keep for now |
| B29 | **Action:** create a second Google OAuth client for Analytics and start Google's review of `analytics.readonly`. | Start early; review takes weeks |
| B30 | **Action:** confirm Firecrawl's real price per page (assumed USD 0.005) and response fields via the live check before rendering is enabled. | Live check script in F18 |
| B31 | 50,000 audit pages per workspace per month fits the Supabase plan. | **Does not fit Free (500 MB database cap, read-only above it).** Lower the default or upgrade before F18 ships; see B48 |

| B48 | Supabase Free plan limits: 500 MB database (read-only when exceeded), shared Nano compute, 60 connections, no daily backups. Upgrade to Pro before Wave 2 (classic SEO data, audit pages, rank history), or stay on Free with tight row limits and retention. | Stay on Free through Waves 0–1; decide before Wave 2 |

### UI

| # | Question | Default |
|---|---|---|
| B32 | App font: OpenSEO's system font or Archivo. | System font; logo stays Archivo |
| B33 | Public marketing site stays as it is (only the customer app adopts the new look). | Yes |
| B34 | `/demo` takes the new app look. | Yes |
| B35 | Drop the split-screen sign-in showcase for single-column auth pages. | Yes |
| B36 | Export download links work without sign-in for their one hour. | Yes |
| B37 | Desktop sidebar cannot collapse (as OpenSEO). | Keep |

### Assistant and reports

| # | Question | Default |
|---|---|---|
| B38 | Members approve paid assistant actions and make reports public. | Yes |
| B39 | Assistant model (`ASSISTANT_MODEL`) and USD 0.50 cap per reply. | Cap USD 0.50; model defaults to `LLM_HELPER_MODEL` until `ASSISTANT_MODEL` is set (accepted) |
| B40 | Assistant reads only your site, declared competitors and cited pages. | Yes |
| B41 | Drafts started from the assistant count against Content Studio's own cap; ship disabled. | Yes |
| B42 | Serve shared reports from a separate domain for stronger isolation. | Later, optional |
| B43 | Scheduled or emailed reports remain a follow-up. | Yes |

### Sign-in, email, analytics

| # | Question | Default |
|---|---|---|
| B44 | Product analytics is opt-in for everyone (fewer measured users; DPDP-aligned). | Yes |
| B45 | Notification emails default on (stop link in each); product updates default off. | Yes |
| B46 | Google sign-in shows the `<ref>.supabase.co` domain unless a Supabase custom domain is bought. | Keep `<ref>.supabase.co`; no custom domain for now (accepted) |
| B47 | Team invites to throwaway-inbox addresses stay allowed. | Yes |

### Accounts you will need before the related phases

DataForSEO account (F02 bake-off) · Loops account (F25) · PostHog EU project (F26) · Cloudflare Turnstile site key (F24) · second Google OAuth client with Analytics scope (F20). Step-by-step setup for the last four: [`_ACCOUNT-SETUP.md`](./_ACCOUNT-SETUP.md).
