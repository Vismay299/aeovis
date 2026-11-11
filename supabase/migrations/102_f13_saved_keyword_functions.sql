-- F13: atomic saved-keyword operations (port of the repository logic in
-- openseo:src/server/features/keywords/repositories/*.ts). Keyword and tag
-- normalisation happen in TypeScript; these functions trust normalised input.
CREATE OR REPLACE FUNCTION public.f13_like_escape(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT replace(replace(replace(p, '\', '\\'), '%', '\%'), '_', '\_') $$;

-- p_tags: [{"name": "Oversized tees", "normalized": "oversized tees"}]
CREATE OR REPLACE FUNCTION public.f13_upsert_tags(p_brand text, p_tags jsonb) RETURNS uuid[]
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF jsonb_typeof(p_tags) IS DISTINCT FROM 'array' OR jsonb_array_length(p_tags) > 60 THEN
    RAISE EXCEPTION 'saved_keywords_invalid:tags';
  END IF;
  INSERT INTO saved_keyword_tags(brand_key, name, normalized_name)
    SELECT p_brand, t->>'name', t->>'normalized' FROM jsonb_array_elements(p_tags) t
  ON CONFLICT (brand_key, normalized_name) DO NOTHING;
  IF (SELECT count(*) FROM saved_keyword_tags WHERE brand_key = p_brand) > 200 THEN
    RAISE EXCEPTION 'saved_keywords_cap:tags';
  END IF;
  RETURN (SELECT coalesce(array_agg(id ORDER BY normalized_name), '{}') FROM saved_keyword_tags
           WHERE brand_key = p_brand
             AND normalized_name IN (SELECT t->>'normalized' FROM jsonb_array_elements(p_tags) t));
END $$;

CREATE OR REPLACE FUNCTION public.save_keywords(p_brand text, p_keywords text[], p_location integer,
  p_language text, p_tags jsonb DEFAULT '[]'::jsonb, p_tag_mode text DEFAULT 'append', p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_ids uuid[]; v_created integer; v_tag_ids uuid[];
BEGIN
  IF p_tag_mode NOT IN ('append','replace') THEN RAISE EXCEPTION 'saved_keywords_invalid:tag_mode'; END IF;
  IF p_tag_mode = 'replace' AND jsonb_array_length(coalesce(p_tags,'[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'saved_keywords_invalid:replace_requires_tags';
  END IF;
  IF coalesce(array_length(p_keywords, 1), 0) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'saved_keywords_invalid:keywords';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM customer_brands WHERE brand_key = p_brand AND is_active) THEN
    RAISE EXCEPTION 'saved_keywords_invalid:brand';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('f13_saved_keywords:' || p_brand));
  INSERT INTO saved_keywords(brand_key, keyword, location_code, language_code, created_by)
    SELECT p_brand, k, p_location, p_language, p_actor FROM unnest(p_keywords) AS k
  ON CONFLICT ON CONSTRAINT saved_keywords_unique_market DO NOTHING;
  GET DIAGNOSTICS v_created = ROW_COUNT;
  IF (SELECT count(*) FROM saved_keywords WHERE brand_key = p_brand) > 5000 THEN
    RAISE EXCEPTION 'saved_keywords_cap:keywords';
  END IF;
  SELECT coalesce(array_agg(id ORDER BY keyword), '{}') INTO v_ids FROM saved_keywords
   WHERE brand_key = p_brand AND location_code = p_location AND language_code = p_language
     AND keyword = ANY(p_keywords);
  IF jsonb_array_length(coalesce(p_tags,'[]'::jsonb)) > 0 THEN
    v_tag_ids := f13_upsert_tags(p_brand, p_tags);
    INSERT INTO saved_keyword_tag_assignments(brand_key, saved_keyword_id, tag_id)
      SELECT p_brand, s, t FROM unnest(v_ids) s CROSS JOIN unnest(v_tag_ids) t
    ON CONFLICT DO NOTHING;
    IF p_tag_mode = 'replace' THEN
      DELETE FROM saved_keyword_tag_assignments
       WHERE brand_key = p_brand AND saved_keyword_id = ANY(v_ids) AND NOT (tag_id = ANY(v_tag_ids));
    END IF;
  END IF;
  RETURN jsonb_build_object('savedKeywordIds', to_jsonb(v_ids), 'created', v_created);
END $$;

CREATE OR REPLACE FUNCTION public.f13_filtered_saved_keywords(p_brand text, p_filters jsonb)
RETURNS TABLE (id uuid, keyword text, location_code integer, language_code text, created_at timestamptz,
  search_volume integer, cpc numeric, competition numeric, keyword_difficulty smallint, intent text,
  monthly_searches jsonb, fetched_at timestamptz)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT s.id, s.keyword, s.location_code, s.language_code, s.created_at,
         m.search_volume, m.cpc, m.competition, m.keyword_difficulty, m.intent, m.monthly_searches, m.fetched_at
    FROM saved_keywords s
    LEFT JOIN keyword_metrics m
      ON m.keyword = s.keyword AND m.location_code = s.location_code AND m.language_code = s.language_code
   WHERE s.brand_key = p_brand
     AND (nullif(btrim(coalesce(p_filters->>'search', '')), '') IS NULL
          OR lower(s.keyword) LIKE '%' || f13_like_escape(lower(btrim(p_filters->>'search'))) || '%' ESCAPE '\')
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(p_filters->'includeTerms', '[]'::jsonb)) AS t(term)
                      WHERE btrim(t.term) <> ''
                        AND lower(s.keyword) NOT LIKE '%' || f13_like_escape(lower(btrim(t.term))) || '%' ESCAPE '\')
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(p_filters->'excludeTerms', '[]'::jsonb)) AS t(term)
                      WHERE btrim(t.term) <> ''
                        AND lower(s.keyword) LIKE '%' || f13_like_escape(lower(btrim(t.term))) || '%' ESCAPE '\')
     AND (p_filters->>'minVolume' IS NULL OR m.search_volume >= (p_filters->>'minVolume')::integer)
     AND (p_filters->>'maxVolume' IS NULL OR m.search_volume <= (p_filters->>'maxVolume')::integer)
     AND (p_filters->>'minCpc' IS NULL OR m.cpc >= (p_filters->>'minCpc')::numeric)
     AND (p_filters->>'maxCpc' IS NULL OR m.cpc <= (p_filters->>'maxCpc')::numeric)
     AND (p_filters->>'minDifficulty' IS NULL OR m.keyword_difficulty >= (p_filters->>'minDifficulty')::integer)
     AND (p_filters->>'maxDifficulty' IS NULL OR m.keyword_difficulty <= (p_filters->>'maxDifficulty')::integer)
     AND (jsonb_array_length(coalesce(p_filters->'tagIds', '[]'::jsonb)) = 0 OR EXISTS (
          SELECT 1 FROM saved_keyword_tag_assignments a
           WHERE a.saved_keyword_id = s.id
             AND a.tag_id IN (SELECT x::uuid FROM jsonb_array_elements_text(p_filters->'tagIds') AS x)))
$$;

CREATE OR REPLACE FUNCTION public.list_saved_keywords(p_brand text, p_filters jsonb DEFAULT '{}'::jsonb,
  p_sort text DEFAULT 'fetchedAt', p_order text DEFAULT 'desc', p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE v_total integer; v_rows jsonb; v_tags jsonb;
BEGIN
  IF p_sort NOT IN ('createdAt','keyword','searchVolume','cpc','competition','keywordDifficulty','fetchedAt')
     OR p_order NOT IN ('asc','desc') OR p_limit NOT BETWEEN 1 AND 5000 OR p_offset < 0 THEN
    RAISE EXCEPTION 'saved_keywords_invalid:list';
  END IF;
  SELECT count(*) INTO v_total FROM f13_filtered_saved_keywords(p_brand, p_filters);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'keyword', f.keyword, 'locationCode', f.location_code, 'languageCode', f.language_code,
      'createdAt', f.created_at, 'searchVolume', f.search_volume, 'cpc', f.cpc, 'competition', f.competition,
      'keywordDifficulty', f.keyword_difficulty, 'intent', f.intent,
      'monthlySearches', coalesce(f.monthly_searches, '[]'::jsonb), 'fetchedAt', f.fetched_at,
      'tags', coalesce((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name,
                          'normalizedName', t.normalized_name, 'color', t.color) ORDER BY t.normalized_name)
                          FROM saved_keyword_tag_assignments a JOIN saved_keyword_tags t ON t.id = a.tag_id
                         WHERE a.saved_keyword_id = f.id), '[]'::jsonb)
    ) ORDER BY f.ord), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT x.*, row_number() OVER (ORDER BY
        CASE WHEN p_sort = 'keyword' AND p_order = 'asc' THEN x.keyword END ASC,
        CASE WHEN p_sort = 'keyword' AND p_order = 'desc' THEN x.keyword END DESC,
        CASE WHEN p_sort = 'searchVolume' AND p_order = 'asc' THEN x.search_volume END ASC NULLS LAST,
        CASE WHEN p_sort = 'searchVolume' AND p_order = 'desc' THEN x.search_volume END DESC NULLS LAST,
        CASE WHEN p_sort = 'cpc' AND p_order = 'asc' THEN x.cpc END ASC NULLS LAST,
        CASE WHEN p_sort = 'cpc' AND p_order = 'desc' THEN x.cpc END DESC NULLS LAST,
        CASE WHEN p_sort = 'competition' AND p_order = 'asc' THEN x.competition END ASC NULLS LAST,
        CASE WHEN p_sort = 'competition' AND p_order = 'desc' THEN x.competition END DESC NULLS LAST,
        CASE WHEN p_sort = 'keywordDifficulty' AND p_order = 'asc' THEN x.keyword_difficulty END ASC NULLS LAST,
        CASE WHEN p_sort = 'keywordDifficulty' AND p_order = 'desc' THEN x.keyword_difficulty END DESC NULLS LAST,
        CASE WHEN p_sort = 'fetchedAt' AND p_order = 'asc' THEN x.fetched_at END ASC NULLS LAST,
        CASE WHEN p_sort = 'fetchedAt' AND p_order = 'desc' THEN x.fetched_at END DESC NULLS LAST,
        CASE WHEN p_sort = 'createdAt' AND p_order = 'asc' THEN x.created_at END ASC,
        CASE WHEN p_sort = 'createdAt' AND p_order = 'desc' THEN x.created_at END DESC,
        x.id ASC) AS ord
      FROM f13_filtered_saved_keywords(p_brand, p_filters) AS x
     ORDER BY ord LIMIT p_limit OFFSET p_offset
  ) AS f;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'normalizedName', t.normalized_name,
      'color', t.color, 'keywordCount', (SELECT count(*) FROM saved_keyword_tag_assignments a WHERE a.tag_id = t.id))
      ORDER BY t.normalized_name), '[]'::jsonb) INTO v_tags
    FROM saved_keyword_tags t WHERE t.brand_key = p_brand;
  RETURN jsonb_build_object('rows', v_rows, 'totalCount', v_total, 'tags', v_tags);
END $$;

CREATE OR REPLACE FUNCTION public.update_saved_keyword_tags(p_brand text, p_ids uuid[],
  p_add jsonb DEFAULT '[]'::jsonb, p_remove uuid[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_ids uuid[]; v_add uuid[] := '{}'; v_added jsonb := '[]'::jsonb; v_removed_ids uuid[] := '{}'; v_removed integer := 0;
BEGIN
  IF coalesce(array_length(p_ids, 1), 0) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'saved_keywords_invalid:ids'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('f13_saved_keywords:' || p_brand));
  SELECT coalesce(array_agg(id), '{}') INTO v_ids FROM saved_keywords WHERE brand_key = p_brand AND id = ANY(p_ids);
  IF jsonb_array_length(coalesce(p_add, '[]'::jsonb)) > 0 AND cardinality(v_ids) > 0 THEN
    v_add := f13_upsert_tags(p_brand, p_add);
    INSERT INTO saved_keyword_tag_assignments(brand_key, saved_keyword_id, tag_id)
      SELECT p_brand, s, t FROM unnest(v_ids) s CROSS JOIN unnest(v_add) t
    ON CONFLICT DO NOTHING;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'normalizedName', normalized_name,
        'color', color) ORDER BY normalized_name), '[]'::jsonb)
      INTO v_added FROM saved_keyword_tags WHERE id = ANY(v_add);
  END IF;
  IF cardinality(coalesce(p_remove, '{}')) > 0 AND cardinality(v_ids) > 0 THEN
    SELECT coalesce(array_agg(id), '{}') INTO v_removed_ids FROM saved_keyword_tags
     WHERE brand_key = p_brand AND id = ANY(p_remove);
    DELETE FROM saved_keyword_tag_assignments
     WHERE brand_key = p_brand AND saved_keyword_id = ANY(v_ids) AND tag_id = ANY(v_removed_ids);
    GET DIAGNOSTICS v_removed = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('taggedCount', cardinality(v_ids), 'addedTags', v_added,
    'removedTagIds', to_jsonb(v_removed_ids), 'removedAssignments', v_removed);
END $$;

-- FOR UPDATE on the tag blocks a concurrent assignment insert (FK takes KEY SHARE),
-- so "in use" cannot race with a cascade delete (OpenSEO guard, SavedKeywordTagsRepository.ts:382-391).
CREATE OR REPLACE FUNCTION public.delete_saved_keyword_tag(p_brand text, p_tag uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  PERFORM 1 FROM saved_keyword_tags WHERE brand_key = p_brand AND id = p_tag FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  SELECT count(*) INTO v_count FROM saved_keyword_tag_assignments WHERE tag_id = p_tag;
  IF v_count > 0 THEN RETURN jsonb_build_object('status', 'in_use', 'assignmentCount', v_count); END IF;
  DELETE FROM saved_keyword_tags WHERE brand_key = p_brand AND id = p_tag;
  RETURN jsonb_build_object('status', 'deleted');
END $$;

CREATE OR REPLACE FUNCTION public.remove_saved_keywords(p_brand text, p_ids uuid[]) RETURNS integer
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  IF coalesce(array_length(p_ids, 1), 0) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'saved_keywords_invalid:ids'; END IF;
  DELETE FROM saved_keywords WHERE brand_key = p_brand AND id = ANY(p_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.f13_like_escape(text)', 'public.f13_upsert_tags(text, jsonb)',
    'public.save_keywords(text, text[], integer, text, jsonb, text, uuid)',
    'public.f13_filtered_saved_keywords(text, jsonb)',
    'public.list_saved_keywords(text, jsonb, text, text, integer, integer)',
    'public.update_saved_keyword_tags(text, uuid[], jsonb, uuid[])',
    'public.delete_saved_keyword_tag(text, uuid)', 'public.remove_saved_keywords(text, uuid[])'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
