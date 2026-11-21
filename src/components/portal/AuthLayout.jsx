// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/auth/AuthPage.tsx:131-175
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Link from "next/link";
import { PerceevMark } from "@/components/app/brand/PerceevLogo";
import AuthBackdrop from "./AuthBackdrop";

/**
 * Shell for the customer sign-in surfaces (login, signup, onboarding, invite
 * acceptance, password reset). A single centred column on the app surface:
 * mark, eyebrow, title, subtitle, form, footer and the legal line.
 *
 * @param {{ eyebrow?: React.ReactNode; title: React.ReactNode; titleId?: string; subtitle?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }} props
 */
export default function AuthLayout({ eyebrow = null, title, titleId, subtitle = null, children, footer = null }) {
  return (
    <div className="auth-shell relative isolate flex h-[100dvh] flex-col items-center overflow-y-auto bg-background p-4">
      <AuthBackdrop />
      <div className="auth-column m-auto flex w-full flex-col items-center">
        <div className="w-full max-w-xs space-y-6">
          <div className="space-y-3 text-center">
            <Link href="/" aria-label="Perceev home" className="inline-flex">
              <PerceevMark className="mx-auto size-10" />
            </Link>
            <div>
              {eyebrow ? <p className="app-eyebrow text-xs text-muted-foreground">{eyebrow}</p> : null}
              <h1 id={titleId} className="auth-title text-xl font-semibold">{title}</h1>
              {subtitle ? <p className="auth-subtitle mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
            </div>
          </div>

          <div className="space-y-4">{children}</div>

          {footer ? <div className="text-center text-sm text-muted-foreground">{footer}</div> : null}

          <p className="text-center text-xs text-muted-foreground">
            © Perceev <span aria-hidden="true">·</span>{" "}
            <Link href="/privacy" className="hover:text-foreground">Privacy</Link>{" "}
            <span aria-hidden="true">·</span>{" "}
            <Link href="/terms" className="hover:text-foreground">Terms</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
