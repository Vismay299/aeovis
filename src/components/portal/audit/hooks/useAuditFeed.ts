"use client";

// F18 phase 4 — the live crawl feed. Enabled only while the audit is active;
// the server paces it at 1.5 s.

import { fetchJson } from "@/lib/query/fetchJson";
import { keys } from "@/lib/query/keys";
import { useServerPacedQuery } from "@/components/app/hooks/useServerPacedQuery";

export type AuditFeedEntry = {
  url: string;
  statusCode: number | null;
  title: string | null;
  crawledAt: string;
};

export type AuditFeedResponse = {
  entries: AuditFeedEntry[];
  pollAfterSeconds: number | null;
};

export function useAuditFeed(auditId: string, enabled: boolean) {
  return useServerPacedQuery<AuditFeedResponse>({
    queryKey: keys.siteAuditFeed(auditId),
    queryFn: () =>
      fetchJson<AuditFeedResponse>(
        `/api/customer/audit/${auditId}/feed?limit=50`,
      ),
    enabled: Boolean(auditId) && enabled,
    isActive: (feed) => feed.pollAfterSeconds !== null,
    pollAfterSeconds: (feed) => feed.pollAfterSeconds,
    floorSeconds: 1.5,
    fallbackSeconds: 1.5,
  });
}
