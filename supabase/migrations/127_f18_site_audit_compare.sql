-- 127: F18 compare two audits of the same workspace. Safe to re-run.
CREATE OR REPLACE FUNCTION public.site_audit_compare(p_brand_key text, p_base uuid, p_head uuid, p_sample integer DEFAULT 100)
RETURNS TABLE (issue_type text, severity text, base_pages bigint, head_pages bigint,
               new_pages text[], fixed_pages text[])
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH ok AS (
    SELECT 1 FROM site_audits b, site_audits h
     WHERE b.id = p_base AND h.id = p_head AND b.brand_key = p_brand_key AND h.brand_key = p_brand_key),
  b AS (SELECT DISTINCT issue_type, severity, page_url FROM site_audit_issues WHERE audit_id = p_base AND EXISTS (SELECT 1 FROM ok)),
  h AS (SELECT DISTINCT issue_type, severity, page_url FROM site_audit_issues WHERE audit_id = p_head AND EXISTS (SELECT 1 FROM ok)),
  types AS (SELECT issue_type, max(severity) AS severity FROM (SELECT issue_type, severity FROM b UNION ALL SELECT issue_type, severity FROM h) x GROUP BY issue_type)
  SELECT t.issue_type, t.severity,
         (SELECT count(*) FROM b WHERE b.issue_type = t.issue_type),
         (SELECT count(*) FROM h WHERE h.issue_type = t.issue_type),
         ARRAY(SELECT h.page_url FROM h WHERE h.issue_type = t.issue_type
                 AND NOT EXISTS (SELECT 1 FROM b WHERE b.issue_type = h.issue_type AND b.page_url = h.page_url)
               ORDER BY h.page_url LIMIT p_sample),
         ARRAY(SELECT b.page_url FROM b WHERE b.issue_type = t.issue_type
                 AND NOT EXISTS (SELECT 1 FROM h WHERE h.issue_type = b.issue_type AND h.page_url = b.page_url)
               ORDER BY b.page_url LIMIT p_sample)
    FROM types t
$$;
REVOKE ALL ON FUNCTION public.site_audit_compare(text,uuid,uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.site_audit_compare(text,uuid,uuid,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
