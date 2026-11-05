export const dynamic = "force-dynamic";

import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

export default async function ForgotPasswordPage({ searchParams }) {
  const params = await searchParams;
  const email = params?.email ?? "";
  const next = params?.next ?? "";
  const turnstileSiteKey = process.env["NEXT_PUBLIC_TURNSTILE_SITE_KEY"] ?? "";

  return (
    <ForgotPasswordForm
      initialEmail={email}
      next={next}
      turnstileSiteKey={turnstileSiteKey}
    />
  );
}
