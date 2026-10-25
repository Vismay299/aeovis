// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/url-policy.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

const BLOCKED_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
  "100.100.100.200",
]);

const BLOCKED_HOST_SUFFIXES: readonly string[] = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home.arpa",
];

export { BLOCKED_HOSTS, BLOCKED_HOST_SUFFIXES };

export function normalizeHost(hostname: string): string {
  let host = hostname.toLowerCase().trim();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  const percent = host.indexOf("%");
  if (percent !== -1) {
    host = host.slice(0, percent);
  }
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  return host;
}

export function isBlockedHostName(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
