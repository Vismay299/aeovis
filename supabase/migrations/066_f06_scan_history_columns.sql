-- 066_f06_scan_history_columns.sql
-- F06 phase 5: server-side Scans history filters and paging.
-- Additive and safe to re-run.
--
-- Adds derived columns to public.scans so the history route can filter, sort
-- and page in the database instead of loading the latest 20 rows into the
-- browser. engines / collection_partial / started_by are maintained by a
-- trigger; existing rows are backfilled directly, never by rewriting
-- raw_results. listed_at is a generated column so legacy rows with a null
-- scanned_at still have a stable ordering/filtering key.
--
-- No grants change: reads stay service-role-only, scoped by brand_key.

ALTER TABLE public.scans
  ADD COLUMN IF NOT EXISTS engines text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS collection_partial boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS started_by text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS listed_at timestamptz GENERATED ALWAYS AS (coalesce(scanned_at, created_at)) STORED;

ALTER TABLE public.scans DROP CONSTRAINT IF EXISTS scans_started_by_ck;
ALTER TABLE public.scans ADD CONSTRAINT scans_started_by_ck CHECK (started_by IN ('manual','scheduled'));

-- Engine ids exactly as GET /api/customer/scan derives them today: array
-- elements' `engine` (falling back to `name`), or the object's keys, else the
-- platform string. No normalisation, so the two derivations stay equal.
CREATE OR REPLACE FUNCTION public.scan_engines(raw jsonb, platform text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(raw->'engines') = 'array'
              THEN COALESCE((SELECT array_agg(coalesce(v->>'engine', v->>'name') ORDER BY ord)
                               FROM jsonb_array_elements(raw->'engines') WITH ORDINALITY AS t(v, ord)
                              WHERE coalesce(v->>'engine', v->>'name') IS NOT NULL
                                AND coalesce(v->>'engine', v->>'name') <> ''), '{}'::text[])
              WHEN jsonb_typeof(raw->'engines') = 'object'
              THEN COALESCE(ARRAY(SELECT jsonb_object_keys(raw->'engines')), '{}'::text[])
              WHEN platform IS NOT NULL AND platform <> '' THEN ARRAY[platform]
              ELSE '{}'::text[] END;
$$;

-- Partial when any engine slice carries data_source_issue = true or a numeric
-- error_rate_pct greater than zero, mirroring the route's `.some(...)`.
CREATE OR REPLACE FUNCTION public.scan_collection_partial(raw jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM (SELECT CASE WHEN jsonb_typeof(raw->'engines') = 'array' THEN raw->'engines'
                       WHEN jsonb_typeof(raw->'engines') = 'object' THEN raw->'engines'
                       ELSE NULL END AS engines) e
      JOIN LATERAL (SELECT a.value AS v FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.engines) = 'array' THEN e.engines ELSE '[]'::jsonb END) AS a
                    UNION ALL
                    SELECT o.value AS v FROM jsonb_each(CASE WHEN jsonb_typeof(e.engines) = 'object' THEN e.engines ELSE '{}'::jsonb END) AS o) s ON true
     WHERE s.v->'data_source_issue' = 'true'::jsonb
        OR (jsonb_typeof(s.v->'error_rate_pct') = 'number' AND (s.v->>'error_rate_pct')::numeric > 0)
  );
$$;

CREATE OR REPLACE FUNCTION public.scans_derive_history_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.engines := public.scan_engines(NEW.raw_results, NEW.platform);
  NEW.collection_partial := public.scan_collection_partial(NEW.raw_results);
  NEW.started_by := CASE WHEN EXISTS (SELECT 1 FROM public.measurement_windows w WHERE w.job_id = NEW.origin_job_id) THEN 'scheduled' ELSE 'manual' END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scans_derive_history ON public.scans;
CREATE TRIGGER scans_derive_history BEFORE INSERT OR UPDATE OF raw_results, platform, origin_job_id ON public.scans
  FOR EACH ROW EXECUTE FUNCTION public.scans_derive_history_columns();

-- Backfill existing rows directly. The trigger does not fire because
-- raw_results is not in the SET list. Batched on IS DISTINCT FROM so a re-run
-- only rewrites rows that are actually stale.
DO $$
DECLARE
  changed integer;
BEGIN
  LOOP
    UPDATE public.scans s
       SET engines = public.scan_engines(s.raw_results, s.platform),
           collection_partial = public.scan_collection_partial(s.raw_results),
           started_by = CASE WHEN EXISTS (SELECT 1 FROM public.measurement_windows w WHERE w.job_id = s.origin_job_id) THEN 'scheduled' ELSE 'manual' END
     WHERE s.id IN (SELECT id FROM public.scans
                     WHERE engines IS DISTINCT FROM public.scan_engines(raw_results, platform)
                        OR collection_partial IS DISTINCT FROM public.scan_collection_partial(raw_results)
                        OR started_by IS DISTINCT FROM CASE WHEN EXISTS (SELECT 1 FROM public.measurement_windows w WHERE w.job_id = origin_job_id) THEN 'scheduled' ELSE 'manual' END
                     ORDER BY id LIMIT 1000);
    GET DIAGNOSTICS changed = ROW_COUNT;
    EXIT WHEN changed = 0;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS scans_brand_listed_idx ON public.scans (brand_key, listed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS scans_brand_visibility_idx ON public.scans (brand_key, visibility_pct);
CREATE INDEX IF NOT EXISTS scans_engines_gin_idx ON public.scans USING gin (engines);

COMMENT ON COLUMN public.scans.engines IS 'F06: engine ids derived from raw_results->engines (object keys, or array engine/name), else platform.';
COMMENT ON COLUMN public.scans.collection_partial IS 'F06: any engine slice flagged data_source_issue or error_rate_pct > 0.';
COMMENT ON COLUMN public.scans.started_by IS 'F06: scheduled when a measurement_windows row matches origin_job_id, else manual.';
COMMENT ON COLUMN public.scans.listed_at IS 'F06: coalesce(scanned_at, created_at); the history list orders and filters on this.';

NOTIFY pgrst, 'reload schema';
