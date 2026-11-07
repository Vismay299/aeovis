-- F25: lifecycle email outbox, per-user preferences, workspace milestones.

CREATE TABLE IF NOT EXISTS public.user_email_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  product_updates boolean NOT NULL DEFAULT false,
  product_updates_changed_at timestamptz,
  product_updates_source text CHECK (product_updates_source IS NULL OR product_updates_source IN
    ('onboarding','settings','unsubscribe_link','signup_default')),
  scan_results boolean NOT NULL DEFAULT true,
  schedule_alerts boolean NOT NULL DEFAULT true,
  spend_alerts boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.user_email_preferences IS
  'Per user, across workspaces. A missing row means the defaults: product updates off, every notification category on.';
COMMENT ON COLUMN public.user_email_preferences.product_updates_changed_at IS 'Record of consent for product-update emails.';

ALTER TABLE public.user_email_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_email_preferences FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_email_preferences TO authenticated;
GRANT ALL ON public.user_email_preferences TO service_role;
DROP POLICY IF EXISTS user_email_preferences_read_own ON public.user_email_preferences;
CREATE POLICY user_email_preferences_read_own ON public.user_email_preferences
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP TRIGGER IF EXISTS user_email_preferences_touch ON public.user_email_preferences;
CREATE TRIGGER user_email_preferences_touch BEFORE UPDATE ON public.user_email_preferences
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('transactional','event','contact')),
  template text NOT NULL CHECK (template IN (
    'scan_finished','schedule_skipped','spend_cap_reached',       -- transactional
    'signed_up',                                                  -- event
    'contact_signup','contact_milestones')),                       -- contact
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brand_key text REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  data jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(data) = 'object' AND pg_column_size(data) < 4096),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','skipped','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  claimed_by text CHECK (claimed_by IS NULL OR length(claimed_by) <= 80),
  skip_reason text CHECK (skip_reason IS NULL OR skip_reason ~ '^[a-z_]{1,40}$'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,40}$'),
  loops_duplicate boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT email_outbox_sent_has_time CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
COMMENT ON COLUMN public.email_outbox.dedupe_key IS
  'Globally unique business key, e.g. scan_finished:<scanId>:<userId>. The idempotency guarantee for the row''s lifetime.';
COMMENT ON COLUMN public.email_outbox.data IS
  'Template variables only (§6.4 allow-list). Never answer text, questions, citations or competitor names.';
CREATE UNIQUE INDEX IF NOT EXISTS email_outbox_dedupe_idx ON public.email_outbox (dedupe_key);
CREATE INDEX IF NOT EXISTS email_outbox_due_idx ON public.email_outbox (next_attempt_at)
  WHERE status IN ('pending','sending');
CREATE INDEX IF NOT EXISTS email_outbox_finished_idx ON public.email_outbox (updated_at)
  WHERE status IN ('sent','skipped','failed');
CREATE INDEX IF NOT EXISTS email_outbox_brand_idx ON public.email_outbox (brand_key, created_at DESC)
  WHERE brand_key IS NOT NULL;
ALTER TABLE public.email_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.email_outbox TO service_role;
DROP TRIGGER IF EXISTS email_outbox_touch ON public.email_outbox;
CREATE TRIGGER email_outbox_touch BEFORE UPDATE ON public.email_outbox
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.workspace_milestones (
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  milestone text NOT NULL CHECK (milestone IN ('workspace_created','first_scan_completed','schedule_set',
    'gsc_connected','audit_run','draft_approved','assistant_used')),
  reached_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_key, milestone)
);
ALTER TABLE public.workspace_milestones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_milestones FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.workspace_milestones TO authenticated;
GRANT ALL ON public.workspace_milestones TO service_role;
DROP POLICY IF EXISTS workspace_milestones_member_read ON public.workspace_milestones;
CREATE POLICY workspace_milestones_member_read ON public.workspace_milestones
  FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key));
