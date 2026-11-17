"use client";

// F18 phase 4 — affected pages for one issue type, read when a group expands.

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";

export type AuditIssueRow = {
  id: string;
  pageId: string | null;
  pageUrl: string;
  details: Record<string, unknown> | null;
};

export type AuditIssuesResponse = {
  issueType: string;
  total: number;
  rows: AuditIssueRow[];
};

export function useAuditIssues(
  auditId: string,
  issueType: string,
  offset: number,
  enabled: boolean,
) {
  return useQuery<AuditIssuesResponse>({
    queryKey: keys.siteAuditIssues(auditId, issueType, offset),
    queryFn: () => {
      const params = new URLSearchParams({
        type: issueType,
        offset: String(offset),
        limit: "100",
      });
      return fetchJson<AuditIssuesResponse>(
        `/api/customer/audit/${auditId}/issues?${params.toString()}`,
      );
    },
    enabled: Boolean(auditId) && Boolean(issueType) && enabled,
  });
}
