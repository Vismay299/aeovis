-- 135: F20 Google Analytics 4 — OAuth attempts, per-user Analytics grants, workspace connections.
-- Port of openseo ga4.schema.ts and its per-user grant rows. Separate from every gsc_* table. Safe to re-run.

CREATE TABLE IF NOT EXISTS public.ga4_oauth_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  state_hash text NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  session_token_hash text NOT NULL CHECK (session_token_hash ~ '^[0-9a-f]{64}$'),
  encrypted_code_verifier text NOT NULL,
  return_path text NOT NULL DEFAULT '/portal/settings/integrations'
    CHECK (return_path IN ('/portal/settings/integrations', '/portal/analytics', '/onboarding')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  consumed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS ga4_oauth_attempts_state_idx ON public.ga4_oauth_attempts (state_hash);
CREATE INDEX IF NOT EXISTS ga4_oauth_attempts_expiry_idx ON public.ga4_oauth_attempts (expires_at);

-- A grant belongs to a person, not a workspace (OpenSEO keys grants per user, googleOAuth.ts:37-49), so it has
-- no brand_key (deviation from conventions §6.8); it is service-only. The workspace link is ga4_connections.
CREATE TABLE IF NOT EXISTS public.ga4_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  google_sub text NOT NULL CHECK (google_sub ~ '^[0-9A-Za-z_-]{1,255}$'),
  google_email text CHECK (google_email IS NULL OR length(google_email) <= 320),
  encrypted_refresh_token text,
  encrypted_access_token text,
  access_token_expires_at timestamptz,
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','error')),
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 300),
  key_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ga4_grants_user_sub_key UNIQUE (user_id, google_sub)
);
COMMENT ON COLUMN public.ga4_grants.updated_at IS 'Touched on link, re-consent, token refresh and property selection. Grants with no connection and updated_at older than 24 h are purged and revoked (port of googleDataRetention.ts).';
CREATE INDEX IF NOT EXISTS ga4_grants_sub_idx ON public.ga4_grants (google_sub);
CREATE INDEX IF NOT EXISTS ga4_grants_updated_idx ON public.ga4_grants (updated_at);
DROP TRIGGER IF EXISTS ga4_grants_touch ON public.ga4_grants;
CREATE TRIGGER ga4_grants_touch BEFORE UPDATE ON public.ga4_grants
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.ga4_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  grant_id uuid NOT NULL REFERENCES public.ga4_grants(id) ON DELETE CASCADE,
  connected_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  google_sub text NOT NULL,
  connected_account_email text,
  property_id text NOT NULL CHECK (property_id ~ '^properties/[0-9]{1,20}$'),
  property_display_name text NOT NULL CHECK (length(property_display_name) <= 200),
  property_time_zone text NOT NULL CHECK (length(property_time_zone) <= 64),
  property_currency_code text NOT NULL CHECK (property_currency_code ~ '^[A-Z]{3}$'),
  account_display_name text CHECK (account_display_name IS NULL OR length(account_display_name) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ga4_connections_brand_key UNIQUE (brand_key)
);
CREATE INDEX IF NOT EXISTS ga4_connections_grant_idx ON public.ga4_connections (grant_id);
DROP TRIGGER IF EXISTS ga4_connections_touch ON public.ga4_connections;
CREATE TRIGGER ga4_connections_touch BEFORE UPDATE ON public.ga4_connections
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

ALTER TABLE public.ga4_oauth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ga4_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ga4_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ga4_oauth_attempts, public.ga4_grants FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.ga4_oauth_attempts, public.ga4_grants TO service_role;
DROP POLICY IF EXISTS ga4_connections_read ON public.ga4_connections;
CREATE POLICY ga4_connections_read ON public.ga4_connections FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));
REVOKE INSERT, UPDATE, DELETE ON public.ga4_connections FROM anon, authenticated;
NOTIFY pgrst, 'reload schema';
