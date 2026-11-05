export const dynamic = "force-dynamic";

import AuthLayout from "@/components/portal/AuthLayout";
import { isFeatureEnabled } from "@/lib/features/flags";
import { SignInForm } from "@/components/auth/SignInForm";

export default async function CustomerLoginPage({ searchParams }) {
  const params = await searchParams;
  const next = params?.next ?? "";
  const error = params?.error ?? "";
  const googleEnabled = await isFeatureEnabled("google_sign_in");
  const turnstileSiteKey = process.env["NEXT_PUBLIC_TURNSTILE_SITE_KEY"] ?? "";

  return (
    <AuthLayout title="Sign in" titleId="login-title">
      <SignInForm
        googleEnabled={googleEnabled}
        turnstileSiteKey={turnstileSiteKey}
        next={next}
        initialError={error}
      />
    </AuthLayout>
  );
}
