// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/lighthouse.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export const LIGHTHOUSE_CATEGORIES = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
] as const;

export const LIGHTHOUSE_CATEGORY_TABS = [
  "all",
  ...LIGHTHOUSE_CATEGORIES,
] as const;

export type LighthouseCategory = (typeof LIGHTHOUSE_CATEGORIES)[number];
export type LighthouseCategoryTab = (typeof LIGHTHOUSE_CATEGORY_TABS)[number];
