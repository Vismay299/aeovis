// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/audit-limits.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export const MIN_AUDIT_PAGES = 10;
export const DEFAULT_AUDIT_PAGES = 50;
export const FREE_MAX_AUDIT_PAGES = 50;
export const MAX_AUDIT_PAGES = 10_000;
export const PAID_MAX_AUDIT_PAGES = 10_000;
export const RENDERED_MAX_AUDIT_PAGES = 1_000;
export const LARGE_AUDIT_CONFIRM_PAGES = 500;
export const LIGHTHOUSE_SAMPLE_MAX = 10;
export const AUDIT_MONTHLY_PAGES_DEFAULT = 50_000;
export const AUDIT_HOST_CAP = 2;

export function clampAuditMaxPages(n?: number | null): number {
  if (n === undefined || n === null || Number.isNaN(n)) {
    return DEFAULT_AUDIT_PAGES;
  }
  return Math.max(MIN_AUDIT_PAGES, Math.min(MAX_AUDIT_PAGES, Math.floor(n)));
}

export function maxPagesFor(render: boolean, envMax?: number): number {
  const upper = envMax ?? MAX_AUDIT_PAGES;
  return render ? Math.min(RENDERED_MAX_AUDIT_PAGES, upper) : upper;
}

export function estimatedCrawlMinutes(pages: number): number {
  return Math.max(1, Math.ceil(pages / 60));
}
