-- Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
--   src/server/auth/disposable-email.ts
-- Modified for Perceev. See THIRD_PARTY_NOTICES.md.

-- F24: refuse disposable email domains when an account is created.
-- Wired as the Supabase Auth "Before User Created" hook (owner enables it in the dashboard).
-- Covers email/password and Google sign-ups and direct calls to Supabase Auth with the anon key.

CREATE TABLE IF NOT EXISTS public.disposable_email_domains (
  domain text PRIMARY KEY
    CHECK (domain = lower(domain) AND domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
           AND length(domain) <= 253),
  source text NOT NULL DEFAULT 'operator' CHECK (source IN ('openseo', 'operator')),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.disposable_email_domains IS
  'Throwaway-inbox domains refused at sign-up. Subdomains of a listed domain are refused too. Service role and supabase_auth_admin only.';

ALTER TABLE public.disposable_email_domains ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.disposable_email_domains FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.disposable_email_domains TO service_role;

-- Seed: OpenSEO's curated list (openseo:src/server/auth/disposable-email.ts:10-48), MIT.
INSERT INTO public.disposable_email_domains (domain, source) VALUES
  ('0clock.net','openseo'),('10minutemail.com','openseo'),('20minutemail.com','openseo'),('33mail.com','openseo'),
  ('burnermail.io','openseo'),('dispostable.com','openseo'),('emailondeck.com','openseo'),('fakeinbox.com','openseo'),
  ('getairmail.com','openseo'),('getnada.com','openseo'),('guerrillamail.com','openseo'),('guerrillamail.net','openseo'),
  ('guerrillamail.org','openseo'),('inboxbear.com','openseo'),('inboxkitten.com','openseo'),('mail-temp.com','openseo'),
  ('mailcatch.com','openseo'),('maildrop.cc','openseo'),('mailinator.com','openseo'),('mailnesia.com','openseo'),
  ('moakt.com','openseo'),('mohmal.com','openseo'),('mytemp.email','openseo'),('sharklasers.com','openseo'),
  ('spam4.me','openseo'),('temp-mail.io','openseo'),('temp-mail.org','openseo'),('tempmail.com','openseo'),
  ('tempmail.dev','openseo'),('tempmailo.com','openseo'),('tempr.email','openseo'),('throwawaymail.com','openseo'),
  ('trashmail.com','openseo'),('trashmail.de','openseo'),('yopmail.com','openseo'),('yopmail.fr','openseo'),
  ('yopmail.net','openseo')
ON CONFLICT (domain) DO NOTHING;

-- Exact domain or any subdomain of a listed domain.
CREATE OR REPLACE FUNCTION public.is_disposable_email_domain(p_domain text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.disposable_email_domains d
     WHERE lower(rtrim(btrim(coalesce(p_domain, '')), '.')) = d.domain
        OR lower(rtrim(btrim(coalesce(p_domain, '')), '.')) LIKE '%.' || d.domain
  );
$$;

-- Supabase Auth "Before User Created" hook. Input: { metadata: {...}, user: { email, app_metadata: { provider }, ... } }.
-- Output: {} to allow, or { error: { http_code, message } } to refuse.
CREATE OR REPLACE FUNCTION public.hook_before_user_created(event jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email  text := lower(btrim(coalesce(event #>> '{user,email}', '')));
  v_domain text;
BEGIN
  IF v_email = '' OR position('@' IN v_email) = 0 THEN
    RETURN '{}'::jsonb;                     -- phone or anonymous creation: not a Perceev path; nothing to check
  END IF;
  v_domain := regexp_replace(v_email, '^.*@', '');   -- part after the last @
  IF NOT public.is_disposable_email_domain(v_domain) THEN
    RETURN '{}'::jsonb;
  END IF;
  -- A workspace owner's pending invitation admits the address (team invites are unchanged; Mixed row "Teams").
  IF EXISTS (SELECT 1 FROM public.customer_team_invites i
              WHERE lower(btrim(i.email)) = v_email AND i.status = 'pending' AND i.expires_at > now()) THEN
    RETURN '{}'::jsonb;
  END IF;
  RETURN jsonb_build_object('error', jsonb_build_object(
    'http_code', 400,
    'message', 'Please sign up with a non-disposable email address.'));
END;
$$;

REVOKE ALL ON FUNCTION public.is_disposable_email_domain(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hook_before_user_created(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_disposable_email_domain(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.hook_before_user_created(jsonb) TO service_role;

-- Supabase's auth role exists on hosted projects; CI's bootstrap creates it too (P1.T3.S2).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
    GRANT EXECUTE ON FUNCTION public.hook_before_user_created(jsonb) TO supabase_auth_admin;
    GRANT EXECUTE ON FUNCTION public.is_disposable_email_domain(text) TO supabase_auth_admin;
  END IF;
END $$;
