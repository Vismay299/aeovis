// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/auth-error.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export const dynamic = "force-dynamic";

import Link from "next/link";
import AuthLayout from "@/components/portal/AuthLayout";
import { authErrorCopy, isAuthErrorCode } from "@/shared/auth-errors";
import { firstParam, normalizeAuthRedirect, signInHref } from "@/shared/auth-redirect";

export default async function AuthErrorPage({ searchParams }) {
  const params = await searchParams;
  // Only a code from the closed set is ever echoed; anything else is "unknown".
  const raw = firstParam(params?.error);
  const error = isAuthErrorCode(raw) ? raw : "unknown";
  const copy = authErrorCopy(error);
  const backHref = signInHref(normalizeAuthRedirect(firstParam(params?.next)));

  return (
    <AuthLayout
      title={copy.title}
      titleId="auth-error-title"
      subtitle={copy.description}
      footer={<p className="font-mono text-xs text-muted-foreground">Code: {error}</p>}
    >
      <div className="space-y-4">
        <Link
          href={backHref}
          className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-secondary px-4 text-sm font-semibold text-secondary-foreground hover:bg-secondary/80"
        >
          Back to sign in
        </Link>
      </div>
    </AuthLayout>
  );
}
