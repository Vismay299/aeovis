-- 136: F20 GA4 functions — grant upsert, connection set/disconnect, account removal, unused-grant purge,
-- cache purge, attempt pruning. Service-role only. Safe to re-run.

-- Port of upsertGrant (googleOAuth.ts:134-177): one grant per (user, Google account); keep the stored
-- refresh token when Google omits a new one.
CREATE OR REPLACE FUNCTION public.ga4_upsert_grant(p_user_id uuid, p_google_sub text, p_google_email text,
  p_encrypted_refresh_token text, p_encrypted_access_token text, p_access_token_expires_at timestamptz, p_scopes text[])
RETURNS uuid LANGUAGE sql SET search_path = public AS $$
  INSERT INTO ga4_grants (user_id, google_sub, google_email, encrypted_refresh_token, encrypted_access_token,
                          access_token_expires_at, scopes, status, last_error)
  VALUES (p_user_id, p_google_sub, p_google_email, p_encrypted_refresh_token, p_encrypted_access_token,
          p_access_token_expires_at, p_scopes, 'active', NULL)
  ON CONFLICT (user_id, google_sub) DO UPDATE SET
    google_email = coalesce(excluded.google_email, ga4_grants.google_email),
    encrypted_refresh_token = coalesce(excluded.encrypted_refresh_token, ga4_grants.encrypted_refresh_token),
    encrypted_access_token = excluded.encrypted_access_token,
    access_token_expires_at = excluded.access_token_expires_at,
    scopes = excluded.scopes, status = 'active', last_error = NULL
  RETURNING id
$$;

-- Deletes the workspace's cached GA4 reports; returns Storage paths of large bodies for removal.
CREATE OR REPLACE FUNCTION public.ga4_purge_cache(p_brand_key text)
RETURNS SETOF text LANGUAGE sql SET search_path = public AS $$
  DELETE FROM provider_cache WHERE brand_key = p_brand_key AND namespace LIKE 'ga4.%' RETURNING storage_path
$$;

-- Port of Ga4Service.setProperty + Ga4ConnectionRepository.upsert (Ga4Service.ts:86-134, Ga4ConnectionRepository.ts:18-54).
CREATE OR REPLACE FUNCTION public.ga4_set_connection(p_brand_key text, p_user_id uuid, p_grant_id uuid,
  p_property_id text, p_property_display_name text, p_property_time_zone text, p_property_currency_code text,
  p_account_display_name text)
RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE g ga4_grants; v_id uuid;
BEGIN
  PERFORM 1 FROM customer_brands WHERE brand_key = p_brand_key AND is_active FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM customer_brand_memberships
      WHERE brand_key = p_brand_key AND user_id = p_user_id AND role = 'owner') THEN
    RAISE EXCEPTION 'owner_required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO g FROM ga4_grants WHERE id = p_grant_id AND user_id = p_user_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'ga4_grant_not_found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO ga4_connections (brand_key, grant_id, connected_by, google_sub, connected_account_email, property_id,
                               property_display_name, property_time_zone, property_currency_code, account_display_name)
  VALUES (p_brand_key, g.id, p_user_id, g.google_sub, g.google_email, p_property_id, p_property_display_name,
          p_property_time_zone, p_property_currency_code, p_account_display_name)
  ON CONFLICT (brand_key) DO UPDATE SET grant_id = excluded.grant_id, connected_by = excluded.connected_by,
    google_sub = excluded.google_sub, connected_account_email = excluded.connected_account_email,
    property_id = excluded.property_id, property_display_name = excluded.property_display_name,
    property_time_zone = excluded.property_time_zone, property_currency_code = excluded.property_currency_code,
    account_display_name = excluded.account_display_name
  RETURNING id INTO v_id;
  UPDATE ga4_grants SET updated_at = now() WHERE id = g.id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.ga4_disconnect(p_brand_key text, p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM customer_brand_memberships
      WHERE brand_key = p_brand_key AND user_id = p_user_id AND role = 'owner') THEN
    RAISE EXCEPTION 'owner_required' USING ERRCODE = '42501';
  END IF;
  DELETE FROM ga4_connections WHERE brand_key = p_brand_key;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;

-- Port of GoogleAccountRepository.getRemovalImpact / remove (:52-70): own grants only, atomic.
CREATE OR REPLACE FUNCTION public.ga4_grant_impact(p_user_id uuid, p_grant_id uuid)
RETURNS integer LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT count(*)::integer FROM ga4_connections c JOIN ga4_grants g ON g.id = c.grant_id
   WHERE g.id = p_grant_id AND g.user_id = p_user_id
$$;

CREATE OR REPLACE FUNCTION public.ga4_remove_grant(p_user_id uuid, p_grant_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_sub text; v_brands text[]; v_remaining integer;
BEGIN
  SELECT google_sub INTO v_sub FROM ga4_grants WHERE id = p_grant_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('removed', false); END IF;
  SELECT coalesce(array_agg(brand_key), '{}') INTO v_brands FROM ga4_connections WHERE grant_id = p_grant_id;
  DELETE FROM ga4_grants WHERE id = p_grant_id;                     -- cascades to ga4_connections
  SELECT count(*) INTO v_remaining FROM ga4_grants WHERE google_sub = v_sub;
  RETURN jsonb_build_object('removed', true, 'googleSub', v_sub, 'brands', to_jsonb(v_brands),
                            'remainingForGoogleAccount', v_remaining);
END $$;

-- Port of listUnusedGrants / deleteUnusedGrant (GoogleAccountRepository.ts:122-149).
CREATE OR REPLACE FUNCTION public.ga4_list_unused_grants(p_updated_before timestamptz, p_limit integer)
RETURNS TABLE (id uuid, user_id uuid, google_sub text)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT g.id, g.user_id, g.google_sub FROM ga4_grants g
   WHERE g.updated_at < p_updated_before
     AND NOT EXISTS (SELECT 1 FROM ga4_connections c WHERE c.grant_id = g.id)
   ORDER BY g.updated_at LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION public.ga4_delete_unused_grant(p_id uuid, p_updated_before timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_sub text; v_remaining integer;
BEGIN
  DELETE FROM ga4_grants g WHERE g.id = p_id AND g.updated_at < p_updated_before
     AND NOT EXISTS (SELECT 1 FROM ga4_connections c WHERE c.grant_id = g.id)
  RETURNING g.google_sub INTO v_sub;
  IF v_sub IS NULL THEN RETURN jsonb_build_object('deleted', false); END IF;
  SELECT count(*) INTO v_remaining FROM ga4_grants WHERE google_sub = v_sub;
  RETURN jsonb_build_object('deleted', true, 'remainingForGoogleAccount', v_remaining);
END $$;

CREATE OR REPLACE FUNCTION public.prune_ga4_oauth_attempts()
RETURNS integer LANGUAGE sql SET search_path = public AS $$
  WITH d AS (
    DELETE FROM ga4_oauth_attempts
     WHERE expires_at < now() - interval '1 day'
        OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '1 day')
    RETURNING 1)
  SELECT count(*)::integer FROM d
$$;

REVOKE ALL ON FUNCTION
  public.ga4_upsert_grant(uuid,text,text,text,text,timestamptz,text[]), public.ga4_purge_cache(text),
  public.ga4_set_connection(text,uuid,uuid,text,text,text,text,text), public.ga4_disconnect(text,uuid),
  public.ga4_grant_impact(uuid,uuid), public.ga4_remove_grant(uuid,uuid),
  public.ga4_list_unused_grants(timestamptz,integer), public.ga4_delete_unused_grant(uuid,timestamptz),
  public.prune_ga4_oauth_attempts()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.ga4_upsert_grant(uuid,text,text,text,text,timestamptz,text[]), public.ga4_purge_cache(text),
  public.ga4_set_connection(text,uuid,uuid,text,text,text,text,text), public.ga4_disconnect(text,uuid),
  public.ga4_grant_impact(uuid,uuid), public.ga4_remove_grant(uuid,uuid),
  public.ga4_list_unused_grants(timestamptz,integer), public.ga4_delete_unused_grant(uuid,timestamptz),
  public.prune_ga4_oauth_attempts()
TO service_role;
NOTIFY pgrst, 'reload schema';
