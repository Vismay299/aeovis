export const dynamic = "force-dynamic";

import { VerifyEmailCard } from "@/components/auth/VerifyEmailCard";

export default async function VerifyPage({ searchParams }) {
  const params = await searchParams;
  const email = params?.email ?? "";
  const next = params?.next ?? "";
  const error = params?.error ?? "";
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
