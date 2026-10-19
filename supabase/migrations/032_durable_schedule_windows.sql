-- Scheduled opportunity and job enqueue commit together. Legacy rows remain readable.
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS panel_snapshot jsonb;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS measurement_context jsonb;
CREATE TABLE IF NOT EXISTS measurement_windows (
 brand text NOT NULL REFERENCES scan_schedules(brand),window_at timestamptz NOT NULL,
 disposition text NOT NULL CHECK(disposition IN ('started','missed','overlap','blocked','finalized')),
 reason text,job_id uuid UNIQUE REFERENCES scan_jobs(id),panel_snapshot jsonb,context jsonb,
 recorded_at timestamptz NOT NULL DEFAULT now(),finalized_at timestamptz,outcome jsonb,
 PRIMARY KEY(brand,window_at)
);
ALTER TABLE measurement_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON measurement_windows FROM PUBLIC,anon,authenticated;
GRANT SELECT ON measurement_windows TO authenticated;
GRANT ALL ON measurement_windows TO service_role;
DROP POLICY IF EXISTS measurement_windows_customer_read ON measurement_windows;
CREATE POLICY measurement_windows_customer_read ON measurement_windows FOR SELECT TO authenticated USING(customer_can_access_brand(brand));
CREATE OR REPLACE FUNCTION enqueue_measurement_window(p_brand text,p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE s scan_schedules; panel repair_artifacts; due_at timestamptz; step interval; job scan_jobs; skipped integer:=0; ctx jsonb; owned_site text; owned_name text;
BEGIN
 SELECT * INTO s FROM scan_schedules WHERE brand=p_brand FOR UPDATE;
 IF NOT FOUND OR NOT coalesce(s.enabled,false) OR s.cadence='off' OR s.next_run_at IS NULL OR s.next_run_at>p_now THEN RETURN jsonb_build_object('started',false,'reason','not_due');END IF;
 step:=CASE s.cadence WHEN 'daily' THEN interval '1 day' WHEN 'weekly' THEN interval '7 days' ELSE interval '72 hours' END;
 -- Record elapsed opportunities with one catch-up, never a dispatch storm.
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
REVOKE ALL ON FUNCTION enqueue_measurement_window(text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION enqueue_measurement_window(text,timestamptz) TO service_role;
CREATE OR REPLACE FUNCTION finish_measurement_window() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF NEW.status IN ('complete','failed','cancelled') AND OLD.status IS DISTINCT FROM NEW.status THEN
 UPDATE measurement_windows SET disposition='finalized',finalized_at=now(),outcome=coalesce(NEW.run_record->'summary_stats'->'terminal_outcome',jsonb_build_object('execution_status',NEW.status,'reason',NEW.error_message)) WHERE job_id=NEW.id AND disposition='started';
 END IF;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS measurement_window_finished ON scan_jobs;
CREATE TRIGGER measurement_window_finished AFTER UPDATE ON scan_jobs FOR EACH ROW EXECUTE FUNCTION finish_measurement_window();
NOTIFY pgrst,'reload schema';
