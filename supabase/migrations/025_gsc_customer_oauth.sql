-- Migration 025: GSC customer OAuth infrastructure.
-- Adds per-workspace OAuth credentials, attempts, sync jobs, and extends
-- gsc_connections/gsc_daily with workspace scope and connection generations.

-- 1. OAuth attempts table (short-lived, server-only).
CREATE TABLE IF NOT EXISTS public.gsc_oauth_attempts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  state_hash text NOT NULL,
  session_token_hash text,
  encrypted_code_verifier text,
  encrypted_pending_grant text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  consumed_at timestamptz,
  CONSTRAINT gsc_oauth_attempts_state_hash_nonempty CHECK (btrim(state_hash) <> '')
);

CREATE INDEX IF NOT EXISTS gsc_oauth_attempts_state_hash_idx
  ON public.gsc_oauth_attempts (state_hash)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS gsc_oauth_attempts_expiry_idx
  ON public.gsc_oauth_attempts (expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE public.gsc_oauth_attempts ENABLE ROW LEVEL SECURITY;
-- No customer access — server-only via service role.

-- 2. OAuth credentials table (encrypted, server-only).
CREATE TABLE IF NOT EXISTS public.gsc_oauth_credentials (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  authorizing_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted_refresh_token text,
  encrypted_access_token text,
  access_token_expires_at timestamptz,
  scopes text[] NOT NULL DEFAULT '{}',
  key_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked', 'error')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gsc_oauth_credentials_brand_unique UNIQUE (brand_key)
);

ALTER TABLE public.gsc_oauth_credentials ENABLE ROW LEVEL SECURITY;
-- No customer access — server-only via service role.

-- 3. Extend gsc_connections with workspace FK, credential FK, auth mode, and connection generation.
ALTER TABLE public.gsc_connections
  ADD COLUMN IF NOT EXISTS brand_key text REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS credential_id uuid REFERENCES public.gsc_oauth_credentials(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS auth_mode text DEFAULT 'service_account' CHECK (auth_mode IN ('service_account', 'oauth')),
  ADD COLUMN IF NOT EXISTS connection_generation integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS permission_level text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Legacy operator connections remain unassigned. Ownership requires an explicit operator action.

-- 4. GSC sync jobs table (durable, resumable).
CREATE TABLE IF NOT EXISTS public.gsc_sync_jobs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  connection_generation integer NOT NULL DEFAULT 1,
  sync_type text NOT NULL DEFAULT 'initial' CHECK (sync_type IN ('initial', 'incremental', 'manual')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  checkpoint_date text,
  checkpoint_page integer DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  error_message text,
  rows_written integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gsc_sync_jobs_brand_idx
  ON public.gsc_sync_jobs (brand_key, status);

CREATE INDEX IF NOT EXISTS gsc_sync_jobs_pending_idx
  ON public.gsc_sync_jobs (created_at)
  WHERE status = 'pending';

ALTER TABLE public.gsc_sync_jobs ENABLE ROW LEVEL SECURITY;
-- No direct customer access — server-only. Owners read status through the API.

-- 5. Add connection_generation to gsc_daily for scope isolation.
ALTER TABLE public.gsc_daily
  ADD COLUMN IF NOT EXISTS connection_generation integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS brand_key text REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE;

-- Legacy data remains unassigned; do not infer tenant ownership from a label.

-- New uniqueness: (brand_key, date, query, connection_generation) prevents mixing
-- old and new property data when a property is replaced.
-- Keep the old (brand, date, query) unique constraint for backward compatibility.
CREATE UNIQUE INDEX IF NOT EXISTS gsc_daily_brand_key_gen_idx
  ON public.gsc_daily (brand_key, date, query, connection_generation);

-- Index for workspace-scoped reads.
CREATE INDEX IF NOT EXISTS gsc_daily_brand_key_date_idx
  ON public.gsc_daily (brand_key, date DESC);

-- 6. Safe connection metadata view for customer reads (no secrets).
-- Customers read connection status through the API handler which selects
-- allowlisted columns. The RLS policy on gsc_connections (from migration 023)
-- already gates by brand membership.

-- 7. Clean up expired OAuth attempts (call from cron or maintenance).
CREATE OR REPLACE FUNCTION public.prune_expired_gsc_oauth_attempts()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH deleted AS (
    DELETE FROM public.gsc_oauth_attempts
     WHERE expires_at < now()
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted;
$$;

REVOKE ALL ON FUNCTION public.prune_expired_gsc_oauth_attempts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_expired_gsc_oauth_attempts() TO service_role;