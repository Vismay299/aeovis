// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/posthog-sanitize.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

const ALLOWED_QUERY = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "tab",
  "view",
  "step",
  "range",
]);

const DROP_QUERY = new Set(["brand_key", "domain", "scan", "next", "redirect", "code"]);

/** Bare error-code shape (no dots/slashes) — messages that match may keep their text. */
const ERROR_CODE_RE = /^[A-Za-z0-9_:-]{1,64}$/;

export function isErrorCode(value: string): boolean {
  return ERROR_CODE_RE.test(value);
}

export function sanitizePostHogUrl(raw: string | undefined | null): string {
  if (!raw || typeof raw !== "string") return "";
  try {
    const base = "https://perceev.invalid";
    const u = new URL(raw, base);
    const kept = new URLSearchParams();
    for (const [k, v] of u.searchParams.entries()) {
      const key = k.toLowerCase();
      if (DROP_QUERY.has(key)) continue;
      if (ALLOWED_QUERY.has(key) || key.startsWith("utm_")) kept.set(k, v);
    }
    u.search = kept.toString() ? `?${kept.toString()}` : "";
    u.hash = "";
    // Return path+query only when same-origin relative; otherwise origin+path+query without hash.
    if (raw.startsWith("/") || !/^https?:\/\//i.test(raw)) {
      return `${u.pathname}${u.search}`;
    }
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return "";
  }
}

function cleanNestedUrls(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.includes("://") || value.startsWith("/")) return sanitizePostHogUrl(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(cleanNestedUrls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Heatmap / autocapture keys that can carry link targets
      if (k === "$external_click_url" || k === "href" || k === "url" || k === "$current_url") {
        out[k] = typeof v === "string" ? sanitizePostHogUrl(v) : cleanNestedUrls(v);
        continue;
      }
      out[k] = cleanNestedUrls(v);
    }
    return out;
  }
  return value;
}

export type PostHogEventLike = {
  event?: string;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
};

export function sanitizeEvent<T extends PostHogEventLike | null | undefined>(event: T): T {
  if (!event) return event;
  const props = { ...(event.properties ?? {}) } as Record<string, unknown>;

  if (typeof props.$current_url === "string") {
    props.$current_url = sanitizePostHogUrl(props.$current_url);
  }
  if (typeof props.$pathname === "string") {
    // Path only — strip query/hash if present
    props.$pathname = sanitizePostHogUrl(props.$pathname).split("?")[0];
  }

  // Exception messages: blank unless bare error code
  const list = props.$exception_list;
  if (Array.isArray(list)) {
    props.$exception_list = list.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const e = { ...(entry as Record<string, unknown>) };
      const value = typeof e.value === "string" ? e.value : "";
      if (value && !isErrorCode(value)) e.value = "";
      return e;
    });
  }
  if (typeof props.$exception_message === "string" && !isErrorCode(props.$exception_message)) {
    props.$exception_message = "";
  }

  // Drop autocaptured link targets
  delete props.$external_click_url;

  const cleaned = cleanNestedUrls(props) as Record<string, unknown>;
  return { ...event, properties: cleaned };
}
