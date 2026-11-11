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
\ir ../supabase/migrations/070_f07_project_memory.sql
\ir ../supabase/migrations/075_f08_workspace_questions.sql
\ir ../supabase/migrations/076_f08_question_backfill.sql
\ir ../supabase/migrations/080_f09_price_approvals.sql
\ir ../supabase/migrations/085_f10_customer_schedules.sql
\ir ../supabase/migrations/100_f13_saved_keywords.sql
\ir ../supabase/migrations/102_f13_saved_keyword_functions.sql
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
ROLLBACK;

