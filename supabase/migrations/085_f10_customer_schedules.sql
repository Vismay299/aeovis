-- Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
--   src/db/ai-visibility.schema.ts, src/server/features/ai-visibility/repositories/AiVisibilityRepository.ts
-- Modified for Perceev. See THIRD_PARTY_NOTICES.md.

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
-- Every missed window must lie in [p_observed_next, p_window_at); the job's cap may not exceed the
-- schedule's current approval (a cap lowered after the tick read the row reads as a stale plan).
CREATE OR REPLACE FUNCTION public.start_customer_window(p_brand text, p_now timestamptz, p_observed_next timestamptz,
  p_window_at timestamptz, p_missed timestamptz[], p_next timestamptz, p_job_id uuid, p_approved_max numeric, p_quote jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s scan_schedules; panel repair_artifacts; job scan_jobs; ctx jsonb; owned_site text; owned_name text; w timestamptz;
  missed_n integer := 0; skip_reason text;
BEGIN
  IF p_window_at IS NULL OR p_next IS NULL OR p_next <= p_window_at OR p_approved_max IS NULL OR p_approved_max <= 0
     OR p_job_id IS NULL OR (p_quote IS NOT NULL AND pg_column_size(p_quote) >= 16384) THEN
    RAISE EXCEPTION 'invalid customer window'; END IF;
  FOREACH w IN ARRAY coalesce(p_missed, '{}'::timestamptz[]) LOOP
    IF w IS NULL OR w >= p_window_at OR p_observed_next IS NULL OR w < p_observed_next THEN
      RAISE EXCEPTION 'invalid customer window'; END IF;
  END LOOP;
  SELECT * INTO s FROM scan_schedules WHERE brand = p_brand FOR UPDATE;
  IF NOT FOUND OR s.managed_by <> 'customer' OR NOT coalesce(s.enabled, false)
     OR s.next_run_at IS DISTINCT FROM p_observed_next OR p_window_at > p_now
     OR s.approved_max_usd IS NULL OR p_approved_max > s.approved_max_usd THEN
    RETURN jsonb_build_object('started', false, 'reason', 'not_due'); END IF;
  FOREACH w IN ARRAY coalesce(p_missed, '{}'::timestamptz[]) LOOP
    INSERT INTO measurement_windows(brand, window_at, disposition, reason) VALUES (p_brand, w, 'missed', 'bounded_catchup_elapsed')
    ON CONFLICT DO NOTHING;
    IF FOUND THEN missed_n := missed_n + 1; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM measurement_windows WHERE brand = p_brand AND window_at = p_window_at) THEN
    UPDATE scan_schedules SET next_run_at = p_next, updated_at = p_now WHERE brand = p_brand;
    RETURN jsonb_build_object('started', false, 'reason', 'already_recorded'); END IF;
  SELECT website, display_name INTO owned_site, owned_name FROM customer_brands WHERE brand_key = p_brand AND is_active;
  -- Same overlap rule as the legacy path: a NULL-brand_key job for this site counts too.
  IF EXISTS (SELECT 1 FROM scan_jobs
             WHERE (brand_key = p_brand
                    OR (brand_key IS NULL AND lower(brand) = lower(coalesce(owned_name, s.display_name, p_brand))))
               AND status IN ('pending','generating_prompts','sourcing','probing','scoring','running')) THEN
    INSERT INTO measurement_windows(brand, window_at, disposition, reason) VALUES (p_brand, p_window_at, 'overlap', 'active_scan_overlap');
    UPDATE scan_schedules SET next_run_at = p_next, last_skip_reason = 'active_scan_overlap', last_skip_at = p_now, updated_at = p_now
     WHERE brand = p_brand;
    RETURN jsonb_build_object('started', false, 'reason', 'active_scan_overlap'); END IF;
  SELECT a.* INTO panel FROM repair_artifact_heads h JOIN repair_artifacts a ON a.id = h.artifact_id
   WHERE h.brand = p_brand AND h.kind = 'panel' AND h.artifact_key = 'default' AND a.state = 'approved';
  IF panel.id IS NULL OR owned_site IS NULL THEN
    skip_reason := CASE WHEN owned_site IS NULL THEN 'workspace_inactive' ELSE 'panel_not_approved' END;
    INSERT INTO measurement_windows(brand, window_at, disposition, reason) VALUES (p_brand, p_window_at, 'blocked', skip_reason);
    UPDATE scan_schedules SET next_run_at = p_next, updated_at = p_now, last_skip_at = p_now, last_skip_reason = skip_reason
     WHERE brand = p_brand;
    RETURN jsonb_build_object('started', false, 'reason', skip_reason);
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
  RETURN jsonb_build_object('started', true, 'job_id', job.id, 'window_at', p_window_at, 'missed', missed_n);
END $$;

-- F10 skip: record the window as blocked with a closed-vocabulary reason and move the schedule on.
-- Same due and missed-window rules as start; a window already in the ledger is not re-reported as blocked.
CREATE OR REPLACE FUNCTION public.block_customer_window(p_brand text, p_now timestamptz, p_observed_next timestamptz,
  p_window_at timestamptz, p_missed timestamptz[], p_next timestamptz, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s scan_schedules; w timestamptz;
BEGIN
  IF p_reason IS NULL OR p_reason !~ '^[a-z_]{1,60}$' OR p_next IS NULL OR p_window_at IS NULL OR p_next <= p_window_at THEN
    RAISE EXCEPTION 'invalid customer window'; END IF;
  FOREACH w IN ARRAY coalesce(p_missed, '{}'::timestamptz[]) LOOP
    IF w IS NULL OR w >= p_window_at OR p_observed_next IS NULL OR w < p_observed_next THEN
      RAISE EXCEPTION 'invalid customer window'; END IF;
  END LOOP;
  SELECT * INTO s FROM scan_schedules WHERE brand = p_brand FOR UPDATE;
  IF NOT FOUND OR s.managed_by <> 'customer' OR NOT coalesce(s.enabled, false)
     OR s.next_run_at IS DISTINCT FROM p_observed_next OR p_window_at > p_now THEN
    RETURN jsonb_build_object('blocked', false, 'reason', 'not_due'); END IF;
  FOREACH w IN ARRAY coalesce(p_missed, '{}'::timestamptz[]) LOOP
    INSERT INTO measurement_windows(brand, window_at, disposition, reason) VALUES (p_brand, w, 'missed', 'bounded_catchup_elapsed')
    ON CONFLICT DO NOTHING;
  END LOOP;
  IF EXISTS (SELECT 1 FROM measurement_windows WHERE brand = p_brand AND window_at = p_window_at) THEN
    UPDATE scan_schedules SET next_run_at = p_next, updated_at = p_now WHERE brand = p_brand;
    RETURN jsonb_build_object('blocked', false, 'reason', 'already_recorded'); END IF;
  INSERT INTO measurement_windows(brand, window_at, disposition, reason) VALUES (p_brand, p_window_at, 'blocked', p_reason);
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
