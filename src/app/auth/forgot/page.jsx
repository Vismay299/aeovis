export const dynamic = "force-dynamic";

import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { firstParam } from "@/shared/auth-redirect";

export default async function ForgotPasswordPage({ searchParams }) {
  const params = await searchParams;
  const email = firstParam(params?.email);
  const next = firstParam(params?.next);
  const turnstileSiteKey = process.env["NEXT_PUBLIC_TURNSTILE_SITE_KEY"] ?? "";

  return (
    <ForgotPasswordForm
      initialEmail={email}
      next={next}
      turnstileSiteKey={turnstileSiteKey}
    />
  );
}
