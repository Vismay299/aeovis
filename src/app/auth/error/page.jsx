// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/auth-error.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export const dynamic = "force-dynamic";

import Link from "next/link";
import AuthLayout from "@/components/portal/AuthLayout";
import { authErrorCopy } from "@/shared/auth-errors";

export default async function AuthErrorPage({ searchParams }) {
  const params = await searchParams;
  const error = params?.error ?? "unknown";
  const copy = authErrorCopy(error);

  const footer = error ? (
    <p className="font-mono text-xs text-muted-foreground">Code: {error}</p>
  ) : null;

  return (
    <AuthLayout
      title={copy.title}
      titleId="auth-error-title"
      subtitle={copy.description}
      footer={footer}
    >
      <div className="space-y-4">
        <Link
          href="/login"
          className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-secondary px-4 text-sm font-semibold text-secondary-foreground hover:bg-secondary/80"
        >
          Back to sign in
        </Link>
      </div>
    </AuthLayout>
  );
}
