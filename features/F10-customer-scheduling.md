# F10 — Customer scheduling

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F10 |
| Wave | 1 |
| Comparison rows covered | "Scheduling" (OpenSEO: the customer picks daily, weekly or monthly per tracker; the next run is shown on the page. Perceev: durable schedule windows exist but are operator-only and off by default; the seven-day soak has not started) |
| Depends on | F01 (merged: `definePeriodic`, `enqueueSystemJob`, `defineJob`, spend holds, flags, `requireWorkspace`), F09 (merged: priced-action registry, `estimateScanRun` with `scheduleInterval`, `recordApproval`, `price_approvals`, `scan_jobs.approved_max_usd`/`price_quote`, `CostReviewDialog`, `MonthlyProjection`, `probeDaySpendToday`), F03 (`scheduledChecksPerMonth`). Phase 4 (UI) also needs F04 and F05. Queued collection needs F02 phase 4 (optional, §6.4). |
| Blocks | F15 (reuses `src/shared/schedule.ts` and `src/lib/schedules/runDue.ts`), R11 soak execution (owner) |
| Reserved migrations | 085–089. **085** `085_f10_customer_schedules.sql`. 086–089 unused. |
| Feature flag | `FEATURE_CUSTOMER_SCHEDULING` (name `customer_scheduling`, spend `["ai_visibility.scan"]`), in `CLIENT_FEATURES`. Off in production until the R11 soak gates pass (§10). |
| Spend features | none new (scheduled scans reserve under F03's `ai_visibility.scan`) |
| OpenSEO reference | `openseo:src/db/ai-visibility.schema.ts:11-45`, `openseo:src/server/features/ai-visibility/services/{scheduledAiVisibility,aiVisibilitySchedule,aiVisibilityRuns}.ts`, `openseo:src/server/features/ai-visibility/repositories/AiVisibilityRepository.ts:226-290`, `openseo:src/shared/rank-tracking.ts:151-392`, `openseo:src/types/schemas/schedule-time.ts`, `openseo:src/client/features/rank-tracking/{ScheduleField.tsx,scheduleTime.ts}`, `openseo:src/client/features/ai-visibility/TrackingScheduleSummary.tsx` at `c5f8db1` |

## 1. Summary

Workspace owners choose daily, weekly or monthly scans (optionally at a time and weekday in their own timezone), see the monthly cost projection and approve it once. Every due window runs the approved question panel through the existing durable window ledger and P0 dispatch controls; a window that cannot run is recorded as skipped with a visible reason (paused collection, workspace not allowlisted, a spend cap, a price above the approval, no approved questions) and the schedule still moves on. Overview and Scans show "Next scan …". The scheduling utility is shared with rank tracking (F15).

## 2. What OpenSEO does (observed)

1. **Schema.** One tracker per project with `enabled`, `schedule_interval` `daily | weekly | monthly` (default weekly), `next_check_at`, `last_skip_reason`, and a due index on `(enabled, next_check_at)` (`openseo:src/db/ai-visibility.schema.ts:13-45`). A partial unique index allows one queued or running run per tracker (`:65-96`).
2. **New trackers** run weekly and the first check is at least a week out, "so creating a tracker never charges on its own" (`openseo:src/server/features/ai-visibility/services/aiVisibilityConfiguration.ts:87-97`, `:114-129`).
3. **Changing the schedule** (`openseo:src/server/features/ai-visibility/services/aiVisibilitySchedule.ts:14-71`): disabling sets `enabled = false`; enabling needs active prompts and a configured provider; an unchanged interval and time keep the stored next check; otherwise it is recomputed; `last_skip_reason` is cleared; the first enable starts a baseline when the project has no scheduled or baseline run (a running check or missing credits do not block saving).
4. **Next-run calculation** (`openseo:src/shared/rank-tracking.ts:296-374`): daily/weekly advance from the previous anchor in whole steps until in the future, so a late run does not drift; monthly runs on the user's last day of the month, keeping a −1/0/+1 day shift relative to the UTC month end (`:207-229`); a chosen time is converted from the user's timezone to UTC including the weekday (`:229-284`); with no choice the time is random between 04:00 and 10:00 UTC to spread load (`:338-345`). The chosen time is `{ weekday?, hour, minute, timeZone? }` and the timezone is not stored (`openseo:src/types/schemas/schedule-time.ts:17-37`).
5. **Cron body** (`openseo:src/server/features/ai-visibility/services/scheduledAiVisibility.ts:16-83`): retention sweep first; due trackers oldest first (limit 50, `AiVisibilityRepository.ts:263-277`); a 2-minute deadline and a 1,000-answer budget per tick, the first start always admitted (`:9-14`, `:36-39`); **the schedule is advanced before the run starts** by a compare-and-set on the observed `next_check_at` (`:40-53`; `AiVisibilityRepository.ts:226-243`), "so a tracker that fails or is busy moves on instead of staying due and crowding out the rest"; a known error message becomes `last_skip_reason`, anything else "The scheduled check could not start." (`:64-81`).
6. **Mode.** Scheduled runs are always queued (cheaper); live is used only when a user starts a run (`:54-55`; `openseo:src/server/features/ai-visibility/services/aiVisibilityRuns.ts:100-105`). Credits are checked before a run starts and a shortfall is recorded as `INSUFFICIENT_CREDITS` on the tracker (`aiVisibilityRuns.ts:98-124`).
7. **Projection.** `scheduledChecksPerMonth`: daily 30, weekly 4, monthly 1 (`openseo:src/shared/rank-tracking.ts:186-195`), used by the cost estimate (`openseo:src/server/features/ai-visibility/services/aiVisibilityCost.ts:77-80`).
8. **UI.** Schedule section: enabled → "{Daily|Weekly|Monthly} · Next run {date}" with "Pause" and "Change schedule"; disabled → "Schedule tracking" (`openseo:src/client/features/ai-visibility/TrackingScheduleSummary.tsx:7-69`). Picker: "Daily", "Weekly", "Monthly (end of month)"; description "Runs weekly on Mondays at 9:00 AM (03:30 UTC)" with a "change" link revealing a weekday select, a time input and "In your local timezone: {City} (UTC+5:30)"; daily shows "Daily checks use 7x more credits than weekly" (`openseo:src/client/features/rank-tracking/ScheduleField.tsx:27-152`; `scheduleTime.ts:43-106`).
9. **Tests.** "moves every due tracker on, including one whose check cannot start" and "records a skipped check for credits on the tracker without starting it" (`openseo:src/server/features/ai-visibility/services/scheduledAiVisibility.test.ts:60-85`); schedule maths (`openseo:src/shared/rank-tracking.test.ts:53-160`).

## 3. What Perceev has today

- **`scan_schedules`** (`supabase/migrations/005_analytics_platform.sql:84-96`): `brand` (primary key = workspace key), `display_name`, `cadence` (`72h | daily | weekly | off`, no CHECK), `enabled` (column default true; product default false), `engines`, `geo`, `prompt_target`, `last_run_at`, `next_run_at`; due index `scan_schedules_next_run_idx` (`:117`). Customers can read their row (`supabase/migrations/023_customer_auth_and_tenant_rls.sql:138-162`). The scan worker registers a disabled row after a brand's first scan ("scheduling is opt-in", `src/lib/workers/scanWorker.js:1367-1415`).
- **Operator route** `GET/PUT /api/brands/[brand]/schedule` (`src/app/api/brands/[brand]/schedule/route.js:1-139`) with `validateScheduleBody`, `applyInsertDefaults`, `applyNextRunAt` (`src/lib/brandAnalyticsApi.js`); operator-gated.
- **Durable windows** (`supabase/migrations/032_durable_schedule_windows.sql:4-59`): `measurement_windows` (`started | missed | overlap | blocked | finalized`, reason, job id, panel and context snapshot); `enqueue_measurement_window(brand, now)` locks the schedule, records elapsed windows as `missed` with one catch-up, records `overlap` for an active scan and `blocked reviewed_panel_required` without an approved panel, otherwise creates the scan job with the frozen panel and advances `next_run_at` in the same transaction; a trigger finalizes the window when the job ends. Steps: daily 1 day, weekly 7 days, anything else 72 hours.
- **Tick:** `runSchedulerTick` (`src/lib/workers/scanWorker.js:3308-3352`) calls `enqueue_measurement_window` for each due schedule from `listDueSchedules` (`src/lib/db/analytics.js:838`) and kicks the first chunk. It runs from `/api/scan/worker`, whose Vercel cron fires once a day at 00:00 UTC (`vercel.json`). That cannot honour weekly-at-09:00 or monthly anchors.
- **R11 policy helpers** (`src/lib/continuousMeasurement.js:1-379`): bounded catch-up, overlap policy, spend-cap blocking, soak evaluation (≥ 95 % per surface, no day below 90 %), operational health.
- **History UI:** the measurement page lists `measurement_windows` ("Scheduled opportunities", fix branch card) from `GET /api/customer/measurement` (`src/app/api/customer/measurement/route.js:20-33`).
- **P0 controls:** `claim_probe_dispatch` refuses every observation while dispatch is paused unless the job's workspace is in the one-brand allowlist (`supabase/migrations/035_scoped_provider_rollout.sql:27-32`). A scheduled scan started while paused would create a job whose every observation is blocked.
- **R11 status** (`docs/audits/2026-10-16/REPAIR-BACKLOG.md:695-745`): durable claims and bounded catch-up done; "R11.1b Keep customer scheduling opt-in; show enabled/off/paused and next due/last successful measurement separately" open; the seven-day soak (840 observations, R11-15..18) not started.
- **Must not break:** operator schedules and the daily cron path; `enqueue_measurement_window` semantics for operator rows; `measurement_windows` history and its finalize trigger; `scan_jobs_one_running_per_workspace`.

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F10-AC-01 | `computeNextRunAt` reproduces OpenSEO's results: daily/weekly step from the anchor without drift; monthly on the user's last day with the −1/0/+1 shift; a chosen time and weekday converted from an IANA timezone; default 04:00–10:00 UTC with injected randomness. | unit `src/shared/schedule.test.ts` (port of `rank-tracking.test.ts:53-160`) |
| F10-AC-02 | `planWindows(nextRunAt, interval, now)` returns `run` = the latest elapsed window, `missed` = earlier elapsed windows (one catch-up, `MAX_CATCH_UP_WINDOWS`), `next` > `now`; nothing due → `run: null`. | unit `schedule.test.ts` |
| F10-AC-03 | Migration 085 adds the customer columns with their constraints; a customer row needs an interval and an approved maximum; `enqueue_measurement_window` returns `{started:false, reason:"customer_managed"}` for customer rows; `listDueSchedules` returns only operator rows. | DB `scripts/qa/check-f10-db.mjs` group `schema`; unit `src/lib/db/analytics.test.mjs` |
| F10-AC-04 | `PUT /api/customer/schedule` with `enabled: true` is owner-only, prices through `ai_visibility.schedule.save` (`400 approval_required` without `maxUsd`, `409 price_changed`, `409 panel_not_approved` when blocked), records a `price_approvals` row (`source 'schedule'`, subject `scan_schedule`), stores `approved_max_usd`, sets `managed_by 'customer'` and computes `next_run_at`; an unchanged interval and time keep the stored slot; an operator-managed enabled row → `409 operator_schedule_active`. | route `src/lib/schedules/schedule.route.test.mjs`; DB group `save` |
| F10-AC-05 | Pausing (`enabled: false`) is allowed for members and owners, creates no windows while paused, and resuming needs a fresh approval. | route; DB group `pause` |
| F10-AC-06 | Periodic `ai_visibility.schedules` (every 300 s) enqueues one system job per 5-minute slot; the job handles at most 10 due customer schedules, oldest first; every handled schedule's `next_run_at` advances, whether its window started or was skipped. | unit `src/lib/schedules/aiVisibilitySchedules.test.ts`; DB group `tick` |
| F10-AC-07 | Each skip reason — `scheduling_disabled`, `workspace_inactive`, `dispatch_paused`, `brand_not_allowlisted`, `panel_not_approved`, `no_engines`, `over_scan_limit`, `price_changed`, `daily_capacity_reached`, `daily_cap`, `workspace_cap`, `feature_disabled` — records a `blocked` window with that reason, sets `last_skip_reason`/`last_skip_at`, advances the schedule, creates no scan job and leaves no spend hold. | unit (one case each); DB groups `skip-paused`, `skip-panel`, `skip-price` |
| F10-AC-08 | A started window creates one scan job with the approved head panel as `panel_snapshot`, `approved_max_usd` = the schedule's approval, `price_quote`, a `started` window, a `scan_job` spend hold, and one worker wake-up; a second tick for the same window or two concurrent ticks create no second job. | DB groups `start`, `race` |
| F10-AC-09 | An active scan at the window → `overlap` / `active_scan_overlap` and the schedule advances; a unique-index race on the workspace's running scan is recorded the same way. | DB group `overlap` |
| F10-AC-10 | An unexpected error while starting one schedule records `blocked start_failed`, advances it, releases its hold and does not stop the other schedules in the tick. | unit `aiVisibilitySchedules.test.ts` |
| F10-AC-11 | Scheduled scans collect in queued mode where supported: with F02 phase 4 merged and an approved DataForSEO route, a scheduled job's frozen routes for `chatgpt`, `gemini` and `aio` use `scraper_queued`/`serp_queued`; model-API engines stay live. | unit `src/lib/schedules/queuedMode.test.ts` (skipped with a named reason until F02 phase 4 exists) |
| F10-AC-12 | `GET /api/customer/schedule` returns status (`off`, `on`, `paused`, `operator`), interval, chosen time, next run, last run, last completed scheduled scan, last skip with message, approved maximum and the last 10 windows with messages; members and owners. | route |
| F10-AC-13 | Settings → Schedule shows every state in §6.6 with exact copy, the per-scan "Up to" amount, the monthly projection from the quote, the daily warning, and opens `CostReviewDialog` with `MonthlyProjection` before saving. | browser `scripts/qa/check-f10-browser.mjs` B1–B5 |
| F10-AC-14 | `NextRunBadge` on Overview and Scans shows "Next scan …", "Scheduled scans off" or the skipped variant, and nothing while loading or when the flag is off. | render test `src/components/portal/schedule/nextRunBadge.test.ts`; browser B6 |
| F10-AC-15 | `runDueSchedules` (generic) advances every item before or instead of starting it, records skips, isolates failures, and has no Perceev-scan imports, so F15 can reuse it; `src/shared/schedule.ts` imports nothing from `src/lib`. | unit `src/lib/schedules/runDue.test.ts`; import guard in `schedule.test.ts` |
| F10-AC-16 | `expectedWindows(schedule, from, to)` and `unexplainedGaps(expected, recorded)` list every scheduled opportunity and every one with no ledger row; `scripts/qa/f10-window-ledger.mjs` prints the ledger for the R11 soak. | unit `src/lib/schedules/soakLedger.test.ts` |
| F10-AC-17 | At 375 px the settings page and badges have no horizontal scroll; controls are labelled and keyboard reachable. | browser B7 |

## 5. Scope

**In scope:** shared schedule maths; generic due-runner; migration 085 (customer columns, two window functions, legacy guard); scheduler tick job; priced action `ai_visibility.schedule.save`; customer schedule routes; Settings → Schedule tab; `NextRunBadge` on Overview and Scans; soak ledger helper.

**Out of scope:**
- Operator scheduling (`/api/brands/[brand]/schedule`, cadence `72h`, the daily cron path) stays as it is for operator rows.
- Running the R11 seven-day soak, alerts (R11.3b) and incident handling (`AlertIncidentManager`): F10 provides the scheduler and ledger the soak uses; the owner runs the soak.
- Automatic baseline on first enable (OpenSEO does it): the first scan comes from F08's setup flow or "Run scan" (F09 price dialog).
- Per-engine or per-market schedules; multiple schedules per workspace (one panel, one schedule, as OpenSEO's one tracker per project).
- Scheduled reports or emails (no row covers them; "Neither" in the teardown).
- Trend comparability (Mixed): unchanged.

## 6. Design

### 6.1 Data model

#### `supabase/migrations/085_f10_customer_schedules.sql`

```sql
-- F10: customer-managed schedules on the existing scan_schedules / measurement_windows ledger. Additive.
ALTER TABLE public.scan_schedules ADD COLUMN IF NOT EXISTS managed_by text NOT NULL DEFAULT 'operator';
ALTER TABLE public.scan_schedules ADD COLUMN IF NOT EXISTS schedule_interval text;
ALTER TABLE public.scan_schedules ADD COLUMN IF NOT EXISTS schedule_time jsonb;
ALTER TABLE public.scan_schedules ADD COLUMN IF NOT EXISTS last_skip_reason text;
ALTER TABLE public.scan_schedules ADD COLUMN IF NOT EXISTS last_skip_at timestamptz;
ALTER TABLE public.scan_schedules ADD COLUMN IF NOT EXISTS approved_max_usd numeric(12,6);
ALTER TABLE public.scan_schedules ADD COLUMN IF NOT EXISTS approval_id uuid REFERENCES public.price_approvals(id) ON DELETE SET NULL;
ALTER TABLE public.scan_schedules ADD COLUMN IF NOT EXISTS customer_updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.scan_schedules ADD COLUMN IF NOT EXISTS customer_updated_at timestamptz;

ALTER TABLE public.scan_schedules DROP CONSTRAINT IF EXISTS scan_schedules_f10_checks;
ALTER TABLE public.scan_schedules ADD CONSTRAINT scan_schedules_f10_checks CHECK (
  managed_by IN ('operator','customer')
  AND (schedule_interval IS NULL OR schedule_interval IN ('daily','weekly','monthly'))
  AND (schedule_time IS NULL OR (jsonb_typeof(schedule_time) = 'object' AND pg_column_size(schedule_time) < 512))
  AND (last_skip_reason IS NULL OR last_skip_reason ~ '^[a-z_]{1,60}$')
  AND (approved_max_usd IS NULL OR approved_max_usd > 0)
  AND (managed_by = 'operator' OR (schedule_interval IS NOT NULL AND approved_max_usd IS NOT NULL)));
-- Column names managed_by and customer_updated_at are frozen: F15 and F27 read them.
COMMENT ON COLUMN public.scan_schedules.managed_by IS 'operator = legacy daily-cron path (enqueue_measurement_window); customer = F10 tick (start/block_customer_window).';
COMMENT ON COLUMN public.scan_schedules.approved_max_usd IS 'Per-scan maximum the owner approved (F09 ai_visibility.schedule.save). Becomes scan_jobs.approved_max_usd.';
COMMENT ON COLUMN public.scan_schedules.schedule_time IS 'Chosen {weekday?, hour, minute, timeZone?} for display only; next_run_at is the UTC anchor.';
CREATE INDEX IF NOT EXISTS scan_schedules_customer_due_idx ON public.scan_schedules (next_run_at)
  WHERE enabled AND managed_by = 'customer';

-- Legacy path refuses customer rows (defence in depth; listDueSchedules also filters them).
CREATE OR REPLACE FUNCTION enqueue_measurement_window(p_brand text,p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE s scan_schedules; panel repair_artifacts; due_at timestamptz; step interval; job scan_jobs; skipped integer:=0; ctx jsonb; owned_site text; owned_name text;
BEGIN
 SELECT * INTO s FROM scan_schedules WHERE brand=p_brand FOR UPDATE;
 IF FOUND AND s.managed_by='customer' THEN RETURN jsonb_build_object('started',false,'reason','customer_managed');END IF;
 IF NOT FOUND OR NOT coalesce(s.enabled,false) OR s.cadence='off' OR s.next_run_at IS NULL OR s.next_run_at>p_now THEN RETURN jsonb_build_object('started',false,'reason','not_due');END IF;
 step:=CASE s.cadence WHEN 'daily' THEN interval '1 day' WHEN 'weekly' THEN interval '7 days' ELSE interval '72 hours' END;
 due_at:=s.next_run_at;
 WHILE due_at+step<=p_now LOOP
  INSERT INTO measurement_windows(brand,window_at,disposition,reason) VALUES(p_brand,due_at,'missed','bounded_catchup_elapsed') ON CONFLICT DO NOTHING;
  due_at:=due_at+step;skipped:=skipped+1;
 END LOOP;
 IF EXISTS(SELECT 1 FROM measurement_windows WHERE brand=p_brand AND window_at=due_at) THEN RETURN jsonb_build_object('started',false,'reason','already_recorded');END IF;
 IF EXISTS(SELECT 1 FROM scan_jobs WHERE (brand_key=p_brand OR (brand_key IS NULL AND lower(brand)=lower(coalesce(s.display_name,p_brand)))) AND status IN ('pending','sourcing','probing','scoring','running')) THEN
  INSERT INTO measurement_windows(brand,window_at,disposition,reason) VALUES(p_brand,due_at,'overlap','active_scan_overlap');
  UPDATE scan_schedules SET next_run_at=due_at+step,updated_at=p_now WHERE brand=p_brand;
  RETURN jsonb_build_object('started',false,'reason','active_scan_overlap','missed',skipped);
 END IF;
 SELECT a.* INTO panel FROM repair_artifact_heads h JOIN repair_artifacts a ON a.id=h.artifact_id WHERE h.brand=p_brand AND h.kind='panel' AND h.artifact_key='default' AND a.state='approved';
 IF panel.id IS NULL THEN
  INSERT INTO measurement_windows(brand,window_at,disposition,reason) VALUES(p_brand,due_at,'blocked','reviewed_panel_required');
  UPDATE scan_schedules SET next_run_at=due_at+step,updated_at=p_now WHERE brand=p_brand;
  RETURN jsonb_build_object('started',false,'reason','reviewed_panel_required','missed',skipped);
 END IF;
 SELECT website,display_name INTO owned_site,owned_name FROM customer_brands WHERE brand_key=p_brand AND is_active;
 ctx:=coalesce(panel.payload->'context',jsonb_build_object('country',s.geo));
 INSERT INTO scan_jobs(brand,brand_key,url,status,progress_pct,heartbeat_at,panel_snapshot,measurement_context,query_source,gsc_queries)
 VALUES(coalesce(owned_name,s.display_name,p_brand),p_brand,coalesce(owned_site,'https://'||p_brand),'pending',0,p_now,to_jsonb(panel),ctx,'reviewed_panel','[]'::jsonb) RETURNING * INTO job;
 INSERT INTO measurement_windows(brand,window_at,disposition,job_id,panel_snapshot,context) VALUES(p_brand,due_at,'started',job.id,to_jsonb(panel),ctx);
 UPDATE scan_schedules SET last_run_at=p_now,next_run_at=due_at+step,updated_at=p_now WHERE brand=p_brand;
 RETURN jsonb_build_object('started',true,'job_id',job.id,'window_at',due_at,'missed',skipped);
END $$;

-- F10 start: TS has already planned the windows (run, missed, next) and passed every pre-check.
CREATE OR REPLACE FUNCTION public.start_customer_window(p_brand text, p_now timestamptz, p_observed_next timestamptz,
  p_window_at timestamptz, p_missed timestamptz[], p_next timestamptz, p_job_id uuid, p_approved_max numeric, p_quote jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s scan_schedules; panel repair_artifacts; job scan_jobs; ctx jsonb; owned_site text; owned_name text; w timestamptz;
BEGIN
  IF p_window_at IS NULL OR p_next IS NULL OR p_next <= p_window_at OR p_approved_max IS NULL OR p_approved_max <= 0
     OR p_job_id IS NULL OR (p_quote IS NOT NULL AND pg_column_size(p_quote) >= 16384) THEN
    RAISE EXCEPTION 'invalid customer window'; END IF;
  SELECT * INTO s FROM scan_schedules WHERE brand = p_brand FOR UPDATE;
  IF NOT FOUND OR s.managed_by <> 'customer' OR NOT coalesce(s.enabled, false)
     OR s.next_run_at IS DISTINCT FROM p_observed_next OR p_window_at > p_now THEN
    RETURN jsonb_build_object('started', false, 'reason', 'not_due'); END IF;
  FOREACH w IN ARRAY coalesce(p_missed, '{}'::timestamptz[]) LOOP
    INSERT INTO measurement_windows(brand, window_at, disposition, reason) VALUES (p_brand, w, 'missed', 'bounded_catchup_elapsed')
    ON CONFLICT DO NOTHING;
  END LOOP;
  IF EXISTS (SELECT 1 FROM measurement_windows WHERE brand = p_brand AND window_at = p_window_at) THEN
    UPDATE scan_schedules SET next_run_at = p_next, updated_at = p_now WHERE brand = p_brand;
    RETURN jsonb_build_object('started', false, 'reason', 'already_recorded'); END IF;
  IF EXISTS (SELECT 1 FROM scan_jobs WHERE brand_key = p_brand
             AND status IN ('pending','generating_prompts','sourcing','probing','scoring','running')) THEN
    INSERT INTO measurement_windows(brand, window_at, disposition, reason) VALUES (p_brand, p_window_at, 'overlap', 'active_scan_overlap');
    UPDATE scan_schedules SET next_run_at = p_next, last_skip_reason = 'active_scan_overlap', last_skip_at = p_now, updated_at = p_now
     WHERE brand = p_brand;
    RETURN jsonb_build_object('started', false, 'reason', 'active_scan_overlap'); END IF;
  SELECT a.* INTO panel FROM repair_artifact_heads h JOIN repair_artifacts a ON a.id = h.artifact_id
   WHERE h.brand = p_brand AND h.kind = 'panel' AND h.artifact_key = 'default' AND a.state = 'approved';
  SELECT website, display_name INTO owned_site, owned_name FROM customer_brands WHERE brand_key = p_brand AND is_active;
  IF panel.id IS NULL OR owned_site IS NULL THEN
    INSERT INTO measurement_windows(brand, window_at, disposition, reason)
      VALUES (p_brand, p_window_at, 'blocked', CASE WHEN owned_site IS NULL THEN 'workspace_inactive' ELSE 'panel_not_approved' END);
    UPDATE scan_schedules SET next_run_at = p_next, updated_at = p_now, last_skip_at = p_now,
      last_skip_reason = CASE WHEN owned_site IS NULL THEN 'workspace_inactive' ELSE 'panel_not_approved' END WHERE brand = p_brand;
    RETURN jsonb_build_object('started', false, 'reason', CASE WHEN owned_site IS NULL THEN 'workspace_inactive' ELSE 'panel_not_approved' END);
  END IF;
  ctx := coalesce(panel.payload->'context', jsonb_build_object('country', s.geo));
  INSERT INTO scan_jobs(id, brand, brand_key, url, status, progress_pct, heartbeat_at, panel_snapshot, measurement_context,
                        query_source, gsc_queries, approved_max_usd, price_quote)
  VALUES (p_job_id, owned_name, p_brand, owned_site, 'pending', 0, p_now, to_jsonb(panel), ctx,
          'reviewed_panel', '[]'::jsonb, p_approved_max, p_quote) RETURNING * INTO job;
  INSERT INTO measurement_windows(brand, window_at, disposition, job_id, panel_snapshot, context)
    VALUES (p_brand, p_window_at, 'started', job.id, to_jsonb(panel), ctx);
  UPDATE scan_schedules SET last_run_at = p_now, next_run_at = p_next, last_skip_reason = NULL, last_skip_at = NULL, updated_at = p_now
   WHERE brand = p_brand;
  RETURN jsonb_build_object('started', true, 'job_id', job.id, 'window_at', p_window_at,
    'missed', coalesce(array_length(p_missed, 1), 0));
END $$;

-- F10 skip: record the window as blocked with a closed-vocabulary reason and move the schedule on.
CREATE OR REPLACE FUNCTION public.block_customer_window(p_brand text, p_now timestamptz, p_observed_next timestamptz,
  p_window_at timestamptz, p_missed timestamptz[], p_next timestamptz, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s scan_schedules; w timestamptz;
BEGIN
  IF p_reason IS NULL OR p_reason !~ '^[a-z_]{1,60}$' OR p_next IS NULL OR p_window_at IS NULL OR p_next <= p_window_at THEN
    RAISE EXCEPTION 'invalid customer window'; END IF;
  SELECT * INTO s FROM scan_schedules WHERE brand = p_brand FOR UPDATE;
  IF NOT FOUND OR s.managed_by <> 'customer' OR NOT coalesce(s.enabled, false) OR s.next_run_at IS DISTINCT FROM p_observed_next THEN
    RETURN jsonb_build_object('blocked', false, 'reason', 'not_due'); END IF;
  FOREACH w IN ARRAY coalesce(p_missed, '{}'::timestamptz[]) LOOP
    INSERT INTO measurement_windows(brand, window_at, disposition, reason) VALUES (p_brand, w, 'missed', 'bounded_catchup_elapsed')
    ON CONFLICT DO NOTHING;
  END LOOP;
  INSERT INTO measurement_windows(brand, window_at, disposition, reason) VALUES (p_brand, p_window_at, 'blocked', p_reason)
  ON CONFLICT DO NOTHING;
  UPDATE scan_schedules SET next_run_at = p_next, last_skip_reason = p_reason, last_skip_at = p_now, updated_at = p_now
   WHERE brand = p_brand;
  RETURN jsonb_build_object('blocked', true, 'reason', p_reason);
END $$;

REVOKE ALL ON FUNCTION public.start_customer_window(text,timestamptz,timestamptz,timestamptz,timestamptz[],timestamptz,uuid,numeric,jsonb),
  public.block_customer_window(text,timestamptz,timestamptz,timestamptz,timestamptz[],timestamptz,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_customer_window(text,timestamptz,timestamptz,timestamptz,timestamptz[],timestamptz,uuid,numeric,jsonb),
  public.block_customer_window(text,timestamptz,timestamptz,timestamptz,timestamptz[],timestamptz,text) TO service_role;
REVOKE ALL ON FUNCTION enqueue_measurement_window(text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION enqueue_measurement_window(text,timestamptz) TO service_role;
NOTIFY pgrst, 'reload schema';
```

`enqueue_measurement_window` is the 032 body verbatim plus the one `customer_managed` line; `scripts/qa/check-f10-db.mjs` group `legacy` re-runs the 032 assertions from `check-repair-workflows.mjs` against operator rows to prove no other change. `scripts/setup-supabase.mjs` required objects: `"085_f10_customer_schedules.sql": [{kind:"column",name:"scan_schedules.managed_by"},{kind:"column",name:"scan_schedules.schedule_interval"},{kind:"column",name:"scan_schedules.approved_max_usd"},{kind:"column",name:"scan_schedules.last_skip_reason"},{kind:"function",name:"start_customer_window"},{kind:"function",name:"block_customer_window"}]`. Tenant RLS: `scan_schedules` and `measurement_windows` already have member-read policies; `tests/customer-uat.sql` adds one customer-managed schedule per workspace and asserts each user reads only their own. Retention: windows are the R11 ledger and are kept (risk 4).

### 6.2 Server modules

#### 6.2.1 `src/shared/schedule.ts` (PORT of `openseo:src/shared/rank-tracking.ts:151-392`, `openseo:src/types/schemas/schedule-time.ts`, pure parts of `openseo:src/client/features/rank-tracking/scheduleTime.ts`)

Shared by client and server; imports only `zod` and `./ai-visibility-pricing.ts` (F03).

```ts
export const SCHEDULE_INTERVALS = ["daily","weekly","monthly"] as const;
export type ScheduleInterval = typeof SCHEDULE_INTERVALS[number];
export const scheduleTimeSchema: z.ZodObject;  // COPY schedule-time.ts:20-37 (weekday 0-6 optional, hour 0-23, minute 0-59, timeZone IANA optional)
export type ScheduleTime = z.infer<typeof scheduleTimeSchema>;
export function computeNextRunAt(interval: ScheduleInterval, previous?: string | null, chosen?: ScheduleTime,
  deps?: { now?: () => number; random?: () => number }): string;            // PORT computeNextCheckAt :296-374
export const MAX_CATCH_UP_WINDOWS = 1;                                        // same value as continuousMeasurement.js:14
export function planWindows(nextRunAt: string, interval: ScheduleInterval, now: number):
  { run: string | null; missed: string[]; next: string };
export { scheduledChecksPerMonth } from "./ai-visibility-pricing.ts";         // F03
export function scheduleLabel(i: ScheduleInterval): "Daily" | "Weekly" | "Monthly";
export const WEEKDAYS: readonly string[];                                     // "Sunday"…"Saturday"
export function describeSchedule(i: ScheduleInterval, t: { weekday: number; hour: number; minute: number }, now?: Date): string; // COPY scheduleTime.ts:71-96, "Runs …"
export function browserTimeZoneLabel(tz?: string, now?: Date): string;       // COPY :61-69
export function formatNextRun(iso: string, locale?: string): string;         // COPY formatNextCheck :98-106
export const SKIP_REASONS: readonly string[];                                 // §6.3 table
export function skipReasonMessage(reason: string): string;                    // §6.3 table; unknown → "The scheduled scan could not start."
```

`planWindows` walks from `nextRunAt` with `computeNextRunAt(interval, anchor)` semantics: collect every window `≤ now`; `run` = the last one, `missed` = the earlier ones (at most 50 kept; older ones are dropped from the list and counted only in logs); `next` = the first window `> now`. With no window `≤ now`, `{ run: null, missed: [], next: nextRunAt }`.

#### 6.2.2 `src/lib/schedules/runDue.ts` (generic, PORT of `scheduledAiVisibility.ts:16-83` structure)

```ts
export type DueItem = { key: string; observedNextRunAt: string; interval: ScheduleInterval };
export type WindowPlan = { run: string; missed: string[]; next: string };
export type Evaluation<C> = { skip: string } | { start: C };
export async function runDueSchedules<T extends DueItem, C>(i: {
  items: T[];                                                     // already listed, oldest first
  now: number;
  evaluate(item: T, plan: WindowPlan): Promise<Evaluation<C>>;   // pre-checks only; no writes
  start(item: T, plan: WindowPlan, ctx: C): Promise<{ started: boolean; reason?: string }>;
  block(item: T, plan: WindowPlan, reason: string): Promise<void>;
  wrap?(name: string, fn: () => Promise<void>): Promise<void>;   // job step wrapper; default runs fn
  logger?: Pick<Console, "error" | "warn">;
}): Promise<{ started: number; skipped: Record<string, number>; failed: number; notDue: number }>;
```

Per item: `plan = planWindows(...)`; `run === null` → `notDue++`; else inside `wrap("window:" + key + ":" + plan.run, …)`: `evaluate` → `skip` → `block(reason)`; `start` → `start()`; any thrown error → `logger.error("[schedules] start failed", { key })` then `block(item, plan, "start_failed")` (itself guarded: a failing block is logged and counted in `failed`). Items are processed sequentially; one item's failure never stops the loop. No imports from `src/lib/workers`, `src/lib/db.js` or pricing (F15 reuse).

#### 6.2.3 `src/lib/schedules/aiVisibilitySchedules.ts` (scan adapter)

```ts
export const SCHEDULE_TICK_LIMIT = 10;
export async function listDueCustomerSchedules(admin: SupabaseClient, now: Date, limit: number): Promise<CustomerScheduleRow[]>;
  // select brand, schedule_interval, next_run_at, approved_max_usd from scan_schedules
  // where enabled and managed_by = 'customer' and next_run_at <= now order by next_run_at asc limit
export async function evaluateScheduledScan(admin: SupabaseClient, row: CustomerScheduleRow, plan: WindowPlan,
  deps?: EvaluateDeps): Promise<Evaluation<{ jobId: string; holdId: string; quote: PriceQuote }>>;
export async function startScheduledScan(admin: SupabaseClient, row, plan, c, deps?): Promise<{ started: boolean; reason?: string }>;
export async function blockScheduledScan(admin: SupabaseClient, row, plan, reason: string): Promise<void>;
export const wakeScanWorker: (jobId: string) => { fired: boolean; reason: string | null };
  // makeSelfContinue({ routePath: "/api/scan/worker", label: "customer-schedule" }) from ../selfContinue.js
```

`evaluateScheduledScan` checks, in order (first failure wins, the reason is returned as `skip`):
1. `isFeatureEnabled("customer_scheduling", brand)` false → `scheduling_disabled`.
2. `customer_brands.is_active` false → `workspace_inactive`.
3. `probe_dispatch_control` (singleton): `paused` and brand not in `brand_allowlist` → `brand_not_allowlisted` when the allowlist is non-empty, else `dispatch_paused` (mirrors `035:27-32`; no write).
4. `quote = await quote("ai_visibility.scan.run", ctx, { panelKey: "default" })` (F09): `blocked.code` ∈ `panel_not_approved | no_engines | over_scan_limit` → that code.
5. `quoteExceeds(quote.totalUsd, row.approved_max_usd)` → `price_changed` (F09 §6.2.5).
6. `b = dispatchBudget(env)`; `b.dayCap !== null` and `probeDaySpendToday(admin) + quote.totalUsd > b.dayCap` → `daily_capacity_reached`.
7. `jobId = crypto.randomUUID()`; `reserveSpend({ brandKey, feature: "ai_visibility.scan", estimateUsd: max(quote.totalUsd, 0.000001), maxUsd: row.approved_max_usd, idempotencyKey: "scan:" + jobId, ttlSeconds: 86340, subject: { kind: "scan_job", id: jobId } })`; `SpendRefused.reason` `daily_cap | workspace_cap | feature_disabled | over_approved_max` → that reason (`over_approved_max` maps to `price_changed`).
8. → `{ start: { jobId, holdId, quote } }`.

`startScheduledScan` calls `start_customer_window(brand, now, observedNext, plan.run, plan.missed, plan.next, jobId, approved_max_usd, quote)`. `started:false` → `releaseSpend(holdId, "schedule_" + reason)`; `started:true` → `wakeScanWorker(jobId)` (once). A thrown error (including unique violation `23505` on `scan_jobs_one_running_per_workspace`) → `releaseSpend(holdId, "schedule_start_failed")` then rethrow; `runDueSchedules` turns it into `block(…, "start_failed")`, except `23505`, which the adapter maps to `block(…, "active_scan_overlap")`.

`src/lib/db/analytics.js` `listDueSchedules`: adds `.eq("managed_by", "operator")` (one line), so the daily cron never sees customer rows.

#### 6.2.4 Priced action `src/lib/pricing/actions/scheduleSave.ts` (registered in `src/lib/pricing/actions/index.ts`)

```ts
export const scheduleSaveInput = z.strictObject({ panelKey: z.string().min(1).max(80).default("default"),
  scheduleInterval: z.enum(SCHEDULE_INTERVALS) });
export const scheduleSaveAction = definePricedAction({ key: "ai_visibility.schedule.save", feature: "ai_visibility.scan",
  input: scheduleSaveInput, requireApproval: true,
  estimate: (ctx, input) => estimateScanRun(ctx, { panelKey: input.panelKey, scheduleInterval: input.scheduleInterval }) });
```

The quote's `totalUsd` is the per-scan "up to" amount the owner approves; `monthly.totalUsd` = per-scan × `scheduledChecksPerMonth(interval)`; `expectedUsd` is F09's typical cost from recent answers (which reflects queued prices once F02 phase 4 runs scans). One extra warning for this action: `schedule_note` "Each scheduled scan reserves up to this amount and is charged only for answers collected."

#### 6.2.5 `src/lib/schedules/customerSchedule.ts` (route service)

```ts
export async function getCustomerSchedule(admin: SupabaseClient, ws: Workspace): Promise<CustomerScheduleView>;  // §6.5 GET shape
export async function saveCustomerSchedule(admin: SupabaseClient, ws: Workspace, body: SaveScheduleBody): Promise<CustomerScheduleView>;
export function sameSlot(row: ScanScheduleRow, interval: ScheduleInterval, time: ScheduleTime | undefined): boolean;
```

`saveCustomerSchedule` with `enabled: true`: owner only (`requireWorkspace(..., { role: "owner" })` in the route); existing row with `managed_by = 'operator'` and `enabled = true` → `AppError(409,"operator_schedule_active","Perceev support manages this workspace's schedule. Contact support to change it.")`; `requireApprovedPrice("ai_visibility.schedule.save", ctx, { panelKey: "default", scheduleInterval: interval }, maxUsd)`; `approvalId = recordApproval(admin, { brandKey, action: "ai_visibility.schedule.save", approvedMaxUsd, quote, source: "schedule", subject: { kind: "scan_schedule", id: brandKey }, approvedBy: user.id })`; `next_run_at = sameSlot(...) && row.next_run_at > now ? row.next_run_at : computeNextRunAt(interval, null, scheduleTime)`; upsert `scan_schedules` (`brand`, `display_name`, `managed_by 'customer'`, `enabled true`, `cadence = interval`, `schedule_interval`, `schedule_time`, `next_run_at`, `approved_max_usd`, `approval_id`, `last_skip_reason null`, `last_skip_at null`, `customer_updated_by`, `customer_updated_at`); `engines`, `geo` and `prompt_target` are not touched. With `enabled: false` (members and owners): `enabled = false` only; `next_run_at` and the approval are kept for display; no price check.

### 6.3 Jobs

| Kind / periodic | Trigger | Steps | Completion |
|---|---|---|---|
| periodic `ai_visibility.schedules` (300 s) | F01 `definePeriodic` | `enqueueSystemJob("ai_visibility.schedules.tick", { at }, { dedupeKey: "ai_visibility.schedules:" + floor(now/300 s), singleActiveKey: "ai_visibility.schedules" })` | — |
| `ai_visibility.schedules.tick` | system; `deadlineSeconds: 240`, `pollAfterSeconds: 20` | `list` (`DB_STEP`): `listDueCustomerSchedules(now, 10)` → `[{ key, observedNextRunAt, interval, approvedMaxUsd }]`. Then `runDueSchedules` with `wrap = (name, fn) => ctx.step.do(name, { timeoutMs: 60000, retries: 0 }, fn)`: one step per window (`window:<brand>:<runIso>`) that evaluates and starts or blocks. Retries are 0 because the step reserves spend; a failed step is caught by `runDueSchedules` and recorded as `start_failed` in a follow-up step `block:<brand>:<runIso>` (`DB_STEP`, idempotent SQL). | `completed` with `{ started, skipped, failed, notDue }`; `partial` when any `failed > 0` |

Registered in `src/lib/schedules/aiVisibilitySchedules.jobs.ts`, imported from `src/lib/jobs/kinds.ts`. The F01 tick runs every minute, so a window starts within about 5 minutes of its time (OpenSEO's cron is `*/5`). Ten schedules per tick × 12 ticks per hour bounds the start rate; each started scan runs on the existing scan worker and P0 claim path.

**Skip reasons (closed vocabulary; `src/shared/schedule.ts`):**

| Reason | Message shown to the customer |
|---|---|
| `scheduling_disabled` | "Scheduled scans are turned off for this workspace." |
| `workspace_inactive` | "This workspace is inactive." |
| `dispatch_paused` | "Answer collection is paused for maintenance." |
| `brand_not_allowlisted` | "Answer collection is limited to selected workspaces right now." |
| `panel_not_approved` | "There are no approved questions. Approve your questions to resume scheduled scans." |
| `no_engines` | "No answer engines are set up for scans yet." |
| `over_scan_limit` | "The scan is above the per-scan limit. Remove questions or contact support." |
| `price_changed` | "The scan now costs more than you approved. Review the new price to resume." |
| `daily_capacity_reached` | "Today's collection capacity was used up." |
| `daily_cap` | "Today's spend limit for this workspace was reached." |
| `workspace_cap` | "This month's spend limit for this workspace was reached." |
| `feature_disabled` | "Scans are not enabled for this workspace." |
| `active_scan_overlap` | "A scan was already running." |
| `start_failed` | "The scheduled scan could not start." |
| `bounded_catchup_elapsed` | "Missed while scheduling was unavailable." |

### 6.4 Provider calls and cost

F10 makes no provider calls. Scheduled scans run through the existing scan worker: every answer is a `probe_observations` row claimed through `claim_probe_dispatch` with the job's `approved_max_usd` as the scan cap (F09 §6.2.4), so P0 pause, allowlist, circuits and budgets apply. **Queued mode:** answer routes are frozen per scan by F02 (`resolveFrozenRoutes`, `DATAFORSEO_SCAN_MODES`: `aio` `serp_queued`, `chatgpt`/`gemini` `scraper_queued`, `perplexity`/`claude` `model_live`), so scheduled scans collect queued wherever the provider supports it, as OpenSEO's scheduled runs do. Before F02 phase 4, scans use today's routes (no queued mode exists yet). Cost per scheduled run is bounded by the approved maximum; the projection is `quote.monthly.totalUsd`.

### 6.5 API routes

Contracts in `src/lib/schedules/schedule.contract.ts`. Both verbs: `requireWorkspace`; flag `customer_scheduling` off → `AppError(404,"feature_unavailable","This page is not available for your workspace yet.")`; `toErrorResponse`; `Cache-Control: no-store`.

**`GET /api/customer/schedule?brand_key=`** (`src/app/api/customer/schedule/route.ts`; members and owners) → 200:

```json
{
  "brandKey": "offcult.in",
  "status": "on",
  "interval": "weekly",
  "scheduleTime": { "weekday": 1, "hour": 9, "minute": 0, "timeZone": "Asia/Kolkata" },
  "nextRunAt": "2026-10-27T03:30:00.000Z",
  "lastRunAt": "2026-10-20T03:31:12.000Z",
  "lastCompletedAt": "2026-10-20T03:58:40.000Z",
  "lastSkip": { "reason": "price_changed", "at": "2026-10-13T03:30:40.000Z",
                "message": "The scan now costs more than you approved. Review the new price to resume." },
  "approvedMaxUsd": 24,
  "approvedAt": "2026-10-06T10:02:00.000Z",
  "windows": [ { "windowAt": "2026-10-20T03:30:00.000Z", "disposition": "finalized", "reason": null, "message": null, "jobId": "0c2a…" },
               { "windowAt": "2026-10-13T03:30:00.000Z", "disposition": "blocked", "reason": "price_changed",
                 "message": "The scan now costs more than you approved. Review the new price to resume.", "jobId": null } ]
}
```

`status`: `off` (no row, or an operator row that is disabled), `on` (customer, enabled), `paused` (customer, disabled), `operator` (operator row, enabled; read-only for customers). `lastCompletedAt` = the latest `finalized` window's `finalized_at`. `windows` = last 10 by `window_at`. Errors: 400 `invalid_request`; 401/403/404/503 (workspace); 404 `feature_unavailable`.

**`PUT /api/customer/schedule`** body:

```ts
z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  enabled: z.boolean(),
  interval: z.enum(SCHEDULE_INTERVALS).optional(),     // required when enabled
  scheduleTime: scheduleTimeSchema.optional(),         // weekday required when interval is weekly and scheduleTime is given
  maxUsd: z.number().positive().max(1000).optional(),  // required when enabled
}).superRefine((b, ctx) => { if (b.enabled && !b.interval) ctx.addIssue({ code: "custom", path: ["interval"], message: "Choose how often to scan." }); })
```

Example `{ "enabled": true, "interval": "weekly", "scheduleTime": { "weekday": 1, "hour": 9, "minute": 0, "timeZone": "Asia/Kolkata" }, "maxUsd": 24 }` → 200 with the GET shape. Errors: 400 `invalid_request`/`approval_required`; 403 `owner_required` (enable or change); 409 `price_changed` (with `details.quote`), `panel_not_approved`, `no_engines`, `over_scan_limit`, `operator_schedule_active`; 404 `feature_unavailable`; 503 `schedule_unavailable` "The schedule could not be saved. Please retry." Idempotent: repeating the same body converges to the same row (a new approval row is recorded each time).

The F09 estimate route already serves the quote: `POST /api/customer/price/estimate { action: "ai_visibility.schedule.save", input: { scheduleInterval } }`.

### 6.6 UI

**Settings tab.** `src/components/portal/settings/tabs.ts` appends `{ href: "/portal/settings/schedule", label: "Schedule", flag: "customer_scheduling" }`. Page `src/app/portal/settings/schedule/page.tsx` renders `ScheduleSettings`. Components in `src/components/portal/schedule/`: `ScheduleSettings.tsx`, `ScheduleField.tsx` (PORT `ScheduleField.tsx`, without "Manual only"), `ScheduleSummary.tsx` (PORT `TrackingScheduleSummary.tsx`), `ScheduleHistory.tsx`, `NextRunBadge.tsx`, `hooks/useSchedule.ts` (`useQuery(keys.schedule(brandKey))`, `useSaveSchedule`). `src/lib/query/keys.ts` gains `schedule: (brandKey) => ["schedule", brandKey]`. `src/lib/features/clientFeatures.ts` appends `"customer_scheduling"`. F04 primitives: `CardShell`, `Field`, `Select`, `Input type="time"`, `Button`, `Badge`, `Alert`, `Skeleton`, `Tooltip`; F09 `CostReviewDialog`, `MonthlyProjection`, `usePriceQuote`.

**`ScheduleSettings` states** (inside `CardShell title="Scheduled scans"`, description "Scan your approved questions automatically. Each scan asks exactly the questions you approved."):

| State | Content |
|---|---|
| Loading | `Skeleton` lines (3) |
| Error | `ErrorState` "The schedule could not be loaded." + "Retry" |
| `operator` | `Alert` info "Perceev support manages this workspace's schedule. Next scan {formatNextRun(nextRunAt)}." No controls. |
| No approved panel (`GET /api/customer/questions` or the quote is blocked `panel_not_approved`) | `Alert` warning "Approve your questions before scheduling scans." + `Button` "Review questions" → `/portal/measurement`; picker disabled |
| `off` / `paused` | `ScheduleField`; under it the price block (below); primary `Button` "Turn on scheduled scans" (`paused`: "Resume scheduled scans"); members see the picker disabled and `PermissionHint` "Only the workspace owner can schedule scans." |
| `on` | `ScheduleSummary`: "{Weekly} · Next scan {Mon 27 Oct, 9:00 AM}" (muted part after the dot), `Button` outline "Pause" (members too) and "Change schedule" (owner; reveals `ScheduleField` and "Save schedule") |
| Last skip (any state with `lastSkip` newer than `lastRunAt`) | `Alert` warning "The scheduled scan on {date} did not run. {message}" + action by reason: `price_changed` → "Review price" (opens the dialog with the current interval); `panel_not_approved` → "Review questions"; `daily_cap`/`workspace_cap` → "View usage" (when `usage_page` is on) |
| Saving | buttons disabled; primary shows spinner "Saving…" |

**`ScheduleField`** (PORT): label "How often"; `Select` items "Daily", "Weekly", "Monthly (end of month)"; description `describeSchedule(...)`, e.g. "Runs weekly on Mondays at 9:00 AM (03:30 UTC)", followed by a link "change" revealing a weekday `Select` (weekly only, `aria-label="Day of week"`), `Input type="time"` (`aria-label="Time of day"`) and "In your local timezone: Kolkata (UTC+5:30)". Daily adds `Info` icon text "Daily scans cost about 7 times as much as weekly." (warning color). Default pick: weekly, weekday and time from a random 04:00–10:00 UTC slot shown in local time (`randomScheduleDate`, `scheduleTime.ts:31-41`). Props (frozen for F15 and F27): `{ value; onChange; disabled?; allowManual?: boolean /* default false; adds "Manual only" (OpenSEO `rank-tracking/ScheduleField.tsx:44-58`) */; dailyNote?: string /* default "Daily scans cost about 7 times as much as weekly." */ }`. F10 ships both optional props so F15 and F27 need no edit to this file.

**Price block** (live from `usePriceQuote({ action: "ai_visibility.schedule.save", input: { scheduleInterval } })`): "Up to **{formatUsd(totalUsd)}** per scan"; `MonthlyProjection` "**{formatUsd(monthly.totalUsd)}** estimated per month if it runs {interval}."; when `expectedUsd !== null`: muted "Typically about {formatUsd(expectedUsd)} per scan, based on recent answers."; `collection_paused` warning from the quote as `Alert` warning "Answer collection is paused for maintenance. Scheduled scans will be skipped until it resumes."; loading `Skeleton h-4 w-40`; error "The price could not be calculated." + "Retry".

**Confirm.** "Turn on scheduled scans", "Resume scheduled scans" and "Save schedule" open `CostReviewDialog` (title "Schedule scans", confirm "Approve and schedule", pending "Saving…", `detail = (q) => <MonthlyProjection monthly={q.monthly} />`, footer note "Each scheduled scan can reserve up to the approved amount. If the price rises above it, scheduled scans are skipped until you approve again."). Confirm → `PUT` with `maxUsd`; `409 price_changed` → the dialog's price-changed state (F09); success → toast "Scheduled scans are on. Next scan {formatNextRun}." Pause → `PUT { enabled: false }` → toast "Scheduled scans are paused."

**`ScheduleHistory`** (below the card, `CardShell title="Recent scheduled scans"`): rows "{date in local time}" + badge (`started` "Running" info, `finalized` "Finished" success, `blocked` "Skipped" warning, `missed` "Missed" secondary, `overlap` "Skipped" warning) + muted `message`; empty "No scheduled scans yet."

**`NextRunBadge`** (Overview header actions in `src/app/portal/page.jsx`; Scans `PageHeader` actions in `src/app/portal/scans/page.jsx`; rendered only when `features.customer_scheduling === true`): loading → nothing; `on` → `Badge` secondary with `CalendarClock` icon "Next scan {formatNextRun}" and `Tooltip` "{Weekly} · up to {formatUsd(approvedMaxUsd)} per scan"; `on` with a last skip newer than the last run → `Badge` warning "Next scan {date} · last one skipped" linking to `/portal/settings/schedule`; `operator` → "Next scan {date}"; `off`/`paused` → ghost link "Scheduled scans off" → `/portal/settings/schedule` (owners) or plain text (members). Both pages are compiled by render-harness tests (F04 rule 2), so `NextRunBadge` is added to their module maps as `autoNull`.

**Accessibility:** the select and time input have labels; the badge's link text is complete without the tooltip; the toast region is `aria-live="polite"`. **Phone:** the picker stacks; buttons full width; badges wrap under the page title; no horizontal page scroll.

### 6.7 Permissions, privacy, observability

- Enable, change and resume: owner only (recurring spend). Pause and read: members and owners. Operator rows are read-only to customers. The tick uses the service role and filters by `brand`.
- Logs: `[schedules] tick { due, started, skipped, failed }`, `[schedules] start failed { key }`, `[schedules] block failed { key }`. No panel text or prices beyond the approved amount are logged.
- PostHog (F26 names, registered when `src/lib/telemetry/events.ts` exists): `schedule:enabled { interval, approved_usd }`, `schedule:paused {}`, `schedule:changed { interval }`, `schedule:skipped { reason }` (server, from the tick).

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/shared/rank-tracking.ts:151-229, 296-392` (+ `rank-tracking.test.ts:53-160`) | `src/shared/schedule.ts` (+ `schedule.test.ts`) | PORT | `computeNextCheckAt` → `computeNextRunAt` with injectable clock and random; `planWindows` added for bounded catch-up; manual interval dropped. |
| `openseo:src/types/schemas/schedule-time.ts:1-37` | `src/shared/schedule.ts` (`scheduleTimeSchema`) | COPY | zod v4. |
| `openseo:src/server/features/ai-visibility/services/scheduledAiVisibility.ts:16-83` (+ `.test.ts:60-85`) | `src/lib/schedules/runDue.ts`, `aiVisibilitySchedules.ts` (+ tests) | PORT | Claim-and-advance moved into SQL functions that also write the R11 window ledger; credits → F09 price + F01 spend + P0 checks; answer budget → 10 schedules per tick. |
| `openseo:src/server/features/ai-visibility/repositories/AiVisibilityRepository.ts:226-243, 263-277` | `start_customer_window`/`block_customer_window` (compare on observed `next_run_at`), `listDueCustomerSchedules` | PORT | Compare-and-set kept; oldest-first ordering kept. |
| `openseo:src/server/features/ai-visibility/services/aiVisibilitySchedule.ts:14-71` | `src/lib/schedules/customerSchedule.ts` | PORT | Same "unchanged schedule keeps its slot" rule; no automatic baseline; owner-only enable with price approval. |
| `openseo:src/db/ai-visibility.schema.ts:32-43` | `085_f10_customer_schedules.sql` columns on `scan_schedules` | PORT | `schedule_interval`, `next_run_at` (existing), `last_skip_reason` (+ `last_skip_at`). |
| `openseo:src/client/features/rank-tracking/ScheduleField.tsx:27-152`, `scheduleTime.ts:1-106` | `src/components/portal/schedule/ScheduleField.tsx`, `src/shared/schedule.ts` | PORT | "Manual only" removed; "credits" copy → cost copy. |
| `openseo:src/client/features/ai-visibility/TrackingScheduleSummary.tsx:7-69` | `ScheduleSummary.tsx` | PORT | "Next run" → "Next scan"; owner gating. |

## 8. Implementation plan

### Phase 1 — Shared schedule maths and generic runner
**Goal:** pure, reusable scheduling logic with OpenSEO's tested behaviour.

- [ ] **P1.T1 Schedule maths**
  - [ ] **P1.T1.S1** *Files:* `src/shared/schedule.ts`, `src/shared/schedule.test.ts`. *Do:* §6.2.1; port `rank-tracking.test.ts:53-160` cases (monthly end-of-month, advancing past now, chosen time next occurrence, timezone with weekday, monthly on the user's last day across a UTC date change), plus `planWindows` cases (none due; one due; three elapsed → run = third, missed = first two; `next > now`), `skipReasonMessage` for every reason, and an import guard (file text has no `"../lib/"` or `"@/lib/"`). *Verify:* `node --test src/shared/schedule.test.ts` → pass (F10-AC-01, 02).
- [ ] **P1.T2 Generic runner and soak ledger**
  - [ ] **P1.T2.S1** *Files:* `src/lib/schedules/runDue.ts`, `runDue.test.ts`. *Do:* §6.2.2; fake adapters: not-due item untouched; skip → block called once; start; thrown start → block `start_failed`; failing block counted in `failed` and the next item still runs; `wrap` receives `window:<key>:<iso>`. *Verify:* `node --test src/lib/schedules/runDue.test.ts` → pass (F10-AC-15).
  - [ ] **P1.T2.S2** *Files:* `src/lib/schedules/soakLedger.ts`, `soakLedger.test.ts`, `scripts/qa/f10-window-ledger.mjs`. *Do:* `expectedWindows({ interval, anchor, from, to })` (walks `computeNextRunAt`), `unexplainedGaps(expected, recorded)` (expected windows with no `measurement_windows` row); the script (service-role read, `--brand`, `--from`, `--to`) prints one line per window `{windowAt} {disposition} {reason}` and `gaps=N`; read-only. *Verify:* `node --test src/lib/schedules/soakLedger.test.ts` → pass; `node scripts/qa/f10-window-ledger.mjs --help` exits 0 (F10-AC-16).

**Checkpoint:** `npm test`, `npm run typecheck`. ACs 01, 02, 15, 16.

### Phase 2 — Database: customer schedules and window functions
**Goal:** customer rows can be started or skipped atomically on the R11 ledger without touching operator behaviour.

- [ ] **P2.T1 Migration and paperwork**
  - [ ] **P2.T1.S1** *Files:* `supabase/migrations/085_f10_customer_schedules.sql`. *Do:* §6.1. *Verify:* CI `customer-database` → green.
  - [ ] **P2.T1.S2** *Files:* `scripts/setup-supabase.mjs`, `tests/customer-uat.sql`, `.github/workflows/ci.yml` (add `node scripts/qa/check-f10-db.mjs` after `check-repair-workflows.mjs`). *Verify:* `node --test src/lib/migrationsRunner.test.mjs` → pass.
  - [ ] **P2.T1.S3** *Files:* `README.md` (row `085_f10_customer_schedules` "Customer-managed scan schedules: interval, approved maximum, skip reasons; start/block window functions; legacy path ignores customer rows."), `docs/OPERATOR_LEDGER.md` § C (append; "apply after 080"), `docs/PROD_MIGRATIONS.md` (one bullet). *Verify:* `node --test src/lib/docStatus.test.mjs src/lib/migrationsRunner.test.mjs` → pass.
- [ ] **P2.T2 Legacy filter**
  - [ ] **P2.T2.S1** *Files:* `src/lib/db/analytics.js` (`listDueSchedules` filter), `src/lib/db/analytics.test.mjs` (new case: a recorded query includes `managed_by = operator`). *Verify:* `node --test src/lib/db/analytics.test.mjs` → pass (F10-AC-03 unit).
- [ ] **P2.T3 Database harness**
  - [ ] **P2.T3.S1** *Files:* `scripts/qa/check-f10-db.mjs` (loopback `_qa` guard; seeds a workspace with an approved `panel/default`, `probe_dispatch_control` row, F09 080 columns). Groups: `schema` (constraint rejects a customer row without interval/max; `enqueue_measurement_window` → `customer_managed`), `legacy` (032 behaviours on an operator row unchanged), `start` (job row fields, window `started`, schedule advanced, `last_skip_reason` cleared), `race` (two connections call `start_customer_window` with the same observed time → one job), `overlap` (active job → `overlap`), `skip-panel` (no approved head → `blocked panel_not_approved`), `block` (`block_customer_window` with `price_changed` → window, reason, advance; stale observed time → `not_due`), `pause` (disabled row → `not_due`, no window). *Verify:* `node scripts/qa/check-f10-db.mjs` → "ok 8 groups" (F10-AC-03, 05 DB, 07 DB, 08, 09).

**Checkpoint:** suite, typecheck, build, `check-f10-db.mjs`, `check-repair-workflows.mjs`. ACs 03, 08, 09.

### Phase 3 — Tick, priced action and routes
**Goal:** schedules run themselves and customers can manage them through the API.

- [ ] **P3.T1 Flag and action**
  - [ ] **P3.T1.S1** *Files:* `src/lib/features/names.ts` (`customer_scheduling: { spend: ["ai_visibility.scan"] }`), `.env.example` (`FEATURE_CUSTOMER_SCHEDULING=`, `FEATURE_CUSTOMER_SCHEDULING_BRANDS=`). *Verify:* `node --test src/lib/features/*.test.ts` → pass.
  - [ ] **P3.T1.S2** *Files:* `src/lib/pricing/actions/scheduleSave.ts`, `scheduleSave.test.ts`, `src/lib/pricing/actions/index.ts`. *Do:* §6.2.4; tests: requires approval; monthly 30/4/1 × per-scan; blocked panel passes through; `schedule_note` warning. *Verify:* `node --test src/lib/pricing/actions/scheduleSave.test.ts` → pass.
- [ ] **P3.T2 Scan adapter and tick job**
  - [ ] **P3.T2.S1** *Files:* `src/lib/schedules/aiVisibilitySchedules.ts`, `aiVisibilitySchedules.test.ts`. *Do:* §6.2.3 with injected `isFeatureEnabled`, dispatch control, `quote`, `dispatchBudget`, `probeDaySpendToday`, F01 spend memory store, fake rpc and fake `wakeScanWorker`. Cases: each skip reason in order (F10-AC-07), no hold left after any skip, start path (hold subject, rpc args, one wake), `started:false` releases the hold, thrown rpc → `start_failed` and hold released, `23505` → `active_scan_overlap`, ten-item limit, OpenSEO's two scheduler tests ported (advance even when the start cannot happen; a spend refusal is recorded without a job). *Verify:* `node --test src/lib/schedules/aiVisibilitySchedules.test.ts` → pass (F10-AC-06 unit, 07, 10).
  - [ ] **P3.T2.S2** *Files:* `src/lib/schedules/aiVisibilitySchedules.jobs.ts`, `src/lib/jobs/kinds.ts`. *Do:* §6.3. *Verify:* `node --test src/lib/jobs/*.test.ts` → pass; `node scripts/qa/check-f10-db.mjs --group tick` (runs the job handler once against the DB with two due rows: one started, one skipped; both advanced) → ok (F10-AC-06 DB).
  - [ ] **P3.T2.S3** *Files:* `src/lib/schedules/queuedMode.test.ts`. *Do:* when `src/lib/engines/engineRoutes.ts` exports `DATAFORSEO_SCAN_MODES` and `QUEUED_COLLECTION_READY` is true, assert modes for `chatgpt`, `gemini`, `aio` are queued and the scheduled job path calls no live-only option; otherwise `test.skip("F02 phase 4 not merged")`. *Verify:* `node --test src/lib/schedules/queuedMode.test.ts` → pass or named skip (F10-AC-11).
- [ ] **P3.T3 Routes**
  - [ ] **P3.T3.S1** *Files:* `src/app/api/customer/schedule/route.ts`, `src/lib/schedules/customerSchedule.ts`, `src/lib/schedules/schedule.contract.ts`. *Verify:* `node --test src/lib/http/routeContract.test.ts` → pass.
  - [ ] **P3.T3.S2** *Files:* `src/lib/schedules/schedule.route.test.mjs`. *Do:* GET states `off`/`on`/`paused`/`operator`, skip messages, last 10 windows; PUT enable (owner) with approval → row fields and approval `source 'schedule'`; member enable → 403 `owner_required`; member pause → 200; no `maxUsd` → 400 `approval_required`; low `maxUsd` → 409 `price_changed`; blocked panel → 409; operator-active → 409; unchanged slot kept; flag off → 404. *Verify:* `node --import ./src/lib/liveWriteGuardAuto.mjs --test src/lib/schedules/schedule.route.test.mjs` → pass (F10-AC-04, 05, 12).

**Checkpoint:** suite, typecheck, build, DB harness. ACs 04–07, 10–12.

### Phase 4 — Settings tab and next-run badges (requires F04, F05, F09 phase 3)
**Goal:** owners schedule scans and everyone sees the next one.

- [ ] **P4.T1 Hooks**
  - [ ] **P4.T1.S1** *Files:* `src/lib/query/keys.ts` (+ test), `src/components/portal/schedule/hooks/useSchedule.ts`, `src/lib/features/clientFeatures.ts`. *Verify:* `node --test src/lib/query/keys.test.ts` → pass.
- [ ] **P4.T2 Components**
  - [ ] **P4.T2.S1** *Files:* `src/components/portal/schedule/{ScheduleSettings,ScheduleField,ScheduleSummary,ScheduleHistory}.tsx`, `src/app/portal/settings/schedule/page.tsx`, `src/components/portal/settings/tabs.ts`. *Do:* §6.6 with exact copy. *Verify:* `npm run build` → exit 0.
  - [ ] **P4.T2.S2** *Files:* `src/components/portal/schedule/NextRunBadge.tsx`, `nextRunBadge.test.ts` (render harness: each state's text; nothing when flag off), `src/app/portal/page.jsx`, `src/app/portal/scans/page.jsx`, `src/components/portal/portalRegressions.test.mjs` and `src/components/portal/portalProgress.test.mjs` (add `@/components/portal/schedule/NextRunBadge` to their module maps as `autoNull`). *Verify:* `node --test src/components/portal/schedule/nextRunBadge.test.ts src/components/portal/portalRegressions.test.mjs` → pass (F10-AC-14).
- [ ] **P4.T3 Browser**
  - [ ] **P4.T3.S1** *Files:* `scripts/qa/check-f10-browser.mjs` (fixture APIs). Scenarios: B1 `off` → pick weekly Monday 09:00 → price block shows per-scan and monthly → dialog → saved toast; B2 daily warning visible; B3 `on` → Pause → `paused` state; B4 last skip `price_changed` → "Review price" opens the dialog; B5 member view: picker disabled with the permission hint, Pause enabled; B6 Overview and Scans badges for `on`, skipped and `off`; B7 375 px: no horizontal scroll; keyboard reaches select, time input and buttons. *Verify:* `node scripts/qa/check-f10-browser.mjs` → "ok 7 scenarios" (F10-AC-13, 14, 17).

**Checkpoint:** build, suite, browser script. ACs 13, 14, 17.

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `src/shared/schedule.test.ts` | ported schedule maths, `planWindows`, messages, import guard | 01, 02, 15 |
| `src/lib/schedules/runDue.test.ts` | generic runner semantics | 15 |
| `src/lib/schedules/soakLedger.test.ts` | expected windows, gaps | 16 |
| `src/lib/db/analytics.test.mjs` (new case) | legacy filter | 03 |
| `src/lib/pricing/actions/scheduleSave.test.ts` | quote, approval required | 04 |
| `src/lib/schedules/aiVisibilitySchedules.test.ts` | skip order, holds, start, failures, limit | 06, 07, 10 |
| `src/lib/schedules/queuedMode.test.ts` | queued routes for scheduled scans | 11 |
| `src/lib/schedules/schedule.route.test.mjs` | GET/PUT, roles, prices, flag | 04, 05, 12 |
| `src/components/portal/schedule/nextRunBadge.test.ts` | badge states | 14 |
| `scripts/qa/check-f10-db.mjs` | schema, legacy, start, race, overlap, skip-panel, block, pause, tick | 03, 05, 06, 07, 08, 09 |
| `scripts/qa/check-f10-browser.mjs` | B1–B7 | 13, 14, 17 |

Fixtures: `tests/fixtures/f10/schedules.json` (customer and operator rows, windows of every disposition), `tests/fixtures/f10/quote-weekly.json` (an F09 quote with `monthly`). Synthetic; no provider calls anywhere in F10 tests.

## 10. Rollout and rollback

- **Env (names only):** `FEATURE_CUSTOMER_SCHEDULING`, `FEATURE_CUSTOMER_SCHEDULING_BRANDS`.
- **Defaults:** off in production. The tick job runs only when F01's `jobs_tick` is on; it touches only `managed_by = 'customer'` rows, and there are none until an owner saves a schedule.
- **Migration order:** 085 after F09's 080 (the `approval_id` foreign key). Additive.
- **R11 seven-day soak (required before customers):** R11 acceptance needs seven real elapsed days, ≥ 95 % valid observations per surface, no day below 90 % and no unexplained missing window (`REPAIR-BACKLOG.md:715-745`, R11-15..18). Steps for the owner: (1) set `FEATURE_CUSTOMER_SCHEDULING=allowlist` with only the owned QA workspace; (2) with the owner's explicit approval, allow that workspace through P0 (`set_probe_rollout(true, true, array['<qa key>'])`, as in the 20 October handoff; never `set_probe_rollout(false, …)`); (3) save a daily schedule with an approved maximum; (4) after seven days run `node scripts/qa/f10-window-ledger.mjs --brand <qa key> --from <start> --to <end>` (gaps must be 0) and `node scripts/qa/run-repair.mjs --repair R11 --suite soak --environment qa --days 7`; (5) record the result in the P0 qualification record; (6) only then widen the flag. Turning a schedule on does not close R11.
- **Turn off:** set the flag `off` (every due window is skipped with `scheduling_disabled` and the schedule advances, so the ledger stays complete); to stop the tick entirely, disable `jobs_tick` (F01). Owners can pause.
- **Rollback:** revert the application change; customer rows remain and the legacy path ignores them (`customer_managed`). To hand a workspace back to operators: `update scan_schedules set managed_by = 'operator', enabled = false, schedule_interval = null, approved_max_usd = null where brand = '<key>';`.

## 11. Risks and open questions

| # | Risk / question | Default chosen |
|---|---|---|
| 1 | The tick depends on F01's pg_cron minute tick; if it stops, windows pile up. | Bounded catch-up records `missed` windows on recovery; the ledger script shows gaps; R11.3b alerting stays an R11 task. |
| 2 | A schedule approved at one price is skipped after the panel grows (more questions, higher quote). | Intended (F09 contract): `price_changed` skip with "Review price"; the schedule keeps advancing. |
| 3 | While P0 dispatch is paused, every scheduled window is skipped. | Intended: no job is created whose observations would all be blocked; the reason is visible. |
| 4 | `measurement_windows` grows by one row per window with no retention. | Keep: it is the R11 evidence ledger (≤ 365 rows per daily workspace per year). Revisit with R11 release. |
| 5 | Members cannot turn schedules on. | Owner-only for recurring spend; members can pause. Revisit with the Teams Mixed row. |
| 6 | No automatic baseline on first enable (OpenSEO starts one). | F08's setup offers a priced first scan; Overview offers "Run scan". |
| 7 | Monthly runs on the user's last day of the month; a 28-day February shortens the gap. | Same as OpenSEO; projection uses 1 run per month. |
| 8 | Queued mode depends on F02 phase 4 and the bake-off decision. | Until then scheduled scans use today's routes; the projection uses the reservation amount, so it never under-states. |

**Deviations from conventions:** (a) `enqueue_measurement_window` (migration 032, an R11 function) is redefined in 085 with one added guard line; its behaviour for operator rows is unchanged and re-tested (group `legacy`). (b) Customer schedules live on the existing `scan_schedules` table, whose key column is `brand` (not `brand_key`) and which has no foreign key to `customer_brands`; the SQL functions check `customer_brands.is_active` instead, and the existing member-read policy applies.

## 12. Definition of done

- [ ] Phases 1–4 merged; every subtask ticked.
- [ ] F10-AC-01..17 covered by passing tests in §9.
- [ ] `npm test`, `npm run typecheck`, `npm run build`, `check-f10-db.mjs`, `check-repair-workflows.mjs`, `check-f10-browser.mjs` green.
- [ ] Migration paperwork (README, OPERATOR_LEDGER § C, PROD_MIGRATIONS) and `THIRD_PARTY_NOTICES.md` updated.
- [ ] `features/README.md` F10 status updated.
- [ ] R11 soak result recorded before the flag is widened beyond the QA workspace (owner).
