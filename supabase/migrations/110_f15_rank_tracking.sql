-- Portions ported from every-app/open-seo@c5f8db19c7ca9e750836b6ed5c8a6491d4f967f4 (MIT, © 2026 Ben Senescu).
-- Modified for Perceev; see THIRD_PARTY_NOTICES.md.
-- F15: rank tracking. Tables mirror OpenSEO app.schema.ts:216-376 with brand_key
-- tenancy, composite tenant FKs, timestamptz and a queued-task ledger.
CREATE TABLE IF NOT EXISTS public.rank_tracking_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  domain text NOT NULL CHECK (domain = lower(btrim(domain)) AND length(domain) BETWEEN 3 AND 253
    AND domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' AND domain NOT LIKE 'www.%'),
  location_code integer NOT NULL DEFAULT 2840 CHECK (location_code BETWEEN 1000 AND 9999999),
  language_code text NOT NULL DEFAULT 'en' CHECK (language_code ~ '^[a-z]{2,3}(-[A-Za-z]{2,4})?$'),
  location_name text CHECK (location_name IS NULL OR length(location_name) BETWEEN 1 AND 200),
  devices text NOT NULL DEFAULT 'mobile' CHECK (devices IN ('both','desktop','mobile')),
  serp_depth integer NOT NULL DEFAULT 40 CHECK (serp_depth BETWEEN 10 AND 100 AND serp_depth % 10 = 0),
  schedule_interval text NOT NULL DEFAULT 'weekly' CHECK (schedule_interval IN ('daily','weekly','monthly','manual')),
  is_active boolean NOT NULL DEFAULT true,
  last_checked_at timestamptz,
  next_check_at timestamptz,
  last_skip_reason text CHECK (last_skip_reason IS NULL OR last_skip_reason ~ '^[a-z_]{1,40}$'),
  last_skip_at timestamptz,
  approved_max_usd numeric(12,6) CHECK (approved_max_usd IS NULL OR approved_max_usd > 0),
  approval_id uuid REFERENCES public.price_approvals(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rank_tracking_configs_manual_unscheduled CHECK (schedule_interval <> 'manual' OR next_check_at IS NULL),
  CONSTRAINT rank_tracking_configs_id_brand UNIQUE (id, brand_key)
);
COMMENT ON COLUMN public.rank_tracking_configs.location_name IS 'Canonical DataForSEO location_name (city/county/region) for a local tracker; NULL = country-level.';
COMMENT ON COLUMN public.rank_tracking_configs.approved_max_usd IS 'Approved maximum per scheduled check (F09 action rank_tracking.config.save). NULL = scheduled checks skip with approval_missing.';
CREATE UNIQUE INDEX IF NOT EXISTS rank_tracking_configs_national_idx
  ON public.rank_tracking_configs (brand_key, domain, location_code, language_code) WHERE location_name IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rank_tracking_configs_local_idx
  ON public.rank_tracking_configs (brand_key, domain, location_code, language_code, location_name) WHERE location_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS rank_tracking_configs_brand_active_idx
  ON public.rank_tracking_configs (brand_key, is_active, created_at);
CREATE INDEX IF NOT EXISTS rank_tracking_configs_due_idx
  ON public.rank_tracking_configs (next_check_at, id) WHERE is_active AND schedule_interval <> 'manual';
DROP TRIGGER IF EXISTS rank_tracking_configs_touch ON public.rank_tracking_configs;
CREATE TRIGGER rank_tracking_configs_touch BEFORE UPDATE ON public.rank_tracking_configs
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.rank_tracking_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  config_id uuid NOT NULL,
  keyword text NOT NULL CHECK (keyword = btrim(keyword) AND length(keyword) BETWEEN 1 AND 200),
  match_case boolean NOT NULL DEFAULT false,
  search_volume integer CHECK (search_volume IS NULL OR search_volume >= 0),
  keyword_difficulty smallint CHECK (keyword_difficulty IS NULL OR keyword_difficulty BETWEEN 0 AND 100),
  cpc numeric(12,4) CHECK (cpc IS NULL OR cpc >= 0),
  metrics_fetched_at timestamptz,
  metrics_source text CHECK (metrics_source IS NULL OR metrics_source IN ('cache','labs','google_ads','labs_ranked')),
  pinned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rank_tracking_keywords_config_fk FOREIGN KEY (config_id, brand_key)
    REFERENCES public.rank_tracking_configs(id, brand_key) ON DELETE CASCADE,
  CONSTRAINT rank_tracking_keywords_case CHECK (match_case OR keyword = lower(keyword)),
  CONSTRAINT rank_tracking_keywords_unique UNIQUE (config_id, keyword)
);
CREATE INDEX IF NOT EXISTS rank_tracking_keywords_brand_idx ON public.rank_tracking_keywords (brand_key, config_id);

CREATE TABLE IF NOT EXISTS public.rank_check_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  config_id uuid NOT NULL,
  job_id uuid,                                  -- F01 jobs.id; no FK (jobs are pruned after 30 days)
  trigger text NOT NULL CHECK (trigger IN ('manual','scheduled')),
  method text NOT NULL CHECK (method IN ('live','queued')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  phase text CHECK (phase IS NULL OR phase IN ('checking','rechecking','finishing')),
  domain text NOT NULL,                         -- frozen copy of the config at start (deterministic replay)
  location_code integer NOT NULL,
  language_code text NOT NULL,
  location_name text,
  devices text NOT NULL CHECK (devices IN ('both','desktop','mobile')),
  serp_depth integer NOT NULL CHECK (serp_depth BETWEEN 10 AND 100),
  keyword_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(keyword_ids) <= 1000),
  is_subset_run boolean NOT NULL DEFAULT false,
  keywords_total integer NOT NULL DEFAULT 0 CHECK (keywords_total BETWEEN 0 AND 1000),
  keywords_checked integer NOT NULL DEFAULT 0 CHECK (keywords_checked BETWEEN 0 AND 1000),
  approved_max_usd numeric(12,6) NOT NULL CHECK (approved_max_usd > 0),
  reserved_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,60}$'),
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 500),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT rank_check_runs_config_fk FOREIGN KEY (config_id, brand_key)
    REFERENCES public.rank_tracking_configs(id, brand_key) ON DELETE CASCADE,
  CONSTRAINT rank_check_runs_id_brand UNIQUE (id, brand_key),
  CONSTRAINT rank_check_runs_reserve_within_max CHECK (reserved_usd <= approved_max_usd)
);
COMMENT ON COLUMN public.rank_check_runs.reserved_usd IS 'Sum of step estimates reserved by rank_check_reserve; refuses beyond approved_max_usd (run-level cap).';
CREATE INDEX IF NOT EXISTS rank_check_runs_config_idx ON public.rank_check_runs (config_id, started_at DESC);
CREATE INDEX IF NOT EXISTS rank_check_runs_brand_idx ON public.rank_check_runs (brand_key, started_at DESC);
CREATE INDEX IF NOT EXISTS rank_check_runs_started_idx ON public.rank_check_runs (started_at);
CREATE UNIQUE INDEX IF NOT EXISTS rank_check_runs_one_active_per_config_idx
  ON public.rank_check_runs (config_id) WHERE status IN ('pending','running');

CREATE TABLE IF NOT EXISTS public.rank_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  -- No FK to rank_tracking_keywords, on purpose (OpenSEO app.schema.ts:349-351):
  -- history survives removing a keyword from tracking.
  tracking_keyword_id uuid NOT NULL,
  keyword text NOT NULL CHECK (length(keyword) BETWEEN 1 AND 200),
  device text NOT NULL CHECK (device IN ('desktop','mobile')),
  position integer CHECK (position IS NULL OR position BETWEEN 1 AND 700),  -- NULL = checked, not found within serp_depth
  url text CHECK (url IS NULL OR length(url) <= 2048),
  serp_features text[] NOT NULL DEFAULT '{}' CHECK (cardinality(serp_features) <= 60),
  has_ai_overview boolean GENERATED ALWAYS AS ('ai_overview' = ANY (serp_features)) STORED,
  checked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rank_snapshots_run_fk FOREIGN KEY (run_id, brand_key)
    REFERENCES public.rank_check_runs(id, brand_key) ON DELETE CASCADE,
  CONSTRAINT rank_snapshots_run_keyword_device UNIQUE (run_id, tracking_keyword_id, device)
);
COMMENT ON COLUMN public.rank_snapshots.serp_features IS 'Distinct SERP item types (e.g. ai_overview, people_also_ask). Type names only; never overview text or references.';
CREATE INDEX IF NOT EXISTS rank_snapshots_keyword_device_idx ON public.rank_snapshots (tracking_keyword_id, device, checked_at);

CREATE TABLE IF NOT EXISTS public.rank_check_tasks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  round smallint NOT NULL CHECK (round BETWEEN 0 AND 2),     -- 0 = first queued check; 1..2 = retry rounds
  tracking_keyword_id uuid NOT NULL,
  keyword text NOT NULL,
  device text NOT NULL CHECK (device IN ('desktop','mobile')),
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','posted','rejected','completed','failed','expired')),
  provider_task_id text CHECK (provider_task_id IS NULL OR length(provider_task_id) <= 100),
  position integer CHECK (position IS NULL OR position BETWEEN 1 AND 700),
  url text CHECK (url IS NULL OR length(url) <= 2048),
  serp_features text[] NOT NULL DEFAULT '{}',
  message text CHECK (message IS NULL OR length(message) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rank_check_tasks_run_fk FOREIGN KEY (run_id, brand_key)
    REFERENCES public.rank_check_runs(id, brand_key) ON DELETE CASCADE,
  CONSTRAINT rank_check_tasks_pair UNIQUE (run_id, round, tracking_keyword_id, device)
);
COMMENT ON TABLE public.rank_check_tasks IS 'F15: queued DataForSEO tasks per run and round. Replaces Workflow step outputs, which F01 caps at 64 KB.';
CREATE INDEX IF NOT EXISTS rank_check_tasks_run_round_state_idx ON public.rank_check_tasks (run_id, round, state, id);
CREATE INDEX IF NOT EXISTS rank_check_tasks_created_idx ON public.rank_check_tasks (created_at);
DROP TRIGGER IF EXISTS rank_check_tasks_touch ON public.rank_check_tasks;
CREATE TRIGGER rank_check_tasks_touch BEFORE UPDATE ON public.rank_check_tasks
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['rank_tracking_configs','rank_tracking_keywords','rank_check_runs','rank_snapshots','rank_check_tasks'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key))', t || '_read', t);
  END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
