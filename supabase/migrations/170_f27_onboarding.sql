-- F27: per-user onboarding progress, per-user checklist dismissals, Search Console return path.

CREATE TABLE IF NOT EXISTS public.user_onboarding (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  brand_key text REFERENCES public.customer_brands(brand_key) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_via text CHECK (completed_via IS NULL OR completed_via IN ('wizard','first_scan','skipped')),
  steps jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(steps) = 'object' AND pg_column_size(steps) < 2048),
  handoff jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(handoff) = 'object' AND pg_column_size(handoff) < 1024),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_onboarding_completed_via CHECK ((completed_at IS NULL) = (completed_via IS NULL))
);
COMMENT ON COLUMN public.user_onboarding.brand_key IS 'Workspace created (or first used) in onboarding.';
COMMENT ON COLUMN public.user_onboarding.steps IS
  '{ "<step>": { "status": "done"|"skipped", "at": ISO } } for website, search_console, analytics, preferences, first_scan.';
COMMENT ON COLUMN public.user_onboarding.handoff IS
  '{ "domain": host|null, "scanId": uuid|null, "importedQuestions": int, "importedAt": ISO|null }. Never question text.';

ALTER TABLE public.user_onboarding ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_onboarding FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_onboarding TO authenticated;
GRANT ALL ON public.user_onboarding TO service_role;
DROP POLICY IF EXISTS user_onboarding_read_own ON public.user_onboarding;
CREATE POLICY user_onboarding_read_own ON public.user_onboarding
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP TRIGGER IF EXISTS user_onboarding_touch ON public.user_onboarding;
CREATE TRIGGER user_onboarding_touch BEFORE UPDATE ON public.user_onboarding
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.workspace_setup_dismissals (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  step text NOT NULL CHECK (step IN ('questions','scan','gsc','audit','schedule','ga4','draft','team')),
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, brand_key, step)
);
CREATE INDEX IF NOT EXISTS workspace_setup_dismissals_brand_idx ON public.workspace_setup_dismissals (brand_key);
ALTER TABLE public.workspace_setup_dismissals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_setup_dismissals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.workspace_setup_dismissals TO authenticated;
GRANT ALL ON public.workspace_setup_dismissals TO service_role;
DROP POLICY IF EXISTS workspace_setup_dismissals_read_own ON public.workspace_setup_dismissals;
CREATE POLICY workspace_setup_dismissals_read_own ON public.workspace_setup_dismissals
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND public.customer_can_access_brand(brand_key));

-- Search Console OAuth can return to onboarding. Default keeps today's behaviour.
ALTER TABLE public.gsc_oauth_attempts
  ADD COLUMN IF NOT EXISTS return_path text NOT NULL DEFAULT '/portal/search-console';
ALTER TABLE public.gsc_oauth_attempts DROP CONSTRAINT IF EXISTS gsc_oauth_attempts_return_path_ck;
ALTER TABLE public.gsc_oauth_attempts ADD CONSTRAINT gsc_oauth_attempts_return_path_ck
  CHECK (return_path IN ('/portal/search-console', '/onboarding'));
