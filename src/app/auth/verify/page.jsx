export const dynamic = "force-dynamic";

import { VerifyEmailCard } from "@/components/auth/VerifyEmailCard";
import { firstParam } from "@/shared/auth-redirect";

export default async function VerifyPage({ searchParams }) {
  const params = await searchParams;
  const email = firstParam(params?.email);
  const next = firstParam(params?.next);
  const error = firstParam(params?.error);
  const turnstileSiteKey = process.env["NEXT_PUBLIC_TURNSTILE_SITE_KEY"] ?? "";

  return (
    <VerifyEmailCard
      email={email}
      next={next}
      error={error}
      turnstileSiteKey={turnstileSiteKey}
    />
  );
}
