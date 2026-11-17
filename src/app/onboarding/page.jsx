// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_authenticated.onboarding.index.tsx:18-151
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { isFeatureEnabled } from "@/server/features/flags.ts";
import OnboardingWizard from "@/components/portal/onboarding/OnboardingWizard";
import LegacyOnboardingForm from "@/components/portal/onboarding/LegacyOnboardingForm";

export const dynamic = "force-dynamic";

export default async function CustomerOnboardingPage() {
  const enabled = await isFeatureEnabled("onboarding_wizard");
  return enabled ? <OnboardingWizard /> : <LegacyOnboardingForm />;
}
