// Fixture fetch rewriting and DNS resolution for site-audit test harness.

export const FIXTURE_PUBLIC_IP = "93.184.216.34";

export async function fixtureLookup(hostname: string): Promise<string[]> {
  if (hostname.endsWith(".audit.test") || hostname === "audit.test") {
    return [FIXTURE_PUBLIC_IP];
  }
  return [FIXTURE_PUBLIC_IP];
}

export function fixtureFetch(baseUrl: string): typeof fetch {
  const base = new URL(baseUrl);
  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const parsed = new URL(rawUrl);

    // Match <site>.audit.test
    const hostMatch = parsed.hostname.match(/^([a-z0-9-]+)\.audit\.test$/i);
    const siteId = hostMatch ? hostMatch[1] : "main";

    const localUrl = new URL(parsed.pathname + parsed.search, base);
    const headers = new Headers(
      init?.headers ??
        (typeof input === "object" && "headers" in input
          ? (input as any).headers
          : undefined),
    );
    headers.set("x-fixture-site", siteId);
    headers.set("host", parsed.host);

    return fetch(localUrl.toString(), {
      ...init,
      headers,
    });
  }) as typeof fetch;
}
