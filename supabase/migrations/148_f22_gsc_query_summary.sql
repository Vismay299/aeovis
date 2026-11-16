-- F22: Search Console query totals for the assistant (current connection generation only). Read-only.
CREATE OR REPLACE FUNCTION public.assistant_gsc_query_summary(p_brand text, p_since date, p_min_position numeric DEFAULT NULL,
  p_max_position numeric DEFAULT NULL, p_min_impressions integer DEFAULT 0, p_query text DEFAULT NULL, p_limit integer DEFAULT 100)
RETURNS TABLE (query text, clicks bigint, impressions bigint, ctr numeric, avg_position numeric)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH conn AS (SELECT connection_generation FROM gsc_connections WHERE brand_key = p_brand AND enabled),
  agg AS (
    SELECT d.query, sum(d.clicks)::bigint AS clicks, sum(d.impressions)::bigint AS impressions,
           sum(d.position * d.impressions) AS pos_weight
      FROM gsc_daily d JOIN conn c ON c.connection_generation = d.connection_generation
     WHERE d.brand_key = p_brand AND d.date >= p_since
       AND (p_query IS NULL OR strpos(lower(d.query), lower(p_query)) > 0)
     GROUP BY d.query)
  SELECT query, clicks, impressions,
         CASE WHEN impressions > 0 THEN round(clicks::numeric / impressions, 4) END,
         CASE WHEN impressions > 0 THEN round(pos_weight::numeric / impressions, 1) END
    FROM agg
   WHERE impressions >= coalesce(p_min_impressions, 0)
     AND (p_min_position IS NULL OR (impressions > 0 AND pos_weight / impressions >= p_min_position))
     AND (p_max_position IS NULL OR (impressions > 0 AND pos_weight / impressions <= p_max_position))
   ORDER BY clicks DESC, impressions DESC, query
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 500);
$$;
REVOKE ALL ON FUNCTION public.assistant_gsc_query_summary(text,date,numeric,numeric,integer,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assistant_gsc_query_summary(text,date,numeric,numeric,integer,text,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
