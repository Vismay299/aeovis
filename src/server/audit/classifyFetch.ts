// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/classify-fetch.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { PageFetchClass } from "../../shared/audit-fetch-class.ts";

const CHALLENGE_2XX =
  /<title>\s*(?:just a moment\.\.\.|attention required! \| cloudflare)\s*<\/title>|\/\.well-known\/sgcaptcha\//i;

const CHALLENGE_BODY_MARKERS = [
  "just a moment...",
  "challenge-platform",
  "cf-browser-verification",
  "attention required! | cloudflare",
  "verifying you are human",
];

export function classifyFetch(
  statusCode: number,
  mitigated: boolean,
  bodySnippet: string,
): PageFetchClass {
  if (statusCode === 0) return "error";
  if (statusCode === 429) return "rate_limited";
  if (mitigated) return "blocked";
  if (statusCode === 401 || statusCode === 403) return "blocked";
  if (statusCode === 202) return "blocked";
  if (statusCode >= 200 && statusCode < 300 && CHALLENGE_2XX.test(bodySnippet)) {
    return "blocked";
  }
  if (statusCode === 503) {
    const snippet = bodySnippet.toLowerCase();
    if (CHALLENGE_BODY_MARKERS.some((marker) => snippet.includes(marker))) {
      return "blocked";
    }
  }
  return "ok";
}
