-- One locked publication point for all report projections. A failure rolls all back.
CREATE OR REPLACE FUNCTION materialize_scan_report(p_job uuid,p_scan uuid,p_citations jsonb,p_brands jsonb,p_metrics jsonb,p_record jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE job scan_jobs; r jsonb; m brand_metrics_daily;
BEGIN
 SELECT * INTO job FROM scan_jobs WHERE id=p_job FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM scans WHERE id=p_scan AND origin_job_id=p_job) THEN RAISE EXCEPTION 'report identity mismatch';END IF;
 IF job.status='complete' THEN
  IF job.result_id IS DISTINCT FROM p_scan THEN RAISE EXCEPTION 'report already finalized with another identity';END IF;
  RETURN to_jsonb(job);
 END IF;
 IF job.status<>'scoring' THEN RAISE EXCEPTION 'job not finalizing';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_citations) x WHERE (x->>'job_id')::uuid IS DISTINCT FROM p_job OR (x->>'scan_id')::uuid IS DISTINCT FROM p_scan OR NOT EXISTS(SELECT 1 FROM prompt_results p WHERE p.id=(x->>'result_id')::uuid AND p.job_id=p_job))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_brands) x WHERE (x->>'scan_id')::uuid IS DISTINCT FROM p_scan OR NOT EXISTS(SELECT 1 FROM prompt_results p WHERE p.id=(x->>'result_id')::uuid AND p.job_id=p_job)) THEN RAISE EXCEPTION 'foreign materialization row';END IF;
 UPDATE scans SET raw_results=p_record,visibility_pct=(p_record->>'visibility_pct')::numeric,
  prompts_tracked=(p_record->>'prompts_tracked')::integer,prompts_mentioned=(p_record->>'prompts_mentioned')::integer,
  scoring_version=p_record->>'scoring_version',score_ci_low=(p_record->>'score_ci_low')::numeric,score_ci_high=(p_record->>'score_ci_high')::numeric,
  mention_rate_pct=(p_record->>'mention_rate_pct')::numeric WHERE id=p_scan;
 UPDATE prompt_results SET scan_id=p_scan WHERE job_id=p_job;
 DELETE FROM citations WHERE job_id=p_job;
 INSERT INTO citations SELECT (jsonb_populate_record(NULL::citations,x||jsonb_build_object('id',gen_random_uuid(),'created_at',now()))).* FROM jsonb_array_elements(p_citations) x;
 DELETE FROM result_brands WHERE result_id IN (SELECT id FROM prompt_results WHERE job_id=p_job);
 INSERT INTO result_brands SELECT (jsonb_populate_record(NULL::result_brands,x||jsonb_build_object('id',gen_random_uuid()))).* FROM jsonb_array_elements(p_brands) x;
 FOR r IN SELECT value FROM jsonb_array_elements(p_metrics) LOOP
  m:=jsonb_populate_record(NULL::brand_metrics_daily,r);
  IF m.scan_id IS DISTINCT FROM p_scan THEN RAISE EXCEPTION 'foreign rollup';END IF;
  INSERT INTO brand_metrics_daily SELECT m.* ON CONFLICT(brand,date,engine) DO UPDATE SET
   visibility_pct=excluded.visibility_pct,sov_pct=excluded.sov_pct,sentiment_avg=excluded.sentiment_avg,position_avg=excluded.position_avg,
   citation_share_pct=excluded.citation_share_pct,prompts_total=excluded.prompts_total,prompts_answered=excluded.prompts_answered,
   prompts_mentioned=excluded.prompts_mentioned,scan_id=excluded.scan_id,prompt_set_id=excluded.prompt_set_id,sov_state=excluded.sov_state,
   sov_state_reason=excluded.sov_state_reason,citation_denominator=excluded.citation_denominator,citation_state=excluded.citation_state,citation_state_reason=excluded.citation_state_reason;
 END LOOP;
 UPDATE scan_jobs SET status='complete',progress_pct=100,result_id=p_scan,run_record=p_record,heartbeat_at=now() WHERE id=p_job RETURNING * INTO job;
 RETURN to_jsonb(job);
END $$;
REVOKE ALL ON FUNCTION materialize_scan_report(uuid,uuid,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION materialize_scan_report(uuid,uuid,jsonb,jsonb,jsonb,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
