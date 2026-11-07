// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/table/url.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { safeHttpUrl } from "../../shared/safe-url.ts";

export function formatUrlForDisplay(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    const hash = url.hash.startsWith("#:~:") ? "" : url.hash;
    const cleaned = `${url.protocol}//${url.host}${url.pathname}${url.search}${hash}`;
    try {
      return decodeURI(cleaned);
    } catch {
      return cleaned;
    }
  } catch {
    return value;
  }
}

export function resolveUrlHref(
  value: string | null | undefined,
  baseDomain?: string | null,
): string | null {
  if (!value) return null;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) {
    return safeHttpUrl(value);
  }
  if (!baseDomain) return null;
  return safeHttpUrl(
    `https://${baseDomain}${value.startsWith("/") ? value : `/${value}`}`,
  );
}
