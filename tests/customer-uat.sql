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
SELECT public.decide_customer_content('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','awaiting_approval','approved','approved','approved','Test review');
DO $$ BEGIN
 IF (SELECT status FROM public.content_jobs WHERE id='30000000-0000-0000-0000-000000000001') <> 'approved'
 OR (SELECT status FROM public.content_items WHERE id='40000000-0000-0000-0000-000000000001') <> 'approved'
 OR (SELECT count(*) FROM public.content_feedback WHERE item_id='40000000-0000-0000-0000-000000000001') <> 1
 THEN RAISE EXCEPTION 'Review was not committed atomically'; END IF;
 BEGIN
  PERFORM public.decide_customer_content('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','awaiting_approval','rejected','rejected','rejected','Stale review');
  RAISE EXCEPTION 'Stale review was allowed';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Draft changed or is unavailable' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.content_items WHERE id='40000000-0000-0000-0000-000000000001')
 THEN RAISE EXCEPTION 'Another customer can see draft'; END IF;
END $$;
ROLLBACK;
