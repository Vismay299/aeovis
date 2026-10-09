-- Explicit tenant ownership and atomic GSC activation, disconnect and writes.
-- Historical rows stay unassigned; operators must confirm ownership explicitly.
ALTER TABLE public.scans ADD COLUMN IF NOT EXISTS brand_key text REFERENCES public.customer_brands(brand_key);
ALTER TABLE public.scan_jobs ADD COLUMN IF NOT EXISTS brand_key text REFERENCES public.customer_brands(brand_key);
CREATE INDEX IF NOT EXISTS scans_customer_brand_idx ON public.scans(brand_key, scanned_at DESC);
DROP INDEX IF EXISTS public.scan_jobs_one_running_per_brand;
CREATE UNIQUE INDEX scan_jobs_one_running_per_brand ON public.scan_jobs(lower(btrim(brand)))
  WHERE brand_key IS NULL AND status IN ('pending', 'generating_prompts', 'probing', 'scoring');
CREATE UNIQUE INDEX IF NOT EXISTS scan_jobs_one_running_per_workspace ON public.scan_jobs(brand_key)
  WHERE brand_key IS NOT NULL AND status IN ('pending', 'generating_prompts', 'probing', 'scoring');

CREATE OR REPLACE FUNCTION public.customer_can_access_brand(p_brand text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.customer_brand_memberships m
    JOIN public.customer_brands b ON b.brand_key = m.brand_key
    WHERE m.user_id = (SELECT auth.uid()) AND b.is_active AND b.brand_key = p_brand);
$$;
CREATE OR REPLACE FUNCTION public.customer_can_access_scan(p_brand text, p_url text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.customer_can_access_brand(p_brand);
$$;
REVOKE ALL ON FUNCTION public.customer_can_access_brand(text), public.customer_can_access_scan(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_can_access_brand(text), public.customer_can_access_scan(text,text) TO authenticated, service_role;
DROP POLICY IF EXISTS customer_read_own_brand ON public.scans;
CREATE POLICY customer_read_own_brand ON public.scans FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));
DROP POLICY IF EXISTS customer_read_own_brand ON public.scan_jobs;
CREATE POLICY customer_read_own_brand ON public.scan_jobs FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));
DROP POLICY IF EXISTS customer_read_own_brand ON public.gsc_connections;
CREATE POLICY customer_read_own_brand ON public.gsc_connections FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));
DROP POLICY IF EXISTS customer_read_own_brand ON public.gsc_daily;
CREATE POLICY customer_read_own_brand ON public.gsc_daily FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));

ALTER TABLE public.gsc_connections ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.gsc_daily DROP CONSTRAINT IF EXISTS gsc_daily_pkey;
ALTER TABLE public.gsc_daily ADD PRIMARY KEY (brand, date, query, connection_generation);
CREATE UNIQUE INDEX IF NOT EXISTS gsc_connections_workspace_idx ON public.gsc_connections(brand_key) WHERE brand_key IS NOT NULL;

-- Activate only after property validation, moving a pending grant atomically.
CREATE OR REPLACE FUNCTION public.activate_customer_gsc(p_brand_key text, p_user_id uuid, p_attempt_id uuid, p_site_url text, p_permission text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.gsc_oauth_attempts; g jsonb; generation integer;
BEGIN
  PERFORM 1 FROM public.customer_brands WHERE brand_key = p_brand_key AND is_active FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.customer_brand_memberships
    WHERE brand_key = p_brand_key AND user_id = p_user_id AND role = 'owner') THEN
    RAISE EXCEPTION 'Workspace owner access required';
  END IF;
  SELECT * INTO a FROM public.gsc_oauth_attempts WHERE id = p_attempt_id
    AND brand_key = p_brand_key AND user_id = p_user_id AND consumed_at IS NOT NULL
    AND encrypted_pending_grant IS NOT NULL AND expires_at > now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Authorization expired or already activated'; END IF;
  g := a.encrypted_pending_grant::jsonb;
  SELECT connection_generation + 1 INTO generation FROM public.gsc_connections WHERE brand_key = p_brand_key FOR UPDATE;
  generation := coalesce(generation, 1);
  INSERT INTO public.gsc_oauth_credentials(brand_key, authorizing_user_id, encrypted_refresh_token,
    encrypted_access_token, access_token_expires_at, scopes, status)
  VALUES (p_brand_key, p_user_id, g->>'encrypted_refresh_token', g->>'encrypted_access_token',
    (g->>'access_token_expires_at')::timestamptz, ARRAY['https://www.googleapis.com/auth/webmasters.readonly'], 'active')
  ON CONFLICT (brand_key) DO UPDATE SET authorizing_user_id = EXCLUDED.authorizing_user_id,
    encrypted_refresh_token = EXCLUDED.encrypted_refresh_token, encrypted_access_token = EXCLUDED.encrypted_access_token,
    access_token_expires_at = EXCLUDED.access_token_expires_at, scopes = EXCLUDED.scopes,
    status = 'active', last_error = NULL, updated_at = now();
  INSERT INTO public.gsc_connections(brand, brand_key, site_url, enabled, auth_mode, credential_id,
    connection_generation, permission_level)
  SELECT p_brand_key, p_brand_key, p_site_url, true, 'oauth', id, generation, p_permission
    FROM public.gsc_oauth_credentials WHERE brand_key = p_brand_key
  ON CONFLICT (brand) DO UPDATE SET site_url = EXCLUDED.site_url, enabled = true, auth_mode = 'oauth',
    credential_id = EXCLUDED.credential_id, connection_generation = EXCLUDED.connection_generation,
    permission_level = EXCLUDED.permission_level, last_ingested_through = NULL, last_status = NULL,
    last_error = NULL, last_attempt_at = NULL, last_rows_written = NULL, updated_at = now();
  UPDATE public.gsc_sync_jobs SET status = 'cancelled', updated_at = now()
    WHERE brand_key = p_brand_key AND status IN ('pending','running');
  INSERT INTO public.gsc_sync_jobs(brand_key, connection_generation, sync_type) VALUES(p_brand_key, generation, 'initial');
  UPDATE public.gsc_oauth_attempts SET encrypted_pending_grant = NULL WHERE id = a.id;
  RETURN generation;
END;
$$;

CREATE OR REPLACE FUNCTION public.disconnect_customer_gsc(p_brand_key text, p_user_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE generation integer;
BEGIN
  PERFORM 1 FROM public.customer_brands WHERE brand_key = p_brand_key AND is_active FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.customer_brand_memberships
    WHERE brand_key = p_brand_key AND user_id = p_user_id AND role = 'owner') THEN
    RAISE EXCEPTION 'Workspace owner access required';
  END IF;
  UPDATE public.gsc_connections SET enabled = false, auth_mode = NULL, credential_id = NULL,
    connection_generation = connection_generation + 1, last_status = NULL,
    last_error = 'Disconnected by owner', updated_at = now()
    WHERE brand_key = p_brand_key RETURNING connection_generation INTO generation;
  DELETE FROM public.gsc_oauth_credentials WHERE brand_key = p_brand_key;
  DELETE FROM public.gsc_oauth_attempts WHERE brand_key = p_brand_key;
  UPDATE public.gsc_sync_jobs SET status = 'cancelled', updated_at = now()
    WHERE brand_key = p_brand_key AND status IN ('pending','running');
  RETURN coalesce(generation, 1);
END;
$$;

-- Lock the connection while committing a batch: replaced/disconnected workers
-- cannot write into any generation or move the active watermark.
CREATE OR REPLACE FUNCTION public.write_gsc_generation(p_brand text, p_generation integer, p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.gsc_connections; n integer;
BEGIN
  SELECT * INTO c FROM public.gsc_connections WHERE brand = p_brand FOR UPDATE;
  IF NOT FOUND OR NOT c.enabled OR c.connection_generation <> p_generation THEN
    RAISE EXCEPTION 'GSC connection generation is no longer active';
  END IF;
  INSERT INTO public.gsc_daily(brand, brand_key, site_url, date, query, clicks, impressions, ctr, position, ingested_at, connection_generation)
  SELECT c.brand, c.brand_key, c.site_url, r.date, r.query, r.clicks, r.impressions, r.ctr, r.position, r.ingested_at, c.connection_generation
    FROM jsonb_to_recordset(p_rows) AS r(date date, query text, clicks integer, impressions integer, ctr numeric, position numeric, ingested_at timestamptz)
  ON CONFLICT (brand,date,query,connection_generation) DO UPDATE SET clicks = EXCLUDED.clicks,
    impressions = EXCLUDED.impressions, ctr = EXCLUDED.ctr, position = EXCLUDED.position, ingested_at = EXCLUDED.ingested_at;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Verified users can redeem only invitations addressed to their own email.
CREATE OR REPLACE FUNCTION public.accept_customer_team_invites()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE invitation record; n integer := 0; verified_email text;
BEGIN
  SELECT lower(email) INTO verified_email FROM auth.users WHERE id = auth.uid() AND email_confirmed_at IS NOT NULL;
  IF verified_email IS NULL THEN RAISE EXCEPTION 'Verified email required'; END IF;
  FOR invitation IN SELECT i.* FROM public.customer_team_invites i
    JOIN public.customer_brands b ON b.brand_key = i.brand_key AND b.is_active
    WHERE lower(btrim(i.email)) = verified_email AND i.status = 'pending' AND i.expires_at > now() FOR UPDATE OF i
  LOOP
    INSERT INTO public.customer_brand_memberships(user_id, brand_key, role)
      VALUES(auth.uid(), invitation.brand_key, invitation.role) ON CONFLICT DO NOTHING;
    UPDATE public.customer_team_invites SET status = 'accepted' WHERE id = invitation.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.activate_customer_gsc(text,uuid,uuid,text,text), public.disconnect_customer_gsc(text,uuid),
  public.write_gsc_generation(text,integer,jsonb), public.accept_customer_team_invites() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_customer_gsc(text,uuid,uuid,text,text), public.disconnect_customer_gsc(text,uuid),
  public.write_gsc_generation(text,integer,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.accept_customer_team_invites() TO authenticated;

CREATE OR REPLACE FUNCTION public.claim_customer_gsc_job(p_job_id uuid, p_worker text)
RETURNS SETOF public.gsc_sync_jobs LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.gsc_sync_jobs SET status = 'running', lease_owner = p_worker,
    lease_expires_at = now() + interval '5 minutes', attempts = attempts + 1,
    started_at = coalesce(started_at, now()), updated_at = now()
  WHERE id = p_job_id AND attempts < max_attempts
    AND (status = 'pending' OR (status = 'running' AND lease_expires_at < now()))
  RETURNING *;
$$;
REVOKE ALL ON FUNCTION public.claim_customer_gsc_job(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_customer_gsc_job(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.create_customer_workspace(
  p_brand_key text,
  p_display_name text,
  p_website text,
  p_website_host text,
  p_user_id uuid,
  p_idempotency_key text DEFAULT NULL,
  p_aliases text[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_brand_key text;
  v_brand_key text;
BEGIN
  -- Serialize retries for a user and scope the key to that user.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  IF p_idempotency_key IS NOT NULL THEN
    p_idempotency_key := p_user_id::text || ':' || p_idempotency_key;
  END IF;
  -- Idempotency: if this key was already used, return the existing brand.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT brand_key INTO v_existing_brand_key
      FROM public.customer_brands
     WHERE idempotency_key = p_idempotency_key
     LIMIT 1;
    IF v_existing_brand_key IS NOT NULL THEN
      RETURN jsonb_build_object('brand_key', v_existing_brand_key, 'created', false, 'idempotent', true);
    END IF;
  END IF;

  -- Insert the brand.
  INSERT INTO public.customer_brands (brand_key, display_name, website, website_host, aliases, idempotency_key)
  VALUES (p_brand_key, p_display_name, p_website, p_website_host, p_aliases, p_idempotency_key);
  v_brand_key := p_brand_key;

  -- Names and domains are metadata, never authorization aliases.

  -- Create owner membership.
  INSERT INTO public.customer_brand_memberships (user_id, brand_key, role)
  VALUES (p_user_id, v_brand_key, 'owner');

  RETURN jsonb_build_object('brand_key', v_brand_key, 'created', true, 'idempotent', false);
END;
$$;

REVOKE ALL ON FUNCTION public.create_customer_workspace(text, text, text, text, uuid, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_customer_workspace(text, text, text, text, uuid, text, text[]) TO service_role;


CREATE OR REPLACE FUNCTION public.prune_expired_gsc_oauth_attempts()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH deleted AS (
    DELETE FROM public.gsc_oauth_attempts
     WHERE expires_at < now()
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted;
$$;

REVOKE ALL ON FUNCTION public.prune_expired_gsc_oauth_attempts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_expired_gsc_oauth_attempts() TO service_role;

-- Persist a stable window and row offset across bounded worker invocations.
ALTER TABLE public.gsc_sync_jobs ADD COLUMN IF NOT EXISTS window_start_date date;
ALTER TABLE public.gsc_sync_jobs ADD COLUMN IF NOT EXISTS window_end_date date;
WITH duplicates AS (
 SELECT id, row_number() OVER (PARTITION BY brand_key, connection_generation ORDER BY created_at,id) AS rank
 FROM public.gsc_sync_jobs WHERE status IN ('pending','running')
) UPDATE public.gsc_sync_jobs SET status = 'cancelled', updated_at = now()
 WHERE id IN (SELECT id FROM duplicates WHERE rank > 1);
CREATE UNIQUE INDEX IF NOT EXISTS gsc_sync_jobs_one_active_generation
  ON public.gsc_sync_jobs(brand_key, connection_generation) WHERE status IN ('pending','running');

CREATE OR REPLACE FUNCTION public.commit_customer_gsc_page(
  p_job_id uuid, p_worker text, p_rows jsonb, p_next_page integer, p_complete boolean
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j public.gsc_sync_jobs; c public.gsc_connections; n integer;
BEGIN
  SELECT * INTO j FROM public.gsc_sync_jobs WHERE id = p_job_id;
  SELECT * INTO c FROM public.gsc_connections WHERE brand_key = j.brand_key FOR UPDATE;
  IF NOT FOUND OR NOT c.enabled OR c.connection_generation <> j.connection_generation THEN
    RAISE EXCEPTION 'GSC connection generation is no longer active';
  END IF;
  SELECT * INTO j FROM public.gsc_sync_jobs WHERE id = p_job_id FOR UPDATE;
  IF j.status <> 'running' OR j.lease_owner IS DISTINCT FROM p_worker OR j.lease_expires_at <= now()
    OR j.window_end_date IS NULL THEN RAISE EXCEPTION 'Sync lease is no longer active'; END IF;
  IF NOT p_complete AND p_next_page <= coalesce(j.checkpoint_page,0) THEN
    RAISE EXCEPTION 'Sync pagination must advance';
  END IF;
  n := public.write_gsc_generation(c.brand, c.connection_generation, p_rows);
  UPDATE public.gsc_sync_jobs SET checkpoint_page = p_next_page,
    status = CASE WHEN p_complete THEN 'completed' ELSE 'pending' END,
    rows_written = rows_written + n, attempts = 0, error_message = NULL,
    completed_at = CASE WHEN p_complete THEN now() ELSE NULL END,
    lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = j.id;
  IF p_complete THEN
    UPDATE public.gsc_connections SET last_ingested_through = j.window_end_date,
      last_attempt_at = now(), last_status = 'ok', last_error = NULL, updated_at = now(),
      last_rows_written = j.rows_written + n WHERE brand = c.brand;
  END IF;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.commit_customer_gsc_page(uuid,text,jsonb,integer,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_customer_gsc_page(uuid,text,jsonb,integer,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_customer_gsc_syncs()
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH inserted AS (
    INSERT INTO public.gsc_sync_jobs(brand_key, connection_generation, sync_type)
    SELECT brand_key, connection_generation, 'incremental' FROM public.gsc_connections
    WHERE enabled AND auth_mode = 'oauth' AND brand_key IS NOT NULL
      AND (last_attempt_at IS NULL OR last_attempt_at < now() - interval '1 day')
    ON CONFLICT DO NOTHING RETURNING 1
  ) SELECT count(*)::integer FROM inserted;
$$;
REVOKE ALL ON FUNCTION public.enqueue_customer_gsc_syncs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_customer_gsc_syncs() TO service_role;

CREATE OR REPLACE FUNCTION public.decide_customer_content(p_item_id uuid,p_brand text,p_old_status text,
 p_status text,p_job_status text,p_verdict text,p_comment text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE item public.content_items;
BEGIN
 SELECT * INTO item FROM public.content_items WHERE id=p_item_id AND brand=p_brand AND status=p_old_status FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Draft changed or is unavailable'; END IF;
 IF p_old_status <> 'awaiting_approval' OR p_verdict NOT IN ('approved','rejected') OR p_status <> p_verdict
 THEN RAISE EXCEPTION 'Invalid review transition'; END IF;
 INSERT INTO public.content_feedback(item_id,brand,verdict,comment) VALUES(p_item_id,p_brand,p_verdict,p_comment);
 UPDATE public.content_items SET status=p_status,updated_at=now() WHERE id=p_item_id;
 UPDATE public.content_jobs SET status=p_job_status WHERE id=item.job_id AND brand=p_brand;
END;
$$;
REVOKE ALL ON FUNCTION public.decide_customer_content(uuid,text,text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.decide_customer_content(uuid,text,text,text,text,text,text) TO service_role;
