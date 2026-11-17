-- F23: anonymous daily view counts per public link. No IP, user agent or cookie is stored.
CREATE TABLE IF NOT EXISTS public.report_share_views (
  report_id uuid NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  day date NOT NULL,
  share_pseudonym text NOT NULL CHECK (share_pseudonym ~ '^share:[0-9a-f]{16}$'),
  browser_views integer NOT NULL DEFAULT 0 CHECK (browser_views >= 0),
  other_views integer NOT NULL DEFAULT 0 CHECK (other_views >= 0),
  PRIMARY KEY (report_id, day, share_pseudonym)
);
COMMENT ON COLUMN public.report_share_views.share_pseudonym IS '"share:" + first 16 hex of sha256(token). Identifies the link, never a person.';
CREATE INDEX IF NOT EXISTS report_share_views_day_idx ON public.report_share_views (day);

CREATE OR REPLACE FUNCTION public.record_report_view(p_report uuid, p_brand text, p_pseudonym text, p_from_browser boolean)
RETURNS void LANGUAGE sql SET search_path = public AS $$
  INSERT INTO report_share_views (report_id, brand_key, day, share_pseudonym, browser_views, other_views)
  VALUES (p_report, p_brand, (now() AT TIME ZONE 'utc')::date, p_pseudonym,
          CASE WHEN p_from_browser THEN 1 ELSE 0 END, CASE WHEN p_from_browser THEN 0 ELSE 1 END)
  ON CONFLICT (report_id, day, share_pseudonym) DO UPDATE
    SET browser_views = report_share_views.browser_views + EXCLUDED.browser_views,
        other_views = report_share_views.other_views + EXCLUDED.other_views;
$$;

CREATE OR REPLACE FUNCTION public.prune_report_share_views(p_before date, p_limit integer DEFAULT 5000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (SELECT report_id, day, share_pseudonym FROM report_share_views WHERE day < p_before LIMIT p_limit)
  DELETE FROM report_share_views s USING old
   WHERE s.report_id = old.report_id AND s.day = old.day AND s.share_pseudonym = old.share_pseudonym;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;

ALTER TABLE public.report_share_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.report_share_views FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.report_share_views TO authenticated;
GRANT ALL ON public.report_share_views TO service_role;
DROP POLICY IF EXISTS report_share_views_read ON public.report_share_views;
CREATE POLICY report_share_views_read ON public.report_share_views FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));
REVOKE ALL ON FUNCTION public.record_report_view(uuid,text,text,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_report_share_views(date,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_report_view(uuid,text,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_report_share_views(date,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
