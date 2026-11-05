// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/auth/AuthPage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export function TermsAgreementNotice({ action }: { action: string }) {
  return (
    <p className="text-center text-sm leading-relaxed text-muted-foreground">
      {action}, you agree to our{" "}
      <a
        href="/terms"
        target="_blank"
        rel="noreferrer"
        className="text-foreground underline underline-offset-2 transition-colors hover:text-foreground/80"
      >
        Terms
      </a>{" "}
      and{" "}
      <a
        href="/privacy"
        target="_blank"
        rel="noreferrer"
        className="text-foreground underline underline-offset-2 transition-colors hover:text-foreground/80"
      >
        Privacy Policy
      </a>
      .
    </p>
  );
}
