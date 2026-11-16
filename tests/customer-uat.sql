-- Run against a disposable PostgreSQL database with migrations 001-026 and
-- Supabase-compatible auth/storage schemas. Never run against customer data.
BEGIN;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('00000000-0000-0000-0000-000000000001','owner-a@example.test',now()),
 ('00000000-0000-0000-0000-000000000002','owner-b@example.test',now()),
 ('00000000-0000-0000-0000-000000000003','invitee@example.test',now());
SELECT public.create_customer_workspace('10000000-0000-0000-0000-000000000001','%', 'https://same.example','same.example',
 '00000000-0000-0000-0000-000000000001','same-request',ARRAY['same.example','%']);
SELECT public.create_customer_workspace('10000000-0000-0000-0000-000000000002','%', 'https://same.example','same.example',
 '00000000-0000-0000-0000-000000000002','same-request',ARRAY['same.example','%']);
-- The migration runner re-applies files. Overlapping workspace metadata must
-- remain safe on a subsequent run, and grants must be restored by 026.
\ir ../supabase/migrations/023_customer_auth_and_tenant_rls.sql
\ir ../supabase/migrations/024_customer_workspace_ownership.sql
\ir ../supabase/migrations/025_gsc_customer_oauth.sql
\ir ../supabase/migrations/026_customer_uat_repairs.sql
-- 023's blanket REVOKE strips authenticated's later grants, so the re-apply
-- finishes with 040, 041, 043 and 070 exactly as the runner's filename order
-- does.
\ir ../supabase/migrations/040_f01_jobs.sql
\ir ../supabase/migrations/041_f01_spend.sql
\ir ../supabase/migrations/043_f01_jobs_cron.sql
\ir ../supabase/migrations/065_f06_exports.sql
\ir ../supabase/migrations/066_f06_scan_history_columns.sql
\ir ../supabase/migrations/070_f07_project_memory.sql
\ir ../supabase/migrations/075_f08_workspace_questions.sql
\ir ../supabase/migrations/076_f08_question_backfill.sql
\ir ../supabase/migrations/080_f09_price_approvals.sql
\ir ../supabase/migrations/085_f10_customer_schedules.sql
\ir ../supabase/migrations/095_f12_question_answer_links.sql
\ir ../supabase/migrations/100_f13_saved_keywords.sql
\ir ../supabase/migrations/102_f13_saved_keyword_functions.sql
\ir ../supabase/migrations/110_f15_rank_tracking.sql
\ir ../supabase/migrations/111_f15_rank_tracking_functions.sql
\ir ../supabase/migrations/112_f15_rank_keyword_questions.sql
\ir ../supabase/migrations/120_f17_local_seo.sql
\ir ../supabase/migrations/121_f17_local_seo_functions.sql
\ir ../supabase/migrations/125_f18_site_audit.sql
\ir ../supabase/migrations/126_f18_site_audit_functions.sql
\ir ../supabase/migrations/130_f19_indexnow.sql
\ir ../supabase/migrations/135_f20_ga4.sql
\ir ../supabase/migrations/136_f20_ga4_functions.sql
\ir ../supabase/migrations/160_f25_email_tables.sql
\ir ../supabase/migrations/161_f25_email_functions.sql
\ir ../supabase/migrations/165_f26_privacy_and_telemetry_ids.sql
\ir ../supabase/migrations/170_f27_onboarding.sql
\ir ../supabase/migrations/145_f22_assistant_sessions.sql
\ir ../supabase/migrations/146_f22_assistant_stream_chunks.sql
\ir ../supabase/migrations/147_f22_assistant_approvals.sql
\ir ../supabase/migrations/148_f22_gsc_query_summary.sql
\ir ../supabase/migrations/149_f22_assistant_milestone_fix.sql
DO $$ BEGIN
 IF (SELECT count(*) FROM public.customer_brands) <> 2 THEN RAISE EXCEPTION 'Idempotency keys must be scoped to each user'; END IF;
 IF public.create_customer_workspace('retry','%', 'https://same.example','same.example',
  '00000000-0000-0000-0000-000000000001','same-request',ARRAY[]::text[])->>'brand_key'
  <> '10000000-0000-0000-0000-000000000001' THEN RAISE EXCEPTION 'Workspace retry failed'; END IF;
 IF EXISTS(SELECT 1 FROM public.gsc_connections WHERE brand='legacy-operator.example' AND brand_key IS NOT NULL)
  THEN RAISE EXCEPTION 'Legacy connections were assigned automatically'; END IF;
END $$;
INSERT INTO public.scans(brand,url,brand_key) VALUES
 ('%','https://same.example','10000000-0000-0000-0000-000000000001'),
 ('%','https://same.example','10000000-0000-0000-0000-000000000002'),
 ('%','https://same.example',NULL);
INSERT INTO public.scan_jobs(brand,url,brand_key,status) VALUES
 ('%','https://same.example','10000000-0000-0000-0000-000000000001','pending'),
 ('%','https://same.example','10000000-0000-0000-0000-000000000002','pending');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.scans) <> 1 OR (SELECT count(*) FROM public.scan_jobs) <> 1
  THEN RAISE EXCEPTION 'Scan ownership leaked across tenants'; END IF;
 IF NOT public.customer_can_access_brand('10000000-0000-0000-0000-000000000001')
  OR public.customer_can_access_brand('same.example') OR public.customer_can_access_scan('%','https://same.example')
  THEN RAISE EXCEPTION 'Brand predicate must use workspace keys'; END IF;
END $$;
RESET ROLE;
INSERT INTO public.customer_team_invites(brand_key,email,invited_by) VALUES
 ('10000000-0000-0000-0000-000000000001','invitee@example.test','00000000-0000-0000-0000-000000000001');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $$ BEGIN
 IF public.accept_customer_team_invites() <> 0 THEN RAISE EXCEPTION 'Another email redeemed an invite'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',true);
DO $$ BEGIN
 IF public.accept_customer_team_invites() <> 1 OR public.accept_customer_team_invites() <> 0
  THEN RAISE EXCEPTION 'Invite redemption is not scoped and idempotent'; END IF;
 IF NOT public.customer_can_access_brand('10000000-0000-0000-0000-000000000001')
  THEN RAISE EXCEPTION 'Invite did not grant workspace membership'; END IF;
END $$;
RESET ROLE;
INSERT INTO public.gsc_oauth_attempts(id,user_id,brand_key,state_hash,consumed_at,encrypted_pending_grant) VALUES
 ('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001','test-state',now(),
  '{"encrypted_refresh_token":"TEST CIPHERTEXT","encrypted_access_token":"TEST CIPHERTEXT","access_token_expires_at":"2099-01-01T00:00:00Z"}');
SET LOCAL ROLE service_role;
DO $$ BEGIN
 IF public.activate_customer_gsc('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001','sc-domain:same.example','siteOwner') <> 1
  THEN RAISE EXCEPTION 'Initial activation failed'; END IF;
END $$;
SELECT public.write_gsc_generation('10000000-0000-0000-0000-000000000001',1,
 '[{"date":"2026-09-01","query":"shared query","clicks":1,"impressions":10,"ctr":0.1,"position":2,"ingested_at":"2026-09-04T00:00:00Z"}]');
RESET ROLE;
INSERT INTO public.gsc_oauth_attempts(id,user_id,brand_key,state_hash,consumed_at,encrypted_pending_grant) VALUES
 ('20000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001','test-state-2',now(),
  '{"encrypted_refresh_token":"REPLACEMENT CIPHERTEXT","encrypted_access_token":"REPLACEMENT CIPHERTEXT","access_token_expires_at":"2099-01-01T00:00:00Z"}');
DO $$ BEGIN
 IF (SELECT encrypted_refresh_token FROM public.gsc_oauth_credentials WHERE brand_key='10000000-0000-0000-0000-000000000001') <> 'TEST CIPHERTEXT'
  THEN RAISE EXCEPTION 'Pending grant overwrote active credentials'; END IF;
END $$;
SET LOCAL ROLE service_role;
SELECT public.activate_customer_gsc('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',
 '20000000-0000-0000-0000-000000000002','https://same.example/','siteOwner');
SELECT public.write_gsc_generation('10000000-0000-0000-0000-000000000001',2,
 '[{"date":"2026-09-01","query":"shared query","clicks":2,"impressions":20,"ctr":0.1,"position":3,"ingested_at":"2026-09-05T00:00:00Z"}]');
DO $$ BEGIN
 BEGIN
  PERFORM public.write_gsc_generation('10000000-0000-0000-0000-000000000001',1,'[]');
  RAISE EXCEPTION 'Old generation was allowed';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'GSC connection generation is no longer active' THEN RAISE; END IF;
 END;
 IF (SELECT count(*) FROM public.gsc_daily WHERE brand_key='10000000-0000-0000-0000-000000000001') <> 2
  THEN RAISE EXCEPTION 'Property generations overwrote one another'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.gsc_connections) <> 1 THEN RAISE EXCEPTION 'UUID connection is not visible to its owner'; END IF;
 IF has_function_privilege('authenticated','public.write_gsc_generation(text,integer,jsonb)','EXECUTE')
  THEN RAISE EXCEPTION 'Customer can call privileged writer'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE service_role;
DO $$ DECLARE j public.gsc_sync_jobs; BEGIN
 SELECT * INTO j FROM public.gsc_sync_jobs WHERE brand_key='10000000-0000-0000-0000-000000000001' AND status='pending';
 PERFORM public.claim_customer_gsc_job(j.id,'test-worker');
 UPDATE public.gsc_sync_jobs SET window_start_date='2026-07-01',window_end_date='2026-09-01' WHERE id=j.id;
 PERFORM public.commit_customer_gsc_page(j.id,'test-worker','[]',5000,false);
 IF (SELECT status FROM public.gsc_sync_jobs WHERE id=j.id) <> 'pending'
  OR (SELECT last_ingested_through FROM public.gsc_connections WHERE brand_key=j.brand_key) IS NOT NULL
 THEN RAISE EXCEPTION 'Partial page incorrectly completed the import'; END IF;
 PERFORM public.claim_customer_gsc_job(j.id,'replacement-worker');
 BEGIN
  PERFORM public.commit_customer_gsc_page(j.id,'test-worker','[]',10000,false);
  RAISE EXCEPTION 'Stale worker committed progress';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Sync lease is no longer active' THEN RAISE; END IF; END;
 PERFORM public.commit_customer_gsc_page(j.id,'replacement-worker','[]',5000,true);
 IF (SELECT status FROM public.gsc_sync_jobs WHERE id=j.id) <> 'completed'
  OR (SELECT last_ingested_through FROM public.gsc_connections WHERE brand_key=j.brand_key) <> '2026-09-01'::date
 THEN RAISE EXCEPTION 'Finished import did not record coverage'; END IF;
END $$;
SELECT public.disconnect_customer_gsc('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001');
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.gsc_connections WHERE brand_key='10000000-0000-0000-0000-000000000001' AND enabled)
  OR EXISTS(SELECT 1 FROM public.gsc_oauth_credentials WHERE brand_key='10000000-0000-0000-0000-000000000001')
  OR EXISTS(SELECT 1 FROM public.gsc_sync_jobs WHERE brand_key='10000000-0000-0000-0000-000000000001' AND status IN ('pending','running'))
  THEN RAISE EXCEPTION 'Disconnect did not invalidate credentials and jobs'; END IF;
 BEGIN
  PERFORM public.write_gsc_generation('10000000-0000-0000-0000-000000000001',2,'[]');
  RAISE EXCEPTION 'Disconnected generation was allowed';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'GSC connection generation is no longer active' THEN RAISE; END IF;
 END;
END $$;
RESET ROLE;
INSERT INTO public.content_jobs(id,brand,playbook,status) VALUES
 ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','geo_article','awaiting_approval');
INSERT INTO public.content_items(id,job_id,brand,playbook,status) VALUES
 ('40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','geo_article','awaiting_approval');
SET LOCAL ROLE service_role;
UPDATE public.content_items SET rubric=jsonb_build_object('check',jsonb_build_object('passed',true,'content_hash',content_hash,'research_snapshot',coalesce(research_pack,'{}'::jsonb))) WHERE id='40000000-0000-0000-0000-000000000001';
SELECT public.decide_checked_content(id,brand,content_version,content_hash,'approved','Test review',NULL) FROM public.content_items WHERE id='40000000-0000-0000-0000-000000000001';
DO $$ BEGIN
 IF (SELECT status FROM public.content_jobs WHERE id='30000000-0000-0000-0000-000000000001') <> 'approved'
 OR (SELECT status FROM public.content_items WHERE id='40000000-0000-0000-0000-000000000001') <> 'approved'
 OR (SELECT count(*) FROM public.content_feedback WHERE item_id='40000000-0000-0000-0000-000000000001') <> 1
 THEN RAISE EXCEPTION 'Review was not committed atomically'; END IF;
 BEGIN
  PERFORM public.decide_checked_content('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',0,'stale','rejected','Stale review',NULL);
  RAISE EXCEPTION 'Stale review was allowed';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'stale draft version' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.content_items WHERE id='40000000-0000-0000-0000-000000000001')
 THEN RAISE EXCEPTION 'Another customer can see draft'; END IF;
END $$;
RESET ROLE;
INSERT INTO public.workspace_spend_limits(brand_key,daily_cap_usd,monthly_cap_usd) VALUES
 ('10000000-0000-0000-0000-000000000001',5,50),
 ('10000000-0000-0000-0000-000000000002',5,50);
INSERT INTO public.spend_ledger(brand_key,feature,source_ref,provider,endpoint,estimate_usd,actual_usd,accounted_usd,cost_source) VALUES
 ('10000000-0000-0000-0000-000000000001','platform.selftest','uat:0001:1','openrouter','chat:uat',0.1,0.1,0.1,'provider_reported'),
 ('10000000-0000-0000-0000-000000000002','platform.selftest','uat:0002:1','openrouter','chat:uat',0.1,0.1,0.1,'provider_reported');
-- F03: cost_reconciliations is operator-only; customer users must be refused outright
INSERT INTO public.cost_reconciliations(ledger_id, brand_key, feature, provider, endpoint, kind, estimate_usd, actual_usd)
SELECT id, brand_key, feature, provider, endpoint, 'undershoot', estimate_usd, actual_usd + 0.05
  FROM public.spend_ledger WHERE source_ref IN ('uat:0001:1', 'uat:0002:1');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.workspace_spend_limits) <> 1 OR (SELECT count(*) FROM public.spend_ledger) <> 1
  THEN RAISE EXCEPTION 'Spend limits or ledger leaked across tenants'; END IF;
 BEGIN
  PERFORM 1 FROM public.cost_reconciliations;
  RAISE EXCEPTION 'cost_reconciliations readable by customer';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.workspace_spend_limits) <> 1 OR (SELECT count(*) FROM public.spend_ledger) <> 1
  THEN RAISE EXCEPTION 'Spend limits or ledger leaked across tenants'; END IF;
 BEGIN
  PERFORM 1 FROM public.cost_reconciliations;
  RAISE EXCEPTION 'cost_reconciliations readable by customer';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
INSERT INTO public.jobs(kind,brand_key,trigger,status) VALUES
 ('uat.job','10000000-0000-0000-0000-000000000001','manual','queued'),
 ('uat.job','10000000-0000-0000-0000-000000000002','manual','queued'),
 ('uat.job',NULL,'system','queued');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.jobs) <> 1
  THEN RAISE EXCEPTION 'Jobs leaked across tenants, or the system job was visible'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.jobs) <> 1
  THEN RAISE EXCEPTION 'Jobs leaked across tenants, or the system job was visible'; END IF;
END $$;
RESET ROLE;

-- F26: each user reads only their own privacy choice; telemetry_id is present.
-- The role is switched outside the DO block and reset after it, as every other
-- tenant check here does: a set_config('role', ...) inside the block would stay
-- in force for the rest of the transaction and fail the blocks that follow.
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('00000000-0000-0000-0000-000000000011','f26-u1@example.test',now()),
 ('00000000-0000-0000-0000-000000000012','f26-u2@example.test',now());
INSERT INTO public.user_privacy_choices(user_id,analytics,source,policy_version) VALUES
 ('00000000-0000-0000-0000-000000000011',true,'settings','2026-10-22'),
 ('00000000-0000-0000-0000-000000000012',false,'banner','2026-10-22');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000011',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.user_privacy_choices) <> 1
  THEN RAISE EXCEPTION 'F26 UAT: user must read only own privacy row'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000012',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.user_privacy_choices) <> 1
  THEN RAISE EXCEPTION 'F26 UAT: user must read only own privacy row'; END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF (SELECT count(*) FROM public.customer_brands WHERE telemetry_id IS NULL) <> 0
  THEN RAISE EXCEPTION 'F26 UAT: every brand must have telemetry_id'; END IF;
END $$;

-- F07: each tenant's section, competitor, key page and research row is visible
-- only to that workspace's member. Customers may read these rows but cannot
-- write to the service-only project memory tables.
INSERT INTO public.project_context_sections(brand_key,key,content,updated_by,updated_by_user) VALUES
 ('10000000-0000-0000-0000-000000000001','business_overview','Workspace A memory','user','00000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002','business_overview','Workspace B memory','user','00000000-0000-0000-0000-000000000002');
INSERT INTO public.project_competitors(brand_key,domain,updated_by,updated_by_user) VALUES
 ('10000000-0000-0000-0000-000000000001','competitor-a.example','user','00000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002','competitor-b.example','user','00000000-0000-0000-0000-000000000002');
INSERT INTO public.project_key_pages(brand_key,url,updated_by,updated_by_user) VALUES
 ('10000000-0000-0000-0000-000000000001','https://same.example/a','user','00000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002','https://same.example/b','user','00000000-0000-0000-0000-000000000002');
INSERT INTO public.project_research_log(brand_key,summary,created_by,created_by_user) VALUES
 ('10000000-0000-0000-0000-000000000001','Workspace A research','user','00000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002','Workspace B research','user','00000000-0000-0000-0000-000000000002');
INSERT INTO public.project_memory_state(brand_key,brief_imported) VALUES
 ('10000000-0000-0000-0000-000000000001',false),
 ('10000000-0000-0000-0000-000000000002',false);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.project_context_sections) <> 1
  OR (SELECT count(*) FROM public.project_competitors) <> 1
  OR (SELECT count(*) FROM public.project_key_pages) <> 1
  OR (SELECT count(*) FROM public.project_research_log) <> 1
  OR (SELECT count(*) FROM public.project_memory_state) <> 1
  THEN RAISE EXCEPTION 'F07 memory leaked across customer workspaces'; END IF;
 BEGIN
  INSERT INTO public.project_context_sections(brand_key,key,content,updated_by)
   VALUES('10000000-0000-0000-0000-000000000001','current_goal','Forbidden direct write','user');
  RAISE EXCEPTION 'Customer could write project memory directly';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.project_context_sections) <> 1
  OR (SELECT count(*) FROM public.project_competitors) <> 1
  OR (SELECT count(*) FROM public.project_key_pages) <> 1
  OR (SELECT count(*) FROM public.project_research_log) <> 1
  OR (SELECT count(*) FROM public.project_memory_state) <> 1
  THEN RAISE EXCEPTION 'F07 memory leaked across customer workspaces'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$ BEGIN
 IF has_table_privilege('anon','public.project_context_sections','SELECT')
  OR has_table_privilege('anon','public.project_competitors','SELECT')
  OR has_table_privilege('anon','public.project_key_pages','SELECT')
  OR has_table_privilege('anon','public.project_research_log','SELECT')
  OR has_table_privilege('anon','public.project_memory_state','SELECT')
  THEN RAISE EXCEPTION 'F07 anon has project memory read privileges'; END IF;
END $$;
RESET ROLE;
-- End F07 tenant check.

-- F09: each tenant's price_approvals row is visible only to that workspace's member.
-- Customers may read their own approvals but cannot write or delete them directly.
INSERT INTO public.price_approvals(brand_key, action, approved_max_usd, quoted_usd, source, quote, price_version, approved_by) VALUES
 ('10000000-0000-0000-0000-000000000001', 'ai_visibility.scan.run', 24.0, 24.0, 'dialog', '{"totalUsd":24}'::jsonb, '2026-10-21.1', '00000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002', 'ai_visibility.scan.run', 24.0, 24.0, 'dialog', '{"totalUsd":24}'::jsonb, '2026-10-21.1', '00000000-0000-0000-0000-000000000002');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.price_approvals) <> 1
  THEN RAISE EXCEPTION 'F09 price approvals leaked across customer workspaces'; END IF;
 BEGIN
  INSERT INTO public.price_approvals(brand_key, action, approved_max_usd, quoted_usd, source, quote, price_version)
   VALUES('10000000-0000-0000-0000-000000000001', 'ai_visibility.scan.run', 24.0, 24.0, 'dialog', '{"totalUsd":24}'::jsonb, '2026-10-21.1');
  RAISE EXCEPTION 'Customer could insert price approvals directly';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.price_approvals) <> 1
  THEN RAISE EXCEPTION 'F09 price approvals leaked across customer workspaces'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$ BEGIN
 IF has_table_privilege('anon','public.price_approvals','SELECT')
  OR has_table_privilege('anon','public.price_approvals','INSERT')
  THEN RAISE EXCEPTION 'F09 anon has price_approvals privileges'; END IF;
END $$;
RESET ROLE;
-- End F09 tenant check.

-- F10: one customer-managed schedule per workspace; each member reads only their own.
-- Inserted as the superuser, before any role switch. The CHECK needs an interval and an approved maximum.
INSERT INTO public.scan_schedules(brand, display_name, cadence, enabled, next_run_at, managed_by, schedule_interval, approved_max_usd) VALUES
 ('10000000-0000-0000-0000-000000000001', 'Workspace A', 'daily', true, now() + interval '1 day', 'customer', 'daily', 5.0),
 ('10000000-0000-0000-0000-000000000002', 'Workspace B', 'weekly', true, now() + interval '1 day', 'customer', 'weekly', 7.5);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.scan_schedules) <> 1
  OR (SELECT brand FROM public.scan_schedules) <> '10000000-0000-0000-0000-000000000001'
  THEN RAISE EXCEPTION 'F10 customer schedules leaked across customer workspaces'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.scan_schedules) <> 1
  OR (SELECT brand FROM public.scan_schedules) <> '10000000-0000-0000-0000-000000000002'
  THEN RAISE EXCEPTION 'F10 customer schedules leaked across customer workspaces'; END IF;
END $$;
RESET ROLE;
-- End F10 tenant check.

-- F08: members read only their own settings, questions and question events.
INSERT INTO public.workspace_question_settings(brand_key,revision,persona) VALUES
 ('10000000-0000-0000-0000-000000000001',1,'Workspace A buyers'),
 ('10000000-0000-0000-0000-000000000002',1,'Workspace B buyers');
INSERT INTO public.workspace_questions(id,brand_key,text,topic,origin,created_by) VALUES
 ('50000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','Which tools suit workspace A buyers?','General','manual','00000000-0000-0000-0000-000000000001'),
 ('50000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','How does workspace A compare products?','General','manual','00000000-0000-0000-0000-000000000001'),
 ('50000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000002','Which tools suit workspace B buyers?','General','manual','00000000-0000-0000-0000-000000000002'),
 ('50000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000002','How does workspace B compare products?','General','manual','00000000-0000-0000-0000-000000000002');
INSERT INTO public.workspace_question_events(brand_key,question_id,event,revision,actor) VALUES
 ('10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','created',1,'00000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000003','created',1,'00000000-0000-0000-0000-000000000002');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.workspace_question_settings) <> 1
  OR (SELECT brand_key FROM public.workspace_question_settings) <> '10000000-0000-0000-0000-000000000001'
  OR (SELECT count(*) FROM public.workspace_questions) <> 2
  OR EXISTS(SELECT 1 FROM public.workspace_questions WHERE brand_key='10000000-0000-0000-0000-000000000002')
  OR (SELECT count(*) FROM public.workspace_question_events) <> 1
  THEN RAISE EXCEPTION 'F08 customer A read crossed workspace boundaries'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.workspace_question_settings) <> 1
  OR (SELECT brand_key FROM public.workspace_question_settings) <> '10000000-0000-0000-0000-000000000002'
  OR (SELECT count(*) FROM public.workspace_questions) <> 2
  OR EXISTS(SELECT 1 FROM public.workspace_questions WHERE brand_key='10000000-0000-0000-0000-000000000001')
  OR (SELECT count(*) FROM public.workspace_question_events) <> 1
  THEN RAISE EXCEPTION 'F08 customer B read crossed workspace boundaries'; END IF;
END $$;
RESET ROLE;
-- End F08 tenant check.
-- F25: workspace_milestones (per workspace), user_email_preferences (per user),
-- email_outbox (service role only, denied to authenticated).
INSERT INTO public.workspace_milestones(brand_key, milestone, reached_at) VALUES
 ('10000000-0000-0000-0000-000000000001', 'workspace_created', now()),
 ('10000000-0000-0000-0000-000000000002', 'workspace_created', now());
INSERT INTO public.user_email_preferences(user_id, product_updates, scan_results) VALUES
 ('00000000-0000-0000-0000-000000000001', true, true),
 ('00000000-0000-0000-0000-000000000002', false, true);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.workspace_milestones) <> 1
  OR (SELECT brand_key FROM public.workspace_milestones) <> '10000000-0000-0000-0000-000000000001'
  THEN RAISE EXCEPTION 'F25 workspace_milestones leaked across customer workspaces'; END IF;
 IF (SELECT count(*) FROM public.user_email_preferences) <> 1
  OR (SELECT user_id FROM public.user_email_preferences) <> '00000000-0000-0000-0000-000000000001'
  THEN RAISE EXCEPTION 'F25 user_email_preferences leaked across users'; END IF;
 BEGIN
  PERFORM 1 FROM public.email_outbox;
  RAISE EXCEPTION 'email_outbox readable by customer';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.workspace_milestones) <> 1
  OR (SELECT brand_key FROM public.workspace_milestones) <> '10000000-0000-0000-0000-000000000002'
  THEN RAISE EXCEPTION 'F25 workspace_milestones leaked across customer workspaces'; END IF;
 IF (SELECT count(*) FROM public.user_email_preferences) <> 1
  OR (SELECT user_id FROM public.user_email_preferences) <> '00000000-0000-0000-0000-000000000002'
  THEN RAISE EXCEPTION 'F25 user_email_preferences leaked across users'; END IF;
 BEGIN
  PERFORM 1 FROM public.email_outbox;
  RAISE EXCEPTION 'email_outbox readable by customer';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
-- End F25 tenant check.
-- F20: ga4_connections is tenant-isolated (workspace members read own only).
-- ga4_grants and ga4_oauth_attempts are service-only (deny authenticated).
INSERT INTO public.ga4_grants(id, user_id, google_sub, google_email) VALUES
 ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'sub-1', 'owner1@example.com'),
 ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'sub-2', 'owner2@example.com');
INSERT INTO public.ga4_connections(brand_key, grant_id, connected_by, google_sub, property_id, property_display_name, property_time_zone, property_currency_code) VALUES
 ('10000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'sub-1', 'properties/123456789', 'Prop A', 'UTC', 'USD'),
 ('10000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'sub-2', 'properties/987654321', 'Prop B', 'UTC', 'USD');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.ga4_connections) <> 1
  OR (SELECT brand_key FROM public.ga4_connections) <> '10000000-0000-0000-0000-000000000001'
  THEN RAISE EXCEPTION 'F20 ga4_connections leaked across customer workspaces'; END IF;
 BEGIN
  PERFORM 1 FROM public.ga4_grants;
  RAISE EXCEPTION 'ga4_grants readable by authenticated';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM 1 FROM public.ga4_oauth_attempts;
  RAISE EXCEPTION 'ga4_oauth_attempts readable by authenticated';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.ga4_connections) <> 1
  OR (SELECT brand_key FROM public.ga4_connections) <> '10000000-0000-0000-0000-000000000002'
  THEN RAISE EXCEPTION 'F20 ga4_connections leaked across customer workspaces'; END IF;
END $$;
RESET ROLE;
-- End F20 tenant check.
-- F19: indexnow_keys, indexnow_submissions, indexnow_key_checks are tenant-isolated.
INSERT INTO public.indexnow_keys(brand_key, key, created_by) VALUES
 ('10000000-0000-0000-0000-000000000001', '0123456789abcdef0123456789abcdef', '00000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002', 'fedcba9876543210fedcba9876543210', '00000000-0000-0000-0000-000000000002');
INSERT INTO public.indexnow_submissions(brand_key, request_id, source, host, url_count, urls, status, message, created_by) VALUES
 ('10000000-0000-0000-0000-000000000001', gen_random_uuid(), 'settings', 'offcult.in', 1, ARRAY['https://offcult.in/p1'], 'submitted', 'Submitted 1 URL.', '00000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002', gen_random_uuid(), 'settings', 'brand2.com', 1, ARRAY['https://brand2.com/p1'], 'submitted', 'Submitted 1 URL.', '00000000-0000-0000-0000-000000000002');
INSERT INTO public.indexnow_key_checks(brand_key, host, status) VALUES
 ('10000000-0000-0000-0000-000000000001', 'offcult.in', 'found'),
 ('10000000-0000-0000-0000-000000000002', 'brand2.com', 'found');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.indexnow_keys) <> 1
  OR (SELECT brand_key FROM public.indexnow_keys) <> '10000000-0000-0000-0000-000000000001'
  THEN RAISE EXCEPTION 'F19 indexnow_keys leaked across customer workspaces'; END IF;
 IF (SELECT count(*) FROM public.indexnow_submissions) <> 1
  OR (SELECT brand_key FROM public.indexnow_submissions) <> '10000000-0000-0000-0000-000000000001'
  THEN RAISE EXCEPTION 'F19 indexnow_submissions leaked across customer workspaces'; END IF;
 IF (SELECT count(*) FROM public.indexnow_key_checks) <> 1
  OR (SELECT brand_key FROM public.indexnow_key_checks) <> '10000000-0000-0000-0000-000000000001'
  THEN RAISE EXCEPTION 'F19 indexnow_key_checks leaked across customer workspaces'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.indexnow_keys) <> 1
  OR (SELECT brand_key FROM public.indexnow_keys) <> '10000000-0000-0000-0000-000000000002'
  THEN RAISE EXCEPTION 'F19 indexnow_keys leaked across customer workspaces'; END IF;
 IF (SELECT count(*) FROM public.indexnow_submissions) <> 1
  OR (SELECT brand_key FROM public.indexnow_submissions) <> '10000000-0000-0000-0000-000000000002'
  THEN RAISE EXCEPTION 'F19 indexnow_submissions leaked across customer workspaces'; END IF;
 IF (SELECT count(*) FROM public.indexnow_key_checks) <> 1
  OR (SELECT brand_key FROM public.indexnow_key_checks) <> '10000000-0000-0000-0000-000000000002'
  THEN RAISE EXCEPTION 'F19 indexnow_key_checks leaked across customer workspaces'; END IF;
END $$;
RESET ROLE;
-- End F19 tenant check.
-- F13: keyword_metrics is unreadable by authenticated customers (service role only).
INSERT INTO public.keyword_metrics(keyword, location_code, language_code, search_volume, source)
VALUES ('oversized tees', 2356, 'en', 8100, 'labs');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $$ BEGIN
  BEGIN
    PERFORM count(*) FROM public.keyword_metrics;
    RAISE EXCEPTION 'keyword_metrics is readable by customers';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
-- F13: saved keywords, tags, and tag assignments tenant isolation.
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
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.saved_keywords) <> 1 OR (SELECT count(*) FROM public.saved_keyword_tags) <> 1
     OR (SELECT count(*) FROM public.saved_keyword_tag_assignments) <> 1
    THEN RAISE EXCEPTION 'Saved keywords leaked across tenants'; END IF;
END $$;
RESET ROLE;
-- End F13 saved keywords check.
-- End F13 keyword_metrics check.

-- F15: each workspace sees its own rank tracker, keyword, run, snapshot and task.
INSERT INTO public.rank_tracking_configs(id,brand_key,domain,location_code,language_code,devices,serp_depth,created_by) VALUES
 ('15000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','rank-a.example',2840,'en','mobile',40,'00000000-0000-0000-0000-000000000001'),
 ('15000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','rank-b.example',2840,'en','mobile',40,'00000000-0000-0000-0000-000000000002');
INSERT INTO public.rank_tracking_keywords(id,brand_key,config_id,keyword,match_case) VALUES
 ('15000000-0000-0000-0000-000000000011','10000000-0000-0000-0000-000000000001','15000000-0000-0000-0000-000000000001','alpha',false),
 ('15000000-0000-0000-0000-000000000012','10000000-0000-0000-0000-000000000002','15000000-0000-0000-0000-000000000002','beta',false);
INSERT INTO public.rank_check_runs(id,brand_key,config_id,trigger,method,domain,location_code,language_code,devices,serp_depth,approved_max_usd,created_by) VALUES
 ('15000000-0000-0000-0000-000000000021','10000000-0000-0000-0000-000000000001','15000000-0000-0000-0000-000000000001','manual','live','rank-a.example',2840,'en','mobile',40,1,'00000000-0000-0000-0000-000000000001'),
 ('15000000-0000-0000-0000-000000000022','10000000-0000-0000-0000-000000000002','15000000-0000-0000-0000-000000000002','manual','live','rank-b.example',2840,'en','mobile',40,1,'00000000-0000-0000-0000-000000000002');
INSERT INTO public.rank_snapshots(brand_key,run_id,tracking_keyword_id,keyword,device,position) VALUES
 ('10000000-0000-0000-0000-000000000001','15000000-0000-0000-0000-000000000021','15000000-0000-0000-0000-000000000011','alpha','mobile',1),
 ('10000000-0000-0000-0000-000000000002','15000000-0000-0000-0000-000000000022','15000000-0000-0000-0000-000000000012','beta','mobile',2);
INSERT INTO public.rank_check_tasks(brand_key,run_id,round,tracking_keyword_id,keyword,device) VALUES
 ('10000000-0000-0000-0000-000000000001','15000000-0000-0000-0000-000000000021',0,'15000000-0000-0000-0000-000000000011','alpha','mobile'),
 ('10000000-0000-0000-0000-000000000002','15000000-0000-0000-0000-000000000022',0,'15000000-0000-0000-0000-000000000012','beta','mobile');
INSERT INTO public.rank_keyword_questions(brand_key,tracking_keyword_id,question_id,created_by) VALUES
 ('10000000-0000-0000-0000-000000000001','15000000-0000-0000-0000-000000000011','50000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002','15000000-0000-0000-0000-000000000012','50000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002');
DO $f15$ BEGIN
  BEGIN
    INSERT INTO public.rank_check_tasks(brand_key,run_id,round,tracking_keyword_id,keyword,device)
    VALUES ('10000000-0000-0000-0000-000000000002','15000000-0000-0000-0000-000000000021',1,
      '15000000-0000-0000-0000-000000000011','alpha','mobile');
    RAISE EXCEPTION 'F15 cross-workspace task was allowed';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $f15$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $f15$ BEGIN
  IF (SELECT count(*) FROM public.rank_tracking_configs) <> 1
   OR (SELECT count(*) FROM public.rank_tracking_keywords) <> 1
   OR (SELECT count(*) FROM public.rank_check_runs) <> 1
   OR (SELECT count(*) FROM public.rank_snapshots) <> 1
   OR (SELECT count(*) FROM public.rank_check_tasks) <> 1
   OR (SELECT count(*) FROM public.rank_keyword_questions) <> 1
  THEN RAISE EXCEPTION 'F15 rank tracking rows leaked across customer workspaces'; END IF;
END $f15$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $f15$ BEGIN
  IF (SELECT count(*) FROM public.rank_tracking_configs) <> 1
   OR (SELECT count(*) FROM public.rank_tracking_keywords) <> 1
   OR (SELECT count(*) FROM public.rank_check_runs) <> 1
   OR (SELECT count(*) FROM public.rank_snapshots) <> 1
   OR (SELECT count(*) FROM public.rank_check_tasks) <> 1
   OR (SELECT count(*) FROM public.rank_keyword_questions) <> 1
  THEN RAISE EXCEPTION 'F15 rank tracking rows leaked across customer workspaces'; END IF;
END $f15$;
RESET ROLE;
-- End F15 tenant check.

-- F17: one own business, one fetch with one item, one grid and one search per
-- workspace; members read only their workspace's rows; an item insert with
-- workspace 2's brand_key and workspace 1's fetch_id fails the composite FK.
INSERT INTO public.local_businesses(brand_key, role, title, cid, place_id, latitude, longitude, created_by) VALUES
 ('10000000-0000-0000-0000-000000000001','own','Workspace A Store','1234567890123456789','ChIJF17A',19.0760,72.8777,'00000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002','own','Workspace B Store','9876543210987654321','ChIJF17B',48.8566,2.3522,'00000000-0000-0000-0000-000000000002');
INSERT INTO public.local_fetches(brand_key, request_id, business_id, kind, identifier, params, params_hash, item_count, requested_by) VALUES
 ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-0000000000f1',
  (SELECT id FROM public.local_businesses WHERE brand_key='10000000-0000-0000-0000-000000000001' AND role='own'),
  'reviews','{"cid":"1234567890123456789"}','{"depth":20}','1111111111111111111111111111111111111111111111111111111111111111',1,'00000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-0000000000f2',
  (SELECT id FROM public.local_businesses WHERE brand_key='10000000-0000-0000-0000-000000000002' AND role='own'),
  'reviews','{"cid":"9876543210987654321"}','{"depth":20}','2222222222222222222222222222222222222222222222222222222222222222',1,'00000000-0000-0000-0000-000000000002');
INSERT INTO public.local_fetch_items(fetch_id, brand_key, idx, item) VALUES
 ((SELECT id FROM public.local_fetches WHERE request_id='30000000-0000-0000-0000-0000000000f1'),
  '10000000-0000-0000-0000-000000000001',0,'{"rank_absolute":1}'),
 ((SELECT id FROM public.local_fetches WHERE request_id='30000000-0000-0000-0000-0000000000f2'),
  '10000000-0000-0000-0000-000000000002',0,'{"rank_absolute":1}');
INSERT INTO public.local_grid_runs(brand_key, request_id, business_id, keyword, center_lat, center_lng, grid_size, spacing_km, zoom, device, language_code, target, params_hash, requested_by) VALUES
 ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-0000000000a1',
  (SELECT id FROM public.local_businesses WHERE brand_key='10000000-0000-0000-0000-000000000001' AND role='own'),
  'coffee store',19.0760,72.8777,3,2,13,'mobile','en','{"cid":"1234567890123456789"}','3333333333333333333333333333333333333333333333333333333333333333','00000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-0000000000a2',
  (SELECT id FROM public.local_businesses WHERE brand_key='10000000-0000-0000-0000-000000000002' AND role='own'),
  'coffee store',48.8566,2.3522,3,2,13,'mobile','en','{"cid":"9876543210987654321"}','4444444444444444444444444444444444444444444444444444444444444444','00000000-0000-0000-0000-000000000002');
INSERT INTO public.local_searches(brand_key, kind, params, result_count, own_rank, cache_key, cached, requested_by) VALUES
 ('10000000-0000-0000-0000-000000000001','local_serp','{"keyword":"coffee store"}',20,4,'5555555555555555555555555555555555555555555555555555555555555555',false,'00000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002','local_serp','{"keyword":"coffee store"}',20,NULL,'6666666666666666666666666666666666666666666666666666666666666666',false,'00000000-0000-0000-0000-000000000002');
DO $f17$ BEGIN
  BEGIN
    INSERT INTO public.local_fetch_items(fetch_id, brand_key, idx, item)
    VALUES ((SELECT id FROM public.local_fetches WHERE request_id='30000000-0000-0000-0000-0000000000f1'),
            '10000000-0000-0000-0000-000000000002',1,'{"rank_absolute":2}');
    RAISE EXCEPTION 'F17 cross-workspace fetch item was allowed';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $f17$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $f17$ BEGIN
  IF (SELECT count(*) FROM public.local_businesses) <> 1
   OR (SELECT count(*) FROM public.local_fetches) <> 1
   OR (SELECT count(*) FROM public.local_fetch_items) <> 1
   OR (SELECT count(*) FROM public.local_grid_runs) <> 1
   OR (SELECT count(*) FROM public.local_searches) <> 1
  THEN RAISE EXCEPTION 'F17 local SEO rows leaked across customer workspaces'; END IF;
END $f17$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $f17$ BEGIN
  IF (SELECT count(*) FROM public.local_businesses) <> 1
   OR (SELECT count(*) FROM public.local_fetches) <> 1
   OR (SELECT count(*) FROM public.local_fetch_items) <> 1
   OR (SELECT count(*) FROM public.local_grid_runs) <> 1
   OR (SELECT count(*) FROM public.local_searches) <> 1
  THEN RAISE EXCEPTION 'F17 local SEO rows leaked across customer workspaces'; END IF;
END $f17$;
RESET ROLE;
-- End F17 tenant check.

-- F06 phase 3: export_requests is tenant data. One row per fixture workspace;
-- a member reads only their own workspace's row and `anon` reads none. The seed
-- runs as the table owner, and the grant is explicit because bare PostgreSQL
-- has no Supabase default privileges.
RESET ROLE;
INSERT INTO public.export_requests(brand_key, kind, format, params, status, row_count, byte_size, storage_path, expires_at) VALUES
 ('10000000-0000-0000-0000-000000000001','workspace_answers','csv','{"from":"2026-07-01","to":"2026-07-31"}','ready',10,100,'10000000-0000-0000-0000-000000000001/workspace_answers/f06-a.csv',now() + interval '1 hour'),
 ('10000000-0000-0000-0000-000000000002','workspace_answers','json','{"from":"2026-07-01","to":"2026-07-31"}','ready',5,50,'10000000-0000-0000-0000-000000000002/workspace_answers/f06-b.json',now() + interval '1 hour');
GRANT SELECT ON public.export_requests TO authenticated;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $f06$ BEGIN
  IF (SELECT count(*) FROM public.export_requests) <> 1
   OR NOT EXISTS(SELECT 1 FROM public.export_requests WHERE brand_key='10000000-0000-0000-0000-000000000001')
  THEN RAISE EXCEPTION 'F06 export rows leaked across customer workspaces'; END IF;
END $f06$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $f06$ BEGIN
  IF (SELECT count(*) FROM public.export_requests) <> 1
   OR NOT EXISTS(SELECT 1 FROM public.export_requests WHERE brand_key='10000000-0000-0000-0000-000000000002')
  THEN RAISE EXCEPTION 'F06 export rows leaked across customer workspaces'; END IF;
END $f06$;
SET LOCAL ROLE anon;
DO $f06$ BEGIN
  BEGIN
    PERFORM count(*) FROM public.export_requests;
    RAISE EXCEPTION 'F06 anon read of export_requests was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $f06$;
RESET ROLE;
-- End F06 tenant check.

-- F06 phase 5: migration 066 derived columns. Trigger derives engines /
-- collection_partial / started_by / listed_at on insert. Verify on a scan that
-- carries raw_results engines and a data_source_issue slice.
RESET ROLE;
INSERT INTO public.scans(brand, url, brand_key, raw_results, platform, scanned_at, origin_job_id)
VALUES ('%','https://same.example','10000000-0000-0000-0000-000000000001',
        '{"engines":{"chatgpt":{"data_source_issue":true},"gemini":{}}}'::jsonb,
        'multi', '2026-10-02T09:00:00Z', NULL);
DO $f06p5$ BEGIN
  IF (SELECT count(*) FROM public.scans WHERE brand_key='10000000-0000-0000-0000-000000000001' AND engines @> ARRAY['chatgpt','gemini']::text[]) <> 1
     OR (SELECT count(*) FROM public.scans WHERE brand_key='10000000-0000-0000-0000-000000000001' AND collection_partial = true) < 1
     OR (SELECT count(*) FROM public.scans WHERE brand_key='10000000-0000-0000-0000-000000000001' AND started_by='manual') < 1
     OR (SELECT count(*) FROM public.scans WHERE brand_key='10000000-0000-0000-0000-000000000001' AND listed_at IS NULL) <> 0
  THEN RAISE EXCEPTION 'F06 phase 5 derived columns were not populated by the trigger'; END IF;
END $f06p5$;
RESET ROLE;
-- End F06 phase 5 tenant check.

-- F12: each member reads only their own workspace's question_answer_links rows.
-- Customers may read their links but cannot write them directly.
RESET ROLE;
INSERT INTO public.prompt_results(id, job_id, brand, query, engine, answered) VALUES
 ('12000000-0000-0000-0000-000000000001','12000000-0000-0000-0000-000000000011','10000000-0000-0000-0000-000000000001','Which tools suit workspace A buyers?','chatgpt',true),
 ('12000000-0000-0000-0000-000000000002','12000000-0000-0000-0000-000000000012','10000000-0000-0000-0000-000000000002','Which tools suit workspace B buyers?','chatgpt',true);
INSERT INTO public.question_answer_links(brand_key, question_id, source, prompt_result_id, scan_job_id, engine, asked_text, collected_at, linked_by) VALUES
 ('10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','legacy','12000000-0000-0000-0000-000000000001','12000000-0000-0000-0000-000000000011','chatgpt','Which tools suit workspace A buyers?',now(),'backfill'),
 ('10000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000003','legacy','12000000-0000-0000-0000-000000000002','12000000-0000-0000-0000-000000000012','chatgpt','Which tools suit workspace B buyers?',now(),'backfill');
GRANT SELECT ON public.question_answer_links TO authenticated;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $f12$ BEGIN
  IF (SELECT count(*) FROM public.question_answer_links) <> 1
   OR (SELECT brand_key FROM public.question_answer_links) <> '10000000-0000-0000-0000-000000000001'
  THEN RAISE EXCEPTION 'F12 links leaked across customer workspaces'; END IF;
END $f12$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $f12$ BEGIN
  IF (SELECT count(*) FROM public.question_answer_links) <> 1
   OR (SELECT brand_key FROM public.question_answer_links) <> '10000000-0000-0000-0000-000000000002'
  THEN RAISE EXCEPTION 'F12 links leaked across customer workspaces'; END IF;
END $f12$;
SET LOCAL ROLE anon;
DO $f12$ BEGIN
  BEGIN
    PERFORM count(*) FROM public.question_answer_links;
    RAISE EXCEPTION 'F12 anon read of question_answer_links was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $f12$;
RESET ROLE;
-- End F12 tenant check.

-- F27: one user_onboarding row per test user and one dismissal per user per workspace;
-- each user reads only their own rows, and a dismissal for a workspace the user left is not readable.
RESET ROLE;
INSERT INTO public.user_onboarding(user_id, brand_key, steps, handoff) VALUES
 ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '{"website":{"status":"done"}}'::jsonb, '{"domain":"same.example"}'::jsonb),
 ('00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '{"website":{"status":"done"}}'::jsonb, '{"domain":"same.example"}'::jsonb),
 ('00000000-0000-0000-0000-000000000003', NULL, '{}'::jsonb, '{}'::jsonb);

INSERT INTO public.workspace_setup_dismissals(user_id, brand_key, step) VALUES
 ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'gsc'),
 ('00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'gsc');

-- A dismissal for user 1 in workspace B (which user 1 cannot access)
INSERT INTO public.workspace_setup_dismissals(user_id, brand_key, step) VALUES
 ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'scan');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $f27$ BEGIN
  IF (SELECT count(*) FROM public.user_onboarding) <> 1
   OR (SELECT brand_key FROM public.user_onboarding) <> '10000000-0000-0000-0000-000000000001'
  THEN RAISE EXCEPTION 'F27 user_onboarding rows leaked across users'; END IF;

  IF (SELECT count(*) FROM public.workspace_setup_dismissals) <> 1
   OR (SELECT brand_key FROM public.workspace_setup_dismissals) <> '10000000-0000-0000-0000-000000000001'
  THEN RAISE EXCEPTION 'F27 workspace_setup_dismissals leaked across workspaces or permitted inaccessible workspace'; END IF;
END $f27$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $f27$ BEGIN
  IF (SELECT count(*) FROM public.user_onboarding) <> 1
   OR (SELECT brand_key FROM public.user_onboarding) <> '10000000-0000-0000-0000-000000000002'
  THEN RAISE EXCEPTION 'F27 user_onboarding rows leaked across users'; END IF;

  IF (SELECT count(*) FROM public.workspace_setup_dismissals) <> 1
   OR (SELECT brand_key FROM public.workspace_setup_dismissals) <> '10000000-0000-0000-0000-000000000002'
  THEN RAISE EXCEPTION 'F27 workspace_setup_dismissals leaked across workspaces'; END IF;
END $f27$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',true);
DO $f27$ BEGIN
  IF (SELECT count(*) FROM public.user_onboarding) <> 1
   OR (SELECT brand_key FROM public.user_onboarding) IS NOT NULL
  THEN RAISE EXCEPTION 'F27 user 3 user_onboarding mismatch'; END IF;

  IF (SELECT count(*) FROM public.workspace_setup_dismissals) <> 0
  THEN RAISE EXCEPTION 'F27 user 3 should see 0 dismissals'; END IF;
END $f27$;

SET LOCAL ROLE anon;
DO $f27$ BEGIN
  BEGIN
    PERFORM count(*) FROM public.user_onboarding;
    RAISE EXCEPTION 'F27 anon read of user_onboarding was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM count(*) FROM public.workspace_setup_dismissals;
    RAISE EXCEPTION 'F27 anon read of workspace_setup_dismissals was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $f27$;
RESET ROLE;
-- End F27 tenant check.

-- F22: assistant sessions, messages, turns and approvals are private to the user
-- who created them. Workspace A has two members (users 1 and 3); workspace B has
-- one (user 2). Each sees exactly their own rows and nobody else's.
RESET ROLE;
INSERT INTO public.assistant_sessions(id, brand_key, user_id) VALUES
 ('23000000-0000-4000-8000-000000000001', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001'),
 ('23000000-0000-4000-8000-000000000002', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003'),
 ('23000000-0000-4000-8000-000000000003', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002');

INSERT INTO public.assistant_turns(id, session_id, brand_key, user_id, status, stop_reason, finished_at) VALUES
 ('24000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000001', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'completed', 'finished', now()),
 ('24000000-0000-4000-8000-000000000002', '23000000-0000-4000-8000-000000000002', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003', 'completed', 'finished', now()),
 ('24000000-0000-4000-8000-000000000003', '23000000-0000-4000-8000-000000000003', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'completed', 'finished', now());

INSERT INTO public.assistant_messages(session_id, id, brand_key, role, parts, metadata, turn_id) VALUES
 ('23000000-0000-4000-8000-000000000001', 'uat-a1-message', '10000000-0000-0000-0000-000000000001', 'user',
  '[{"type":"text","text":"Synthetic question for workspace A member 1"}]'::jsonb, '{"kind":"chat"}'::jsonb, '24000000-0000-4000-8000-000000000001'),
 ('23000000-0000-4000-8000-000000000002', 'uat-a2-message', '10000000-0000-0000-0000-000000000001', 'user',
  '[{"type":"text","text":"Synthetic question for workspace A member 2"}]'::jsonb, '{"kind":"chat"}'::jsonb, '24000000-0000-4000-8000-000000000002'),
 ('23000000-0000-4000-8000-000000000003', 'uat-b1-message', '10000000-0000-0000-0000-000000000002', 'user',
  '[{"type":"text","text":"Synthetic question for workspace B member 1"}]'::jsonb, '{"kind":"chat"}'::jsonb, '24000000-0000-4000-8000-000000000003');

INSERT INTO public.assistant_approvals(id, session_id, turn_id, brand_key, user_id, tool_name, tool_call_id, kind, input, input_sha256, label, expires_at) VALUES
 ('25000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'list_scans', 'uat-a1-call', 'confirm',
  '{}'::jsonb, repeat('a',64), 'List scans', now() + interval '15 minutes'),
 ('25000000-0000-4000-8000-000000000002', '23000000-0000-4000-8000-000000000002', '24000000-0000-4000-8000-000000000002',
  '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003', 'list_scans', 'uat-a2-call', 'confirm',
  '{}'::jsonb, repeat('b',64), 'List scans', now() + interval '15 minutes'),
 ('25000000-0000-4000-8000-000000000003', '23000000-0000-4000-8000-000000000003', '24000000-0000-4000-8000-000000000003',
  '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'list_scans', 'uat-b1-call', 'confirm',
  '{}'::jsonb, repeat('c',64), 'List scans', now() + interval '15 minutes');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $f22$ BEGIN
  IF (SELECT count(*) FROM public.assistant_sessions) <> 1
   OR (SELECT id FROM public.assistant_sessions) <> '23000000-0000-4000-8000-000000000001'
  THEN RAISE EXCEPTION 'F22 assistant_sessions leaked across users or workspaces'; END IF;
  IF (SELECT count(*) FROM public.assistant_messages) <> 1
   OR (SELECT id FROM public.assistant_messages) <> 'uat-a1-message'
  THEN RAISE EXCEPTION 'F22 assistant_messages leaked across users or workspaces'; END IF;
  IF (SELECT count(*) FROM public.assistant_turns) <> 1
   OR (SELECT id FROM public.assistant_turns) <> '24000000-0000-4000-8000-000000000001'
  THEN RAISE EXCEPTION 'F22 assistant_turns leaked across users or workspaces'; END IF;
  IF (SELECT count(*) FROM public.assistant_approvals) <> 1
   OR (SELECT id FROM public.assistant_approvals) <> '25000000-0000-4000-8000-000000000001'
  THEN RAISE EXCEPTION 'F22 assistant_approvals leaked across users or workspaces'; END IF;
END $f22$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',true);
DO $f22$ BEGIN
  IF (SELECT count(*) FROM public.assistant_sessions) <> 1
   OR (SELECT id FROM public.assistant_sessions) <> '23000000-0000-4000-8000-000000000002'
  THEN RAISE EXCEPTION 'F22 second workspace member saw another member''s sessions'; END IF;
  IF (SELECT count(*) FROM public.assistant_messages) <> 1
   OR (SELECT id FROM public.assistant_messages) <> 'uat-a2-message'
  THEN RAISE EXCEPTION 'F22 second workspace member saw another member''s messages'; END IF;
  IF (SELECT count(*) FROM public.assistant_turns) <> 1
   OR (SELECT id FROM public.assistant_turns) <> '24000000-0000-4000-8000-000000000002'
  THEN RAISE EXCEPTION 'F22 second workspace member saw another member''s turns'; END IF;
  IF (SELECT count(*) FROM public.assistant_approvals) <> 1
   OR (SELECT id FROM public.assistant_approvals) <> '25000000-0000-4000-8000-000000000002'
  THEN RAISE EXCEPTION 'F22 second workspace member saw another member''s approvals'; END IF;
  IF EXISTS (SELECT 1 FROM public.assistant_sessions WHERE id = '23000000-0000-4000-8000-000000000001')
   OR EXISTS (SELECT 1 FROM public.assistant_messages WHERE id = 'uat-a1-message')
   OR EXISTS (SELECT 1 FROM public.assistant_turns WHERE id = '24000000-0000-4000-8000-000000000001')
   OR EXISTS (SELECT 1 FROM public.assistant_approvals WHERE id = '25000000-0000-4000-8000-000000000001')
  THEN RAISE EXCEPTION 'F22 second workspace member can read the first member''s rows'; END IF;
END $f22$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $f22$ BEGIN
  IF (SELECT count(*) FROM public.assistant_sessions) <> 1
   OR (SELECT id FROM public.assistant_sessions) <> '23000000-0000-4000-8000-000000000003'
  THEN RAISE EXCEPTION 'F22 assistant_sessions leaked across workspaces'; END IF;
  IF (SELECT count(*) FROM public.assistant_messages) <> 1
   OR (SELECT id FROM public.assistant_messages) <> 'uat-b1-message'
  THEN RAISE EXCEPTION 'F22 assistant_messages leaked across workspaces'; END IF;
  IF (SELECT count(*) FROM public.assistant_turns) <> 1
   OR (SELECT id FROM public.assistant_turns) <> '24000000-0000-4000-8000-000000000003'
  THEN RAISE EXCEPTION 'F22 assistant_turns leaked across workspaces'; END IF;
  IF (SELECT count(*) FROM public.assistant_approvals) <> 1
   OR (SELECT id FROM public.assistant_approvals) <> '25000000-0000-4000-8000-000000000003'
  THEN RAISE EXCEPTION 'F22 assistant_approvals leaked across workspaces'; END IF;
  IF EXISTS (SELECT 1 FROM public.assistant_sessions WHERE brand_key = '10000000-0000-0000-0000-000000000001')
   OR EXISTS (SELECT 1 FROM public.assistant_messages WHERE brand_key = '10000000-0000-0000-0000-000000000001')
   OR EXISTS (SELECT 1 FROM public.assistant_turns WHERE brand_key = '10000000-0000-0000-0000-000000000001')
   OR EXISTS (SELECT 1 FROM public.assistant_approvals WHERE brand_key = '10000000-0000-0000-0000-000000000001')
  THEN RAISE EXCEPTION 'F22 workspace B can read workspace A rows'; END IF;
END $f22$;

SET LOCAL ROLE anon;
DO $f22$ BEGIN
  BEGIN
    PERFORM count(*) FROM public.assistant_sessions;
    RAISE EXCEPTION 'F22 anon read of assistant_sessions was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM count(*) FROM public.assistant_messages;
    RAISE EXCEPTION 'F22 anon read of assistant_messages was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM count(*) FROM public.assistant_turns;
    RAISE EXCEPTION 'F22 anon read of assistant_turns was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM count(*) FROM public.assistant_approvals;
    RAISE EXCEPTION 'F22 anon read of assistant_approvals was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $f22$;
RESET ROLE;
-- End F22 tenant check.
ROLLBACK;

