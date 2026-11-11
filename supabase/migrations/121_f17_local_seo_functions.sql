-- Save or update a business with the own/competitor caps. Identity only; profile is optional
-- and passed only by server code that fetched it.
CREATE OR REPLACE FUNCTION public.save_local_business(p_brand text, p_role text, p_title text, p_cid text,
  p_place_id text, p_lat numeric, p_lng numeric, p_location_code integer, p_language text,
  p_profile jsonb, p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_id uuid; v_competitors integer;
BEGIN
  IF p_role NOT IN ('own','competitor') THEN RAISE EXCEPTION 'local_business_invalid:role'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('f17:local_businesses:' || p_brand));
  SELECT id INTO v_id FROM local_businesses
   WHERE brand_key = p_brand AND ((p_cid IS NOT NULL AND cid = p_cid) OR (p_place_id IS NOT NULL AND place_id = p_place_id))
   LIMIT 1;
  IF p_role = 'own' THEN
    UPDATE local_businesses SET role = 'competitor' WHERE brand_key = p_brand AND role = 'own' AND id IS DISTINCT FROM v_id;
  END IF;
  IF v_id IS NULL THEN
    IF p_role = 'competitor' THEN
      SELECT count(*) INTO v_competitors FROM local_businesses WHERE brand_key = p_brand AND role = 'competitor';
      IF v_competitors >= 10 THEN RAISE EXCEPTION 'local_business_cap:competitors'; END IF;
    END IF;
    INSERT INTO local_businesses (brand_key, role, title, cid, place_id, latitude, longitude, location_code,
                                  language_code, profile, profile_fetched_at, created_by)
    VALUES (p_brand, p_role, p_title, p_cid, p_place_id, p_lat, p_lng, p_location_code, coalesce(p_language, 'en'),
            p_profile, CASE WHEN p_profile IS NULL THEN NULL ELSE now() END, p_actor)
    RETURNING id INTO v_id;
  ELSE
    UPDATE local_businesses SET role = p_role, title = p_title,
           cid = coalesce(p_cid, cid), place_id = coalesce(p_place_id, place_id),
           latitude = coalesce(p_lat, latitude), longitude = coalesce(p_lng, longitude),
           location_code = coalesce(p_location_code, location_code),
           profile = coalesce(p_profile, profile),
           profile_fetched_at = CASE WHEN p_profile IS NULL THEN profile_fetched_at ELSE now() END
     WHERE id = v_id;
    IF p_role = 'competitor' THEN
      SELECT count(*) INTO v_competitors FROM local_businesses WHERE brand_key = p_brand AND role = 'competitor';
      IF v_competitors > 10 THEN RAISE EXCEPTION 'local_business_cap:competitors'; END IF;
    END IF;
  END IF;
  -- Final cap check: an own-business demotion above also adds a competitor.
  SELECT count(*) INTO v_competitors FROM local_businesses WHERE brand_key = p_brand AND role = 'competitor';
  IF v_competitors > 10 THEN RAISE EXCEPTION 'local_business_cap:competitors'; END IF;
  RETURN v_id;
END $$;

-- Reuse window for paid fetches and grids (OpenSEO's one-hour receipt).
CREATE OR REPLACE FUNCTION public.find_local_reuse(p_brand text, p_table text, p_hash text, p_since timestamptz)
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE v uuid;
BEGIN
  IF p_table = 'fetch' THEN
    SELECT id INTO v FROM local_fetches WHERE brand_key = p_brand AND params_hash = p_hash
       AND created_at >= p_since AND status IN ('processing','completed') ORDER BY created_at DESC LIMIT 1;
  ELSIF p_table = 'grid' THEN
    SELECT id INTO v FROM local_grid_runs WHERE brand_key = p_brand AND params_hash = p_hash
       AND created_at >= p_since AND status IN ('processing','completed') ORDER BY created_at DESC LIMIT 1;
  ELSE RAISE EXCEPTION 'local_reuse_invalid'; END IF;
  RETURN v;
END $$;

-- Claim a poll slot so concurrent tabs make at most one provider read per 4 s per fetch/grid.
CREATE OR REPLACE FUNCTION public.claim_local_poll(p_brand text, p_table text, p_id uuid, p_min_seconds integer DEFAULT 4)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  IF p_table = 'fetch' THEN
    UPDATE local_fetches SET last_polled_at = now() WHERE id = p_id AND brand_key = p_brand AND status = 'processing'
       AND (last_polled_at IS NULL OR last_polled_at < now() - make_interval(secs => p_min_seconds));
  ELSIF p_table = 'grid' THEN
    UPDATE local_grid_runs SET last_polled_at = now() WHERE id = p_id AND brand_key = p_brand AND status = 'processing'
       AND (last_polled_at IS NULL OR last_polled_at < now() - make_interval(secs => p_min_seconds));
  ELSE RAISE EXCEPTION 'local_poll_invalid'; END IF;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v = 1;
END $$;

-- Retention: 13 months (F17-AC-16).
CREATE OR REPLACE FUNCTION public.prune_local_seo(p_before timestamptz, p_limit integer DEFAULT 1000)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_f integer; v_g integer; v_s integer;
BEGIN
  WITH old AS (SELECT id FROM local_fetches WHERE created_at < p_before ORDER BY created_at LIMIT greatest(1, least(p_limit, 5000)))
  DELETE FROM local_fetches f USING old WHERE f.id = old.id; GET DIAGNOSTICS v_f = ROW_COUNT;
  WITH old AS (SELECT id FROM local_grid_runs WHERE created_at < p_before ORDER BY created_at LIMIT greatest(1, least(p_limit, 5000)))
  DELETE FROM local_grid_runs g USING old WHERE g.id = old.id; GET DIAGNOSTICS v_g = ROW_COUNT;
  WITH old AS (SELECT id FROM local_searches WHERE created_at < p_before ORDER BY created_at LIMIT greatest(1, least(p_limit, 5000)))
  DELETE FROM local_searches s USING old WHERE s.id = old.id; GET DIAGNOSTICS v_s = ROW_COUNT;
  RETURN jsonb_build_object('fetches', v_f, 'grids', v_g, 'searches', v_s);
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY[
    'save_local_business(text,text,text,text,text,numeric,numeric,integer,text,jsonb,uuid)',
    'find_local_reuse(text,text,text,timestamptz)','claim_local_poll(text,text,uuid,integer)',
    'prune_local_seo(timestamptz,integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
