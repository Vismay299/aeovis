// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/QueryState.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export type QueryStateView = "loading" | "error" | "error+content" | "content";

export interface QueryStateInput {
  isPending: boolean;
  isError: boolean;
  data: unknown;
}

/**
 * Pure function covering the four view states of a query:
 * - "loading": initial fetch in flight (isPending)
 * - "error": first fetch failed and no cached data is present (isError && data === undefined)
 * - "error+content": background refetch failed but stale data is still present (isError && data !== undefined)
 * - "content": query succeeded and content is available
 */
export function queryStateView(q: QueryStateInput): QueryStateView {
  if (q.isPending) {
    return "loading";
  }
  if (q.isError) {
    return q.data !== undefined ? "error+content" : "error";
  }
  return "content";
}
