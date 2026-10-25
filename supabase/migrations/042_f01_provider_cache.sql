-- F01: soft-TTL, schema-validated provider cache (port of OpenSEO r2-cache.ts to Postgres + Storage).
CREATE TABLE IF NOT EXISTS public.provider_cache (
  key text PRIMARY KEY CHECK (key ~ '^[0-9a-f]{64}$'),
  namespace text NOT NULL CHECK (namespace ~ '^[a-z][a-z0-9_.:-]{1,80}$'),
  version integer NOT NULL CHECK (version >= 1),
  scope text NOT NULL CHECK (scope IN ('workspace','global')),
  brand_key text REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  value jsonb,
  storage_path text,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT provider_cache_one_body CHECK ((value IS NULL) <> (storage_path IS NULL)),
  CONSTRAINT provider_cache_scope CHECK ((scope = 'workspace') = (brand_key IS NOT NULL))
);
COMMENT ON COLUMN public.provider_cache.storage_path IS 'provider-cache bucket object for bodies over 256 KB.';
CREATE INDEX IF NOT EXISTS provider_cache_expires_idx ON public.provider_cache (expires_at);
CREATE INDEX IF NOT EXISTS provider_cache_ns_idx ON public.provider_cache (namespace, version);
ALTER TABLE public.provider_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.provider_cache FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.provider_cache TO service_role;
-- Service-only by design: cached provider payloads are never read by browsers.

INSERT INTO storage.buckets (id, name, public)
VALUES (
  'provider-cache',
  'provider-cache',
  false
)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.prune_provider_cache(p_expired_before timestamptz, p_limit integer DEFAULT 1000)
RETURNS SETOF text LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH old AS (SELECT key FROM provider_cache WHERE expires_at < p_expired_before ORDER BY expires_at LIMIT p_limit)
  DELETE FROM provider_cache p USING old WHERE p.key = old.key RETURNING p.storage_path;
END $$;
REVOKE ALL ON FUNCTION public.prune_provider_cache(timestamptz,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_provider_cache(timestamptz,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
