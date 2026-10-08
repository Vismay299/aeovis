-- Customer accounts and brand-level isolation for UAT.
-- Existing operator APIs move to SUPABASE_SERVICE_ROLE_KEY before this is
-- applied. The service role is server-only; customers use Auth JWTs and RLS.

CREATE TABLE IF NOT EXISTS customer_brands (
  brand_key text PRIMARY KEY,
  display_name text NOT NULL,
  website text NOT NULL,
  website_host text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_brands_key_nonempty CHECK (btrim(brand_key) <> ''),
  CONSTRAINT customer_brands_host_nonempty CHECK (btrim(website_host) <> '')
);

CREATE TABLE IF NOT EXISTS customer_brand_memberships (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, brand_key)
);

-- Legacy app tables store human-readable brand labels. This registry makes
-- those labels unique across tenants so two display names can never overlap
-- the RLS scope for historical rows.
CREATE TABLE IF NOT EXISTS customer_brand_aliases (
  alias text PRIMARY KEY CHECK (alias = lower(btrim(alias)) AND btrim(alias) <> ''),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_brand_memberships_brand_idx
  ON public.customer_brand_memberships (brand_key, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS customer_brands_website_host_key
  ON public.customer_brands (website_host);

ALTER TABLE public.customer_brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_brand_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_brand_aliases ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT lower(btrim(alias))
      FROM public.customer_brands AS b
      CROSS JOIN LATERAL unnest(array_append(b.aliases, b.brand_key)) AS aliases(alias)
     WHERE alias IS NOT NULL AND btrim(alias) <> ''
     GROUP BY lower(btrim(alias))
    HAVING count(DISTINCT b.brand_key) > 1
  ) THEN
    RAISE EXCEPTION 'Customer brand aliases overlap across tenants; resolve them before applying migration 023.';
  END IF;
END $$;

INSERT INTO public.customer_brand_aliases (alias, brand_key)
SELECT DISTINCT lower(btrim(alias)), b.brand_key
  FROM public.customer_brands AS b
  CROSS JOIN LATERAL unnest(array_append(b.aliases, b.brand_key)) AS aliases(alias)
 WHERE alias IS NOT NULL AND btrim(alias) <> ''
ON CONFLICT (alias) DO NOTHING;

-- These SECURITY DEFINER predicates read membership data without creating an
-- RLS recursion through customer_brand_memberships. Their result discloses no
-- other tenant's rows and callers cannot use them to mutate membership.
CREATE OR REPLACE FUNCTION customer_can_access_brand(p_brand text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.customer_brand_memberships AS m
      JOIN public.customer_brands AS b ON b.brand_key = m.brand_key
      JOIN public.customer_brand_aliases AS a ON a.brand_key = b.brand_key
     WHERE m.user_id = (SELECT auth.uid())
       AND b.is_active
       AND lower(btrim(p_brand)) = a.alias
  );
$$;

CREATE OR REPLACE FUNCTION customer_can_access_scan(p_brand text, p_url text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.customer_can_access_brand(p_brand)
      OR EXISTS (
        SELECT 1
          FROM public.customer_brand_memberships AS m
          JOIN public.customer_brands AS b ON b.brand_key = m.brand_key
         WHERE m.user_id = (SELECT auth.uid())
           AND b.is_active
           AND regexp_replace(
                 lower(split_part(split_part(regexp_replace(coalesce(p_url, ''), '^https?://', '', 'i'), '/', 1), ':', 1)),
                 '^www\.', ''
               ) = b.website_host
      );
$$;

REVOKE ALL ON FUNCTION public.customer_can_access_brand(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.customer_can_access_scan(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_can_access_brand(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_can_access_scan(text, text) TO authenticated;

-- Remove every existing public/anonymous policy and direct grant. The legacy
-- Next.js APIs use the server-side service-role client after this migration;
-- the customer API uses authenticated JWTs and the scoped SELECT policies below.
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND ('anon' = ANY (roles) OR 'public' = ANY (roles))
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
  END LOOP;
END $$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
GRANT ALL ON public.customer_brands, public.customer_brand_memberships, public.customer_brand_aliases TO service_role;

-- Public scan creation, workers, and all operator APIs are server mediated.
-- Browser clients receive read-only access to tenant rows, always filtered by
-- the membership of auth.uid(). No customer write grants are issued here.
GRANT SELECT ON public.customer_brands, public.customer_brand_memberships TO authenticated;
DROP POLICY IF EXISTS customer_brand_memberships_read_self ON public.customer_brand_memberships;
CREATE POLICY customer_brand_memberships_read_self ON public.customer_brand_memberships
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS customer_brands_read_member ON public.customer_brands;
CREATE POLICY customer_brands_read_member ON public.customer_brands
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.customer_brand_memberships AS m
     WHERE m.brand_key = customer_brands.brand_key
       AND m.user_id = (SELECT auth.uid())
       AND customer_brands.is_active
  ));

GRANT SELECT ON
  public.scans,
  public.scan_jobs,
  public.brand_prompts,
  public.content_events,
  public.content_jobs,
  public.content_items,
  public.content_feedback,
  public.brand_briefs,
  public.content_lessons,
  public.content_agents,
  public.knowledge_blocks,
  public.prompt_results,
  public.result_brands,
  public.citations,
  public.brand_metrics_daily,
  public.scan_schedules,
  public.topics,
  public.content_runs,
  public.scan_runs,
  public.gsc_connections,
  public.gsc_daily
TO authenticated;

DO $$
DECLARE
  t text;
  brand_tables text[] := ARRAY[
    'brand_prompts', 'content_events', 'content_jobs', 'content_items',
    'content_feedback', 'brand_briefs', 'content_lessons', 'content_agents',
    'knowledge_blocks', 'prompt_results', 'result_brands', 'citations',
    'brand_metrics_daily', 'scan_schedules', 'topics', 'content_runs',
    'scan_runs', 'gsc_connections', 'gsc_daily'
  ];
BEGIN
  FOREACH t IN ARRAY brand_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS customer_read_own_brand ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY customer_read_own_brand ON public.%I FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand))',
      t
    );
  END LOOP;
END $$;

ALTER TABLE public.scans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_read_own_brand ON public.scans;
CREATE POLICY customer_read_own_brand ON public.scans
  FOR SELECT TO authenticated
  USING (public.customer_can_access_scan(brand, url));

ALTER TABLE public.scan_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_read_own_brand ON public.scan_jobs;
CREATE POLICY customer_read_own_brand ON public.scan_jobs
  FOR SELECT TO authenticated
  USING (public.customer_can_access_scan(brand, url));

ALTER TABLE public.crawlability_audits ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.crawlability_audits TO authenticated;
DROP POLICY IF EXISTS customer_read_own_brand ON public.crawlability_audits;
CREATE POLICY customer_read_own_brand ON public.crawlability_audits
  FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(domain));

-- Operational tables have no customer grants or policies. The private evidence
-- bucket is available only to server-side signed-URL routes and workers.
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT policyname FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname LIKE 'probe-evidence anon %'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', p.policyname);
  END LOOP;
END $$;
REVOKE ALL PRIVILEGES ON TABLE storage.objects FROM anon, authenticated;
