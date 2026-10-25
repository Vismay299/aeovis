-- F26: opaque workspace ids for analytics groups, and each user's analytics consent.

-- Older workspaces use their domain as brand_key; analytics groups must never carry it.
ALTER TABLE public.customer_brands
  ADD COLUMN IF NOT EXISTS telemetry_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS customer_brands_telemetry_id_idx ON public.customer_brands (telemetry_id);
COMMENT ON COLUMN public.customer_brands.telemetry_id IS
  'Opaque id used as the PostHog "workspace" group key. Never derive it from brand_key; never send brand_key.';

CREATE TABLE IF NOT EXISTS public.user_privacy_choices (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  analytics boolean NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('onboarding','settings','banner')),
  policy_version text NOT NULL CHECK (policy_version ~ '^\d{4}-\d{2}-\d{2}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.user_privacy_choices IS
  'Record of consent for product analytics. No row = not decided = analytics off.';

ALTER TABLE public.user_privacy_choices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_privacy_choices FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_privacy_choices TO authenticated;
GRANT ALL ON public.user_privacy_choices TO service_role;
DROP POLICY IF EXISTS user_privacy_choices_read_own ON public.user_privacy_choices;
CREATE POLICY user_privacy_choices_read_own ON public.user_privacy_choices
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP TRIGGER IF EXISTS user_privacy_choices_touch ON public.user_privacy_choices;
CREATE TRIGGER user_privacy_choices_touch BEFORE UPDATE ON public.user_privacy_choices
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();
