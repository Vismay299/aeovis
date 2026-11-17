-- F23: assistant-written HTML reports and report templates. Customer content.
CREATE TABLE IF NOT EXISTS public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2500),
  html text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 500000),
  sanitizer_version integer NOT NULL CHECK (sanitizer_version >= 1),
  skill text CHECK (skill IS NULL OR skill ~ '^[a-z][a-z0-9-]{2,59}$'),
  skill_version text CHECK (skill_version IS NULL OR skill_version ~ '^\d+\.\d+\.\d+$'),
  template_id uuid,
  session_id uuid,
  created_by text NOT NULL CHECK (created_by IN ('assistant','app')),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  share_token text CHECK (share_token IS NULL OR share_token ~ '^[A-Za-z0-9_-]{32}$'),
  shared_at timestamptz,
  shared_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(html) = size_bytes),
  CHECK ((share_token IS NULL) = (shared_at IS NULL))
);
COMMENT ON COLUMN public.reports.html IS 'Sanitised self-contained HTML document (§6.2.2). Read only by /r and /s/<token>/raw and get_report(includeHtml).';
COMMENT ON COLUMN public.reports.template_id IS 'Template followed, if any. No FK: deleting a template must not touch reports (OpenSEO reports.schema.ts:34-37).';
COMMENT ON COLUMN public.reports.session_id IS 'Assistant session that wrote the report. No FK: sessions are pruned after 395 days idle.';
COMMENT ON COLUMN public.reports.share_token IS 'Public link capability (192 bits). NULL = private; nulling revokes.';
CREATE UNIQUE INDEX IF NOT EXISTS reports_title_idx ON public.reports (brand_key, title);
CREATE UNIQUE INDEX IF NOT EXISTS reports_share_token_idx ON public.reports (share_token) WHERE share_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS reports_list_idx ON public.reports (brand_key, updated_at DESC, id DESC) INCLUDE (size_bytes);

-- updated_at changes only with content, never with sharing (OpenSEO ReportRepository.ts:221-223).
CREATE OR REPLACE FUNCTION public.reports_touch_content() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.html IS DISTINCT FROM OLD.html OR NEW.title IS DISTINCT FROM OLD.title OR NEW.summary IS DISTINCT FROM OLD.summary
     OR NEW.skill IS DISTINCT FROM OLD.skill OR NEW.template_id IS DISTINCT FROM OLD.template_id THEN
    NEW.updated_at := now();
  END IF;
  NEW.created_by := OLD.created_by; NEW.created_by_user_id := OLD.created_by_user_id; NEW.created_at := OLD.created_at;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reports_touch ON public.reports;
CREATE TRIGGER reports_touch BEFORE UPDATE ON public.reports FOR EACH ROW EXECUTE FUNCTION public.reports_touch_content();

CREATE TABLE IF NOT EXISTS public.report_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
  instructions text NOT NULL CHECK (char_length(instructions) BETWEEN 1 AND 3000),
  created_by text NOT NULL CHECK (created_by IN ('assistant','app')),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS report_templates_name_idx ON public.report_templates (brand_key, lower(name));
DROP TRIGGER IF EXISTS report_templates_touch ON public.report_templates;
CREATE TRIGGER report_templates_touch BEFORE UPDATE ON public.report_templates
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

-- Race-safe mint: keeps the first token (OpenSEO ReportRepository.ts:224-248).
CREATE OR REPLACE FUNCTION public.set_report_share_token(p_report uuid, p_brand text, p_token text, p_user uuid)
RETURNS TABLE (share_token text, shared_at timestamptz, created boolean) LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r reports;
BEGIN
  UPDATE reports SET share_token = p_token, shared_at = now(), shared_by = p_user
   WHERE id = p_report AND brand_key = p_brand AND reports.share_token IS NULL RETURNING * INTO r;
  IF FOUND THEN RETURN QUERY SELECT r.share_token, r.shared_at, true; RETURN; END IF;
  SELECT * INTO r FROM reports WHERE id = p_report AND brand_key = p_brand;
  IF NOT FOUND THEN RAISE EXCEPTION 'report_not_found'; END IF;
  RETURN QUERY SELECT r.share_token, r.shared_at, false;
END $$;

CREATE OR REPLACE FUNCTION public.clear_report_share_token(p_report uuid, p_brand text)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  PERFORM 1 FROM reports WHERE id = p_report AND brand_key = p_brand;
  IF NOT FOUND THEN RAISE EXCEPTION 'report_not_found'; END IF;
  UPDATE reports SET share_token = NULL, shared_at = NULL, shared_by = NULL
   WHERE id = p_report AND brand_key = p_brand AND share_token IS NOT NULL;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v > 0;
END $$;

-- The public read: token → report and workspace state. Service role only.
CREATE OR REPLACE FUNCTION public.get_shared_report(p_token text)
RETURNS TABLE (id uuid, brand_key text, title text, summary text, skill text, updated_at timestamptz,
               website_host text, workspace_active boolean, sanitizer_version integer)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT r.id, r.brand_key, r.title, r.summary, r.skill, r.updated_at, b.website_host, b.is_active, r.sanitizer_version
    FROM reports r JOIN customer_brands b ON b.brand_key = r.brand_key
   WHERE r.share_token = p_token
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.report_workspace_usage(p_brand text)
RETURNS TABLE (report_count bigint, total_bytes bigint) LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT count(*)::bigint, coalesce(sum(size_bytes), 0)::bigint FROM reports WHERE brand_key = p_brand;
$$;

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reports, public.report_templates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.reports, public.report_templates TO authenticated;
GRANT ALL ON public.reports, public.report_templates TO service_role;
DROP POLICY IF EXISTS reports_read ON public.reports;
CREATE POLICY reports_read ON public.reports FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key));
DROP POLICY IF EXISTS report_templates_read ON public.report_templates;
CREATE POLICY report_templates_read ON public.report_templates FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key));
REVOKE ALL ON FUNCTION public.set_report_share_token(uuid,text,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_report_share_token(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_shared_report(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_workspace_usage(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_report_share_token(uuid,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_report_share_token(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_shared_report(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.report_workspace_usage(text) TO service_role;
NOTIFY pgrst, 'reload schema';
