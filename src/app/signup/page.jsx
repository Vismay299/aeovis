export const dynamic = "force-dynamic";

import AuthLayout from "@/components/portal/AuthLayout";
import { isFeatureEnabled } from "@/lib/features/flags";
import { buildOnboardingPath } from "@/shared/auth-redirect";
import { SignUpForm } from "@/components/auth/SignUpForm";

export default async function CustomerSignupPage({ searchParams }) {
  const params = await searchParams;
  const onboardingPath = buildOnboardingPath({
    domain: params?.domain,
    scan: params?.scan,
    redirect: params?.next,
  });

  const googleEnabled = await isFeatureEnabled("google_sign_in");
  const turnstileSiteKey = process.env["NEXT_PUBLIC_TURNSTILE_SITE_KEY"] ?? "";

  return (
    <AuthLayout title="Create your account" titleId="signup-title">
      <SignUpForm
        googleEnabled={googleEnabled}
        turnstileSiteKey={turnstileSiteKey}
        onboardingPath={onboardingPath}
        next={params?.next}
      />
    </AuthLayout>
  );
}
