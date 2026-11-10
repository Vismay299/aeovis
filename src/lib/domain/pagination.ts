// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/domain/services/pagination.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * Whether more pages exist, given the raw provider row count for this page
 * (`response.items.length`).
 */
export function computeHasMore(
  offset: number,
  fetchedCount: number,
  totalCount: number | null | undefined,
  pageSize: number,
): boolean {
  return totalCount != null
    ? offset + fetchedCount < totalCount
    : fetchedCount === pageSize;
}
