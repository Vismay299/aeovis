// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/auth/disposable-email.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

// A curated blocklist of the highest-volume disposable / throwaway email
// providers. Mirrored in the seed of supabase/migrations/155_f24_signup_guard.sql
// (a parity test keeps the two lists equal). Pure and import-free so the
// sign-up form (client) and scripts/qa/check-f24-db.mjs can both use it.
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set<string>([
  "0clock.net",
  "10minutemail.com",
  "20minutemail.com",
  "33mail.com",
  "burnermail.io",
  "dispostable.com",
  "emailondeck.com",
  "fakeinbox.com",
  "getairmail.com",
  "getnada.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "inboxbear.com",
  "inboxkitten.com",
  "mail-temp.com",
  "mailcatch.com",
  "maildrop.cc",
  "mailinator.com",
  "mailnesia.com",
  "moakt.com",
  "mohmal.com",
  "mytemp.email",
  "sharklasers.com",
  "spam4.me",
  "temp-mail.io",
  "temp-mail.org",
  "tempmail.com",
  "tempmail.dev",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.de",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
] as const);

/** Lower-cased part after the last "@" with trailing dots removed; null without "@". */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  return email.slice(at + 1).trim().toLowerCase().replace(/\.+$/, "");
}

/** True for a listed domain or any subdomain of one ("a.b.mailinator.com"). */
export function isDisposableEmailDomain(email: string): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return true;
  for (const listed of DISPOSABLE_EMAIL_DOMAINS) {
    if (domain.endsWith("." + listed)) return true;
  }
  return false;
}
