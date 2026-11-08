-- F19: IndexNow keys, submission history and key-check log. The key is public by design:
-- the customer's site serves it at https://<host>/<key>.txt. It is not a credential.
CREATE TABLE IF NOT EXISTS public.indexnow_keys (
  brand_key text PRIMARY KEY REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[0-9a-f]{32}$'),
  last_check jsonb CHECK (last_check IS NULL OR (jsonb_typeof(last_check) = 'array' AND jsonb_array_length(last_check) <= 4)),
  last_checked_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN public.indexnow_keys.last_check IS 'Latest [{host, status}] from the key-file check; status in found|missing|wrong_content|redirects|moved|unreachable|unknown.';
DROP TRIGGER IF EXISTS indexnow_keys_touch ON public.indexnow_keys;
CREATE TRIGGER indexnow_keys_touch BEFORE UPDATE ON public.indexnow_keys
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.indexnow_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('settings','audit','content','tool')),
  source_ref text CHECK (source_ref IS NULL OR length(source_ref) <= 100),   -- audit id or content item id
  host text NOT NULL CHECK (length(host) BETWEEN 1 AND 253 AND host = lower(host)),
  url_count integer NOT NULL CHECK (url_count BETWEEN 1 AND 10000),
  urls text[] NOT NULL CHECK (cardinality(urls) BETWEEN 1 AND 100),            -- first 100 URLs, sorted
  status text NOT NULL CHECK (status IN ('submitted','failed')),
  engine text CHECK (engine IS NULL OR engine IN ('bing','yandex','yep')),
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,40}$'),
  message text NOT NULL CHECK (length(message) <= 300),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT indexnow_submissions_request_host UNIQUE (request_id, host)
);
CREATE INDEX IF NOT EXISTS indexnow_submissions_brand_idx ON public.indexnow_submissions (brand_key, created_at DESC);
CREATE INDEX IF NOT EXISTS indexnow_submissions_source_idx ON public.indexnow_submissions (brand_key, source, source_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS indexnow_submissions_urls_idx ON public.indexnow_submissions USING gin (urls);
CREATE INDEX IF NOT EXISTS indexnow_submissions_created_idx ON public.indexnow_submissions (created_at);

CREATE TABLE IF NOT EXISTS public.indexnow_key_checks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  host text NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  status text NOT NULL CHECK (status IN ('found','missing','wrong_content','redirects','moved','unreachable','unknown')),
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS indexnow_key_checks_brand_idx ON public.indexnow_key_checks (brand_key, checked_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['indexnow_keys','indexnow_submissions','indexnow_key_checks'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key))', t || '_read', t);
  END LOOP;
END $$;

-- Create the key only when missing; concurrent first uses converge (port of ProjectRepository.ts:153-168).
CREATE OR REPLACE FUNCTION public.indexnow_ensure_key(p_brand text, p_key text, p_actor uuid)
RETURNS TABLE (key text, created boolean) LANGUAGE plpgsql SET search_path = public AS $$
#variable_conflict use_column
DECLARE v text;
BEGIN
  IF p_key !~ '^[0-9a-f]{32}$' THEN RAISE EXCEPTION 'indexnow_key_invalid'; END IF;
  INSERT INTO indexnow_keys (brand_key, key, created_by) VALUES (p_brand, p_key, p_actor)
  ON CONFLICT (brand_key) DO NOTHING RETURNING indexnow_keys.key INTO v;
  IF v IS NOT NULL THEN key := v; created := true; RETURN NEXT; RETURN; END IF;
  SELECT k.key INTO v FROM indexnow_keys k WHERE k.brand_key = p_brand;
  key := v; created := false; RETURN NEXT;
END $$;

-- Usage for rate limits (F19-AC-08).
CREATE OR REPLACE FUNCTION public.indexnow_usage(p_brand text, p_now timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'requestsLastHour', (SELECT count(DISTINCT request_id) FROM indexnow_submissions
                          WHERE brand_key = p_brand AND created_at > p_now - interval '1 hour'),
    'oldestRequestInHour', (SELECT min(created_at) FROM indexnow_submissions
                          WHERE brand_key = p_brand AND created_at > p_now - interval '1 hour'),
    'urlsToday', (SELECT coalesce(sum(url_count), 0) FROM indexnow_submissions
                   WHERE brand_key = p_brand AND created_at >= date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
    'checksLastHour', (SELECT count(*) FROM indexnow_key_checks
                        WHERE brand_key = p_brand AND checked_at > p_now - interval '1 hour'),
    'oldestCheckInHour', (SELECT min(checked_at) FROM indexnow_key_checks
                        WHERE brand_key = p_brand AND checked_at > p_now - interval '1 hour'))
$$;

-- URLs already submitted successfully since p_since (recorded URLs only).
CREATE OR REPLACE FUNCTION public.indexnow_recently_submitted(p_brand text, p_urls text[], p_since timestamptz)
RETURNS text[] LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(array_agg(DISTINCT u), '{}')
    FROM indexnow_submissions s CROSS JOIN LATERAL unnest(s.urls) AS u
   WHERE s.brand_key = p_brand AND s.status = 'submitted' AND s.created_at >= p_since
     AND s.urls && p_urls AND u = ANY (p_urls)
$$;

CREATE OR REPLACE FUNCTION public.prune_indexnow(p_submissions_before timestamptz, p_checks_before timestamptz, p_limit integer DEFAULT 5000)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_s integer; v_c integer;
BEGIN
  WITH old AS (SELECT id FROM indexnow_submissions WHERE created_at < p_submissions_before ORDER BY created_at
                LIMIT greatest(1, least(p_limit, 20000)))
  DELETE FROM indexnow_submissions s USING old WHERE s.id = old.id; GET DIAGNOSTICS v_s = ROW_COUNT;
  WITH old AS (SELECT id FROM indexnow_key_checks WHERE checked_at < p_checks_before ORDER BY checked_at
                LIMIT greatest(1, least(p_limit * 4, 80000)))
  DELETE FROM indexnow_key_checks c USING old WHERE c.id = old.id; GET DIAGNOSTICS v_c = ROW_COUNT;
  RETURN jsonb_build_object('submissions', v_s, 'checks', v_c);
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['indexnow_ensure_key(text,text,uuid)','indexnow_usage(text,timestamptz)',
    'indexnow_recently_submitted(text,text[],timestamptz)','prune_indexnow(timestamptz,timestamptz,integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
