// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/QueryState.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export type QueryStateView =
  | "loading"
  | "idle"
  | "error"
  | "error+content"
  | "content";

export interface QueryStateInput {
  isPending: boolean;
  isError: boolean;
  /** TanStack's fetchStatus. Omitted means a fetch may be in flight. */
  fetchStatus?: "fetching" | "paused" | "idle";
  data: unknown;
}

/**
 * Pure function covering the view states of a query:
 * - "loading": no data yet and a fetch is in flight or paused offline
 * - "idle": no data and nothing fetching (a disabled query, `enabled: false`)
 * - "error": first fetch failed and no cached data is present
 * - "error+content": background refetch failed but stale data is still present
 * - "content": query succeeded and content is available
 */
export function queryStateView(q: QueryStateInput): QueryStateView {
  if (q.isPending) {
    return q.fetchStatus === "idle" ? "idle" : "loading";
  }
  if (q.isError) {
    return q.data !== undefined ? "error+content" : "error";
  }
  return "content";
}
