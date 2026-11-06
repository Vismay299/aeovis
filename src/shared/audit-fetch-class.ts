// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/audit-fetch-class.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export const PAGE_FETCH_CLASSES = [
  "ok",
  "blocked",
  "rate_limited",
  "error",
] as const;

export type PageFetchClass = (typeof PAGE_FETCH_CLASSES)[number];
