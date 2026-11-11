-- F13: saved keywords, tags and tag assignments.
-- Port of openseo:src/db/app.schema.ts:90-169 (project -> workspace brand_key).
CREATE TABLE IF NOT EXISTS public.saved_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  keyword text NOT NULL CHECK (keyword = btrim(keyword) AND length(keyword) BETWEEN 1 AND 200),
  location_code integer NOT NULL CHECK (location_code BETWEEN 1000 AND 9999999),
  language_code text NOT NULL CHECK (language_code ~ '^[a-z]{2,3}(-[A-Za-z]{2,4})?$'),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_keywords_unique_market UNIQUE (brand_key, keyword, location_code, language_code),
  CONSTRAINT saved_keywords_brand_id UNIQUE (brand_key, id)
);
COMMENT ON COLUMN public.saved_keywords.keyword IS 'Trimmed, lower-cased in src/lib/keywords/helpers.ts normalizeKeyword before insert.';
CREATE INDEX IF NOT EXISTS saved_keywords_brand_created_idx ON public.saved_keywords (brand_key, created_at DESC, id);
CREATE INDEX IF NOT EXISTS saved_keywords_market_idx ON public.saved_keywords (keyword, location_code, language_code);

CREATE TABLE IF NOT EXISTS public.saved_keyword_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 64),
  normalized_name text NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 64),
  color text CHECK (color IS NULL OR color IN ('slate','rose','amber','lime','emerald','sky','violet','fuchsia')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_keyword_tags_unique_name UNIQUE (brand_key, normalized_name),
  CONSTRAINT saved_keyword_tags_brand_id UNIQUE (brand_key, id)
);
COMMENT ON COLUMN public.saved_keyword_tags.color IS 'Palette key from src/shared/tag-colors.ts; NULL = colour derived from the id at render time.';

-- brand_key is repeated so RLS needs no join; the composite foreign keys make a
-- cross-workspace assignment impossible.
CREATE TABLE IF NOT EXISTS public.saved_keyword_tag_assignments (
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  saved_keyword_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (saved_keyword_id, tag_id),
  CONSTRAINT saved_keyword_tag_assignments_keyword_fk FOREIGN KEY (brand_key, saved_keyword_id)
    REFERENCES public.saved_keywords(brand_key, id) ON DELETE CASCADE,
  CONSTRAINT saved_keyword_tag_assignments_tag_fk FOREIGN KEY (brand_key, tag_id)
    REFERENCES public.saved_keyword_tags(brand_key, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS saved_keyword_tag_assignments_tag_idx ON public.saved_keyword_tag_assignments (tag_id);

DROP TRIGGER IF EXISTS saved_keyword_tags_touch ON public.saved_keyword_tags;
CREATE TRIGGER saved_keyword_tags_touch BEFORE UPDATE ON public.saved_keyword_tags
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['saved_keywords','saved_keyword_tags','saved_keyword_tag_assignments'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS f13_member_read ON public.%I', t);
    EXECUTE format('CREATE POLICY f13_member_read ON public.%I FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key))', t);
  END LOOP;
END $$;
