-- 128: F18 Shopify crawler-access credentials (port of crawler_credentials, app.schema.ts:450-479). Safe to re-run.
CREATE TABLE IF NOT EXISTS public.site_audit_crawler_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  host text NOT NULL CHECK (host ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),
  provider text NOT NULL DEFAULT 'shopify' CHECK (provider IN ('shopify')),
  encrypted_signature_input text NOT NULL,   -- AES-256-GCM JSON envelope (CRAWLER_ACCESS_ENCRYPTION_KEY)
  encrypted_signature text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  expires_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_audit_crawler_credentials_host_key UNIQUE (brand_key, host)
);
ALTER TABLE public.site_audit_crawler_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.site_audit_crawler_credentials FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.site_audit_crawler_credentials TO service_role;
-- Service-only: the signature is a bot-protection credential and never reaches a browser.
DROP TRIGGER IF EXISTS site_audit_crawler_credentials_touch ON public.site_audit_crawler_credentials;
CREATE TRIGGER site_audit_crawler_credentials_touch BEFORE UPDATE ON public.site_audit_crawler_credentials
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_audits_crawler_credential_fk') THEN
    ALTER TABLE public.site_audits ADD CONSTRAINT site_audits_crawler_credential_fk
      FOREIGN KEY (crawler_credential_id) REFERENCES public.site_audit_crawler_credentials(id) ON DELETE SET NULL;
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
