// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/urls.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export function buildAppUrl(
  baseUrl: string,
  path: string,
  params?: Record<string, string | number | undefined>,
): string {
  const url = new URL(path.startsWith("/") ? path : "/" + path, baseUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function appBaseUrl(
  env: Record<string, string | undefined>,
  request?: Request,
): string {
  const configured = env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return new URL(configured).origin;
  if (request) {
    try {
      return new URL(request.url).origin;
    } catch {
      // Use the stable public origin when a test or adapter supplies a bad URL.
    }
  }
  return "https://perceev.com";
}
