# F15 — Rank tracking with AI Overview presence

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F15 |
| Wave | 2 |
| Comparison rows covered | "Rank tracking" (OpenSEO: daily, weekly or monthly positions per keyword and device, SERP features stored including AI Overview presence, anti-glitch rechecks. Perceev: none) |
| Depends on | F01 (merged): `requireWorkspace`, `AppError`/`toErrorResponse`/`jsonOk`, `defineJob`/`enqueueJob`/`enqueueSystemJob` with `singleActiveKey`, `definePeriodic`, `getJobStatus`, `jobStepKey`, step presets, `metered`, `cached`, `isFeatureEnabled`, `f01_touch_updated_at()`, route-contract harness. F02 phase 2: `src/lib/providers/dataforseo/{serp,client,shared}.ts` (`createDataforseoClient().serp.rankCheckBatch` / `.rankCheckTaskPost`, `fetchRankCheckTaskResult`, `MAX_TASKS_PER_POST`). F03 phase 1: `src/lib/pricing/dataforseo.ts` (`costPerSerpAtDepth`, `serpKeywordCostMultiplier`, `dataforseoPricing.domain.rankedKeywords`, `.labs.keywordOverview`, `.keywords.adsSearchVolume`), `src/shared/ai-visibility-pricing.ts` (`scheduledChecksPerMonth`). F06 (tables, export). F09 phase 1 (`definePricedAction`, `quote`, `requireApprovedPrice`, `recordApproval`, `price_approvals`) and phase 3 (`CostReviewDialog`, `usePriceQuote`, `MonthlyProjection`). F10 phase 1 (`src/shared/schedule.ts`, `src/lib/schedules/runDue.ts`) and phase 4 (`ScheduleField`). F13 phase 1 (`src/shared/keyword-locations.ts`, `createLabsClient`, `keyword-metrics.ts`, `PricedActionButton`), phase 2 (`keyword_metrics`, `upsertKeywordMetrics`) and phase 8 (`serp-locations.ts`, `assertLocalResearchLocation`, `/api/customer/keywords/locations`, `SerpLocationCombobox`). F14 phase 1 (`src/lib/domain/domainKeywordMapper.ts`). UI phases need F04 and F05. Phase 6 needs F08 phase 1 (`addWorkspaceQuestion`, `workspace_questions`) and F12 phase 1 (`question_answer_links`). |
| Blocks | F21 (rank-tracking skill), F22 (rank tools), F23 (rank sections in reports) |
| Reserved migrations | 110–114. **110** `110_f15_rank_tracking.sql` (phase 1). **111** `111_f15_rank_tracking_functions.sql` (phase 1). **112** `112_f15_rank_keyword_questions.sql` (phase 6). 113–114 unused. |
| Feature flag | `FEATURE_RANK_TRACKING` (name `rank_tracking`, spend `["rank_tracking.check","rank_tracking.suggestions","rank_tracking.metrics"]`): page, routes, sidebar item, scheduled checks. `FEATURE_RANK_TRACKING_AI_QUESTIONS` (name `rank_tracking_ai_questions`, spend `[]`): the "Track as AI question" action and the AI-visibility column; also needs F08's `question_curation`. Both in `CLIENT_FEATURES`; both off in production by default. |
| Spend features | `rank_tracking.check` ("Rank checks"), `rank_tracking.suggestions` ("Rank tracking keyword suggestions"), `rank_tracking.metrics` ("Rank tracking keyword stats"). All ship disabled. |
| OpenSEO reference | `openseo:src/db/app.schema.ts:216-376`, `openseo:src/server/workflows/{RankCheckWorkflow,rankCheckPaths,rankCheckRetries}.ts`, `openseo:src/server/features/rank-tracking/**`, `openseo:src/server/lib/dataforseo/serp.ts:42-351`, `openseo:src/serverFunctions/rank-tracking.ts`, `openseo:src/shared/rank-tracking.ts`, `openseo:src/types/schemas/{rank-tracking,rank-tracking-search,schedule-time}.ts`, `openseo:src/client/features/rank-tracking/**`, `openseo:src/shared/google-serp-url.ts`, `openseo:scripts/repair-rank-tracking-locations.ts` (lesson only) at `c5f8db1` |

## 1. Summary

Customers track where their domain ranks on Google for chosen keywords, per device and market, on a daily, weekly or monthly schedule or on demand, with OpenSEO's anti-glitch re-checks, change badges, position-distribution chart, history grid and per-keyword trend. Every SERP check is priced, approved, metered and capped. The Perceev twist joins classic SEO to AI visibility: a keyword whose results page shows a Google AI Overview gets an "AI Overview" tag, and one click turns it into a tracked AI question that our Google AI Overview engine measures inside the P0 fence; its verdict (cited, named, absent, no overview) then sits next to the keyword's rank.

## 2. What OpenSEO does (observed)

1. **Data model.** `rank_tracking_configs` (one per project + domain + location + language; devices `both|desktop|mobile`, `serp_depth`, schedule `daily|weekly|monthly|manual` default weekly, `location_name`, `is_active`, `last_checked_at`, `next_check_at`, `last_skip_reason`; national and local partial unique indexes) `openseo:src/db/app.schema.ts:216-265`; `rank_tracking_keywords` (`match_case`, volume/KD/CPC, `metrics_fetched_at`, `pinned_at`, unique per config) `:268-299`; `rank_check_runs` (`pending|running|completed|failed`, totals, `is_subset_run`, partial unique index on `config_id WHERE status IN ('pending','running')` as the duplicate-trigger guard) `:301-339`; `rank_snapshots` (one row per keyword × device × run; position null = not found; `serp_features` JSON array; **no FK to keywords on purpose**, "Historical snapshots are preserved after a keyword is removed") `:341-376`. Postgres mirror: `openseo:drizzle/pg/0000_fixed_nico_minoru.sql:92-133`, `0006_location_name.sql`, `0029_rank_keyword_pins.sql`, `0037_smooth_lady_ursula.sql`.
2. **Limits and prices.** 10 keywords per live batch, 2 retry rounds, ~6 s per batch, 1,000 keywords per config, 200 chars per keyword, 500 configs per project, 100 tasks per `task_post` (`openseo:src/shared/rank-tracking.ts:33-55`). Live $0.002 first page + $0.0015 each extra page; queued $0.0006 + $0.00045 (`:15-25`, `:69-77`); advanced search operators bill 5× (`:86-91`). The estimate is the check at its method's price plus two queued retry rounds of every pair (`:98-117`). Scheduled estimates use queued pricing × checks per month (30/4/1) (`:163-195`).
3. **Check workflow** (`openseo:src/server/workflows/RankCheckWorkflow.ts`): `check-active` guard (`:309-325`); `prepare` refuses a superseded run, flips to running, filters subset ids, re-checks the price against the approved ceiling and balance (`:53-137`); manual checks use the live endpoint, scheduled ones the task queue (~30% of live) (`:368-375`); then retries (`:376`); `finalize` counts from snapshots, marks `failed` when nothing was checked and writes a partial summary "Checked x of y mobile and …" (`:139-241`); `mark-failed` records `insufficient_credits` as the config's skip reason (`:243-276`).
4. **Live path** (`openseo:src/server/workflows/rankCheckPaths.ts:84-178`): one single-attempt step per 10-keyword batch, both devices in parallel, one credit hold per batch; failures are logged and skipped; the first per-keyword rejection is stored on the run (`setRunErrorIfEmpty`, `openseo:src/server/features/rank-tracking/repositories/runQueries.ts:46-53`); snapshots are written per batch.
5. **Queued path** (`rankCheckPaths.ts:180-363`): billed `task_post` per 100 pairs (never retried), then free `task_get` polls after 4/2/2/2/2/3 minutes (cumulative 15), ≤ 500 `task_get` per round with 25 in flight; collect steps retry twice; unfinished tasks are left to the retries.
6. **Anti-glitch retries** (`openseo:src/server/workflows/rankCheckRetries.ts`): a pair is re-checked when it got no answer, reads ≥ 10 positions worse than its known position (best on either device in earlier checks or the other device now), or misses on its first ever check (`:24-50`, `:66-99`); up to 2 queued rounds; the best position wins (`:105-132`); a find on one device makes the other device's miss suspect (`:139-151`); a keyword that ranked before is never saved as "not found": unconfirmed misses are deleted so it reads as not checked (`:161-200`).
7. **SERP call.** `stop_crawl_on_match` on the target domain (organic only, with subdomains) so a page-1 rank bills one page (`openseo:src/server/lib/dataforseo/serp.ts:42-49`); position = `rank_group` of the first organic item on the domain; `serpFeatures` = the distinct item types on the page, which includes `ai_overview` when Google rendered one into the standard SERP (`:137-160`). Rank checks do **not** send `load_async_ai_overview` (`:162-204`, `:223-297`); only OpenSEO's AI-visibility module does (`openseo:src/server/lib/dataforseo/ai-tracking.ts:84-86`, extra $0.0006 queued / $0.002 live, refunded when no overview loads, `openseo:src/shared/ai-visibility.ts:31-40`).
8. **Single active run.** The partial unique index is the lock; `beginRankCheckRun` inserts the run, starts the workflow, and on a conflict inspects the blocker, fails it if its workflow is dead (60 s startup grace) and retries once (`openseo:src/server/features/rank-tracking/services/rankCheckRunGuards.ts:11-19`, `:48-114`, `:140-232`).
9. **Scheduler** (`openseo:src/server/features/rank-tracking/services/scheduledRankChecks.ts`): every 5 minutes; oldest due first, at most 500 (`openseo:src/server/features/rank-tracking/repositories/RankTrackingRepository.ts:134-173`); admission budget of 1,000 task units (keywords × devices) per tick sized against DataForSEO's 2,000 requests/min cap, first start always admitted (`:11-24`, `:93-103`); zero-keyword configs advance with `no_keywords` (`:108-119`); the schedule is advanced by compare-and-set on `next_check_at` before starting (`RankTrackingRepository.ts:187-216`); an already-running config gets its slot restored (`scheduledRankChecks.ts:201-217`); a 3-minute wall clock (`:26-30`). Anchors advance without drift (`openseo:src/shared/rank-tracking.ts:298-374`); a weekly chosen time needs a weekday (`openseo:src/server/features/rank-tracking/services/configSchedule.ts:11-36`).
10. **Results** (`openseo:src/server/features/rank-tracking/services/rankTrackingResults.ts:14-152`): latest snapshot per keyword × device from completed runs; comparison = newest snapshot before now − 1/7/30/90 days, else the earliest snapshot; freshness from the newest snapshot, not the newest run. Trend buckets top 3 / 4–10 / 11–20 / not in top 20 / not checked, filtered by run start, subset runs excluded (`openseo:src/server/features/rank-tracking/repositories/snapshotQueries.ts:83-117`, `openseo:src/serverFunctions/rank-tracking.ts:320-349`); history matrix over the last 12 full runs (`snapshotQueries.ts:124-158`).
11. **Config service** (`openseo:src/server/features/rank-tracking/services/RankTrackingService.ts`): domain normalisation (`:420-434`); re-adding an archived domain reactivates it with history (`:81-120`); config cap (`:95-105`); a location name is validated against DataForSEO at save time (`:63-72`; lesson of `openseo:scripts/repair-rank-tracking-locations.ts:1-28`, where free-form names made every run "complete" with zero results); editing keeps the run time unless the schedule changed (`:198-209`); after adding keywords an automatic check starts unless a scheduled one is due within the hour (`:270-301`); keyword metrics refresh for local configs uses city volume (`:328-380`).
12. **Keywords** (`openseo:src/server/features/rank-tracking/services/RankTrackingKeywordService.ts:12-143`): lowercased unless match-case; de-duplicated; capped at 1,000; pins are shared per project.
13. **UI.** Setup modal: domain, country, national/local targeting, language, devices default **Mobile only** with "Tracking both devices uses 2x credits per keyword check", schedule, depth default 40 with "10 pages is ~8x more expensive than 1 page", and a cost box "up to $x per keyword per check · 50 keywords would cost up to $y/month" (`openseo:src/client/features/rank-tracking/RankTrackingConfigModal.tsx:60-71`, `:170-185`, `:311-355`, `:378-412`); schedule field with "Daily checks use 7x more credits than weekly" (`openseo:src/client/features/rank-tracking/ScheduleField.tsx:144-149`); then the keyword step pre-selects the **top 20 ranking keywords by traffic** (`openseo:src/client/features/rank-tracking/KeywordSuggestionStep.tsx:39`, `:184-200`). Detail: run alerts (`RankRunAlerts.tsx:8-62`), header with device toggle, compare select ("vs yesterday" …) and cost per check (`RankTrackingDetailHeader.tsx:26-153`), stacked area "Position distribution" (`RankTrackingOverview.tsx:30-163`), toolbar Latest/History (`RankTrackingTableToolbar.tsx:61-66`), table with pin star, change badges, URL, volume/KD/CPC, SERP feature tags with a Sparkles "AI" badge for `ai_overview` (`RankTrackingTableParts.tsx:11-108`, `RankTrackingColumns.tsx:99-301`), optimistic pins (`useSetKeywordPinned.ts:10-48`), history matrix with "Not checked" cells (`RankTrackingHistoryMatrix.tsx:27-194`), per-keyword trend modal with a reversed Y axis and a "not found" band (`KeywordTrendModal.tsx:60-120`, `RankTrackingTrendChart.tsx:27-110`), confirm above 50 keywords (`RankTrackingDomainDetail.tsx:193-201`, `CheckConfirmModal.tsx:9-55`), polling 3 s while active and 30 s otherwise (`useRankRunPolling.ts:9-47`), CSV/Sheets export with numeric change and empty cells for "not ranking" (`RankTrackingTableParts.tsx:150-255`).

## 3. What Perceev has today

- No rank tracking, no classic SERP tracking, no keyword tables. No `/portal/rank-tracking` route; the sidebar has no "My Site" rank item.
- Google AI Overview is measured only by the AI-visibility scan engine `aio` (`src/app/api/internal/_lib/probeResultContract.js:72`; Bright Data adapter `src/lib/engines/serp.js:124-160`), inside `claim_probe_dispatch` (`supabase/migrations/035_scoped_provider_rollout.sql:6-100`). Each observation records `answered` or `valid_no_aio` (`src/lib/db/probeDispatch.js:57`) and an `aio_capture_mode` (`src/lib/engines/brightdata.js:839`). The 20 October handoff records that **none of 28 valid India standard SERPs carried an inline AI Overview**; only Bright Data's rendered mode catches asynchronously loaded ones (`docs/audits/2026-10-16/HANDOFF-2026-10-20-demo-and-consolidation.md:29`, `:41`).
- Must not break: P0 controls (no call to an answer engine outside `claim_probe_dispatch`; never `set_probe_rollout`), R14 panels (F15 never approves a panel), the scan worker and its crons (F01 §6.3.8), existing portal pages.

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F15-AC-01 | Migrations 110–111 create `rank_tracking_configs`, `rank_tracking_keywords`, `rank_check_runs`, `rank_snapshots`, `rank_check_tasks` with RLS, read policies, composite tenant FKs, the national/local partial unique indexes, the one-active-run partial unique index and **no** FK from snapshots to keywords; each member reads only their workspace's rows. | DB `scripts/qa/check-f15-db.mjs` groups `schema`, `rls`; `tests/customer-uat.sql` |
| F15-AC-02 | `estimateRankCheckUsd` reproduces OpenSEO's four parity cases in raw USD: live 4 kw desktop depth 10 → 0.0128; live 1,000 kw both depth 40 → 20.8; queued 104 kw desktop depth 10 → 0.1872; queued 1,000 kw both depth 40 → 11.7; an operator keyword (`site:x`) costs 5×. | unit `src/lib/rank-tracking/cost.test.ts` |
| F15-AC-03 | Creating a tracker normalises the domain, reactivates an archived duplicate with its history, refuses an active duplicate (`409 tracker_exists`), refuses the 501st config (`409 tracker_limit`), refuses an unknown city (`409 unknown_location`, free registry check), stores `next_check_at = NULL` for manual and refuses a weekly time without a weekday (`400 schedule_weekday_required`). | unit `service.test.ts`; route test |
| F15-AC-04 | Adding keywords lowercases unless match-case, de-duplicates, caps at 1,000 atomically, fills volume/KD/CPC free from `keyword_metrics` rows fresher than 7 days (national configs), and on a scheduled config whose new per-check quote exceeds the stored approval returns `400 approval_required` (no `maxUsd`) or `409 price_changed` (lower `maxUsd`) and adds nothing; with an adequate `maxUsd` it adds and stores the new approval. | unit; route `rankTracking.route.test.mjs`; DB group `keywords` |
| F15-AC-05 | At most one active run per tracker: a second check returns `409 rank_check_running` with `details.activeRunId`; the partial unique index and F01 `singleActiveKey "rank_tracking.check:<configId>"` both hold; a blocker whose job is terminal or missing after 60 s is failed and replaced exactly once. | unit `runGuards.test.ts` (port of `rankCheckRunGuards.test.ts:72`); DB group `active` |
| F15-AC-06 | A manual check requires approval (`400 approval_required` / `409 price_changed`); `prepare` freezes the keyword list and fails the run with `price_changed` if its fresh estimate exceeds the approved maximum; a run never reserves more than its approved maximum (`rank_check_reserve`). | unit `checkJob.test.ts` (port of `RankCheckWorkflow.test.ts:118`); DB group `reserve` |
| F15-AC-07 | Live path: one billed step (retries 0) per 10 keywords using `serp.rankCheckBatch` with feature `rank_tracking.check` and `idempotencyKey = jobStepKey(ctx, step)`; a failed batch does not stop the run; the first rejection reason is kept; snapshots are written per batch. | unit `checkPaths.test.ts` (port of `rankCheckPaths.test.ts:100`) |
| F15-AC-08 | Queued path: ≤ 100 pairs per billed post step; free collection steps with 2 retries after 240/120/120/120/120/180 s; ≤ 500 `task_get` per round, 25 concurrent; still-pending tasks are marked `expired` after the last round. | unit `checkPaths.test.ts` |
| F15-AC-09 | Retries reproduce OpenSEO's five cases: errored pair re-checked and a never-ranked miss kept; a ≥ 10-position drop re-checked and the best kept; a find on the other device makes a miss suspect; a new keyword found on its second re-check; a previously ranked keyword never saved as not found. | unit `retries.test.ts` (port of `rankCheckPaths.test.ts:113-199`) |
| F15-AC-10 | Finalize: no snapshot → run `failed` with the stored reason (or "No keywords could be checked."); a missing device → `completed` with "Checked 9 of 10 mobile and 10 of 10 desktop keyword(s)"; `completed` sets `last_checked_at` and clears the skip reason; `failed` changes neither. | unit (port of `RankCheckWorkflow.test.ts:167-200`) |
| F15-AC-11 | Scheduling: the tick admits by 1,000 task units (first always admitted; zero-keyword configs advance with `no_keywords`; the first overflow defers the rest); advances by compare-and-set; restores the slot when a run is active; records skip reasons (`price_changed`, `approval_missing`, `rank_tracking_disabled`, `workspace_inactive`, `start_failed`) and advances; uses F10 `runDueSchedules` and `computeNextRunAt`; scheduled checks use the queue. | unit `schedules.test.ts` (ports of `scheduledRankChecks.test.ts:104-328`) |
| F15-AC-12 | Results: compare 1d/7d/30d/90d with the earliest-snapshot fallback; each device result carries `checkedAt` so "not checked yet" differs from "not in top N"; freshness from the newest snapshot even when a newer run failed. | unit `results.test.ts` (port of `rankTrackingResults.test.ts:29`); DB group `results` |
| F15-AC-13 | Trend buckets are disjoint and cover every keyword (`notChecked = keywordsTotal − total`), filter on run start, exclude subset runs; the matrix uses the last N full runs. | DB group `trend` (ports of `RankTrackingRepository.query.test.ts:359`, `:406`) |
| F15-AC-14 | **AI Overview fence:** no rank-check request body contains `load_async_ai_overview`; only the type string `ai_overview` is stored (`serp_features`, `has_ai_overview`); no overview text, references or citations are stored or logged; no file under `src/lib/rank-tracking/` imports `src/lib/providers/dataforseo/answers.ts`. | unit `aiOverviewFence.test.ts`; F02 `answerImportGuard.test.mjs` |
| F15-AC-15 | Pinning moves the row at once in every cached compare period and reverts through a refetch on failure; pins are shared in the workspace. | unit (F05 `optimistic.test.ts` pattern); browser B6 |
| F15-AC-16 | Setup wizard: Mobile only, depth 40, weekly at a random 04:00–10:00 UTC slot by default; live server-priced estimate; the daily and both-devices notes; keyword suggestions fetched only after a priced click; the top 20 by traffic pre-selected; a scheduled tracker's keywords need an approved per-check maximum; an optional first check with its own approval. | browser B1–B3 |
| F15-AC-17 | Detail page: position-distribution chart, table with change badges and SERP feature tags, Latest/History toggle, trend modal with "1 = best" at the top, CSV/Sheets export with numeric change, filters incl. "AI Overview", URL state for view/device/compare/sort/filters. | browser B4–B8 |
| F15-AC-18 | "Update keyword stats" buys only keywords missing or older than 7 days in `keyword_metrics` for national trackers (Labs or Ads by country), always buys city volume for local trackers, is priced and approved, and upserts national rows into `keyword_metrics`. | unit `metrics.test.ts` |
| F15-AC-19 | "Track as AI question" calls `addWorkspaceQuestion` with `origin "manual"` and `sourceRef { kind: "rank_keyword", trackingKeywordId, keyword, locationCode, languageCode }`, links the keyword, reports created / already tracked / restored, maps `question_limit`/`topic_limit`, never changes an approved panel, and is hidden unless `rank_tracking_ai_questions` and `question_curation` are on. | unit `aiQuestions.test.ts`; browser B9 |
| F15-AC-20 | The AI-visibility column shows, per linked keyword, the latest Google AI Overview observation as `cited`, `mentioned`, `absent`, `no_overview` or `not_measured` with its date; it reads only state and boolean flags (never answer text) and degrades to `not_measured` when F12's table is unavailable. | unit `aiQuestions.test.ts`; DB group `aio_status` |
| F15-AC-21 | Retention: runs (with snapshots and tasks) started more than 760 days ago and tasks older than 14 days are pruned daily in batches. | DB group `retention` |
| F15-AC-22 | Flags and spend: flag off → page hidden and routes `404 feature_unavailable`; a disabled spend control → `403 feature_disabled`; the three spend features and both flags are registered with labels and env names. | route tests; `flags.test.ts` |
| F15-AC-23 | The client polls the latest run only while it is `pending`/`running`, at the server's `pollAfterSeconds` (floor 3 s), and refreshes results, trend, matrix and history once when a run finishes. | unit `src/lib/rank-tracking/runPolling.test.ts`; browser B5 |
| F15-AC-24 | Telemetry events carry no keyword text, domain or URL. | unit `telemetry.test.ts` |

## 5. Scope

**In scope:** trackers (configs), keywords, runs, snapshots, queued-task ledger; live and queued checks with retries; single-active-run guard; scheduling on F10's utility with an approved per-check maximum; results, trend, matrix, keyword history; keyword metrics from the shared cache with paid refresh; keyword suggestions from ranked keywords; priced actions; retention; the two portal pages and the setup wizard; the AI Overview tag, filter and summary strip; "Track as AI question" and the AI-visibility column; F22 tool definitions.

**Out of scope:** AI Overview *content* or citation capture in rank checks (stays with the `aio` engine inside the P0 fence); local Maps rank grids (F17); competitor share-of-voice from rank data and AI-visibility competitor tracking (deferred Mixed row "Competitors (tracking side)", unchanged); Search Console position import (deferred Mixed row "Search Console", unchanged); billing/credits; MCP server (F22 registers the tools later); email alerts on rank changes (F25 may add); bulk import from saved keywords (a later F13/F15 follow-up; not built here).

## 6. Design

### 6.1 Data model

#### `supabase/migrations/110_f15_rank_tracking.sql`

```sql
-- F15: rank tracking. Tables mirror OpenSEO app.schema.ts:216-376 with brand_key
-- tenancy, composite tenant FKs, timestamptz and a queued-task ledger.
CREATE TABLE IF NOT EXISTS public.rank_tracking_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  domain text NOT NULL CHECK (domain = lower(btrim(domain)) AND length(domain) BETWEEN 3 AND 253
    AND domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' AND domain NOT LIKE 'www.%'),
  location_code integer NOT NULL DEFAULT 2840 CHECK (location_code BETWEEN 1000 AND 9999999),
  language_code text NOT NULL DEFAULT 'en' CHECK (language_code ~ '^[a-z]{2,3}(-[A-Za-z]{2,4})?$'),
  location_name text CHECK (location_name IS NULL OR length(location_name) BETWEEN 1 AND 200),
  devices text NOT NULL DEFAULT 'mobile' CHECK (devices IN ('both','desktop','mobile')),
  serp_depth integer NOT NULL DEFAULT 40 CHECK (serp_depth BETWEEN 10 AND 100 AND serp_depth % 10 = 0),
  schedule_interval text NOT NULL DEFAULT 'weekly' CHECK (schedule_interval IN ('daily','weekly','monthly','manual')),
  is_active boolean NOT NULL DEFAULT true,
  last_checked_at timestamptz,
  next_check_at timestamptz,
  last_skip_reason text CHECK (last_skip_reason IS NULL OR last_skip_reason ~ '^[a-z_]{1,40}$'),
  last_skip_at timestamptz,
  approved_max_usd numeric(12,6) CHECK (approved_max_usd IS NULL OR approved_max_usd > 0),
  approval_id uuid REFERENCES public.price_approvals(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rank_tracking_configs_manual_unscheduled CHECK (schedule_interval <> 'manual' OR next_check_at IS NULL),
  CONSTRAINT rank_tracking_configs_id_brand UNIQUE (id, brand_key)
);
COMMENT ON COLUMN public.rank_tracking_configs.location_name IS 'Canonical DataForSEO location_name (city/county/region) for a local tracker; NULL = country-level.';
COMMENT ON COLUMN public.rank_tracking_configs.approved_max_usd IS 'Approved maximum per scheduled check (F09 action rank_tracking.config.save). NULL = scheduled checks skip with approval_missing.';
CREATE UNIQUE INDEX IF NOT EXISTS rank_tracking_configs_national_idx
  ON public.rank_tracking_configs (brand_key, domain, location_code, language_code) WHERE location_name IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rank_tracking_configs_local_idx
  ON public.rank_tracking_configs (brand_key, domain, location_code, language_code, location_name) WHERE location_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS rank_tracking_configs_brand_active_idx
  ON public.rank_tracking_configs (brand_key, is_active, created_at);
CREATE INDEX IF NOT EXISTS rank_tracking_configs_due_idx
  ON public.rank_tracking_configs (next_check_at, id) WHERE is_active AND schedule_interval <> 'manual';
DROP TRIGGER IF EXISTS rank_tracking_configs_touch ON public.rank_tracking_configs;
CREATE TRIGGER rank_tracking_configs_touch BEFORE UPDATE ON public.rank_tracking_configs
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.rank_tracking_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  config_id uuid NOT NULL,
  keyword text NOT NULL CHECK (keyword = btrim(keyword) AND length(keyword) BETWEEN 1 AND 200),
  match_case boolean NOT NULL DEFAULT false,
  search_volume integer CHECK (search_volume IS NULL OR search_volume >= 0),
  keyword_difficulty smallint CHECK (keyword_difficulty IS NULL OR keyword_difficulty BETWEEN 0 AND 100),
  cpc numeric(12,4) CHECK (cpc IS NULL OR cpc >= 0),
  metrics_fetched_at timestamptz,
  metrics_source text CHECK (metrics_source IS NULL OR metrics_source IN ('cache','labs','google_ads','labs_ranked')),
  pinned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rank_tracking_keywords_config_fk FOREIGN KEY (config_id, brand_key)
    REFERENCES public.rank_tracking_configs(id, brand_key) ON DELETE CASCADE,
  CONSTRAINT rank_tracking_keywords_case CHECK (match_case OR keyword = lower(keyword)),
  CONSTRAINT rank_tracking_keywords_unique UNIQUE (config_id, keyword)
);
CREATE INDEX IF NOT EXISTS rank_tracking_keywords_brand_idx ON public.rank_tracking_keywords (brand_key, config_id);

CREATE TABLE IF NOT EXISTS public.rank_check_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  config_id uuid NOT NULL,
  job_id uuid,                                  -- F01 jobs.id; no FK (jobs are pruned after 30 days)
  trigger text NOT NULL CHECK (trigger IN ('manual','scheduled')),
  method text NOT NULL CHECK (method IN ('live','queued')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  phase text CHECK (phase IS NULL OR phase IN ('checking','rechecking','finishing')),
  domain text NOT NULL,                         -- frozen copy of the config at start (deterministic replay)
  location_code integer NOT NULL,
  language_code text NOT NULL,
  location_name text,
  devices text NOT NULL CHECK (devices IN ('both','desktop','mobile')),
  serp_depth integer NOT NULL CHECK (serp_depth BETWEEN 10 AND 100),
  keyword_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(keyword_ids) <= 1000),
  is_subset_run boolean NOT NULL DEFAULT false,
  keywords_total integer NOT NULL DEFAULT 0 CHECK (keywords_total BETWEEN 0 AND 1000),
  keywords_checked integer NOT NULL DEFAULT 0 CHECK (keywords_checked BETWEEN 0 AND 1000),
  approved_max_usd numeric(12,6) NOT NULL CHECK (approved_max_usd > 0),
  reserved_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,60}$'),
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 500),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT rank_check_runs_config_fk FOREIGN KEY (config_id, brand_key)
    REFERENCES public.rank_tracking_configs(id, brand_key) ON DELETE CASCADE,
  CONSTRAINT rank_check_runs_id_brand UNIQUE (id, brand_key),
  CONSTRAINT rank_check_runs_reserve_within_max CHECK (reserved_usd <= approved_max_usd)
);
COMMENT ON COLUMN public.rank_check_runs.reserved_usd IS 'Sum of step estimates reserved by rank_check_reserve; refuses beyond approved_max_usd (run-level cap).';
CREATE INDEX IF NOT EXISTS rank_check_runs_config_idx ON public.rank_check_runs (config_id, started_at DESC);
CREATE INDEX IF NOT EXISTS rank_check_runs_brand_idx ON public.rank_check_runs (brand_key, started_at DESC);
CREATE INDEX IF NOT EXISTS rank_check_runs_started_idx ON public.rank_check_runs (started_at);
CREATE UNIQUE INDEX IF NOT EXISTS rank_check_runs_one_active_per_config_idx
  ON public.rank_check_runs (config_id) WHERE status IN ('pending','running');

CREATE TABLE IF NOT EXISTS public.rank_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  -- No FK to rank_tracking_keywords, on purpose (OpenSEO app.schema.ts:349-351):
  -- history survives removing a keyword from tracking.
  tracking_keyword_id uuid NOT NULL,
  keyword text NOT NULL CHECK (length(keyword) BETWEEN 1 AND 200),
  device text NOT NULL CHECK (device IN ('desktop','mobile')),
  position integer CHECK (position IS NULL OR position BETWEEN 1 AND 700),  -- NULL = checked, not found within serp_depth
  url text CHECK (url IS NULL OR length(url) <= 2048),
  serp_features text[] NOT NULL DEFAULT '{}' CHECK (cardinality(serp_features) <= 60),
  has_ai_overview boolean GENERATED ALWAYS AS ('ai_overview' = ANY (serp_features)) STORED,
  checked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rank_snapshots_run_fk FOREIGN KEY (run_id, brand_key)
    REFERENCES public.rank_check_runs(id, brand_key) ON DELETE CASCADE,
  CONSTRAINT rank_snapshots_run_keyword_device UNIQUE (run_id, tracking_keyword_id, device)
);
COMMENT ON COLUMN public.rank_snapshots.serp_features IS 'Distinct SERP item types (e.g. ai_overview, people_also_ask). Type names only; never overview text or references.';
CREATE INDEX IF NOT EXISTS rank_snapshots_keyword_device_idx ON public.rank_snapshots (tracking_keyword_id, device, checked_at);

CREATE TABLE IF NOT EXISTS public.rank_check_tasks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  round smallint NOT NULL CHECK (round BETWEEN 0 AND 2),     -- 0 = first queued check; 1..2 = retry rounds
  tracking_keyword_id uuid NOT NULL,
  keyword text NOT NULL,
  device text NOT NULL CHECK (device IN ('desktop','mobile')),
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','posted','rejected','completed','failed','expired')),
  provider_task_id text CHECK (provider_task_id IS NULL OR length(provider_task_id) <= 100),
  position integer CHECK (position IS NULL OR position BETWEEN 1 AND 700),
  url text CHECK (url IS NULL OR length(url) <= 2048),
  serp_features text[] NOT NULL DEFAULT '{}',
  message text CHECK (message IS NULL OR length(message) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rank_check_tasks_run_fk FOREIGN KEY (run_id, brand_key)
    REFERENCES public.rank_check_runs(id, brand_key) ON DELETE CASCADE,
  CONSTRAINT rank_check_tasks_pair UNIQUE (run_id, round, tracking_keyword_id, device)
);
COMMENT ON TABLE public.rank_check_tasks IS 'F15: queued DataForSEO tasks per run and round. Replaces Workflow step outputs, which F01 caps at 64 KB.';
CREATE INDEX IF NOT EXISTS rank_check_tasks_run_round_state_idx ON public.rank_check_tasks (run_id, round, state, id);
CREATE INDEX IF NOT EXISTS rank_check_tasks_created_idx ON public.rank_check_tasks (created_at);
DROP TRIGGER IF EXISTS rank_check_tasks_touch ON public.rank_check_tasks;
CREATE TRIGGER rank_check_tasks_touch BEFORE UPDATE ON public.rank_check_tasks
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['rank_tracking_configs','rank_tracking_keywords','rank_check_runs','rank_snapshots','rank_check_tasks'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key))', t || '_read', t);
  END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
```

#### `supabase/migrations/111_f15_rank_tracking_functions.sql`

All functions are `SECURITY INVOKER`, `SET search_path = public`, revoked from `PUBLIC, anon, authenticated` and granted to `service_role` (routes call them after `requireWorkspace`; every function takes `p_brand` and filters by it).

```sql
-- Atomic keyword add with the 1,000 cap (port of RankTrackingKeywordService.ts:12-58 + RankTrackingRepository.ts:226-245).
CREATE OR REPLACE FUNCTION public.add_rank_tracking_keywords(p_brand text, p_config uuid, p_rows jsonb)
RETURNS uuid[] LANGUAGE plpgsql SET search_path = public AS $$
DECLARE c rank_tracking_configs; v_count integer; v_ids uuid[];
BEGIN
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'rank_keywords_invalid:rows'; END IF;
  SELECT * INTO c FROM rank_tracking_configs WHERE id = p_config AND brand_key = p_brand FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'rank_config_not_found'; END IF;
  SELECT count(*) INTO v_count FROM rank_tracking_keywords WHERE config_id = p_config;
  IF v_count >= 1000 THEN RAISE EXCEPTION 'rank_keywords_cap:%', v_count; END IF;
  WITH incoming AS (
    SELECT r.keyword, coalesce(r.match_case, false) AS match_case, r.search_volume, r.keyword_difficulty, r.cpc,
           r.metrics_fetched_at, r.metrics_source, ord
      FROM jsonb_to_recordset(p_rows) WITH ORDINALITY AS r(keyword text, match_case boolean, search_volume integer,
           keyword_difficulty smallint, cpc numeric, metrics_fetched_at timestamptz, metrics_source text, ord bigint)
     ORDER BY ord LIMIT 1000 - v_count
  ), ins AS (
    INSERT INTO rank_tracking_keywords (brand_key, config_id, keyword, match_case, search_volume, keyword_difficulty,
                                        cpc, metrics_fetched_at, metrics_source)
    SELECT p_brand, p_config, keyword, match_case, search_volume, keyword_difficulty, cpc, metrics_fetched_at, metrics_source
      FROM incoming
    ON CONFLICT (config_id, keyword) DO NOTHING
    RETURNING id
  ) SELECT coalesce(array_agg(id), '{}') INTO v_ids FROM ins;
  RETURN v_ids;
END $$;

-- Compare-and-set on next_check_at (port of RankTrackingRepository.ts:187-216).
CREATE OR REPLACE FUNCTION public.claim_rank_config(p_brand text, p_config uuid, p_observed timestamptz,
  p_next timestamptz, p_write_skip boolean DEFAULT false, p_skip_reason text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  UPDATE rank_tracking_configs
     SET next_check_at = p_next,
         last_skip_reason = CASE WHEN p_write_skip THEN p_skip_reason ELSE last_skip_reason END,
         last_skip_at = CASE WHEN p_write_skip AND p_skip_reason IS NOT NULL THEN now()
                             WHEN p_write_skip THEN NULL ELSE last_skip_at END
   WHERE id = p_config AND brand_key = p_brand AND is_active AND schedule_interval <> 'manual'
     AND next_check_at = p_observed;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v = 1;
END $$;

-- Insert a pending run; false when another run is active (port of runQueries.ts:19-32).
CREATE OR REPLACE FUNCTION public.try_create_rank_run(p_brand text, p_config uuid, p_run uuid, p_trigger text,
  p_method text, p_approved_max numeric, p_keyword_ids uuid[], p_actor uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE c rank_tracking_configs; v integer;
BEGIN
  SELECT * INTO c FROM rank_tracking_configs WHERE id = p_config AND brand_key = p_brand;
  IF NOT FOUND OR NOT c.is_active THEN RAISE EXCEPTION 'rank_config_not_found'; END IF;
  INSERT INTO rank_check_runs (id, brand_key, config_id, trigger, method, domain, location_code, language_code,
                               location_name, devices, serp_depth, keyword_ids, is_subset_run, approved_max_usd, created_by)
  VALUES (p_run, p_brand, p_config, p_trigger, p_method, c.domain, c.location_code, c.language_code, c.location_name,
          c.devices, c.serp_depth, coalesce(p_keyword_ids, '{}'), cardinality(coalesce(p_keyword_ids, '{}')) > 0,
          p_approved_max, p_actor)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v = 1;
END $$;

-- Run-level cap: reserve a step's estimate within the approved maximum.
CREATE OR REPLACE FUNCTION public.rank_check_reserve(p_brand text, p_run uuid, p_usd numeric)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  IF p_usd IS NULL OR p_usd <= 0 THEN RAISE EXCEPTION 'rank_reserve_invalid'; END IF;
  UPDATE rank_check_runs SET reserved_usd = reserved_usd + p_usd
   WHERE id = p_run AND brand_key = p_brand AND status IN ('pending','running')
     AND reserved_usd + p_usd <= approved_max_usd;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v = 1;
END $$;

-- Latest (or latest before p_before) snapshot per keyword x device from completed runs
-- (port of snapshotQueries.ts:167-232 using DISTINCT ON).
CREATE OR REPLACE FUNCTION public.rank_latest_snapshots(p_brand text, p_config uuid, p_before timestamptz DEFAULT NULL)
RETURNS TABLE (tracking_keyword_id uuid, device text, run_id uuid, keyword text, position integer, url text,
               serp_features text[], checked_at timestamptz)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT DISTINCT ON (s.tracking_keyword_id, s.device) s.tracking_keyword_id, s.device, s.run_id, s.keyword,
         s.position, s.url, s.serp_features, s.checked_at
    FROM rank_snapshots s JOIN rank_check_runs r ON r.id = s.run_id
   WHERE r.config_id = p_config AND r.brand_key = p_brand AND s.brand_key = p_brand AND r.status = 'completed'
     AND (p_before IS NULL OR s.checked_at <= p_before)
   ORDER BY s.tracking_keyword_id, s.device, s.checked_at DESC, s.id DESC
$$;

CREATE OR REPLACE FUNCTION public.rank_earliest_snapshots(p_brand text, p_config uuid, p_keyword_ids uuid[])
RETURNS TABLE (tracking_keyword_id uuid, device text, position integer, checked_at timestamptz)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT DISTINCT ON (s.tracking_keyword_id, s.device) s.tracking_keyword_id, s.device, s.position, s.checked_at
    FROM rank_snapshots s JOIN rank_check_runs r ON r.id = s.run_id
   WHERE r.config_id = p_config AND r.brand_key = p_brand AND r.status = 'completed'
     AND s.tracking_keyword_id = ANY (p_keyword_ids)
   ORDER BY s.tracking_keyword_id, s.device, s.checked_at ASC, s.id ASC
$$;

-- Best position per keyword on any device in completed runs (port of snapshotQueries.ts:37-46).
CREATE OR REPLACE FUNCTION public.rank_best_positions(p_brand text, p_config uuid)
RETURNS TABLE (tracking_keyword_id uuid, position integer)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT s.tracking_keyword_id, min(s.position)
    FROM rank_snapshots s JOIN rank_check_runs r ON r.id = s.run_id
   WHERE r.config_id = p_config AND r.brand_key = p_brand AND r.status = 'completed'
   GROUP BY s.tracking_keyword_id
$$;

-- Position distribution per full completed run (port of snapshotQueries.ts:83-117).
CREATE OR REPLACE FUNCTION public.rank_config_trend(p_brand text, p_config uuid, p_device text, p_since timestamptz)
RETURNS TABLE (run_id uuid, checked_at timestamptz, keywords_total integer, total integer, top3 integer,
               top4to10 integer, top11to20 integer, ai_overview integer)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT r.id, r.started_at, r.keywords_total, count(s.id)::int,
         count(*) FILTER (WHERE s.position BETWEEN 1 AND 3)::int,
         count(*) FILTER (WHERE s.position BETWEEN 4 AND 10)::int,
         count(*) FILTER (WHERE s.position BETWEEN 11 AND 20)::int,
         count(*) FILTER (WHERE s.has_ai_overview)::int
    FROM rank_check_runs r JOIN rank_snapshots s ON s.run_id = r.id AND s.device = p_device
   WHERE r.config_id = p_config AND r.brand_key = p_brand AND r.status = 'completed'
     AND NOT r.is_subset_run AND r.started_at >= p_since
   GROUP BY r.id, r.started_at, r.keywords_total
   ORDER BY r.started_at ASC
$$;

-- Last p_run_limit full completed runs, one cell per keyword (port of snapshotQueries.ts:124-158).
CREATE OR REPLACE FUNCTION public.rank_position_matrix(p_brand text, p_config uuid, p_device text, p_run_limit integer)
RETURNS TABLE (run_id uuid, checked_at timestamptz, tracking_keyword_id uuid, position integer)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH recent AS (
    SELECT id, started_at FROM rank_check_runs
     WHERE config_id = p_config AND brand_key = p_brand AND status = 'completed' AND NOT is_subset_run
     ORDER BY started_at DESC LIMIT greatest(1, least(p_run_limit, 26)))
  SELECT s.run_id, recent.started_at, s.tracking_keyword_id, s.position
    FROM rank_snapshots s JOIN recent ON recent.id = s.run_id
   WHERE s.device = p_device ORDER BY recent.started_at ASC
$$;

-- Tracker list (port of RankTrackingRepository.ts:300-355).
CREATE OR REPLACE FUNCTION public.rank_config_summaries(p_brand text)
RETURNS TABLE (id uuid, domain text, location_code integer, language_code text, location_name text, devices text,
               serp_depth integer, schedule_interval text, next_check_at timestamptz, last_checked_at timestamptz,
               last_skip_reason text, last_skip_at timestamptz, approved_max_usd numeric, created_at timestamptz,
               keyword_count integer, last_run_status text, last_run_completed_at timestamptz)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT c.id, c.domain, c.location_code, c.language_code, c.location_name, c.devices, c.serp_depth,
         c.schedule_interval, c.next_check_at, c.last_checked_at, c.last_skip_reason, c.last_skip_at,
         c.approved_max_usd, c.created_at,
         (SELECT count(*)::int FROM rank_tracking_keywords k WHERE k.config_id = c.id),
         lr.status, lr.completed_at
    FROM rank_tracking_configs c
    LEFT JOIN LATERAL (SELECT status, completed_at FROM rank_check_runs r WHERE r.config_id = c.id
                        ORDER BY started_at DESC LIMIT 1) lr ON true
   WHERE c.brand_key = p_brand AND c.is_active ORDER BY c.created_at
$$;

-- Retention (F15-AC-21).
CREATE OR REPLACE FUNCTION public.prune_rank_tracking(p_runs_before timestamptz, p_tasks_before timestamptz, p_limit integer DEFAULT 1000)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_runs integer; v_tasks integer;
BEGIN
  WITH old AS (SELECT id FROM rank_check_runs WHERE started_at < p_runs_before AND status IN ('completed','failed')
                ORDER BY started_at LIMIT greatest(1, least(p_limit, 5000)))
  DELETE FROM rank_check_runs r USING old WHERE r.id = old.id;
  GET DIAGNOSTICS v_runs = ROW_COUNT;
  WITH old AS (SELECT id FROM rank_check_tasks WHERE created_at < p_tasks_before ORDER BY created_at
                LIMIT greatest(1, least(p_limit * 10, 50000)))
  DELETE FROM rank_check_tasks t USING old WHERE t.id = old.id;
  GET DIAGNOSTICS v_tasks = ROW_COUNT;
  RETURN jsonb_build_object('runs', v_runs, 'tasks', v_tasks);
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY[
    'add_rank_tracking_keywords(text,uuid,jsonb)','claim_rank_config(text,uuid,timestamptz,timestamptz,boolean,text)',
    'try_create_rank_run(text,uuid,uuid,text,text,numeric,uuid[],uuid)','rank_check_reserve(text,uuid,numeric)',
    'rank_latest_snapshots(text,uuid,timestamptz)','rank_earliest_snapshots(text,uuid,uuid[])',
    'rank_best_positions(text,uuid)','rank_config_trend(text,uuid,text,timestamptz)',
    'rank_position_matrix(text,uuid,text,integer)','rank_config_summaries(text)',
    'prune_rank_tracking(timestamptz,timestamptz,integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
```

Error mapping (repository): `rank_config_not_found` → `AppError(404,"tracker_not_found","This tracked domain does not exist.")`; `rank_keywords_cap:<n>` → `AppError(409,"keyword_limit","A domain can track up to 1,000 keywords. Remove some first.")`; anything else → `AppError(503,"rank_tracking_unavailable","Rank tracking could not be saved. Please retry.")`.

#### `supabase/migrations/112_f15_rank_keyword_questions.sql` (phase 6)

```sql
DO $$ BEGIN
  IF to_regclass('public.workspace_questions') IS NULL THEN
    RAISE EXCEPTION 'F15 phase 6 requires F08: workspace_questions';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.rank_keyword_questions (
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  tracking_keyword_id uuid NOT NULL REFERENCES public.rank_tracking_keywords(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.workspace_questions(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tracking_keyword_id, question_id)
);
CREATE INDEX IF NOT EXISTS rank_keyword_questions_brand_idx ON public.rank_keyword_questions (brand_key, question_id);
ALTER TABLE public.rank_keyword_questions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rank_keyword_questions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.rank_keyword_questions TO service_role;
GRANT SELECT ON public.rank_keyword_questions TO authenticated;
DROP POLICY IF EXISTS rank_keyword_questions_read ON public.rank_keyword_questions;
CREATE POLICY rank_keyword_questions_read ON public.rank_keyword_questions FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));

-- Latest Google AI Overview observation per question. plpgsql defers name resolution,
-- so this applies before F12's question_answer_links exists; calling it without F12 raises
-- undefined_table, which the service maps to "not_measured".
CREATE OR REPLACE FUNCTION public.rank_question_aio_status(p_brand text, p_question_ids uuid[])
RETURNS TABLE (question_id uuid, collected_at timestamptz, state text, aio_present boolean,
               own_cited boolean, own_mentioned boolean)
LANGUAGE plpgsql STABLE SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (l.question_id) l.question_id, l.collected_at,
         coalesce(o.state, CASE WHEN p.answered THEN 'answered' WHEN p.answered = false THEN 'valid_no_aio' ELSE 'unknown' END),
         coalesce((o.result->>'aio_present')::boolean, p.answered),
         coalesce((o.result->>'brand_cited')::boolean, p.brand_cited),
         coalesce((o.result->>'brand_mentioned_in_text')::boolean, p.mentioned)
    FROM question_answer_links l
    LEFT JOIN probe_observations o ON o.id = l.observation_id
    LEFT JOIN prompt_results p ON p.id = l.prompt_result_id
   WHERE l.brand_key = p_brand AND l.question_id = ANY (p_question_ids) AND l.engine = 'aio'
     AND l.source IN ('scan','legacy')
   ORDER BY l.question_id, l.collected_at DESC;
END $$;
REVOKE ALL ON FUNCTION public.rank_question_aio_status(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rank_question_aio_status(text, uuid[]) TO service_role;
NOTIFY pgrst, 'reload schema';
```

**Required objects** (`scripts/setup-supabase.mjs` `EXPECTED_OBJECTS`): `"110_f15_rank_tracking.sql": [table rank_tracking_configs, rank_tracking_keywords, rank_check_runs, rank_snapshots, rank_check_tasks]`, `"111_f15_rank_tracking_functions.sql": [function add_rank_tracking_keywords, claim_rank_config, try_create_rank_run, rank_check_reserve, rank_latest_snapshots, rank_earliest_snapshots, rank_best_positions, rank_config_trend, rank_position_matrix, rank_config_summaries, prune_rank_tracking]`, `"112_f15_rank_keyword_questions.sql": [table rank_keyword_questions, function rank_question_aio_status]`.

**Tenant RLS test** (`tests/customer-uat.sql`): per workspace one config, one keyword, one completed run, one snapshot, one task (and in phase 6 one link); as user 1 every `count(*)` = 1; a keyword insert with workspace 2's `brand_key` against workspace 1's `config_id` fails the composite FK (wrapped `BEGIN … EXCEPTION WHEN foreign_key_violation` that re-raises any other error).

**Migration paperwork** (§8): `README.md` rows `110_f15_rank_tracking` "Rank tracking tables: trackers, keywords, runs, snapshots, queued-task ledger.", `111_f15_rank_tracking_functions` "Rank tracking functions: atomic keyword add, schedule compare-and-set, run start and run-level spend cap, result reads, retention.", `112_f15_rank_keyword_questions` "Links tracked keywords to AI questions; latest Google AI Overview verdict per question."; `docs/OPERATOR_LEDGER.md` § C ("apply 110 and 111 before deploying F15 phase 2"; "apply 112 after F08's 075–079 and F12's 095, before F15 phase 6"); `docs/PROD_MIGRATIONS.md` one bullet each.

### 6.2 Server modules

All under `src/lib/rank-tracking/` (TypeScript, erasable syntax, relative imports with `.ts`/`.js` extensions, F01 §6.2). COPY/PORT files carry the licence header.

#### 6.2.1 `src/shared/rank-tracking.ts` (client-safe; PORT of `openseo:src/shared/rank-tracking.ts:33-55, 151-161, 376-396`, `openseo:src/types/schemas/rank-tracking{,-search}.ts`, `openseo:src/client/features/rank-tracking/RankTrackingTableParts.tsx:11-34, 150-216`)

```ts
import { z } from "zod";
export const KEYWORDS_PER_BATCH = 10, RETRY_ROUNDS = 2, SECONDS_PER_BATCH = 6;
export const MAX_KEYWORDS_PER_CONFIG = 1000, MAX_TRACKED_KEYWORD_LENGTH = 200, MAX_CONFIGS_PER_WORKSPACE = 500;
export const RETRY_DROP_POSITIONS = 10;
export const DEVICES = ["both","desktop","mobile"] as const; export type Devices = typeof DEVICES[number];
export const RANK_SCHEDULES = ["daily","weekly","monthly","manual"] as const; export type RankSchedule = typeof RANK_SCHEDULES[number];
export const COMPARE_PERIODS = ["1d","7d","30d","90d"] as const; export type ComparePeriod = typeof COMPARE_PERIODS[number];
export const COMPARE_PERIOD_DAYS: Record<ComparePeriod, number> = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 };
export const COMPARE_LABELS: Record<ComparePeriod, string> = { "1d": "vs yesterday", "7d": "vs last week", "30d": "vs last month", "90d": "vs 90 days ago" };
export function defaultComparePeriod(s: RankSchedule): ComparePeriod;         // daily → 1d, monthly → 30d, else 7d
export function devicesCount(d: Devices): 1 | 2;
export function devicesLabel(d: Devices): "Desktop + Mobile" | "Desktop" | "Mobile";
export function rankScheduleLabel(s: RankSchedule): string;                    // "Daily" | "Weekly" | "Monthly" | "Manual"
export function pagesToDepth(pages: number): number;
export function expandDevices(d: Devices): Array<"desktop" | "mobile">;
export type RankDeviceResult = { position: number | null; previousPosition: number | null; rankingUrl: string | null;
  serpFeatures: string[]; checkedAt: string | null };                          // checkedAt null = never checked
export type RankAiQuestion = { questionId: string; status: "cited" | "mentioned" | "absent" | "no_overview" | "not_measured"; measuredAt: string | null };
export type RankTrackingRow = { trackingKeywordId: string; keyword: string; matchCase: boolean; pinned: boolean;
  searchVolume: number | null; keywordDifficulty: number | null; cpc: number | null;
  desktop: RankDeviceResult; mobile: RankDeviceResult; aiQuestion: RankAiQuestion | null };
export const RANK_SKIP_REASONS = ["no_keywords","approval_missing","price_changed","rank_tracking_disabled","workspace_inactive",
  "daily_cap","workspace_cap","feature_disabled","start_failed"] as const;
export function rankSkipReasonMessage(reason: string): string;                 // table in §6.3; unknown → "The scheduled check could not start."
export const SERP_FEATURE_SHORT_LABELS: Record<string, string>;                 // COPY TableParts.tsx:11-21 ("AI" for ai_overview)
export const SERP_FEATURE_TOOLTIPS: Record<string, string>;                     // COPY :23-34; ai_overview copy replaced (§6.6.4)
export function csvChange(current: number | null, previous: number | null): number | string; // COPY :151-158
export function buildRankTrackingExport(rows: RankTrackingRow[], showDesktop: boolean, showMobile: boolean,
  locationLabel?: string | null): { headers: string[]; rows: (string | number)[][] };          // PORT :160-216 + "AI Overview" column ("yes" or "")
export const rankScheduleTimeSchema = scheduleTimeSchema;                       // re-export of F10 src/shared/schedule.ts
```

`src/shared/rank-tracking-filters.ts` (COPY of `openseo:src/client/features/rank-tracking/RankTrackingFilters.logic.ts:1-240`): `Filters`, `EMPTY_FILTERS`, `DomainListFilters`, `EMPTY_DOMAIN_LIST_FILTERS`, `applyDomainListFilters`, `getDomainListFilterOptions`, `applyFilters`, `countActiveFilters`, `countActiveDomainListFilters`. **Added:** filter `aiOverview: "any" | "shown" | "not_seen"` applied to the visible device's `serpFeatures` ("not_seen" = checked and the feature absent; never-checked rows are excluded from both non-"any" values).

`src/shared/google-serp-url.ts` (COPY of `openseo:src/shared/google-serp-url.ts:1-60`): `googleSerpUrl(keyword, market)`.

#### 6.2.2 `cost.ts` (PORT of `openseo:src/shared/rank-tracking.ts:93-145, 163-195`)

```ts
import { costPerSerpAtDepth, serpKeywordCostMultiplier } from "../pricing/dataforseo.ts";   // F03
import { toMicros, fromMicros } from "../spend/money.ts";                                  // F01
export type RankCheckMethod = "live" | "queued";
export function estimateRankCheckUsd(keywords: readonly string[], devices: Devices, depth: number, method: RankCheckMethod):
  { checkUsd: number; retryUsd: number; totalUsd: number; pairs: number };
export function estimatePairsUsd(pairs: ReadonlyArray<{ keyword: string }>, depth: number, method: RankCheckMethod): number;
export function estimateScheduledRankCheckUsd(keywords: readonly string[], devices: Devices, depth: number,
  interval: "daily" | "weekly" | "monthly"): { perCheckUsd: number; runsPerMonth: number; monthlyUsd: number };
```

`checkUsd` = Σ over keyword × device of `costPerSerpAtDepth(depth, method) × serpKeywordCostMultiplier(keyword)`; `retryUsd` = `RETRY_ROUNDS ×` the same sum at `"queued"`; all arithmetic in integer micro-dollars, result through `fromMicros` (no markup, no per-call rounding: we meter raw provider USD). `runsPerMonth` = F03 `scheduledChecksPerMonth(interval)`.

#### 6.2.3 `market.ts`

```ts
export function normalizeTrackedDomain(input: string): string;  // PORT RankTrackingService.ts:420-434; empty → AppError(400,"invalid_domain","Enter a valid domain, like example.com")
export function resolveTrackerMarket(body: { locationCode?: number; languageCode?: string }, brand: { website_host: string }):
  { locationCode: number; languageCode: string };                   // F13 resolveMarket(body, workspaceMarket(brand)); unsupported code → AppError(400,"invalid_location","This country is not supported.")
export async function assertTrackedLocation(locationCode: number, locationName: string, deps?): Promise<void>;
  // F13 assertLocalResearchLocation (free registry check, src/lib/keywords/localVolume.ts) → AppError(409,"unknown_location", its message)
```

Location names are checked against DataForSEO's free location registry at save time, so the failure mode `openseo:scripts/repair-rank-tracking-locations.ts:1-28` repaired cannot arise; no repair script is ported.

#### 6.2.4 `repository.ts` and `memoryRepository.ts`

`createRankTrackingRepository(admin: SupabaseClient)` → `RankTrackingRepository` (every method takes `brandKey` first and filters by it):

`listSummaries(brandKey)` (rpc `rank_config_summaries`), `getConfig(brandKey, configId)`, `findConfigByMarket(brandKey, domain, locationCode, languageCode, locationName)`, `countActiveConfigs(brandKey)`, `insertConfig(row)`, `updateConfig(brandKey, configId, patch)`, `listDueConfigs(now, limit = 500)` (active, not manual, `next_check_at <= now`, joined to active `customer_brands`, ordered `next_check_at, id`), `claimConfig(brandKey, configId, observed, next, skip?: { reason: string | null })` (rpc `claim_rank_config`), `listKeywords(brandKey, configId)` (ordered `created_at, id`), `keywordCounts(brandKey, configIds)`, `addKeywords(brandKey, configId, rows)` (rpc), `removeKeywords(brandKey, configId, ids)` (chunks of 500), `setPinned(brandKey, configId, ids, pinned)`, `updateKeywordMetrics(brandKey, rows)`, `tryCreateRun(i)` (rpc), `getRun(brandKey, runId)`, `getLatestRun(brandKey, configId)`, `getActiveRun(brandKey, configId)`, `updateRun(brandKey, runId, patch)`, `setRunErrorIfEmpty(brandKey, runId, code, message)`, `reserve(brandKey, runId, usd)` (rpc), `insertSnapshots(rows)` (`ON CONFLICT (run_id, tracking_keyword_id, device) DO NOTHING`, chunks of 500), `upsertSnapshots(rows)` (`DO UPDATE SET position, url, serp_features, checked_at = now()`), `deleteNotFoundSnapshots(keys)`, `snapshotsForRun(brandKey, runId)`, `latestSnapshots(brandKey, configId, before?)`, `earliestSnapshots(brandKey, configId, ids)`, `bestPositions(brandKey, configId)`, `keywordHistory(brandKey, configId, keywordId, since)`, `configTrend(…)`, `positionMatrix(…)`, `insertTasks(rows)` (`ON CONFLICT DO NOTHING`), `tasksByState(brandKey, runId, round, states, limit, afterId?)`, `updateTasks(rows)`, `expireTasks(brandKey, runId, round)`, `prune(runsBefore, tasksBefore, limit)`. `memoryRepository.ts` implements the same interface in memory (same cap, CAS and conflict semantics) for unit tests.

#### 6.2.5 `service.ts` (PORT of `RankTrackingService.ts:42-212, 386-434` and `RankTrackingKeywordService.ts:12-187`)

```ts
export async function createConfig(ws: Workspace, body: CreateConfigBody, deps?): Promise<RankConfigView>;
export async function updateConfig(ws: Workspace, configId: string, body: UpdateConfigBody, deps?): Promise<RankConfigView>;
export async function addKeywords(ws: Workspace, configId: string, body: AddKeywordsBody, deps?):
  Promise<{ added: number; addedIds: string[]; skipped: number; metricsFromCache: number; approval: { approvedMaxUsd: number; quote: PriceQuote } | null }>;
export async function removeKeywords(ws, configId, keywordIds: string[]): Promise<{ removed: number; removedIds: string[] }>;
export async function setKeywordsPinned(ws, configId, keywordIds: string[], pinned: boolean): Promise<{ updated: number; updatedIds: string[] }>;
export async function listTrackers(ws): Promise<RankConfigSummaryView[]>;
export async function getTracker(ws, configId): Promise<RankConfigView>;
```

`createConfig`: `normalizeTrackedDomain`; `resolveTrackerMarket`; `locationName` → `assertTrackedLocation` before duplicate checks (OpenSEO order, `:63-72`); interval default `weekly`; `nextCheckAt` = manual ? `null` : F10 `computeNextRunAt(interval, null, scheduleTime)`; a weekly `scheduleTime` without `weekday` → `AppError(400,"schedule_weekday_required","A weekly schedule time needs a weekday.")`; a `scheduleTime` with `manual` → `AppError(400,"schedule_time_without_schedule","A schedule time needs a daily, weekly, or monthly schedule.")` (PORT `configSchedule.ts:11-36`). Existing active row → `AppError(409,"tracker_exists", locationName ? "This domain, city and language are already tracked." : "This domain, country and language are already tracked.")`. Active count ≥ 500 → `AppError(409,"tracker_limit","A workspace can track up to 500 domains. Archive some first.")` (checked for reactivations too). Archived row → reactivate with the new settings, `last_skip_reason = NULL`, `approved_max_usd` kept only if the schedule and devices/depth are unchanged, else `NULL` (the next keyword add or "Review price" re-approves). New row → insert with `created_by`. No provider call, no spend.

`updateConfig`: as `RankTrackingService.ts:145-212`. When the result is scheduled and the per-check quote for the new devices/depth/interval exceeds `approved_max_usd` (or none is stored and keywords exist), the body must carry `maxUsd`: `requireApprovedPrice("rank_tracking.config.save", ctx, { configId, scheduleInterval, devices, serpDepth }, maxUsd)` then `recordApproval(…, source "schedule", subject { kind: "rank_tracking_config", id })` and store `approved_max_usd`/`approval_id`. `isActive: false` archives (no price check). A change of domain or market keeps history (OpenSEO behaviour).

`addKeywords`: trim, lowercase unless `matchCase`, de-duplicate against the request and existing rows; reject over-length entries before any write (`400 invalid_request` via zod). If the config is scheduled: fresh `quote("rank_tracking.config.save", ctx, { configId, addKeywords: normalized, scheduleInterval })`; when `quote.totalUsd > (approved_max_usd ?? 0)`, call `requireApprovedPrice(…, body.maxUsd)` (so a missing `maxUsd` → `400 approval_required`, a lower one → `409 price_changed`, both with `details.quote`) **before** inserting. Metrics prefill (national configs only): one select on `keyword_metrics` for `(keyword lowercased, location_code, resolveKeywordDataLanguage(location_code, language_code))` with `fetched_at > now − 7 days`; matches are written with `metrics_source = 'cache'`. Then `add_rank_tracking_keywords`. After a successful insert on a scheduled config whose approval was required, `recordApproval` and update `approved_max_usd`. No automatic paid check (OpenSEO's `triggerAutoCheck` is replaced by the explicit "Check now" step, §6.6.3): Perceev never spends without an approval.

#### 6.2.6 `runGuards.ts` (PORT of `rankCheckRunGuards.ts:11-250`)

```ts
export async function beginRankCheckRun(ws: { brandKey: string; userId: string | null }, i: { configId: string;
  trigger: "manual" | "scheduled"; keywordIds?: string[]; approvedMaxUsd: number }, deps?):
  Promise<{ ok: true; runId: string; jobId: string } | { ok: false; reason: "already_running"; activeRunId: string | null }>;
export async function failRunIfActive(brandKey: string, runId: string, code: string, message: string, deps?): Promise<void>;
export async function staleReason(run: RunRow, deps?): Promise<string | null>;
export async function getLatestRunView(brandKey: string, configId: string, deps?): Promise<RankRunView | null>;
```

`beginRankCheckRun`: up to 2 attempts: `runId = crypto.randomUUID()`; `try_create_rank_run(..., method = trigger === "scheduled" ? "queued" : "live", approvedMaxUsd, keywordIds)`. Inserted → `enqueueJob("rank_tracking.check", { runId }, { brandKey, singleActiveKey: "rank_tracking.check:" + configId, trigger, createdBy })`, store `job_id`; an enqueue error → `failRunIfActive(runId, "job_start_failed", "The check could not start.")` and rethrow (an `AppError 409 job_already_running` becomes `{ ok: false, reason: "already_running", activeRunId: null }`). Not inserted → read the active run; on attempt 0, `staleReason(blocker)` non-null → `failRunIfActive(blocker, "stale_run", reason)` and retry; else `{ ok: false, reason: "already_running", activeRunId }`. `staleReason`: run `completed`/`failed` → "Run already finished"; `job_id` null and age < 60 s → `null` (startup grace, `:56`); `job_id` null and older → "The check never started"; `getJobStatus(job_id)` status in `completed|partial|failed|cancelled` → "The check stopped without finishing"; job not found → "The check's job was not found"; else `null`. `getLatestRunView` reports `maybeStale`/`staleReason` without writing (OpenSEO `:303-322`: mutating on read raced the original run).

`RankRunView` = `{ id, status, trigger, method, phase, keywordsTotal, keywordsChecked, isSubsetRun, errorCode, errorMessage, startedAt, completedAt, maybeStale, staleReason, pollAfterSeconds }` where `pollAfterSeconds` = `null` when finished, `3` while `phase = 'checking'` and `method = 'live'`, else `20`.

#### 6.2.7 `checkPaths.ts` (PORT of `rankCheckPaths.ts:28-363`)

```ts
export const QUEUED_POLL_SECONDS = [240, 120, 120, 120, 120, 180] as const;
export const TASK_GET_CONCURRENCY = 25, TASK_GETS_PER_COLLECT = 500;
export function expandToTaskInputs(keywords: KeywordEntry[], devices: Devices): RankCheckTaskInput[];   // COPY :57-70
export function mapResultsToSnapshotRows(brandKey: string, runId: string, results: ResultWithDevice[]): SnapshotRow[]; // PORT :28-42 (features as text[])
export async function runLiveCheck(ctx: JobContext<RankCheckPayload>, run: RunRow, deps: CheckDeps): Promise<void>;
export async function runQueuedRound(ctx: JobContext<RankCheckPayload>, run: RunRow, round: 0 | 1 | 2, deps: CheckDeps,
  onCompleted?: (rows: TaskRow[]) => Promise<void>): Promise<{ completed: number; failed: number; expired: number }>;
type CheckDeps = { repo: RankTrackingRepository; client: ReturnType<typeof createDataforseoClient>;
  fetchTaskResult: typeof fetchRankCheckTaskResult; logger: Pick<Console, "warn" | "error"> };
```

- **Live** (`runLiveCheck`): batches of `KEYWORDS_PER_BATCH` keywords from `run.keyword_ids` (resolved against current keywords; removed ones skipped). For batch `i`, `ctx.step.do("live-batch-" + i, SINGLE_ATTEMPT, …)`: `estimate = estimatePairsUsd(pairs, depth, "live")`; `repo.reserve(run, estimate)` false → return `{ written: 0, budget: "exhausted" }` and set `run.error_code = "budget_exhausted"` if empty; else `client.serp.rankCheckBatch({ brandKey, feature: "rank_tracking.check", idempotencyKey: jobStepKey(ctx, name), maxUsd: run.approved_max_usd, jobId: ctx.jobId }, pairs.map(p => ({ keyword, keywordId, locationCode, languageCode, locationName, device, targetDomain: run.domain, depth: run.serp_depth })))`; each rejection → first reason stored via `setRunErrorIfEmpty` (code `dataforseo_unavailable` for upstream failures, else the AppError code; message "Our search data provider had errors." for upstream, else the error message trimmed to 200 chars; PORT `:105-130`); fulfilled → `insertSnapshots`; `keywords_checked = min(total, (i+1) × 10)`; `ctx.progress(checked, total, "Checking keywords")`. A `StepFailedError` from a batch is caught and the loop continues (`:157-176`). `SpendRefused` inside the step fails it; the loop stops and finalize records the reason (`daily_cap`/`workspace_cap`/`feature_disabled`).
- **Queued** (`runQueuedRound`): `ctx.step.do("plan-" + round, DB_STEP, …)` inserts `planned` tasks (round 0: every pair; retry rounds: §6.2.8) and returns `{ planned, chunks: ceil(planned/100) }`. For chunk `c`: `ctx.step.do("post-" + round + "-" + c, SINGLE_ATTEMPT, …)`: read planned tasks of that chunk (ordered by `id`, offset `c × 100`, limit 100); `repo.reserve(estimatePairsUsd(tasks, depth, "queued"))` false → mark them `rejected` with message `budget_exhausted` and return; `client.serp.rankCheckTaskPost({ …, idempotencyKey: jobStepKey(ctx, name) }, { tasks, locationCode, languageCode, locationName, depth, targetDomain })`; posted → `state = 'posted'`, `provider_task_id`; tasks missing from the response → `rejected` (OpenSEO's tag mapping, `serp.ts:272-288`). A thrown post is caught (earlier chunks were charged and must still be collected, `:271-293`). Then for `r` in `0..5`: `ctx.step.sleep("wait-" + round + "-" + r, QUEUED_POLL_SECONDS[r])`; `ctx.step.do("collect-" + round + "-" + r, READ_STEP, …)`: read up to 500 `posted` tasks; `fetchTaskResult({ taskId, keywordId, keyword, targetDomain })` with 25 in flight (free, never metered, `serp.ts:304-310`); `pending` stays; `failed` → `state 'failed'`, message; `completed` → `state 'completed'` with position/url/features; then `onCompleted(rows)`; returns counts. Stop early when no `posted` task remains. Finally `ctx.step.do("expire-" + round, DB_STEP, () => repo.expireTasks(run, round))`.
- Round 0's `onCompleted` inserts snapshots (`ON CONFLICT DO NOTHING`, so a replayed collect is idempotent) and recounts `keywords_checked` from snapshots (`:349-361`).

#### 6.2.8 `retries.ts` (PORT of `rankCheckRetries.ts:24-200`)

```ts
export type RetryPair = { keywordId: string; keyword: string; device: "desktop" | "mobile"; position: number | null;
  answered: boolean; knownPosition: number | null; recheckMiss: boolean };
export function needsRetry(p: RetryPair): boolean;                          // COPY :41-50
export function buildRetryPairs(i: { keywords: KeywordEntry[]; devices: Devices; current: SnapshotLite[];
  answeredInRun: Set<string>; previousBest: Map<string, number | null>; hadPreviousCheck: Set<string> }): RetryPair[]; // PORT :66-99, :139-151 (pure)
export function selectRetryResults(pairs: RetryPair[], collected: TaskRow[]): { toSave: TaskRow[]; updated: RetryPair[] }; // PORT :105-132 (pure)
export function unconfirmedMisses(pairs: RetryPair[]): Array<{ keywordId: string; device: string }>;                      // PORT :187-189
export async function retryRankChecks(ctx: JobContext<RankCheckPayload>, run: RunRow, deps: CheckDeps): Promise<void>;
```

State that OpenSEO kept in step outputs is re-derived from tables, so each step output stays far below F01's 64 KB: `current` = this run's snapshots; `answeredInRun` = pairs with a snapshot or a `completed` task in an earlier round of this run; `previousBest` = `rank_best_positions` (completed runs only; the active run is excluded by status); `hadPreviousCheck` = keywords present in `previousBest`. `knownPosition` = min(previous best, this run's other-device position). For round `r` in 1..2: `plan-r` inserts the pairs with `needsRetry` (OpenSEO posts only those, `:171`), returns 0 → stop; `runQueuedRound(…, r)`; `ctx.step.do("save-" + r, DB_STEP, …)` rebuilds pairs, applies `selectRetryResults` to round `r`'s completed tasks and `upsertSnapshots`. After the rounds, `ctx.step.do("drop-unconfirmed-misses", DB_STEP, …)` deletes null-position snapshots of `unconfirmedMisses` (a keyword that ranked before is never saved as not found, `:191-199`). `ctx.progress(checked, total, "Re-checking results that look wrong")`; `run.phase = 'rechecking'`.

#### 6.2.9 `checkJob.ts` (PORT of `RankCheckWorkflow.ts:53-409`)

`defineJob("rank_tracking.check", handler, { payloadSchema: z.strictObject({ runId: z.uuid() }), pollAfterSeconds: 5, deadlineSeconds: 7200, maxInvocations: 200 })`. Handler steps:

| Step | Options | Does |
|---|---|---|
| `check-active` | `DB_STEP` | config active? No → `failRunIfActive(run, "tracker_archived", "This domain was archived.")`, return `{ status: "completed", result: { skipped: "archived" } }` |
| `prepare` | `{ timeoutMs: 60000, retries: 0 }` | run must be `pending`/`running` else `AppError(409,"run_superseded")`; status `running`, phase `checking`; freeze `keyword_ids` = subset ∩ current keywords, or all current keywords (ordered `created_at, id`); 0 → `AppError(422,"no_keywords","No keywords to track. Add keywords to this domain first.")`; fresh `estimateRankCheckUsd(frozen, devices, depth, method).totalUsd > approved_max_usd` → `AppError(409,"price_changed","This check now costs more than you approved.")`; set `keywords_total`; returns `{ keywordsTotal }` |
| live or queued | §6.2.7 | `method === "live"` → `runLiveCheck`, else `runQueuedRound(…, 0)` |
| retries | §6.2.8 | `retryRankChecks`; errors are caught and logged as `[rank-check] retries failed { runId, code }` so finalize still runs |
| `finalize` | `{ timeoutMs: 60000, retries: 0 }` | PORT `:139-241`: re-read run; skip when already terminal; count snapshots per device; `failed` when none and total > 0 (message = stored reason ?? "No keywords could be checked."), else `completed` with the partial message; `completed` → config `last_checked_at = now`, `last_skip_reason = NULL`, `last_skip_at = NULL`; phase NULL; returns `{ status, keywordsChecked, keywordsTotal }` |
| `mark-failed` | `DB_STEP` (only in the outer catch) | PORT `:243-276`: `failRunIfActive(run, code, message)`; when the error is `SpendRefused`, write `last_skip_reason = err.reason` (shown on the tracker list) |

The handler returns `{ status: run.status === "completed" && partial ? "partial" : "completed", result }` or throws `AppError(422,"rank_check_failed")` after finalize marks the run failed, so the job and the run agree. No log line contains keywords, domains or URLs: `[rank-check] <runId> <status> trigger=<t> keywords=<checked>/<total> error_code=<code>`.

#### 6.2.10 `results.ts` (PORT of `rankTrackingResults.ts:21-188`, `snapshotQueries.ts`, `serverFunctions/rank-tracking.ts:308-361`)

```ts
export async function getLatestResults(ws, configId: string, compare: ComparePeriod, deps?): Promise<{ rows: RankTrackingRow[]; run: RankRunView | null }>;
export async function getKeywordHistory(ws, configId, keywordId, sinceDays: number): Promise<Array<{ device; checkedAt; position }>>;
export async function getConfigTrend(ws, configId, device, sinceDays): Promise<Array<{ runId; checkedAt; top3; top4to10; top11to20; notRanking; notChecked; aiOverview; checked }>>;
export async function getPositionMatrix(ws, configId, device, runLimit: number): Promise<Array<{ runId; checkedAt; trackingKeywordId; position }>>;
```

`getLatestResults`: tracker must exist in the workspace (`404 tracker_not_found`) before any other read is returned; reads in parallel: keywords, `rank_latest_snapshots(now)`, `rank_latest_snapshots(now − days)`, latest run; fallback `rank_earliest_snapshots` for pairs without a comparison (`:72-95`); device results carry `checkedAt` from the snapshot (null when never checked); freshness from the newest snapshot; `aiQuestion` is filled in phase 6 (§6.2.13), else `null`. `getConfigTrend` maps `notRanking = max(0, total − top3 − top4to10 − top11to20)`, `notChecked = max(0, keywordsTotal − total)` (`serverFunctions/rank-tracking.ts:330-348`), `aiOverview` = snapshots with `has_ai_overview`, `checked = total`.

#### 6.2.11 `schedules.ts` (PORT of `scheduledRankChecks.ts:11-256` on F10 `runDueSchedules`)

```ts
export const SCHEDULED_TASK_UNIT_BUDGET = 1000;
export function admitByUnitBudget<T extends { taskUnits: number }>(items: T[], budget: number): { admitted: T[]; deferred: number };
  // PORT :93-103: walk oldest first; zero-unit items always admitted; the first non-zero item always admitted;
  // stop at the first item whose units would overflow (OpenSEO breaks; it does not skip ahead)
export async function runRankScheduleTick(now: Date, ctx: JobContext<{ at: string }>, deps?): Promise<{ started: number; skipped: Record<string, number>; failed: number; notDue: number; deferred: number }>;
```

`list` (`DB_STEP`): `listDueConfigs(now, 500)` + `keywordCounts` → items `{ key: configId, brandKey, observedNextRunAt, interval, taskUnits: count × devicesCount, approvedMaxUsd }`; `admitByUnitBudget`. Then `runDueSchedules({ items: admitted, now, evaluate, start, block, wrap: (name, fn) => ctx.step.do(name, { timeoutMs: 60000, retries: 0 }, fn) })`:

- **evaluate** (first failure wins): `isFeatureEnabled("rank_tracking", brandKey)` false → `rank_tracking_disabled`; workspace inactive → `workspace_inactive`; zero keywords → `no_keywords`; `approved_max_usd` null → `approval_missing`; fresh `quote("rank_tracking.check.run", ctx, { configId, method: "queued" })` total > `approved_max_usd` → `price_changed`; else `{ start: { approvedMaxUsd } }`.
- **start**: `claimConfig(observed → plan.next, skip { reason: null })` (advance before running, `scheduledRankChecks.ts:153-166`); lost CAS → `{ started: false, reason: "concurrent_change" }`; `beginRankCheckRun({ trigger: "scheduled", approvedMaxUsd })`; `already_running` → `claimConfig(plan.next → observed)` without touching the skip reason (restore, `:201-217`) and `{ started: false, reason: "already_running" }`; an enqueue error leaves the schedule advanced (`:184-193`) and rethrows (F10 records `start_failed`).
- **block**: `claimConfig(observed → plan.next, skip { reason })`. A lost CAS is logged `[rank-schedules] block lost to concurrent change` and ignored.

`plan` comes from F10 `planWindows` (missed windows run once; anchors advance without drift).

#### 6.2.12 `metrics.ts` and `suggestions.ts`

```ts
export async function refreshKeywordMetrics(ws, configId, i: { maxUsd: number; requestId: string }, deps?):
  Promise<{ updated: number; fromCache: number; bought: number }>;          // PORT RankTrackingService.ts:328-380
export async function suggestKeywordsForDomain(ws, i: { domain: string; locationCode: number; languageCode?: string;
  maxUsd?: number; cacheOnly: boolean; requestId: string }, deps?): Promise<{ keywords: SuggestedKeyword[]; cached: boolean; fetchedAt: string } | null>;
```

- `refreshKeywordMetrics`: national tracker → keywords whose `keyword_metrics` row is fresh (≤ 7 days) are copied (`metrics_source 'cache'`, free); the rest go to F13 `fetchKeywordMetricsForList({ labs, ads }, { keywords (lowercased, unique), locationCode, languageCode: resolveKeywordDataLanguage(…), call: (tag) => ({ brandKey, feature: "rank_tracking.metrics", idempotencyKey: "rank_tracking.metrics:" + requestId + ":" + tag, maxUsd }) })`; bought rows → `upsertKeywordMetrics` (national, `source` labs/google_ads) and the keyword columns. Local tracker → every keyword through the same call with `locationName` (city volume from Ads merged with national KD, as OpenSEO); not written to `keyword_metrics` (it is national-keyed). Research log: `appendResearch(admin, { brandKey, kind: "rank_tracking.metrics", researchKey: configId, summary: "Keyword stats for <n> tracked keywords of <domain>.", spendUsd: null, author: "user", actorUserId })`.
- `suggestKeywordsForDomain` (PORT of `openseo:src/server/features/domain/services/DomainService.ts:122-216`): `cached({ namespace: "rank_tracking.suggestions", version: 1, keyParts: [hostname, locationCode, languageCode], ttlSeconds: 86400, scope: "workspace", brandKey, schema })` wrapping `createLabsClient().domain.rankedKeywords({ brandKey, feature: "rank_tracking.suggestions", idempotencyKey: "rank_tracking.suggestions:" + requestId, maxUsd }, { target: hostname, locationCode, languageCode: resolveLabsMarket(…).languageCode, limit: 100, orderBy: ["ranked_serp_element.serp_item.etv,desc"] })`, rows mapped with F14 `mapKeywordItem` to `{ keyword, position, searchVolume, traffic, cpc, keywordDifficulty }`; `cacheOnly` → F13 `peekCached` (null = not looked up yet; opening the step never spends, §5.6). Through F13 `cachedIf` (keep only non-empty). Ranked rows are also passed to F13 `upsertKeywordMetrics` with `source 'labs_ranked'` in `keepAlive` (so the later keyword add fills metrics free). A country Labs does not serve (`!isLabsLocationCode`) → `AppError(422,"suggestions_unavailable","Ranked-keyword suggestions aren't available for this country. Add the keywords you want to track manually.")` before any spend. Research log kind `rank_tracking.suggestions`, key `hostname|locationCode|languageCode`, summary "Ranking keywords for <hostname> in <Country>: <n> found.".

#### 6.2.13 `aiQuestions.ts` (phase 6)

```ts
export async function trackKeywordAsAiQuestion(ws, configId: string, keywordId: string, i: { text: string; topic?: string },
  deps?: { add?: typeof addWorkspaceQuestion }): Promise<{ questionId: string; created: boolean; revived: boolean; linked: boolean }>;
export async function aiStatusesForKeywords(admin, brandKey: string, keywordIds: string[]): Promise<Map<string, RankAiQuestion>>;
export function mapAioStatus(row: { state: string; aio_present: boolean | null; own_cited: boolean | null; own_mentioned: boolean | null } | null): RankAiQuestion["status"];
```

- `trackKeywordAsAiQuestion`: keyword must belong to the tracker (`404 keyword_not_found`); `addWorkspaceQuestion(admin, { brandKey, text, origin: "manual", createdBy: userId, topic, sourceRef: { kind: "rank_keyword", trackingKeywordId, keyword, locationCode, languageCode } })` (F08; origin decision as F13's "Track as a question"); upsert `rank_keyword_questions` (`ON CONFLICT DO NOTHING`); F08 errors pass through (`409 question_limit`, `409 topic_limit`, `409 question_duplicate`, `503 questions_unavailable`). It never calls a panel function.
- `aiStatusesForKeywords`: links → `rank_question_aio_status(brandKey, questionIds)`; the newest link per keyword wins when a keyword has several questions. `mapAioStatus`: `state = 'answered'` with `own_cited` → `cited`; with `own_mentioned` → `mentioned`; otherwise → `absent`; `state = 'valid_no_aio'` → `no_overview`; any other state or no row → `not_measured`. A Postgres `42P01` (F12 table missing) → every linked keyword `not_measured` and one `console.warn("[rank-tracking] aio status unavailable")`.

**How this connects to the Google AI Overview engine.** The question enters the workspace library only. Once the customer approves a panel that contains it (F08; R14 unchanged), every scan asks it on every enabled engine; the `aio` engine fetches the search through its own route (Bright Data rendered mode, or DataForSEO `load_async_ai_overview` from `answers.ts` per F02's `ANSWER_ENGINE_ROUTES`) as a `probe_observations` row claimed through `claim_probe_dispatch`, so pause, allowlist, circuits and P0 budgets apply. F12 links the observation to the question; F15 reads only the verdict flags back. Rank tracking itself never asks an answer engine.

#### 6.2.14 Priced actions (`src/lib/pricing/actions/rankTracking.ts`, one import line in `src/lib/pricing/actions/index.ts`)

| Key | Feature | Input (`z.strictObject`) | `requireApproval` | Estimate (exact labels) |
|---|---|---|---|---|
| `rank_tracking.check.run` | `rank_tracking.check` | `{ configId: z.uuid(), keywordIds: z.array(z.uuid()).min(1).max(1000).optional(), method: z.enum(["live","queued"]).default("live") }` | true | `estimateRankCheckUsd(keywords, devices, depth, method)`. Lines: "Check {n} keywords on {devicesLabel} ({live → "results now", queued → "queue price"})" = `checkUsd`; "Re-checks of results that look wrong (up to 2 rounds)" = `retryUsd`. `totalUsd` = sum; `expectedUsd` = `checkUsd`. Units `keywords`, `devices`, `checks` (= n × d). Warnings: `retry_note` "Results that look wrong (an error, or 10 or more positions worse than before) are checked again, up to 2 more times. Most checks need no re-check."; `stop_early_note` "A check stops at the results page where your site appears, so you are usually charged for fewer pages." Blocked: `no_keywords` "Add keywords before checking rankings."; `tracker_archived` "This domain was archived." |
| `rank_tracking.config.save` | `rank_tracking.check` | `{ configId: z.uuid().optional(), draft: z.strictObject({ keywordCount: z.int().min(0).max(1000) }).optional(), addKeywords: z.array(z.string().trim().min(1).max(200)).max(1000).optional(), devices: z.enum(DEVICES).optional(), serpDepth: z.int().min(10).max(100).multipleOf(10).optional(), scheduleInterval: z.enum(RANK_SCHEDULES) }` with a refine: exactly one of `configId` / `draft` | true | Keywords = tracker keywords ∪ `addKeywords` (or `draft.keywordCount` copies of "keyword"); devices/depth from input or tracker. Scheduled: method `queued`; `totalUsd` = per-check total; `monthly = { interval, runsPerMonth, totalUsd: per-check × runsPerMonth }`; lines as above with "Each {interval} check of {n} keywords on {devicesLabel}". Manual: method `live`, `monthly = null`, line "Each check of {n} keywords on {devicesLabel}". Warnings: `retry_note`; `daily_note` (daily) "Daily checks cost about 7 times as much as weekly."; `both_devices_note` (both) "Tracking both devices doubles the cost of every check."; `schedule_note` (scheduled) "Each scheduled check reserves up to this amount and is charged only for result pages crawled." Blocked: `keyword_limit` (> 1,000) "A domain can track up to 1,000 keywords." |
| `rank_tracking.suggestions.run` | `rank_tracking.suggestions` | `{ domain: z.string().trim().min(1).max(253), locationCode: z.int().positive(), languageCode: z.string().min(2).max(8).optional() }` | false | One line "Up to 100 keywords this domain ranks for" = `dataforseoPricing.domain.rankedKeywords({ limit: 100 })` (0.024). Warning `cache_note` "Looking up the same domain and country again within 24 hours is free."; `recent_research` via `findRecentResearch(kind "rank_tracking.suggestions")`. Blocked `suggestions_unavailable` (non-Labs country). |
| `rank_tracking.metrics.run` | `rank_tracking.metrics` | `{ configId: z.uuid() }` | true | National: units `fromCache` (fresh rows) and `stale`; lines per batch of 700 stale keywords: Labs country "Keyword stats for {n} keywords" = `dataforseoPricing.labs.keywordOverview({ keywords: batch })`; Ads country same label, `dataforseoPricing.keywords.adsSearchVolume({})`. Local: per batch "City volume for {n} keywords in {area}" = `adsSearchVolume({})` + "Difficulty for {n} keywords" = `labs.keywordOverview({ keywords: batch })`. Blocked `nothing_to_refresh` "Every keyword's stats were updated in the last 7 days." |

`quote()` input is validated; tracker lookups use `ctx.brandKey`, so a foreign `configId` returns `404 tracker_not_found`.

#### 6.2.15 Contracts, tools, telemetry, registrations

- `src/lib/rank-tracking/rankTracking.contract.ts`: `export const contracts: RouteContract[]` for every §6.5 route (requests `z.strictObject`, responses `z.looseObject`, error codes, one example each).
- `src/lib/rank-tracking/tools.ts` (F22 registers them later; shape of F13 §6.2.6): `list_rank_trackers` (free; output summaries), `get_rank_tracker` (free; input `{ configId, compare? }`, output `{ config, rows (≤ 200, pinned first), run }`), `add_rank_tracking_keywords` (input `{ configId, keywords (1..100), maxUsd? }`; same path as the route), `run_rank_check` (paid; input `{ configId, keywordIds?, maxUsd: z.number().positive().max(50) }`; description "Check Google positions now. Paid: call the price estimate for rank_tracking.check.run first and pass the approved maxUsd.").
- `src/lib/rank-tracking/jobs.ts` registers `rank_tracking.check`, `rank_tracking.schedules.tick`, `rank_tracking.retention` and their periodics; `src/lib/jobs/kinds.ts` gains `import "../rank-tracking/jobs.ts";`.
- `src/shared/spend-features.ts`: `SPEND_FEATURES` gains the three keys; `SPEND_FEATURE_LABELS` gains "Rank checks", "Rank tracking keyword suggestions", "Rank tracking keyword stats". `src/lib/features/names.ts`: `rank_tracking: { spend: ["rank_tracking.check","rank_tracking.suggestions","rank_tracking.metrics"] as const }`, `rank_tracking_ai_questions: { spend: [] as const }`. `src/lib/features/clientFeatures.ts` appends both.

### 6.3 Jobs

| Kind / periodic | Trigger | Steps | Completion |
|---|---|---|---|
| `rank_tracking.check` | `beginRankCheckRun`; `singleActiveKey "rank_tracking.check:<configId>"`; `deadlineSeconds 7200`; `pollAfterSeconds 5` | §6.2.9 | `completed` / `partial` (some devices or keywords missing) / `failed` (`rank_check_failed`, `price_changed`, `no_keywords`, spend refusal codes) |
| periodic `rank_tracking.schedules` (300 s) | F01 `definePeriodic` | `enqueueSystemJob("rank_tracking.schedules.tick", { at }, { dedupeKey: "rank_tracking.schedules:" + floor(now/300 s), singleActiveKey: "rank_tracking.schedules" })` | — |
| `rank_tracking.schedules.tick` | system; `deadlineSeconds 240`, `pollAfterSeconds 20` | §6.2.11: `list`, then one `window:<configId>:<runIso>` step per admitted config (retries 0, because it starts paid work) | `completed` `{ started, skipped, failed, notDue, deferred }`; `partial` when `failed > 0` |
| periodic `rank_tracking.retention` (86,400 s) | `definePeriodic` | `enqueueSystemJob("rank_tracking.retention", {}, { dedupeKey: "rank_tracking.retention:" + YYYY-MM-DD })` | — |
| `rank_tracking.retention` | system | `prune-1`…`prune-20` (`DB_STEP`): `prune_rank_tracking(now − 760 days, now − 14 days, 1000)`, looping while `runs = 1000` | `completed` `{ runs, tasks }` |

**Skip reasons** (`rankSkipReasonMessage`, shown on the tracker row and detail header):

| Reason | Message |
|---|---|
| `no_keywords` | "No keywords to check. Add keywords to resume scheduled checks." |
| `approval_missing` | "Approve the price of scheduled checks to start them." |
| `price_changed` | "Scheduled checks now cost more than you approved. Review the price to resume." |
| `rank_tracking_disabled` | "Rank tracking is turned off for this workspace." |
| `workspace_inactive` | "This workspace is inactive." |
| `daily_cap` | "Today's spend limit for this workspace was reached." |
| `workspace_cap` | "This month's spend limit for this workspace was reached." |
| `feature_disabled` | "Rank checks are not enabled for this workspace." |
| `start_failed` | "The scheduled check could not start." |

### 6.4 Provider calls and cost

| Use | Endpoint (F02 function) | Request body per task | Response fields used | Unit price (F03) | Retries |
|---|---|---|---|---|---|
| Manual check | `POST /v3/serp/google/organic/live/advanced` (`fetchRankCheckSerp` via `serp.rankCheckBatch`) | `{ keyword, location_code \| location_name, language_code, device, os: windows\|android, depth, stop_crawl_on_match: [{ match_value: domain, match_type: "with_subdomains" }], find_targets_in: ["organic"] }` — **no `load_async_ai_overview`** | `items[].type`, organic `rank_group`, `domain`, `url`; `cost` | $0.002 first page + $0.0015 per extra page, × 5 for operator keywords | 0 |
| Scheduled check and all re-checks | `POST /v3/serp/google/organic/task_post` (`postRankCheckTasks` via `serp.rankCheckTaskPost`), ≤ 100 tasks | same + `tag: "<keywordId>:<device>"` | `tasks[].id, status_code, data.tag, cost` | $0.0006 + $0.00045 | 0 |
| Collection | `GET /v3/serp/google/organic/task_get/advanced/{id}` (`fetchRankCheckTaskResult`) | — | as live | free | 2 (READ_STEP) |
| Suggestions | `POST /v3/dataforseo_labs/google/ranked_keywords/live` (F13 `labs.domain.rankedKeywords`) | `target, location_code, language_code, limit: 100, order_by: ["ranked_serp_element.serp_item.etv,desc"]` | `items[]` (F14 mapper) | $0.012 + $0.00012/row | 0 |
| Keyword stats | F13 `fetchKeywordMetricsForList` (Labs `keyword_overview` or Ads `search_volume`) | F13 | F13 | F13 / F03 | 0 |

**AI Overview decision (binding).** Rank checks never request `load_async_ai_overview`. They record `ai_overview` only when DataForSEO includes that item type in the standard organic result, which is what F02's `buildRankCheckResult` already keeps (`openseo:src/server/lib/dataforseo/serp.ts:158`: type strings only). Reasons: (1) conventions §5.6 and §6.1: a SERP fetch that loads the overview is an answer-engine call and must be a `probe_observations` row claimed through `claim_probe_dispatch`; F02 keeps those fetchers in `answers.ts`, callable only from the claim path. A plain organic SERP is classic SEO and stays on `metered()`. (2) We store no overview text, references or citations, so rank data carries no answer content and needs no evidence redaction. (3) The async load would add $0.0006 (queued) or $0.002 (live) per keyword and device, up to doubling scheduled costs, outside P0 budgets. (4) Honesty: the tag means "seen on the results page we fetched". Its absence is never shown as "no AI Overview": async overviews are missed (the India handoff saw 0 inline overviews in 28 searches), so the UI says so, and the authoritative measurement is the AI question bridge (§6.2.13).

**Caches.** `rank_tracking.suggestions` v1, workspace scope, 24 h (a workspace's interest in a domain is private, §5.6). Rank checks are measurements and are never cached. Keyword stats read F13's global `keyword_metrics`.

**Fixtures** (`tests/fixtures/f15/`, synthetic, shaped from DataForSEO's public docs, no account ids): `rank-live-found.json` (organic `example.com` at `rank_group` 3 on page 1, plus `ai_overview` and `people_also_ask` items whose text is the single word "x"), `rank-live-not-found.json` (two pages, no match), `rank-live-no-results.json` (40501), `rank-live-upstream-50000.json`, `rank-task-post.json` (3 accepted with tags, 1 rejected 40501 cost 0, 1 missing tag), `rank-task-get-pending.json` (40601), `rank-task-get-found.json`, `rank-task-get-found-aio.json`, `rank-task-get-failed.json` (40102), `labs-ranked-keywords-100.json` (25 rows), `keyword-overview-3.json`. Live QA: `scripts/qa/check-f15-live.mjs --brand <key> --max-spend-usd 0.05` (one live check of 3 keywords, mobile, depth 10, owner-run only; refuses unless `paid_feature_controls('rank_tracking.check')` admits the brand).

### 6.5 API routes

All routes: `requireWorkspace(request, { brandKey: query.brand_key ?? body.brand_key })` (members and owners); `isFeatureEnabled("rank_tracking", brandKey)` false → `AppError(404,"feature_unavailable","This page is not available for your workspace yet.")`; `toErrorResponse`; `Cache-Control: no-store`; contracts in `rankTracking.contract.ts`. `configId` path params are validated `z.uuid()` (else `404 tracker_not_found`). Common errors: 400 `invalid_request`/`invalid_json`; 401/403/404/503 from `requireWorkspace`; 404 `feature_unavailable`/`tracker_not_found`; 503 `rank_tracking_unavailable`.

| Method and path | Request | Response 200 (example) | Extra errors |
|---|---|---|---|
| `GET /api/customer/rank-tracking/configs` | query `{ brand_key? }` | `{ "trackers": [ { "id": "6f0c…", "domain": "offcult.in", "locationCode": 2356, "languageCode": "en", "locationName": null, "devices": "mobile", "serpDepth": 40, "scheduleInterval": "weekly", "nextCheckAt": "2026-10-27T05:12:00.000Z", "lastCheckedAt": "2026-10-20T05:14:31.000Z", "lastSkipReason": null, "lastSkipMessage": null, "approvedMaxUsd": 0.234, "keywordCount": 20, "lastRunStatus": "completed", "lastRunCompletedAt": "2026-10-20T05:20:02.000Z" } ] }` | — |
| `POST /api/customer/rank-tracking/configs` | `z.strictObject({ brand_key?, domain: z.string().trim().min(3).max(253), locationCode: z.int().positive().optional(), languageCode: z.string().min(2).max(10).optional(), locationName: z.string().trim().min(1).max(200).optional(), devices: z.enum(DEVICES).default("mobile"), serpDepth: z.int().min(10).max(100).multipleOf(10).default(40), scheduleInterval: z.enum(RANK_SCHEDULES).default("weekly"), scheduleTime: scheduleTimeSchema.optional() })` | 201 `{ "tracker": { …summary shape, "keywordCount": 0, "approvedMaxUsd": null } }` | 400 `invalid_domain`, `schedule_weekday_required`, `schedule_time_without_schedule`, `invalid_location`; 409 `tracker_exists`, `tracker_limit`, `unknown_location` |
| `GET /api/customer/rank-tracking/configs/[configId]` | — | `{ "tracker": {…} }` | — |
| `PATCH /api/customer/rank-tracking/configs/[configId]` | `z.strictObject({ brand_key?, domain?, locationCode?, languageCode?, locationName: z.string().min(1).max(200).nullable().optional(), devices?, serpDepth?, scheduleInterval?, scheduleTime?, isActive: z.boolean().optional(), maxUsd: z.number().positive().max(1000).optional() })` | `{ "tracker": {…} }` | 400 `approval_required`; 409 `price_changed`, `tracker_exists`, `unknown_location` |
| `POST …/configs/[configId]/keywords` | `z.strictObject({ brand_key?, keywords: z.array(z.string().trim().min(1).max(200)).min(1).max(1000), matchCase: z.boolean().default(false), source: z.enum(["manual","suggestions"]).default("manual"), maxUsd: z.number().positive().max(1000).optional() })` | `{ "added": 18, "addedIds": ["…"], "skipped": 2, "metricsFromCache": 15, "approval": { "approvedMaxUsd": 0.234, "quote": {…PriceQuote} } }` | 400 `approval_required`; 409 `price_changed`, `keyword_limit` |
| `POST …/configs/[configId]/keywords/remove` | `{ brand_key?, keywordIds: z.array(z.uuid()).min(1).max(1000) }` | `{ "removed": 2, "removedIds": ["…"] }` | — |
| `POST …/configs/[configId]/keywords/pin` | `{ brand_key?, keywordIds: z.array(z.uuid()).min(1).max(1000), pinned: z.boolean() }` | `{ "updated": 1, "updatedIds": ["…"] }` | — |
| `POST …/configs/[configId]/check` | `{ brand_key?, keywordIds: z.array(z.uuid()).min(1).max(1000).optional(), maxUsd: z.number().positive().max(1000).optional() }` | **202** `{ "runId": "a1…", "jobId": "b2…", "status": "queued", "pollAfterSeconds": 3 }` | 400 `approval_required`; 409 `price_changed`, `rank_check_running` (`details.activeRunId`), `no_keywords`, `tracker_archived`; 402 `daily_cap`/`workspace_cap`; 403 `feature_disabled` |
| `GET …/configs/[configId]/runs/latest` | — | `{ "run": { "id": "a1…", "status": "running", "trigger": "manual", "method": "live", "phase": "checking", "keywordsTotal": 20, "keywordsChecked": 10, "isSubsetRun": false, "errorCode": null, "errorMessage": null, "startedAt": "…", "completedAt": null, "maybeStale": false, "staleReason": null, "pollAfterSeconds": 3 } }` (`run: null` when never checked) | — |
| `GET …/configs/[configId]/results` | query `{ compare: z.enum(COMPARE_PERIODS).optional() }` | `{ "rows": [ { "trackingKeywordId": "…", "keyword": "oversized t shirts", "matchCase": false, "pinned": true, "searchVolume": 12100, "keywordDifficulty": 34, "cpc": 0.41, "mobile": { "position": 7, "previousPosition": 9, "rankingUrl": "https://offcult.in/collections/oversized", "serpFeatures": ["ai_overview","people_also_ask","organic"], "checkedAt": "…" }, "desktop": { "position": null, "previousPosition": null, "rankingUrl": null, "serpFeatures": [], "checkedAt": null }, "aiQuestion": null } ], "run": {…} }` | — |
| `GET …/configs/[configId]/trend` | `{ device: z.enum(["desktop","mobile"]), sinceDays: z.coerce.number().int().positive().max(730).default(730) }` | `{ "points": [ { "runId": "…", "checkedAt": "…", "top3": 2, "top4to10": 5, "top11to20": 4, "notRanking": 8, "notChecked": 1, "aiOverview": 6, "checked": 19 } ] }` | — |
| `GET …/configs/[configId]/matrix` | `{ device, runLimit: z.coerce.number().int().min(2).max(26).default(12) }` | `{ "cells": [ { "runId": "…", "checkedAt": "…", "trackingKeywordId": "…", "position": 7 } ] }` | — |
| `GET …/configs/[configId]/keywords/[keywordId]/history` | `{ sinceDays }` | `{ "points": [ { "device": "mobile", "checkedAt": "…", "position": 9 } ] }` | — |
| `POST …/configs/[configId]/metrics/refresh` | `{ brand_key?, maxUsd: z.number().positive().max(1000).optional(), requestId: z.uuid() }` | `{ "updated": 20, "fromCache": 15, "bought": 5 }` | 400 `approval_required`; 409 `price_changed`, `nothing_to_refresh`; 402/403 spend; 502 `rank_metrics_unavailable` ("Keyword stats could not be loaded. Please retry.", F13 `toResearchError`) |
| `POST /api/customer/rank-tracking/suggestions` | `{ brand_key?, domain, locationCode, languageCode?, cacheOnly: z.boolean().default(false), maxUsd?, requestId: z.uuid() }` | `{ "keywords": [ { "keyword": "oversized t shirts", "position": 7, "searchVolume": 12100, "traffic": 410.5, "cpc": 0.41, "keywordDifficulty": 34 } ], "cached": false, "fetchedAt": "…" }`; `cacheOnly` miss → `{ "keywords": null }` | 422 `suggestions_unavailable`; 409 `price_changed`; 402/403 spend; 502 `rank_suggestions_unavailable` ("Ranking keywords could not be loaded. You can add keywords manually.") |
| `POST …/configs/[configId]/keywords/[keywordId]/ai-question` (phase 6) | `{ brand_key?, text: z.string().trim().min(2).max(1500), topic: z.string().trim().max(120).optional() }` | `{ "questionId": "…", "created": true, "revived": false, "linked": true }` | 404 `feature_unavailable` (either flag off), `keyword_not_found`; 409 `question_limit`, `topic_limit`, `question_duplicate`; 503 `questions_unavailable` |

Idempotency: config create converges on the unique indexes; keyword add is set-like; pin is idempotent; check is guarded by the single-active run; paid routes take `requestId` or use the run id in idempotency keys (`duplicate_paid_call` 409 on a replayed request id, F01). `pollAfterSeconds` follows §6.2.6.

### 6.6 UI

Built from F04 (`PageHeader`, `CardShell`, `Card`, `Button`, `Badge`, `Alert`, `Skeleton`, `SkeletonCard`, `EmptyState`, `QueryState`, `ConfirmDialog`, `FormDialog`, `Dialog` with `fullScreenOnMobile`, `Tooltip`, `Select`, `SegmentedToggle`, `CountryCombobox`, `ChartGrid`/`ChartXAxis`/`ChartYAxis`, `chart`), F05 (`useUrlSearchState`, `useDebouncedDraft`, `useServerPacedQuery`, `useOptimisticMutation`, `fetchJson`, `keys`), F06 (`DataTable`, `useDataTable`, `makeSelectionColumn`, `SortableHeader`, `ScoreBadge`, `TableBulkActionBar`, `TableBulkExportMenu`, `ExportMenu`, `useExportRows`), F09 (`CostReviewDialog`, `usePriceQuote`, `MonthlyProjection`), F10 (`ScheduleField`, `formatNextRun`), F13 (`PricedActionButton`, `SerpLocationCombobox`, `LOCATION_OPTIONS`, `SERP_LANGUAGE_OPTIONS`). Money via F03 `formatUsd`. Files in `src/components/portal/rank-tracking/`.

#### 6.6.1 Navigation, flags, query keys

`items.ts` group `site` → `{ id: "rank-tracking", label: "Rank Tracking", href: "/portal/rank-tracking", icon: TrendingUp, flag: "rank_tracking" }`. `src/lib/query/keys.ts`: `rankTrackers(brandKey)`, `rankTracker(brandKey, configId)`, `rankResults(brandKey, configId, compare)`, `rankLatestRun(brandKey, configId)`, `rankTrend(brandKey, configId, device, sinceDays)`, `rankMatrix(brandKey, configId, device)`, `rankKeywordHistory(brandKey, configId, keywordId, sinceDays)`, `rankSuggestions(brandKey, domain, locationCode)`. With the flag off the item is hidden and both pages render F04 `NotFound`.

#### 6.6.2 `/portal/rank-tracking` (`src/app/portal/rank-tracking/page.tsx` → `RankTrackingPage.tsx`, `RankTrackingDomainList.tsx`, PORT of `RankTrackingDomainList.tsx:55-328`)

`PageHeader` title "Rank Tracking", description "Track where your site ranks on Google for the searches that matter, and which of them show an AI Overview."

| State | Content |
|---|---|
| Loading | Card "Tracked Domains" with three rows of `Skeleton h-4 w-48` + `Skeleton h-3 w-72`, `aria-busy` |
| Error | `QueryError` "Failed to load tracked domains" + "Retry" |
| Empty | `EmptyState` icon `Globe`, title "No tracked domains yet", description "Add a domain to start monitoring keyword rankings over time.", action "Add Domain" |
| Filtered empty (≥ 6 domains or active filters) | `EmptyState kind="filtered"` "No matching tracked domains" / "Try clearing search or adjusting filters." + "Clear filters" |
| List | One row per tracker: domain (bold); meta line "{Country or city} · {Mobile} · {Weekly} · Next: {formatNextRun} · Last: {date}" (language shown only when two trackers differ by language alone); right side "Keywords {n}" (hidden on phone); archive icon button (`aria-label="Archive {domain}"`) → `ConfirmDialog` "Archive {domain}?" body "Scheduled checks will stop and this domain will be hidden from the list. Ranking history is preserved." confirm "Archive" (destructive), toast "Domain archived". Skip reasons: `price_changed`/`approval_missing` → warning line with the message and a "Review price" link (opens the detail page's approval dialog); others → muted warning line with the message. |

Filters (≥ 6 trackers): search text, device, country; URL params `q`, `device`, `loc`.

#### 6.6.3 Setup wizard (`RankTrackingConfigDialog.tsx`, PORT of `RankTrackingConfigModal.tsx:86-412`; `KeywordSuggestionStep.tsx`, PORT of `KeywordSuggestionStep.tsx:144-342`)

**Step 1 — "Add Domain"** (`Dialog sm:max-w-lg`, `fullScreenOnMobile`; title "Edit Domain Config" when editing):
- "Target Domain" (placeholder `example.com`; defaults to the workspace host without `www.`; normalised on blur; errors "Enter a domain" / "Enter a valid domain, like example.com").
- "Country" `CountryCombobox options={LOCATION_OPTIONS}` (default from F13 `workspaceMarket`).
- "Search targeting" `SearchTargetingField` (PORT `SearchTargetingField.tsx`): "Country-wide" / "City or region"; local uses F13 `SerpLocationCombobox` (country-scoped); error "Select a city or region for local targeting".
- "Language" select `SERP_LANGUAGE_OPTIONS`, description "Defaults to the country's language. Any language can be tracked in any country. Pick the one your customers search in."
- "Devices": "Mobile only" (default), "Desktop only", "Desktop + Mobile"; description "Most Google searches come from mobile, but choose what your customers use."; when both: `Info` note "Tracking both devices doubles the cost of every check."
- `ScheduleField allowManual dailyNote="Daily checks cost about 7 times as much as weekly."` (F10; "Daily", "Weekly", "Monthly (end of month)", "Manual only"; default weekly at `randomScheduleDate()` shown in local time).
- "Search Depth": "1 page (top 10 results)" … "10 pages (top 100 results)", default 4 pages; description "10 pages is about 8 times as expensive as 1 page."
- **Cost box** (`CostEstimateBox.tsx`): two F09 quotes of `rank_tracking.config.save` with `draft.keywordCount` 1 and 50 (input debounced 350 ms): "**up to {formatUsd(q1.totalUsd)}** per keyword per check" and, when scheduled, "50 keywords would cost up to **{formatUsd(q50.monthly.totalUsd)}**/month"; while refreshing a spinner with `aria-live="polite"` "Updating price…"; on quote error "Price unavailable." with "Retry".
- Buttons "Cancel" / "Add Domain" ("Save Changes" when editing). Errors from the API under the form in an `Alert` (e.g. `tracker_exists` message).

**Step 2 — "Choose keywords to track"** (dialog widens to `sm:max-w-3xl`; shown after create):
- Labs country: header "Find the keywords {domain} already ranks for", `PricedActionButton label="Find ranking keywords"` (action `rank_tracking.suggestions.run`), plus "Add keywords manually instead" link. Opening the step reads `cacheOnly: true` first; a cached list shows directly with "Found {n} keywords {domain} ranks for." (no click, no spend).
- Loading after the click: "Finding your top keywords…" + spinner "This usually takes a few seconds".
- Result: `DataTable` with selection column, columns Keyword / Position / Volume / Traffic (sorted by traffic desc), the **top 20 by traffic pre-selected** once; shift-click range selection (F06 `applyShiftRangeSelection`); footer "{k} of {n} selected", buttons "Skip" and "Save Keyword(s)".
- No rankings: "No rankings found" / "We couldn't find any keywords {domain} currently ranks for. You can add keywords manually." + "Skip".
- Error: "Couldn't fetch keywords" / "You can skip this step and add keywords manually later." + "Skip".
- Non-Labs country: "Add keywords manually" / "Ranked-keyword suggestions aren't available for this country. Continue and add the keywords you want to track manually." + "Continue".
- Saving on a scheduled tracker: when the API answers `approval_required`/`price_changed`, open `CostReviewDialog` title "Approve scheduled checks", confirm "Approve and save", detail line "{n} keywords on {Mobile}, checked {weekly}" and `MonthlyProjection`; confirming resends with `maxUsd = quote.totalUsd`.

**Step 3 — "Check rankings now?"** (`FirstCheckStep.tsx`): body "Your first scheduled check runs {formatNextRun(nextCheckAt)}. Check now to see positions right away." (manual trackers: "Check now to see positions."); `PricedActionButton label="Check {n} keywords now" alwaysConfirm` (action `rank_tracking.check.run`, dialog title "Check rankings now", confirm "Run check"); secondary "Not now" closes and opens the detail page. Toasts: "Added {n} keywords for tracking", "Rank check started".

#### 6.6.4 `/portal/rank-tracking/[configId]` (`src/app/portal/rank-tracking/[configId]/page.tsx` → `RankTrackingDomainDetail.tsx`, PORT of `RankTrackingDomainDetail.tsx:78-392`)

Layout top to bottom:
1. **Run alerts** (`RankRunAlerts.tsx`, PORT `:8-62`): stale → warning "This check may be unresponsive and will be cleaned up automatically."; failed with a spend reason → destructive "Your last rank check didn't run." + the F01 refusal message; other failure → destructive "**Last check failed.** {message}"; completed with an error message → warning "**Your last check was incomplete.** Our search data provider had errors, so some keywords show their previous position."; skip reason `price_changed`/`approval_missing` → warning with the message and "Review price" (opens `CostReviewDialog` for `rank_tracking.config.save`). OpenSEO's "Rank tracking now retries some results" banner is not ported (no prior behaviour to announce).
2. **Header** (`RankTrackingDetailHeader.tsx`, PORT `:33-153`): domain (h2); meta "{place} · {Mobile} · {Weekly} · Next: {date} · Last: {date} · up to {formatUsd(q.totalUsd)}/check" (devices tooltip "Mobile results often differ from desktop. Search Console averages both, so its positions may not match."); device `SegmentedToggle` (Desktop/Mobile, only for both); compare `Select` ("vs yesterday", "vs last week", "vs last month", "vs 90 days ago"; default by schedule); "Configure" (outline) and "Add Keywords".
3. **Add keywords panel** (`AddKeywordsPanel.tsx`, PORT): textarea "One keyword per line", checkbox "Match case" (tooltip "Track these keywords exactly as typed instead of lowercasing them. Google can return different results for a capitalized brand name."), "Add Keywords" / "Cancel"; scheduled approval as Step 2; toast "{n} keywords added"; then toast "Use 'Check rankings' to check these keywords" (never auto-checks).
4. **AI Overview strip** (`AiOverviewStrip.tsx`, shown when the latest full run has ≥ 1 checked keyword): "AI Overview seen for **{a}** of **{c}** checked keywords on {mobile} (latest check)." with info tooltip "Counts results pages where Google showed an AI Overview when we checked. Overviews that load after the page are not detected here; track a keyword as an AI question to measure it fully." Filter link "Show them" sets `aio=shown`.
5. **Position distribution** (`RankTrackingOverview.tsx`, PORT `:30-163`): stacked areas "Top 3" (green), "4–10" (blue), "11–20" (amber), "Not in top 20" (grey), "Not checked" (light, tooltip "Check failed, no position recorded."); range toggle "30d" / "90d" / "All"; one point → `EmptyState` "Only 1 check so far" / "The trend fills in after the next check."; none → "No history yet" / "Run a check to start tracking positions over time."; skeleton `h-[220px]`; an `sr-only` table lists each run's buckets.
6. **Toolbar** (`RankTrackingTableToolbar.tsx`, `ToolbarMenus.tsx`, PORT): "Latest" / "History" toggle (History only after 2 full runs); "Filters" toggle with count; running progress "{checked}/{total}" with `Progress` (`aria-label="Rank check progress"`) and the phase label ("Checking keywords" / "Re-checking results that look wrong"); `ExportMenu` (Export to Sheets, Export CSV, Copy keyword list); "More actions" menu: "Check rankings" ("Running…" while busy; opens `CostReviewDialog` for `rank_tracking.check.run`, title "Check {n} keywords?", detail "{n} keywords × {d} device(s) = {n×d} searches. Results in about {eta}."), "Update keyword stats" (`PricedActionButton alwaysConfirm`, dialog title "Update keyword stats?").
7. **Filters** (`RankTrackingFilterPanel.tsx`, PORT): include/exclude terms, position ranges per device, volume, KD, CPC, **AI Overview** (Any / Shown / Not seen); all in the URL.
8. **Table** (`RankTrackingTable.tsx`, `RankTrackingColumns.tsx`, `RankTrackingTableParts.tsx`, PORT `:28-235`, `:20-301`, `:36-268`): hidden pinned column sorts first; selection; Keyword (pin star `aria-pressed`, label "Pin keyword to top"/"Unpin keyword"; click opens the trend modal; "Aa" badge for match-case); Position per visible device: never checked → "—" with tooltip "Not checked yet"; checked, not found, previous null → "Not in top {depth}" (muted); was ranking now not found → "{prev} → lost"; first check → "{pos}"; both → "{prev} → {pos}" with a green badge (better) or amber (worse); URL (path, external link); Volume ("Local volume" header with the city tooltip on local trackers), KD (`ScoreBadge`), CPC; SERP Features tags (FS, PAA, **AI** with `Sparkles`, Local, KP, Video, Img, Shop, News); (phase 6) "AI visibility" column; row menu: "View history", "Open in Google" (`googleSerpUrl`), "Track as AI question" (phase 6), "Remove". Bulk bar: "Remove" (confirm "Remove keywords?" / "This will stop tracking {n} keywords. Historical ranking data is preserved but won't appear in the table."), "Check selected" (priced, subset run), export selection. Footer "{shown} of {total} keywords". Empty: "No keywords yet" / "Add the keywords you want to track for this domain." + "Add Keywords".
   - AI Overview tag tooltip: "AI Overview: Google showed an AI-generated summary on this results page when we checked. Overviews that load after the page are not detected here."
9. **History grid** (`RankTrackingHistoryMatrix.tsx`, PORT `:27-194`): keyword rows × last 12 full runs; cells "{pos} ▲{n}"/"▼{n}"; "—" not found; `CircleSlash` with tooltip "Not checked: check failed, no position recorded."; filtered empty "No keywords match these filters" + "Clear filters".
10. **Trend modal** (`KeywordTrendModal.tsx`, `RankTrendChart.tsx`, PORT): title = keyword; description "{place} · {language}"; "Open in Google" button (`googleSerpUrl`, title "Search this keyword on Google with the tracked language, country, and city"); chart with Y axis **reversed**, domain `[1, serpDepth]`, label "Google position (1 = best)", "Better ↑", a muted bottom band where not-found checks are plotted, `connectNulls={false}` so never-checked gaps stay gaps; device lines Desktop (#2563eb) and Mobile (#14b8a6); range toggle; history table Date / Device / Position with "Copy" and "Download CSV"; one-point and no-history empty states as in 5.

URL state (detail): `view=history`, `device`, `compare`, `sort`, `order`, `include`, `exclude`, `minDesktopPos`…`maxCpc`, `aio=shown|not_seen` (F05 `useUrlSearchState`; invalid values ignored, as `openseo:src/types/schemas/rank-tracking-search.ts:26-54`).

**Polling** (`hooks/useRankRunPolling.ts`, PORT `useRankRunPolling.ts:9-47` on F05 `useServerPacedQuery`): `isActive = status ∈ {pending, running} && !maybeStale`; `pollAfterSeconds` from the server; floor 3 s; `onFinish` invalidates `rankResults`, `rankTrend`, `rankMatrix`, `rankKeywordHistory` for the tracker. There is no idle 30-second poll (OpenSEO polls idle to discover scheduled checks); conventions §9 poll only active runs, so a scheduled check that starts while the page is open appears on focus or reload.

**Pins** (`hooks/useSetKeywordPinned.ts`, PORT on F05 `useOptimisticMutation`): patches every cached `rankResults` compare period; failure → `onSettled` invalidation.

**Phone (< 640 px):** header stacks; device toggle and compare select wrap; table scrolls horizontally inside its card; the chart keeps 220 px height; dialogs are full-screen; bulk bar above the safe area.

**Accessibility:** charts have `sr-only` data tables; inverted axis is labelled in text; badges carry text, not colour alone ("better", "worse" in `aria-label`); progress has `aria-valuenow`.

#### 6.6.5 Track as AI question (phase 6, `TrackAiQuestionDialog.tsx`)

Shown in the row menu for every keyword, and as a button "Track as AI question" inside the AI Overview tag tooltip. `FormDialog` title "Track as AI question"; field "Question" (prefilled with the keyword; helper "Google AI Overviews are measured on exactly this search. Keep the keyword to compare with your ranking, or write it as a buyer would ask an assistant to also learn what ChatGPT, Gemini and Perplexity say."); optional "Topic"; buttons "Cancel" / "Add question". Results: created → toast "Question added. Approve your panel in Questions to start measuring it." with action "Open Questions" → `/portal/measurement`; existing → "This question is already in your list."; revived → "Question restored from your archive."; limits → inline `Alert` with the API message.

**AI visibility column** (header tooltip "Latest Google AI Overview result for this keyword's AI question, from your AI-visibility scans"): `cited` → badge "Cited in AI Overview" (success); `mentioned` → "Named in AI Overview"; `absent` → "AI Overview without you" (warning); `no_overview` → "No AI Overview" (muted); `not_measured` → "Not measured yet" (muted). Tooltip "Measured {date}" when known; the cell links to `/portal/questions/{questionId}` through F08's `<QuestionHistoryLink>`. Keywords without a question show nothing.

### 6.7 Permissions, privacy, observability

- Members and owners can create, edit, archive, add/remove/pin keywords, approve prices and run checks (OpenSEO: any project member). Workspace spend caps (F01/F03) bound everything.
- Never logged: keywords, domains, URLs, SERP item contents, provider task ids in customer-facing errors. Server log lines use run/config ids and codes only.
- PostHog (F26 names; until `src/lib/telemetry/events.ts` exists events go through `trackRankEvent` in `src/components/portal/rank-tracking/telemetry.ts` (exports `setRankEventTracker(fn)`; no-op until F26 wires it, F26 §6.2.7), a no-op sink F26 wires): `rank_tracking:config_create { devices, schedule, local }`, `rank_tracking:keywords_add { count, source }`, `rank_tracking:check_trigger { keywords, subset }` (client), `rank_tracking:check_complete { status, trigger, keywords_checked }` (server, from finalize), `rank_tracking:pin { pinned }`, `rank_tracking:metrics_refresh { bought, from_cache }`, `rank_tracking:suggestions_open { cached, count }`, `rank_tracking:export_csv { scope }`, `rank_tracking:track_question { created }`.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/db/app.schema.ts:216-376`, `openseo:drizzle/pg/0000_fixed_nico_minoru.sql:92-133`, `0006_location_name.sql`, `0029_rank_keyword_pins.sql`, `0037_smooth_lady_ursula.sql` | `supabase/migrations/110_f15_rank_tracking.sql` | PORT | `brand_key` tenancy, composite FKs, timestamptz, `text[]` features + generated `has_ai_overview`, frozen run copy, `rank_check_tasks` ledger. |
| `openseo:src/server/features/rank-tracking/repositories/{RankTrackingRepository,runQueries,snapshotQueries}.ts` | `111_f15_rank_tracking_functions.sql`, `src/lib/rank-tracking/repository.ts` | PORT | Drizzle → SQL functions (DISTINCT ON); D1 chunking dropped. |
| `openseo:src/shared/rank-tracking.ts:33-55, 93-195, 376-396` (+ `rank-tracking.test.ts:4-51`) | `src/shared/rank-tracking.ts`, `src/lib/rank-tracking/cost.ts` (+ test) | PORT | Credits and markup removed (raw USD); prices from F03; parity values recomputed in USD. |
| `openseo:src/shared/rank-tracking.ts:197-374`, `openseo:src/server/features/rank-tracking/services/configSchedule.ts` | F10 `src/shared/schedule.ts` | PATTERN (reuse) | F15 calls `computeNextRunAt`/`planWindows`; manual stays F15's. |
| `openseo:src/server/workflows/RankCheckWorkflow.ts` (+ `.test.ts:108-200`) | `src/lib/rank-tracking/checkJob.ts` (+ test) | PORT | Cloudflare Workflow → F01 job; credit checks → approved max + `rank_check_reserve` + `metered`. |
| `openseo:src/server/workflows/rankCheckPaths.ts` (+ `.test.ts:99-110`) | `src/lib/rank-tracking/checkPaths.ts` (+ test) | PORT | Step outputs → `rank_check_tasks`; sleeps via `ctx.step.sleep`. |
| `openseo:src/server/workflows/rankCheckRetries.ts` (+ `rankCheckPaths.test.ts:112-199`) | `src/lib/rank-tracking/retries.ts` (+ test) | PORT | Pair state re-derived from tables each step; pure functions kept. |
| `openseo:src/server/features/rank-tracking/services/rankCheckRunGuards.ts` (+ `.test.ts:44-95`) | `src/lib/rank-tracking/runGuards.ts` (+ test) | PORT | Workflow status → F01 `getJobStatus`; plus `singleActiveKey`. |
| `openseo:src/server/features/rank-tracking/services/scheduledRankChecks.ts` (+ `.test.ts:92-374`) | `src/lib/rank-tracking/schedules.ts` (+ test) | PORT | Plan/credit checks → feature flag, approval and F09 quote; F10 `runDueSchedules`; budget admission kept. |
| `openseo:src/server/features/rank-tracking/services/rankTrackingResults.ts` (+ `.test.ts`, `.query.test.ts`) | `src/lib/rank-tracking/results.ts` (+ tests) | PORT | `checkedAt` per device added; `aiQuestion` added. |
| `openseo:src/server/features/rank-tracking/services/{RankTrackingService,RankTrackingKeywordService}.ts` (+ tests) | `src/lib/rank-tracking/service.ts`, `metrics.ts` (+ tests) | PORT | No auto paid check; approvals for schedules; metrics from `keyword_metrics` first. |
| `openseo:src/server/features/domain/services/DomainService.ts:122-216` | `src/lib/rank-tracking/suggestions.ts` | PORT | Own spend feature and workspace cache; F14 mapper. |
| `openseo:src/server/lib/dataforseo/serp.ts:42-351` | F02 `src/lib/providers/dataforseo/serp.ts` | (owned by F02) | F15 adds a body assertion test only. |
| `openseo:src/serverFunctions/rank-tracking.ts` | `src/app/api/customer/rank-tracking/**/route.ts` | PORT | Server functions → JSON routes with `requireWorkspace`. |
| `openseo:src/types/schemas/{rank-tracking,rank-tracking-search}.ts` | `rankTracking.contract.ts`, `src/shared/rank-tracking.ts` | PORT | zod v4 strict requests; MCP credit fields removed. |
| `openseo:src/client/features/rank-tracking/RankTrackingFilters.logic.ts` (+ `RankTrackingFilters.test.ts`) | `src/shared/rank-tracking-filters.ts` (+ test) | COPY | AI Overview filter added. |
| `openseo:src/shared/google-serp-url.ts` (+ `.test.ts`) | `src/shared/google-serp-url.ts` (+ test) | COPY | — |
| `openseo:src/client/features/rank-tracking/{RankTrackingDomainList,RankTrackingDomainDetail,RankTrackingDetailHeader,RankTrackingOverview,RankTrackingTable,RankTrackingColumns,RankTrackingTableParts,RankTrackingTableToolbar,ToolbarMenus,RankTrackingFilters,RankTrackingHistoryMatrix,KeywordTrendModal,RankTrackingTrendChart,AddKeywordsPanel,RankRunAlerts,SearchTargetingField}.tsx` | `src/components/portal/rank-tracking/*.tsx` | PORT | F04/F06 components; credit/plan UI removed; cost via F09; AI Overview strip and column; copy changes listed in §6.6. |
| `openseo:src/client/features/rank-tracking/{RankTrackingConfigModal,KeywordSuggestionStep}.tsx` | `RankTrackingConfigDialog.tsx`, `KeywordSuggestionStep.tsx`, `CostEstimateBox.tsx`, `FirstCheckStep.tsx` | PORT | Server quotes instead of client math; suggestions behind a priced click; approval and first-check steps. |
| `openseo:src/client/features/rank-tracking/{useRankRunPolling,useSetKeywordPinned,useRankCheckTrigger,useSaveConfigMutations,useMetricsRefresh}.ts` | `src/components/portal/rank-tracking/hooks/*.ts` | PORT | F05 helpers; no idle polling. |
| `openseo:src/client/features/rank-tracking/{CheckConfirmModal,FreePlanAlert,RankTrackingChangesAlert}.tsx` | — | not ported | Replaced by F09 `CostReviewDialog`; no plans; no change banner. |
| `openseo:scripts/repair-rank-tracking-locations.ts` | — | PATTERN | Lesson applied: validate names at save time (§6.2.3). |
| `openseo:src/server/mcp/tools/{create-rank-tracker,get-rank-tracker,run-rank-tracker,add-rank-tracking-keywords}.ts` | `src/lib/rank-tracking/tools.ts` | PATTERN | F22 tool definitions; no MCP server. |

## 8. Implementation plan

### Phase 1 — Data model, pure logic, repository

**Goal:** migrations 110–111 applied, pure cost/retry/admission logic and the repository tested.

- [ ] **P1.T1 Migrations**
  - [x] **P1.T1.S1** *Files:* `supabase/migrations/110_f15_rank_tracking.sql`, `supabase/migrations/111_f15_rank_tracking_functions.sql`. *Do:* §6.1 verbatim. *Verify:* `node --test src/lib/migrationsRunner.test.mjs src/lib/migrationsLedger.test.mjs` → pass.
  - [x] **P1.T1.S2** *Files:* `scripts/setup-supabase.mjs` (`EXPECTED_OBJECTS` for 110 and 111), `tests/customer-uat.sql` (§6.1 tenant block). *Verify:* CI customer-database commands against local Postgres 16 → exit 0.
  - [x] **P1.T1.S3** *Files:* `README.md` (two migration rows), `docs/OPERATOR_LEDGER.md` § C ("apply 110 and 111 before deploying F15 phase 2"), `docs/PROD_MIGRATIONS.md` (two bullets). *Verify:* `node --test src/lib/docStatus.test.mjs src/lib/migrationsRunner.test.mjs` → pass.
  - [x] **P1.T1.S4** *Files:* `scripts/qa/check-f15-db.mjs`. *Do:* groups on a loopback `_qa` database (pattern of `scripts/qa/check-repair-workflows.mjs`): `schema` (tables, indexes, no FK from snapshots to keywords), `rls` (two workspaces), `keywords` (cap at 1,000 with a 1,005-row add; duplicates skipped; lowercase check), `active` (second `try_create_rank_run` returns false; after `completed` it succeeds), `reserve` (refuses beyond approved max), `results` (latest/before/earliest), `trend` (port `RankTrackingRepository.query.test.ts:359` and `:406`), `retention`. *Verify:* `node scripts/qa/check-f15-db.mjs` → "ok 8 groups" (F15-AC-01, 04 DB half, 05, 06 DB half, 12 DB half, 13, 21).
- [x] **P1.T2 Shared and pure modules**
  - [x] **P1.T2.S1** *Files:* `src/shared/rank-tracking.ts`, `src/shared/rank-tracking.test.ts`, `src/shared/rank-tracking-filters.ts`, `rank-tracking-filters.test.ts`, `src/shared/google-serp-url.ts`, `google-serp-url.test.ts`. *Do:* §6.2.1; port `RankTrackingFilters.test.ts:65-131` and `google-serp-url.test.ts`; add AI-Overview filter cases and `buildRankTrackingExport` (empty cell for not ranking, numeric change, "AI Overview" column). *Verify:* `node --test src/shared/rank-tracking.test.ts src/shared/rank-tracking-filters.test.ts src/shared/google-serp-url.test.ts` → pass.
  - [x] **P1.T2.S2** *Files:* `src/lib/rank-tracking/cost.ts`, `cost.test.ts`. *Do:* §6.2.2; the four parity cases (0.0128, 20.8, 0.1872, 11.7), operator ×5, scheduled monthly (weekly × 4). *Verify:* `node --test src/lib/rank-tracking/cost.test.ts` → pass (F15-AC-02).
  - [x] **P1.T2.S3** *Files:* `src/lib/rank-tracking/retries.ts` (pure half), `retries.test.ts`. *Do:* `needsRetry`, `buildRetryPairs`, `selectRetryResults`, `unconfirmedMisses`; port the five cases of `rankCheckPaths.test.ts:113-199` as pure tests. *Verify:* `node --test src/lib/rank-tracking/retries.test.ts` → pass (F15-AC-09 pure half).
  - [x] **P1.T2.S4** *Files:* `src/lib/rank-tracking/schedules.ts` (`admitByUnitBudget` only), `schedules.test.ts`. *Do:* ports of `scheduledRankChecks.test.ts:123`, `:174`, `:253` (zero units, budget stop, overflow defers). *Verify:* `node --test src/lib/rank-tracking/schedules.test.ts` → pass.
  - [x] **P1.T2.S5 (assertTrackedLocation deferred — needs F13 phase 8; owner decision)** *Files:* `src/lib/rank-tracking/market.ts`, `market.test.ts`. *Do:* §6.2.3; `normalizeTrackedDomain("https://WWW.Offcult.in/shop?x=1")` → `offcult.in`; empty → `invalid_domain`; unknown city → `unknown_location` with an injected registry. *Verify:* `node --test src/lib/rank-tracking/market.test.ts` → pass.
- [x] **P1.T3 Repository**
  - [x] **P1.T3.S1** *Files:* `src/lib/rank-tracking/repository.ts`, `memoryRepository.ts`, `repository.test.ts`. *Do:* §6.2.4; the same test suite runs against the memory repo (unit) and is reused by `check-f15-db.mjs` against Postgres; error mapping. *Verify:* `node --test src/lib/rank-tracking/repository.test.ts` → pass.
  - [x] **P1.T3.S2** *Files:* `THIRD_PARTY_NOTICES.md`. *Do:* append P1 COPY/PORT paths. *Verify:* `node --test src/lib/platform/thirdPartyNotices.test.mjs` → pass.

**Checkpoint:** full suite `node --import ./src/lib/liveWriteGuardAuto.mjs --test-concurrency=4 --test 'src/**/*.test.mjs' 'src/**/*.test.ts'` passes; `node scripts/qa/check-f15-db.mjs` → "ok 8 groups"; `npm run typecheck` exits 0. Completes F15-AC-01, 02, 13, 21 and the DB halves of 04, 05, 06, 12.

### Phase 2 — Check engine, priced actions and API

**Goal:** a customer can create a tracker, add keywords, approve and run a check, and read results through the API.

- [x] **P2.T1 Registrations**
  - [x] **P2.T1.S1** *Files:* `src/shared/spend-features.ts`, `src/lib/features/names.ts`, `src/lib/features/clientFeatures.ts`, `.env.example` (`FEATURE_RANK_TRACKING=`, `FEATURE_RANK_TRACKING_BRANDS=`, `FEATURE_RANK_TRACKING_AI_QUESTIONS=`, `FEATURE_RANK_TRACKING_AI_QUESTIONS_BRANDS=`). *Do:* §6.2.15. *Verify:* `node --test src/lib/features/flags.test.ts src/shared/*.test.ts` → pass; `grep -c "^FEATURE_RANK_TRACKING=$" .env.example` → 1 (F15-AC-22 registration half).
- [x] **P2.T2 Services**
  - [x] **P2.T2.S1** *Files:* `src/lib/rank-tracking/service.ts`, `service.test.ts`. *Do:* §6.2.5; port `RankTrackingService.test.ts:79-221` (reactivate archived, duplicate, language/location coexist, cap, location refusal) and `:232-280` (run time kept / moved); keyword add cases (lowercase, match-case, de-dupe, cap, cache prefill, approval required/changed/stored) with F09 fakes. *Verify:* `node --test src/lib/rank-tracking/service.test.ts` → pass (F15-AC-03, 04).
  - [x] **P2.T2.S2** *Files:* `src/lib/pricing/actions/rankTracking.ts`, `rankTracking.test.ts`, `src/lib/pricing/actions/index.ts` (one import line). *Do:* §6.2.14 (`check.run`, `config.save`; suggestions and metrics in P4). Cases: line labels, totals equal `estimateRankCheckUsd`, monthly for weekly, warnings, blocked `no_keywords`/`keyword_limit`, foreign `configId` → 404. *Verify:* `node --test src/lib/pricing/actions/rankTracking.test.ts` → pass.
  - [x] **P2.T2.S3** *Files:* `src/lib/rank-tracking/runGuards.ts`, `runGuards.test.ts`. *Do:* §6.2.6; port `rankCheckRunGuards.test.ts:72`; stale blocker (terminal job) replaced once; startup grace; `job_already_running` mapped; `getLatestRunView` never writes. *Verify:* `node --test src/lib/rank-tracking/runGuards.test.ts` → pass (F15-AC-05).
- [x] **P2.T3 Job**
  - [x] **P2.T3.S1** *Files:* `src/lib/rank-tracking/checkPaths.ts`, `checkPaths.test.ts`. *Do:* §6.2.7 with F01 memory jobs/spend, the memory repo and a fake DataForSEO client fed by `tests/fixtures/f15/*.json`. Cases: port `rankCheckPaths.test.ts:100` (failed live batch, run continues); queued post maps tags, marks rejected and missing; collect: pending stays, failed recorded, completed inserts snapshots; 6 rounds then expired; 500/round cap; reserve refusal stops posting. *Verify:* `node --test src/lib/rank-tracking/checkPaths.test.ts` → pass (F15-AC-07, 08).
  - [x] **P2.T3.S2** *Files:* `src/lib/rank-tracking/retries.ts` (job half), `retries.job.test.ts`. *Do:* `retryRankChecks` end to end with fixtures; the five cases through the job. *Verify:* `node --test src/lib/rank-tracking/retries.job.test.ts` → pass (F15-AC-09).
  - [x] **P2.T3.S3** *Files:* `src/lib/rank-tracking/checkJob.ts`, `checkJob.test.ts`, `src/lib/rank-tracking/jobs.ts`, `src/lib/jobs/kinds.ts` (one import). *Do:* §6.2.9; ports of `RankCheckWorkflow.test.ts:118`, `:167`, `:180`; archived tracker; `price_changed` at prepare; spend refusal → skip reason. *Verify:* `node --test src/lib/rank-tracking/checkJob.test.ts` → pass (F15-AC-06, 10).
  - [x] **P2.T3.S4** *Files:* `src/lib/rank-tracking/aiOverviewFence.test.ts`. *Do:* capture every request body the fake core receives during a live and a queued run and assert none has `load_async_ai_overview`; snapshots from `rank-live-found.json` store `serp_features` containing `"ai_overview"` and nothing from the overview item; grep-style check that no file in `src/lib/rank-tracking/` imports `answers.ts`. *Verify:* `node --test src/lib/rank-tracking/aiOverviewFence.test.ts` → pass (F15-AC-14).
- [x] **P2.T4 Routes**
  - [x] **P2.T4.S1** *Files:* `src/lib/rank-tracking/results.ts`, `results.test.ts`. *Do:* §6.2.10; port `rankTrackingResults.test.ts:29` and `.query.test.ts:99-118`; `checkedAt` cases. *Verify:* `node --test src/lib/rank-tracking/results.test.ts` → pass (F15-AC-12).
  - [x] **P2.T4.S2** *Files:* `src/app/api/customer/rank-tracking/configs/route.ts`, `configs/[configId]/route.ts`, `configs/[configId]/keywords/route.ts`, `keywords/remove/route.ts`, `keywords/pin/route.ts`, `configs/[configId]/check/route.ts`, `runs/latest/route.ts`, `results/route.ts`, `trend/route.ts`, `matrix/route.ts`, `keywords/[keywordId]/history/route.ts`, `src/lib/rank-tracking/rankTracking.contract.ts`. *Do:* §6.5. *Verify:* `node --test src/lib/http/routeContract.test.ts` → pass.
  - [x] **P2.T4.S3** *Files:* `src/lib/rank-tracking/rankTracking.route.test.mjs`. *Do:* customer-route hook pattern (`src/lib/customerRoutes.test.hooks.mjs`): flag off → 404 `feature_unavailable`; foreign tracker → 404; check without `maxUsd` → 400 `approval_required`; lower `maxUsd` → 409 `price_changed` with `details.quote`; second check → 409 `rank_check_running`; spend refusal → 403/402 F01 copy; extra body field → 400. *Verify:* `node --import ./src/lib/liveWriteGuardAuto.mjs --test src/lib/rank-tracking/rankTracking.route.test.mjs` → pass (F15-AC-04 route half, 05, 06, 22).
  - [x] **P2.T4.S4** *Files:* `THIRD_PARTY_NOTICES.md`. *Verify:* `node --test src/lib/platform/thirdPartyNotices.test.mjs` → pass.

**Checkpoint:** full suite, `npm run typecheck`, `npm run build`, `node scripts/qa/check-f15-db.mjs` pass; F02's `answerImportGuard.test.mjs` passes. Completes F15-AC-03 to 12, 14, 22.

### Phase 3 — Scheduling and retention (requires F10 phase 1 merged)

**Goal:** scheduled checks run on the queue within approvals; history is pruned.

- [ ] **P3.T1 Tick**
  - [ ] **P3.T1.S1** *Files:* `src/lib/rank-tracking/schedules.ts` (full), `schedules.test.ts`. *Do:* §6.2.11 with F01 memory jobs, F10 `runDueSchedules`, fake F09 quote. Ports of `scheduledRankChecks.test.ts:104` (flag off → `rank_tracking_disabled` advanced), `:147` (claims and starts), `:204` (lost CAS skipped), `:227` (per-config failure contained), `:300` (already running restores the slot), plus `approval_missing`, `price_changed`, `no_keywords`, a missed window runs once, scheduled runs use `queued`. *Verify:* `node --test src/lib/rank-tracking/schedules.test.ts` → pass (F15-AC-11).
  - [ ] **P3.T1.S2** *Files:* `src/lib/rank-tracking/jobs.ts` (periodics `rank_tracking.schedules`, `rank_tracking.retention`; kinds `rank_tracking.schedules.tick`, `rank_tracking.retention`). *Verify:* `node --test src/lib/jobs/registry.test.ts src/lib/rank-tracking/schedules.test.ts` → pass.
- [ ] **P3.T2 Retention**
  - [ ] **P3.T2.S1** *Files:* `src/lib/rank-tracking/retention.ts`, `retention.test.ts`. *Do:* loop of `prune-1`…`prune-20` while 1,000 runs were deleted. *Verify:* `node --test src/lib/rank-tracking/retention.test.ts` → pass; `node scripts/qa/check-f15-db.mjs --only retention` → ok (F15-AC-21).

**Checkpoint:** full suite and build pass. Completes F15-AC-11, 21.

### Phase 4 — List page, setup wizard, suggestions and keyword stats (requires F04, F05, F06, F09 phase 3, F10 phase 4, F13 phases 1–2 and 8, F14 phase 1 merged)

**Goal:** a customer can set up a tracker end to end in the portal.

- [ ] **P4.T1 Server**
  - [ ] **P4.T1.S1** *Files:* `src/lib/rank-tracking/suggestions.ts`, `suggestions.test.ts`, `src/app/api/customer/rank-tracking/suggestions/route.ts`, contract entry, `src/lib/pricing/actions/rankTracking.ts` (`suggestions.run`). *Do:* §6.2.12; cases: `cacheOnly` miss → `{ keywords: null }` and no spend; paid fetch caches non-empty only; non-Labs country → 422 before spend; ranked rows upserted as `labs_ranked`. *Verify:* `node --test src/lib/rank-tracking/suggestions.test.ts src/lib/http/routeContract.test.ts` → pass.
  - [ ] **P4.T1.S2** *Files:* `src/lib/rank-tracking/metrics.ts`, `metrics.test.ts`, `src/app/api/customer/rank-tracking/configs/[configId]/metrics/refresh/route.ts`, contract, `rankTracking.ts` (`metrics.run`). *Do:* §6.2.12; fresh cache rows copied free; stale bought; local always bought with `locationName`; research log written. *Verify:* `node --test src/lib/rank-tracking/metrics.test.ts` → pass (F15-AC-18).
- [ ] **P4.T2 Client**
  - [ ] **P4.T2.S1** *Files:* `src/components/portal/schedule/ScheduleField.tsx` (F10 file, additive). *Do:* add optional props `allowManual?: boolean` (default `false`, adds "Manual only"; PORT of `openseo:src/client/features/rank-tracking/ScheduleField.tsx:44-58`) and `dailyNote?: string` (default F10's copy). F10 ships both props (F10 §6.6 `ScheduleField`), so this subtask only verifies they exist and adds nothing if they do. *Verify:* `npm run typecheck` → exit 0; F10's browser scenarios still pass.
  - [ ] **P4.T2.S2** *Files:* `src/app/portal/rank-tracking/page.tsx`, `src/components/portal/rank-tracking/{RankTrackingPage,RankTrackingDomainList,DomainListFilters}.tsx`, `hooks/useRankTrackers.ts`, `telemetry.ts`, `src/components/app/navigation/items.ts` (entry), `src/lib/query/keys.ts` (factories). *Do:* §6.6.1–6.6.2. *Verify:* `npm run build` → exit 0.
  - [ ] **P4.T2.S3** *Files:* `src/components/portal/rank-tracking/{RankTrackingConfigDialog,SearchTargetingField,CostEstimateBox,KeywordSuggestionStep,FirstCheckStep}.tsx`, `hooks/useSaveConfigMutations.ts`. *Do:* §6.6.3 with exact copy. *Verify:* `npm run build` → exit 0.
  - [ ] **P4.T2.S4** *Files:* `scripts/qa/check-f15-browser.mjs`, `tests/fixtures/f15/api/*.json`. *Do:* fixture API server (pattern of `scripts/qa/check-repair-browser.mjs`); B1 empty list → Add Domain dialog defaults (Mobile only, 4 pages, Weekly) and cost box text; B2 daily shows the 7× note, both devices shows the doubling note; B3 keyword step: no request to `/suggestions` with `cacheOnly: false` before the click, then 25 rows with 20 checked, "Save Keywords" on a scheduled tracker opens "Approve scheduled checks", then "Check rankings now?". *Verify:* `node scripts/qa/check-f15-browser.mjs --only B1,B2,B3` → "ok 3 scenarios" (F15-AC-16).

**Checkpoint:** full suite, build, B1–B3 pass. Completes F15-AC-16, 18.

### Phase 5 — Detail page

**Goal:** OpenSEO's detail experience with the AI Overview tag, strip and filter.

- [ ] **P5.T1 Components**
  - [ ] **P5.T1.S1** *Files:* `src/app/portal/rank-tracking/[configId]/page.tsx`, `src/components/portal/rank-tracking/{RankTrackingDomainDetail,RankTrackingDetailHeader,RankRunAlerts,AddKeywordsPanel,AiOverviewStrip,RankTrackingOverview}.tsx`, `hooks/{useRankRunPolling,useRankCheckTrigger,useRankResults}.ts`, `src/lib/rank-tracking/runPolling.ts`, `runPolling.test.ts`. *Do:* §6.6.4 items 1–5 and polling; `runPolling.test.ts` covers `isActive`, floor 3 s and the finish transition. *Verify:* `node --test src/lib/rank-tracking/runPolling.test.ts` → pass; `npm run build` → exit 0 (F15-AC-23 unit half).
  - [ ] **P5.T1.S2** *Files:* `src/components/portal/rank-tracking/{RankTrackingTableToolbar,ToolbarMenus,RankTrackingFilterPanel,RankTrackingTable,RankTrackingColumns,RankTrackingTableParts,RankTrackingHistoryMatrix,KeywordTrendModal,RankTrendChart}.tsx`, `hooks/{useSetKeywordPinned,useMetricsRefresh}.ts`. *Do:* §6.6.4 items 6–10. *Verify:* `npm run build` → exit 0.
  - [ ] **P5.T1.S3** *Files:* `scripts/qa/check-f15-browser.mjs` (B4–B8). *Do:* B4 detail renders chart legend, strip "AI Overview seen for 6 of 19 checked keywords", "AI" tags; B5 "Check rankings" opens the cost dialog, confirm → progress "10/20", polling stops at `completed` and the table refreshes once; B6 pin moves the row before the request resolves and reverts on a 500; B7 History toggle and trend modal (axis label "Google position (1 = best)"); B8 filters `aio=shown` and export CSV contains numeric change and the "AI Overview" column; phone width 390 px has no horizontal page scroll. *Verify:* `node scripts/qa/check-f15-browser.mjs --only B4,B5,B6,B7,B8` → "ok 5 scenarios" (F15-AC-15, 17, 23).
  - [ ] **P5.T1.S4** *Files:* `src/components/portal/rank-tracking/telemetry.test.mjs`. *Do:* every event payload builder emits only the listed keys; no string property equals a keyword, domain or URL from the fixtures. *Verify:* `node --test src/components/portal/rank-tracking/telemetry.test.mjs` → pass (F15-AC-24).

**Checkpoint:** full suite, build, B1–B8 pass. Completes F15-AC-15, 17, 23, 24.

### Phase 6 — AI Overview bridge (requires F08 phase 1 and F12 phase 1 merged)

**Goal:** a keyword becomes a tracked AI question and shows the Google AI Overview verdict.

- [ ] **P6.T1 Database**
  - [ ] **P6.T1.S1** *Files:* `supabase/migrations/112_f15_rank_keyword_questions.sql`, `scripts/setup-supabase.mjs` (entry), `tests/customer-uat.sql` (one link per workspace). *Verify:* `node --test src/lib/migrationsRunner.test.mjs src/lib/migrationsLedger.test.mjs` → pass; `node scripts/qa/check-f15-db.mjs --only aio_status` → ok (answered+cited → cited; valid_no_aio → no_overview; legacy row; missing F12 table raises `undefined_table`).
  - [ ] **P6.T1.S2** *Files:* `README.md`, `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`. *Verify:* `node --test src/lib/docStatus.test.mjs src/lib/migrationsRunner.test.mjs` → pass.
- [ ] **P6.T2 Service, route, UI**
  - [ ] **P6.T2.S1** *Files:* `src/lib/rank-tracking/aiQuestions.ts`, `aiQuestions.test.ts`, `results.ts` (fill `aiQuestion`). *Do:* §6.2.13; injected `add`: arguments (`origin "manual"`, `sourceRef.kind "rank_keyword"`), created/revived passthrough, limits passthrough, link upsert idempotent, no panel function imported; `mapAioStatus` table; `42P01` → `not_measured`. *Verify:* `node --test src/lib/rank-tracking/aiQuestions.test.ts` → pass (F15-AC-19, 20).
  - [ ] **P6.T2.S2** *Files:* `src/app/api/customer/rank-tracking/configs/[configId]/keywords/[keywordId]/ai-question/route.ts`, contract, route test cases (flag combinations → 404). *Verify:* `node --import ./src/lib/liveWriteGuardAuto.mjs --test src/lib/rank-tracking/rankTracking.route.test.mjs` → pass.
  - [ ] **P6.T2.S3** *Files:* `src/components/portal/rank-tracking/{TrackAiQuestionDialog,AiVisibilityCell}.tsx`, `RankTrackingColumns.tsx`, `RankTrackingTableParts.tsx`, `scripts/qa/check-f15-browser.mjs` (B9). *Do:* §6.6.5; B9: row menu "Track as AI question" prefilled, created toast with "Open Questions", the column shows "Cited in AI Overview" from fixture data. *Verify:* `node scripts/qa/check-f15-browser.mjs --only B9` → "ok 1 scenario".
  - [ ] **P6.T2.S4** *Files:* `src/lib/rank-tracking/tools.ts`, `tools.test.ts`. *Do:* §6.2.15; inputs strict; outputs loose; paid tool refuses without `maxUsd`. *Verify:* `node --test src/lib/rank-tracking/tools.test.ts` → pass.

**Checkpoint:** full suite, build, `node scripts/qa/check-f15-browser.mjs` → "ok 9 scenarios", `node scripts/qa/check-f15-db.mjs` → "ok 9 groups". Completes F15-AC-19, 20.

## 9. Test plan

| File | Cases | ACs |
|---|---|---|
| `scripts/qa/check-f15-db.mjs` | schema, rls, keywords, active, reserve, results, trend, retention, aio_status | 01, 04, 05, 06, 12, 13, 20, 21 |
| `src/shared/rank-tracking.test.ts`, `rank-tracking-filters.test.ts`, `google-serp-url.test.ts` | labels, export rows, filters incl. AI Overview, SERP URL | 17 |
| `src/lib/rank-tracking/cost.test.ts` | four parity cases, operator, monthly | 02 |
| `market.test.ts` | domain normalisation, unknown city | 03 |
| `repository.test.ts` | memory/SQL parity, error mapping | 01, 04 |
| `service.test.ts` | create/update/add/remove/pin, approvals | 03, 04 |
| `src/lib/pricing/actions/rankTracking.test.ts` | four actions | 06, 16, 18 |
| `runGuards.test.ts` | active run, stale blocker, grace | 05 |
| `checkPaths.test.ts`, `retries.test.ts`, `retries.job.test.ts`, `checkJob.test.ts` | live, queued, retries, finalize, prepare price check | 06–10 |
| `aiOverviewFence.test.ts` | no async flag, type-only storage, import guard | 14 |
| `results.test.ts` | compare, fallback, freshness, checkedAt | 12 |
| `schedules.test.ts` | admission, CAS, restore, skip reasons | 11 |
| `retention.test.ts` | prune loop | 21 |
| `metrics.test.ts`, `suggestions.test.ts` | cache-first stats, priced suggestions | 16, 18 |
| `aiQuestions.test.ts`, `tools.test.ts` | bridge, status mapping, tools | 19, 20 |
| `runPolling.test.ts` | active polling and finish | 23 |
| `rankTracking.route.test.mjs` | auth, flags, approvals, conflicts | 04–06, 19, 22 |
| `telemetry.test.mjs` | no keyword/domain/URL | 24 |
| `scripts/qa/check-f15-browser.mjs` | B1–B9 | 15, 16, 17, 19, 23 |

Fixtures: §6.4 list, written by hand from DataForSEO's public documentation shapes; no live recording. The live check (`check-f15-live.mjs`) runs only on the owner's instruction with `--max-spend-usd 0.05`.

## 10. Rollout and rollback

- Env names: `FEATURE_RANK_TRACKING`, `FEATURE_RANK_TRACKING_BRANDS`, `FEATURE_RANK_TRACKING_AI_QUESTIONS`, `FEATURE_RANK_TRACKING_AI_QUESTIONS_BRANDS` (`.env.example` only). DataForSEO credentials are F02's.
- Migration order: 110, 111 before phase 2; 112 after F08 (075–079) and F12 (095), before phase 6. All additive.
- Defaults: both flags off in production; spend controls `rank_tracking.check`, `rank_tracking.suggestions`, `rank_tracking.metrics` disabled.
- Owner enabling: in `/ops/costs` enable the three spend features for an allowlisted workspace with a daily cap (suggested $3) and per-call maximum $1; set `FEATURE_RANK_TRACKING=allowlist` and the brand; optionally run `scripts/qa/check-f15-live.mjs --brand <key> --max-spend-usd 0.05`; later `FEATURE_RANK_TRACKING_AI_QUESTIONS=allowlist` once F08's `question_curation` is on for that workspace.
- Turning off: set the flag `off` (page hidden, routes 404, scheduled checks skip with `rank_tracking_disabled` and advance) or disable a spend control (paid calls refused with 403; running checks stop at the next billed step and finish `partial` or `failed`). Running jobs can be cancelled with F01 `cancelJob`.
- Data cleanup: archived trackers keep history; deleting a workspace cascades; retention prunes after 760 days.

## 11. Risks and open questions

| # | Risk / question | Default chosen |
|---|---|---|
| 1 | The standard SERP under-reports AI Overviews (async ones are missed; India showed none inline). | Keep the tag as "seen"; never claim absence; the AI-question bridge is the authoritative measurement (§6.4 decision). Revisit only through the P0 fence if the owner wants async detection per keyword. |
| 2 | DataForSEO's account limit is 2,000 requests/min; our tick runs every 5 minutes like OpenSEO's. | Port the 1,000 task-unit admission budget unchanged; record `deferred` counts for tuning. |
| 3 | F01 caps step outputs at 64 KB; OpenSEO's step outputs carry task lists. | `rank_check_tasks` holds task state; steps return counts only. |
| 4 | Tracking any domain (competitors) touches the deferred Mixed row "Competitors (tracking side)". | Allowed, as OpenSEO allows it; F15 adds no competitor modelling and does not change AI-visibility competitors. Default domain is the workspace's own. |
| 5 | Location registry check vs OpenSEO's sandbox probe. | Use F13's free registry check (same failure class prevented); if the owner prefers the sandbox probe, add it behind the same function. |
| 6 | Conventions §5.6 names `src/lib/keywords/keyword-locations.ts`, while F13 §6.2.3 ships `src/shared/keyword-locations.ts`. | F15 imports F13's actual path `src/shared/keyword-locations.ts`. |
| 7 | F13's `/api/customer/keywords/locations` may be gated on `keyword_research`. | Requested: F13 admits `keyword_research OR rank_tracking OR local_seo`. Until then the local targeting option is hidden when that route returns 404. |
| 8 | F10's `ScheduleField` drops "Manual only" and has scan copy. | Additive props `allowManual`, `dailyNote` (P4.T2.S1). |
| 9 | No idle polling (§9) means a scheduled check that starts while the page is open is not shown until focus or reload. | Accepted; TanStack refetch on focus covers it. |
| 10 | Snapshot growth: 1,000 keywords × 2 devices × 365 daily runs ≈ 730k rows per tracker per year. | 760-day retention; indexes on `(tracking_keyword_id, device, checked_at)`; revisit partitioning if one workspace exceeds 10 M rows. |
| 11 | Queued `task_post` bills the full depth up front even when the crawl stops early (`serp.ts:252-256`). | Meter at post (as OpenSEO); `task_get`'s lower cost is not re-settled. Reconciliation (F03) may surface the difference. |
| 12 | Every tracked AI question is asked on every scan engine, not only Google AIO. | Stated in the dialog copy; panel approval (F08) remains the customer's decision. |

## 12. Definition of done

- [ ] Phases 1–6 merged; every subtask ticked.
- [ ] F15-AC-01 … F15-AC-24 covered by passing tests listed in §9.
- [ ] `npm run build`, `npm run typecheck`, the full test suite, `check-f15-db.mjs` (9 groups) and `check-f15-browser.mjs` (9 scenarios) pass.
- [ ] Migration paperwork for 110, 111, 112 (README, `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`) and `THIRD_PARTY_NOTICES.md` updated.
- [ ] `features/README.md` status updated (In progress at the first PR, Merged at the last).
- [ ] Owner-run live check result recorded in the PR of the phase that enables it (or "not run" stated).
