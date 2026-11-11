-- F17: local SEO. Saved businesses, paid fetches (reviews, posts, Q&A), map grids and
-- local result snapshots. Public Google data about businesses; reviewer content is kept
-- trimmed and pruned after 13 months.
CREATE TABLE IF NOT EXISTS public.local_businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('own','competitor')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  cid text CHECK (cid IS NULL OR cid ~ '^[0-9]{1,30}$'),
  place_id text CHECK (place_id IS NULL OR (length(place_id) BETWEEN 1 AND 256 AND place_id ~ '^[A-Za-z0-9_:-]+$')),
  latitude numeric(10,7) CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude numeric(10,7) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  location_code integer CHECK (location_code IS NULL OR location_code BETWEEN 1000 AND 9999999),
  language_code text NOT NULL DEFAULT 'en' CHECK (language_code ~ '^[a-z]{2,3}(-[A-Za-z]{2,4})?$'),
  profile jsonb CHECK (profile IS NULL OR (jsonb_typeof(profile) = 'object' AND pg_column_size(profile) < 16384)),
  profile_fetched_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT local_businesses_identity CHECK (cid IS NOT NULL OR place_id IS NOT NULL),
  CONSTRAINT local_businesses_id_brand UNIQUE (id, brand_key)
);
COMMENT ON COLUMN public.local_businesses.profile IS 'Trimmed BusinessProfileView (§6.2.3) from a server fetch; never written from client input.';
CREATE UNIQUE INDEX IF NOT EXISTS local_businesses_one_own_idx ON public.local_businesses (brand_key) WHERE role = 'own';
CREATE UNIQUE INDEX IF NOT EXISTS local_businesses_cid_idx ON public.local_businesses (brand_key, cid) WHERE cid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS local_businesses_place_idx ON public.local_businesses (brand_key, place_id) WHERE place_id IS NOT NULL;
DROP TRIGGER IF EXISTS local_businesses_touch ON public.local_businesses;
CREATE TRIGGER local_businesses_touch BEFORE UPDATE ON public.local_businesses
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.local_fetches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  request_id uuid NOT NULL UNIQUE,
  business_id uuid,
  kind text NOT NULL CHECK (kind IN ('reviews','extended_reviews','updates','questions')),
  identifier jsonb NOT NULL CHECK (jsonb_typeof(identifier) = 'object' AND pg_column_size(identifier) < 1024),
  params jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object' AND pg_column_size(params) < 2048),
  params_hash text NOT NULL CHECK (params_hash ~ '^[0-9a-f]{64}$'),
  provider_task_id text CHECK (provider_task_id IS NULL OR length(provider_task_id) <= 100),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed')),
  totals jsonb CHECK (totals IS NULL OR (jsonb_typeof(totals) = 'object' AND pg_column_size(totals) < 2048)),
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count BETWEEN 0 AND 200),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,60}$'),
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 300),
  last_polled_at timestamptz,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT local_fetches_business_fk FOREIGN KEY (business_id, brand_key)
    REFERENCES public.local_businesses(id, brand_key) ON DELETE SET NULL (business_id),
  CONSTRAINT local_fetches_id_brand UNIQUE (id, brand_key)
);
COMMENT ON COLUMN public.local_fetches.params_hash IS 'sha256 of stableStringify({kind, identifier, params}); a completed or processing fetch with the same hash in the last 60 minutes is reused.';
CREATE INDEX IF NOT EXISTS local_fetches_reuse_idx ON public.local_fetches (brand_key, params_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS local_fetches_business_idx ON public.local_fetches (brand_key, business_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS local_fetches_created_idx ON public.local_fetches (created_at);

CREATE TABLE IF NOT EXISTS public.local_fetch_items (
  fetch_id uuid NOT NULL,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  idx integer NOT NULL CHECK (idx BETWEEN 0 AND 199),
  item jsonb NOT NULL CHECK (jsonb_typeof(item) = 'object' AND pg_column_size(item) < 32768),
  PRIMARY KEY (fetch_id, idx),
  CONSTRAINT local_fetch_items_fetch_fk FOREIGN KEY (fetch_id, brand_key)
    REFERENCES public.local_fetches(id, brand_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.local_grid_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  request_id uuid NOT NULL UNIQUE,
  business_id uuid,
  keyword text NOT NULL CHECK (keyword = btrim(keyword) AND length(keyword) BETWEEN 1 AND 120),
  center_lat numeric(10,7) NOT NULL CHECK (center_lat BETWEEN -90 AND 90),
  center_lng numeric(10,7) NOT NULL CHECK (center_lng BETWEEN -180 AND 180),
  grid_size smallint NOT NULL CHECK (grid_size IN (3,5)),
  spacing_km numeric(5,2) NOT NULL CHECK (spacing_km BETWEEN 0.25 AND 10),
  zoom smallint NOT NULL CHECK (zoom BETWEEN 4 AND 18),
  device text NOT NULL CHECK (device IN ('desktop','mobile')),
  language_code text NOT NULL CHECK (language_code ~ '^[a-z]{2,3}(-[A-Za-z]{2,4})?$'),
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object' AND pg_column_size(target) < 1024),
  params_hash text NOT NULL CHECK (params_hash ~ '^[0-9a-f]{64}$'),
  task_ids jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(task_ids) = 'array' AND jsonb_array_length(task_ids) <= 25),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed')),
  points jsonb CHECK (points IS NULL OR (jsonb_typeof(points) = 'array' AND jsonb_array_length(points) <= 25 AND pg_column_size(points) < 32768)),
  point_rows jsonb CHECK (point_rows IS NULL OR (jsonb_typeof(point_rows) = 'array' AND jsonb_array_length(point_rows) <= 25 AND pg_column_size(point_rows) < 131072)),
  summary jsonb CHECK (summary IS NULL OR jsonb_typeof(summary) = 'object'),
  matched jsonb CHECK (matched IS NULL OR jsonb_typeof(matched) = 'object'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,60}$'),
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 300),
  last_polled_at timestamptz,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT local_grid_runs_business_fk FOREIGN KEY (business_id, brand_key)
    REFERENCES public.local_businesses(id, brand_key) ON DELETE SET NULL (business_id)
);
COMMENT ON COLUMN public.local_grid_runs.task_ids IS 'Provider task id per point in row-major order, null where the provider refused the point (OpenSEO receipt).';
CREATE INDEX IF NOT EXISTS local_grid_runs_reuse_idx ON public.local_grid_runs (brand_key, params_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS local_grid_runs_brand_idx ON public.local_grid_runs (brand_key, created_at DESC);

CREATE TABLE IF NOT EXISTS public.local_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('local_serp','listings')),
  params jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object' AND pg_column_size(params) < 2048),
  result_count integer NOT NULL CHECK (result_count >= 0),
  own_rank integer CHECK (own_rank IS NULL OR own_rank BETWEEN 1 AND 700),
  cache_key text NOT NULL CHECK (length(cache_key) = 64),
  cached boolean NOT NULL,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.local_searches IS 'F17: history of local result and listing searches (parameters and counts only; rows live in the provider cache).';
CREATE INDEX IF NOT EXISTS local_searches_brand_idx ON public.local_searches (brand_key, kind, created_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['local_businesses','local_fetches','local_fetch_items','local_grid_runs','local_searches'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key))', t || '_read', t);
  END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
