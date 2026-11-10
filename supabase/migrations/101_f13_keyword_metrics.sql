-- F13: shared keyword market data. Public DataForSEO metrics per keyword and
-- national market. Holds no tenant data and no brand_key (deviation, see
-- "Deviations from conventions"). Service role only; customers read metrics
-- only through routes that join them onto their own saved keywords.
CREATE TABLE IF NOT EXISTS public.keyword_metrics (
  keyword text NOT NULL CHECK (keyword = btrim(keyword) AND length(keyword) BETWEEN 1 AND 200),
  location_code integer NOT NULL CHECK (location_code BETWEEN 1000 AND 9999999),
  language_code text NOT NULL CHECK (language_code ~ '^[a-z]{2,3}(-[A-Za-z]{2,4})?$'),
  search_volume integer CHECK (search_volume IS NULL OR search_volume >= 0),
  cpc numeric(12,4) CHECK (cpc IS NULL OR cpc >= 0),
  competition numeric(6,5) CHECK (competition IS NULL OR competition BETWEEN 0 AND 1),
  keyword_difficulty smallint CHECK (keyword_difficulty IS NULL OR keyword_difficulty BETWEEN 0 AND 100),
  intent text CHECK (intent IS NULL OR intent IN ('informational','commercial','transactional','navigational','unknown')),
  monthly_searches jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(monthly_searches) = 'array' AND jsonb_array_length(monthly_searches) <= 48),
  source text NOT NULL CHECK (source IN ('labs','google_ads','labs_ranked')),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (keyword, location_code, language_code)
);
COMMENT ON COLUMN public.keyword_metrics.source IS 'labs = keyword_overview or research rows; google_ads = Ads search volume; labs_ranked = partial row from F14 ranked keywords (volume, CPC, difficulty only).';
CREATE INDEX IF NOT EXISTS keyword_metrics_fetched_idx ON public.keyword_metrics (fetched_at);

ALTER TABLE public.keyword_metrics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.keyword_metrics FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.keyword_metrics TO service_role;

-- Batch upsert. Partial sources never erase richer stored fields.
CREATE OR REPLACE FUNCTION public.upsert_keyword_metrics(p_rows jsonb) RETURNS integer
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 1000 THEN
    RAISE EXCEPTION 'keyword_metrics_invalid:rows';
  END IF;
  INSERT INTO keyword_metrics AS m (keyword, location_code, language_code, search_volume, cpc, competition,
      keyword_difficulty, intent, monthly_searches, source, fetched_at)
  SELECT DISTINCT ON (r.keyword, r.location_code, r.language_code)
         r.keyword, r.location_code, r.language_code, r.search_volume, r.cpc, r.competition,
         r.keyword_difficulty, r.intent, coalesce(r.monthly_searches, '[]'::jsonb), r.source, now()
    FROM jsonb_to_recordset(p_rows) AS r(keyword text, location_code integer, language_code text,
         search_volume integer, cpc numeric, competition numeric, keyword_difficulty smallint,
         intent text, monthly_searches jsonb, source text)
  ON CONFLICT (keyword, location_code, language_code) DO UPDATE SET
    search_volume = excluded.search_volume,
    cpc = excluded.cpc,
    competition = CASE WHEN excluded.source = 'labs_ranked' THEN m.competition ELSE excluded.competition END,
    keyword_difficulty = coalesce(excluded.keyword_difficulty, m.keyword_difficulty),
    intent = CASE WHEN excluded.source = 'labs_ranked' THEN m.intent ELSE coalesce(excluded.intent, m.intent) END,
    monthly_searches = CASE WHEN jsonb_array_length(excluded.monthly_searches) = 0
                            THEN m.monthly_searches ELSE excluded.monthly_searches END,
    source = CASE WHEN excluded.source = 'labs_ranked' THEN m.source ELSE excluded.source END,
    fetched_at = now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- Retention: metrics older than p_before that no workspace has saved.
CREATE OR REPLACE FUNCTION public.prune_keyword_metrics(p_before timestamptz, p_limit integer) RETURNS integer
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM keyword_metrics m WHERE (m.keyword, m.location_code, m.language_code) IN (
    SELECT k.keyword, k.location_code, k.language_code FROM keyword_metrics k
     WHERE k.fetched_at < p_before
       AND NOT EXISTS (SELECT 1 FROM saved_keywords s WHERE s.keyword = k.keyword
                         AND s.location_code = k.location_code AND s.language_code = k.language_code)
     LIMIT greatest(1, least(p_limit, 10000)));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.upsert_keyword_metrics(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_keyword_metrics(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_keyword_metrics(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_keyword_metrics(timestamptz, integer) TO service_role;
