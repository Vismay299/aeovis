-- 125: F18 site audit — audits, pages, issues, Lighthouse results, crawl scratch tables (port of OpenSEO's
-- audit.schema.ts and AuditScratchpad SQLite to Postgres). Safe to re-run.

CREATE TABLE IF NOT EXISTS public.site_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  job_id uuid,                                   -- F01 jobs.id; no FK because jobs are pruned after 30 days
  started_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  trigger text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','baseline','tool')),
  requested_url text NOT NULL CHECK (length(requested_url) <= 2048),
  start_url text NOT NULL CHECK (length(start_url) <= 2048),
  start_host text NOT NULL CHECK (start_host ~ '^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$'),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','partial','failed','cancelled')),
  current_phase text NOT NULL DEFAULT 'queued'
    CHECK (current_phase IN ('queued','starting','discovery','crawling','lighthouse','finalizing',
                             'completed','failed','cancelled')),
  max_pages integer NOT NULL CHECK (max_pages BETWEEN 10 AND 10000),
  run_lighthouse boolean NOT NULL DEFAULT false,
  render_javascript boolean NOT NULL DEFAULT false,
  site_platform text CHECK (site_platform IN ('shopify')),
  crawler_credential_id uuid,                    -- P9; FK added by 128
  pages_crawled integer NOT NULL DEFAULT 0 CHECK (pages_crawled >= 0),
  pages_total integer NOT NULL DEFAULT 0 CHECK (pages_total >= 0),
  pages_seen integer NOT NULL DEFAULT 0 CHECK (pages_seen >= 0),
  pages_abandoned integer NOT NULL DEFAULT 0 CHECK (pages_abandoned >= 0),
  crawl_completed boolean,                       -- frontier exhausted before max_pages; NULL until known
  rate_limited boolean NOT NULL DEFAULT false,
  discovery_truncated boolean NOT NULL DEFAULT false,
  link_targets_stored integer NOT NULL DEFAULT 0,
  link_graph_complete boolean NOT NULL DEFAULT true,
  window_hint integer NOT NULL DEFAULT 2 CHECK (window_hint BETWEEN 1 AND 8),
  throttle_state jsonb,
  lighthouse_total integer NOT NULL DEFAULT 0,
  lighthouse_completed integer NOT NULL DEFAULT 0,
  lighthouse_failed integer NOT NULL DEFAULT 0,
  lighthouse_approved_usd numeric(12,6),
  robots_status text CHECK (robots_status IN ('found','missing','error','unreachable','malformed')),
  robots_http_status integer,
  robots_txt text CHECK (robots_txt IS NULL OR octet_length(robots_txt) <= 512000),
  ai_access jsonb,       -- [{name,operator,platform,purpose,status,matchedGroup,reason,unknown}] for the start path
  llms_txt jsonb,        -- {status:'present'|'missing'|'invalid'|'unreachable', httpStatus, contentType, firstLine}
  render_hold_id uuid,
  render_approved_usd numeric(12,6),
  render_attempts integer NOT NULL DEFAULT 0,
  render_billed integer NOT NULL DEFAULT 0,
  render_settled_at timestamptz,
  approved_max_usd numeric(12,6),
  price_quote jsonb,
  error_code text CHECK (error_code IS NULL OR error_code IN
    ('step_timeout','step_attempts_exhausted','billed_step_interrupted','db_error','job_lost','start_failed',
     'start_url_off_site','url_blocked','url_unreachable','no_pages','cancelled','unknown')),
  error_detail text CHECK (error_detail IS NULL OR length(error_detail) <= 500),
  failed_phase text,
  cancel_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN public.site_audits.pages_total IS 'Pages expected: min(frontier seen, max_pages) while running; pages crawled when finished.';
COMMENT ON COLUMN public.site_audits.robots_txt IS 'robots.txt text as read at discovery (≤ 500 KiB, RFC 9309); re-parsed on job replay so rules never change mid-audit.';
CREATE INDEX IF NOT EXISTS site_audits_brand_created_idx ON public.site_audits (brand_key, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS site_audits_one_active_idx ON public.site_audits (brand_key)
  WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS site_audits_active_host_idx ON public.site_audits (start_host)
  WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS site_audits_active_started_idx ON public.site_audits (created_at)
  WHERE status IN ('queued','running');
DROP TRIGGER IF EXISTS site_audits_touch ON public.site_audits;
CREATE TRIGGER site_audits_touch BEFORE UPDATE ON public.site_audits
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.site_audit_pages (
  id uuid PRIMARY KEY,                           -- deterministicUuid(auditId, url)
  audit_id uuid NOT NULL REFERENCES public.site_audits(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  url text NOT NULL CHECK (length(url) <= 2048),
  url_hash bigint GENERATED ALWAYS AS (hashtextextended(url, 0)) STORED,
  status_code integer,
  fetch_class text NOT NULL DEFAULT 'ok' CHECK (fetch_class IN ('ok','blocked','rate_limited','error')),
  redirect_url text CHECK (redirect_url IS NULL OR length(redirect_url) <= 2048),
  title text, meta_description text, canonical_url text, header_canonical_url text,
  robots_meta text, x_robots_tag text, og_title text, og_description text, og_image text,
  h1_count smallint NOT NULL DEFAULT 0, h2_count smallint NOT NULL DEFAULT 0, h3_count smallint NOT NULL DEFAULT 0,
  h4_count smallint NOT NULL DEFAULT 0, h5_count smallint NOT NULL DEFAULT 0, h6_count smallint NOT NULL DEFAULT 0,
  word_count integer NOT NULL DEFAULT 0,
  content_hash text,
  images_total integer NOT NULL DEFAULT 0,
  images_missing_alt integer NOT NULL DEFAULT 0,
  internal_link_count integer NOT NULL DEFAULT 0,
  external_link_count integer NOT NULL DEFAULT 0,
  has_structured_data boolean NOT NULL DEFAULT false,
  structured_data_types text[] NOT NULL DEFAULT '{}',
  hreflang jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{lang, href}] ≤ 50 entries
  is_indexable boolean NOT NULL DEFAULT false,
  crawl_depth integer,                           -- NULL = reached only through the sitemap
  in_sitemap boolean NOT NULL DEFAULT false,
  response_time_ms integer,
  rendered boolean NOT NULL DEFAULT false,
  crawled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_audit_pages_audit_url_key UNIQUE (audit_id, url)
);
CREATE INDEX IF NOT EXISTS site_audit_pages_feed_idx ON public.site_audit_pages (audit_id, crawled_at DESC);
CREATE INDEX IF NOT EXISTS site_audit_pages_hash_idx ON public.site_audit_pages (audit_id, url_hash);
CREATE INDEX IF NOT EXISTS site_audit_pages_redirect_idx ON public.site_audit_pages (audit_id, redirect_url)
  WHERE redirect_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS site_audit_pages_status_idx ON public.site_audit_pages (audit_id, status_code);

CREATE TABLE IF NOT EXISTS public.site_audit_issues (
  id uuid PRIMARY KEY,                           -- deterministicUuid(auditId, pageUrl, issueType, dedupeKey)
  audit_id uuid NOT NULL REFERENCES public.site_audits(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  page_id uuid REFERENCES public.site_audit_pages(id) ON DELETE CASCADE,   -- NULL for site-level issues
  page_url text NOT NULL CHECK (length(page_url) <= 2048),
  issue_type text NOT NULL CHECK (issue_type ~ '^[a-z][a-z0-9-]{1,60}$'),
  severity text NOT NULL CHECK (severity IN ('critical','warning','info')),
  details jsonb CHECK (details IS NULL OR pg_column_size(details) <= 8192),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_audit_issues_type_idx ON public.site_audit_issues (audit_id, issue_type);
CREATE INDEX IF NOT EXISTS site_audit_issues_page_idx ON public.site_audit_issues (page_id);

CREATE TABLE IF NOT EXISTS public.site_audit_lighthouse (
  id uuid PRIMARY KEY,                           -- deterministicUuid(auditId, pageId, strategy)
  audit_id uuid NOT NULL REFERENCES public.site_audits(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES public.site_audit_pages(id) ON DELETE CASCADE,
  strategy text NOT NULL CHECK (strategy IN ('mobile','desktop')),
  performance_score smallint CHECK (performance_score BETWEEN 0 AND 100),
  accessibility_score smallint CHECK (accessibility_score BETWEEN 0 AND 100),
  best_practices_score smallint CHECK (best_practices_score BETWEEN 0 AND 100),
  seo_score smallint CHECK (seo_score BETWEEN 0 AND 100),
  lcp_ms real, cls real, inp_ms real, ttfb_ms real,
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 500),
  payload_path text,                             -- site-audit-lighthouse/<brand>/<audit>/<page>-<strategy>.json
  payload_bytes integer,
  cost_usd numeric(12,6),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_audit_lighthouse_one UNIQUE (audit_id, page_id, strategy)
);
CREATE INDEX IF NOT EXISTS site_audit_lighthouse_audit_idx ON public.site_audit_lighthouse (audit_id);

-- Scratch tables: the Durable Object's frontier and link edges. Service-only; dropped at finalize.
CREATE TABLE IF NOT EXISTS public.site_audit_frontier (
  audit_id uuid NOT NULL REFERENCES public.site_audits(id) ON DELETE CASCADE,
  url text NOT NULL CHECK (length(url) <= 2048),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  depth integer,
  source text NOT NULL CHECK (source IN ('link','sitemap')),
  in_sitemap boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','crawled','abandoned')),
  chunk_no integer,
  PRIMARY KEY (audit_id, url)
);
CREATE INDEX IF NOT EXISTS site_audit_frontier_claim_idx ON public.site_audit_frontier (audit_id, state, source, seq);
CREATE INDEX IF NOT EXISTS site_audit_frontier_chunk_idx ON public.site_audit_frontier (audit_id, chunk_no)
  WHERE chunk_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.site_audit_links (
  audit_id uuid NOT NULL REFERENCES public.site_audits(id) ON DELETE CASCADE,
  page_id uuid NOT NULL,
  url text NOT NULL,
  target_hashes bigint[] NOT NULL,               -- hashtextextended(target_url, 0); ≤ 500 per page
  PRIMARY KEY (audit_id, page_id)
);
COMMENT ON TABLE public.site_audit_links IS 'Internal link edges as 64-bit URL hashes (8 bytes each) instead of URL text, so a 10,000-page audit stays under ~40 MB worst case.';

-- RLS: customers read their workspace's audit data; writes are service-role only (conventions §6.8).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_audits','site_audit_pages','site_audit_issues','site_audit_lighthouse'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key))', t || '_read', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon, authenticated', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['site_audit_frontier','site_audit_links'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

INSERT INTO storage.buckets (id, name, public)
VALUES (
  'site-audit-lighthouse',
  'site-audit-lighthouse',
  false
)
ON CONFLICT (id) DO NOTHING;
NOTIFY pgrst, 'reload schema';
