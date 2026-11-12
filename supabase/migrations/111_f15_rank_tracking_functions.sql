-- Portions ported from every-app/open-seo@c5f8db19c7ca9e750836b6ed5c8a6491d4f967f4 (MIT, © 2026 Ben Senescu).
-- Modified for Perceev; see THIRD_PARTY_NOTICES.md.
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
           r.metrics_fetched_at, r.metrics_source, e.ord
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(item, ord)
      CROSS JOIN LATERAL jsonb_to_record(e.item) AS r(keyword text, match_case boolean, search_volume integer,
           keyword_difficulty smallint, cpc numeric, metrics_fetched_at timestamptz, metrics_source text)
     ORDER BY e.ord LIMIT 1000 - v_count
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
RETURNS TABLE (tracking_keyword_id uuid, device text, run_id uuid, keyword text, "position" integer, url text,
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
RETURNS TABLE (tracking_keyword_id uuid, device text, "position" integer, checked_at timestamptz)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT DISTINCT ON (s.tracking_keyword_id, s.device) s.tracking_keyword_id, s.device, s.position, s.checked_at
    FROM rank_snapshots s JOIN rank_check_runs r ON r.id = s.run_id
   WHERE r.config_id = p_config AND r.brand_key = p_brand AND r.status = 'completed'
     AND s.tracking_keyword_id = ANY (p_keyword_ids)
   ORDER BY s.tracking_keyword_id, s.device, s.checked_at ASC, s.id ASC
$$;

-- Best position per keyword on any device in completed runs (port of snapshotQueries.ts:37-46).
CREATE OR REPLACE FUNCTION public.rank_best_positions(p_brand text, p_config uuid)
RETURNS TABLE (tracking_keyword_id uuid, "position" integer)
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
    FROM rank_check_runs r
    LEFT JOIN rank_snapshots s ON s.run_id = r.id AND s.device = p_device AND s.brand_key = p_brand
   WHERE r.config_id = p_config AND r.brand_key = p_brand AND r.status = 'completed'
     AND NOT r.is_subset_run AND r.started_at >= p_since
   GROUP BY r.id, r.started_at, r.keywords_total
   ORDER BY r.started_at ASC
$$;

-- Last p_run_limit full completed runs, one cell per keyword (port of snapshotQueries.ts:124-158).
CREATE OR REPLACE FUNCTION public.rank_position_matrix(p_brand text, p_config uuid, p_device text, p_run_limit integer)
RETURNS TABLE (run_id uuid, checked_at timestamptz, tracking_keyword_id uuid, "position" integer)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH recent AS (
    SELECT id, started_at FROM rank_check_runs
     WHERE config_id = p_config AND brand_key = p_brand AND status = 'completed' AND NOT is_subset_run
     ORDER BY started_at DESC LIMIT greatest(1, least(p_run_limit, 26))
  ), run_keywords AS (
    SELECT recent.id, recent.started_at, keyword_ids.tracking_keyword_id
      FROM recent
      LEFT JOIN LATERAL (
        SELECT DISTINCT s.tracking_keyword_id
          FROM rank_snapshots s
         WHERE s.run_id = recent.id AND s.brand_key = p_brand
      ) AS keyword_ids ON true
  )
  SELECT run_keywords.id, run_keywords.started_at, run_keywords.tracking_keyword_id, s.position
    FROM run_keywords
    LEFT JOIN rank_snapshots s
      ON s.run_id = run_keywords.id AND s.brand_key = p_brand AND s.device = p_device
     AND s.tracking_keyword_id = run_keywords.tracking_keyword_id
   ORDER BY run_keywords.started_at ASC, run_keywords.tracking_keyword_id
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
