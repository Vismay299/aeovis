-- Migration 024: Customer workspace ownership improvements.
-- Extends 023's customer schema for self-service UAT:
--   - Allows opaque (UUID) brand keys for new workspaces (preserves existing domain keys)
--   - Drops the website_host UNIQUE constraint so independent workspaces can share a domain
--   - Adds idempotency_key for retry-safe workspace creation
--   - Adds team management (invites table + helper functions)
--   - Adds a transactional workspace-creation RPC

-- 1. Drop the website_host UNIQUE index (replaced by a non-unique index for queries).
--    Independent workspaces can now represent the same domain without sharing data.
DROP INDEX IF EXISTS public.customer_brands_website_host_key;
CREATE INDEX IF NOT EXISTS customer_brands_website_host_idx
  ON public.customer_brands (website_host);

-- 2. Add idempotency_key for retry-safe workspace creation.
ALTER TABLE public.customer_brands
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS customer_brands_idempotency_key_idx
  ON public.customer_brands (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 3. Team invites table.
CREATE TABLE IF NOT EXISTS public.customer_team_invites (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  invited_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  CONSTRAINT customer_team_invites_email_nonempty CHECK (btrim(email) <> '')
);

CREATE INDEX IF NOT EXISTS customer_team_invites_brand_idx
  ON public.customer_team_invites (brand_key, status);

CREATE UNIQUE INDEX IF NOT EXISTS customer_team_invites_active_email_idx
  ON public.customer_team_invites (brand_key, lower(btrim(email)))
  WHERE status = 'pending';

ALTER TABLE public.customer_team_invites ENABLE ROW LEVEL SECURITY;

-- 4. Transactional workspace creation RPC.
--    Creates brand, aliases, owner membership, and optionally a GSC connection
--    in a single transaction. Returns the brand_key on success.
--    If idempotency_key matches an existing brand, returns that brand instead
--    of creating a duplicate (retry-safe).
CREATE OR REPLACE FUNCTION public.create_customer_workspace(
  p_brand_key text,
  p_display_name text,
  p_website text,
  p_website_host text,
  p_user_id uuid,
  p_idempotency_key text DEFAULT NULL,
  p_aliases text[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_brand_key text;
  v_brand_key text;
BEGIN
  -- Serialize retries for a user and scope the key to that user.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  IF p_idempotency_key IS NOT NULL THEN
    p_idempotency_key := p_user_id::text || ':' || p_idempotency_key;
  END IF;
  -- Idempotency: if this key was already used, return the existing brand.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT brand_key INTO v_existing_brand_key
      FROM public.customer_brands
     WHERE idempotency_key = p_idempotency_key
     LIMIT 1;
    IF v_existing_brand_key IS NOT NULL THEN
      RETURN jsonb_build_object('brand_key', v_existing_brand_key, 'created', false, 'idempotent', true);
    END IF;
  END IF;

  -- Insert the brand.
  INSERT INTO public.customer_brands (brand_key, display_name, website, website_host, aliases, idempotency_key)
  VALUES (p_brand_key, p_display_name, p_website, p_website_host, p_aliases, p_idempotency_key);
  v_brand_key := p_brand_key;

  -- Names and domains are metadata, never authorization aliases.

  -- Create owner membership.
  INSERT INTO public.customer_brand_memberships (user_id, brand_key, role)
  VALUES (p_user_id, v_brand_key, 'owner');

  RETURN jsonb_build_object('brand_key', v_brand_key, 'created', true, 'idempotent', false);
END;
$$;

REVOKE ALL ON FUNCTION public.create_customer_workspace(text, text, text, text, uuid, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_customer_workspace(text, text, text, text, uuid, text, text[]) TO service_role;

-- 5. Team management: prevent removing the last owner.
CREATE OR REPLACE FUNCTION public.prevent_last_owner_removal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.role = 'owner' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.customer_brand_memberships
       WHERE brand_key = OLD.brand_key
         AND role = 'owner'
         AND user_id <> OLD.user_id
    ) THEN
      RAISE EXCEPTION 'Cannot remove the last owner of a workspace.';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_last_owner_removal ON public.customer_brand_memberships;
CREATE TRIGGER trg_prevent_last_owner_removal
  BEFORE DELETE ON public.customer_brand_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_last_owner_removal();

-- 6. RLS for team invites: owners of the brand can see invites for their workspace.
GRANT SELECT ON public.customer_team_invites TO authenticated;

DROP POLICY IF EXISTS customer_team_invites_read ON public.customer_team_invites;
CREATE POLICY customer_team_invites_read ON public.customer_team_invites
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.customer_brand_memberships m
     WHERE m.brand_key = customer_team_invites.brand_key
       AND m.user_id = (SELECT auth.uid())
       AND m.role = 'owner'
  ));