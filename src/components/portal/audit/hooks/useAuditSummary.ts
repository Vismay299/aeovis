"use client";

// F18 phase 4 — the audit summary: stats, issue groups, stored AI access and
// llms.txt, and the banners' flags. Read once the audit is finished.

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";
import type { IssueCategory, IssueScope, IssueSeverity } from "@/shared/audit-issues";

export type AuditIssueGroup = {
  issueType: string;
  severity: IssueSeverity;
  category: IssueCategory;
  scope: IssueScope;
  pages: number;
  rows: number;
};

export type AiAccessRow = {
  name: string;
  operator: string | null;
  platform: string | null;
  purpose: "search" | "agent" | "training" | string;
  status: "open" | "partial" | "blocked" | string;
  matchedGroup: string | null;
  reason: string | null;
  unknown?: boolean;
};

export type AuditSummary = {
  audit: {
    id: string;
    startUrl: string;
    status: string;
    pagesCrawled: number;
    pagesSeen: number;
    maxPages: number;
    crawlCompleted: boolean;
    lighthouse: boolean;
    renderJavaScript: boolean;
    sitePlatform: string | null;
    createdAt: string;
    completedAt: string | null;
  };
  stats: {
    averageResponseMs: number | null;
    pagesBlocked: number;
    pagesRateLimited: number;
    pagesAbandoned: number;
    pagesUnread: number;
    lighthouse: {
      tests: number;
      failed: number;
      avgPerformance: number | null;
      avgSeo: number | null;
      avgAccessibility: number | null;
    };
  };
  issueGroups: AuditIssueGroup[];
  aiAccess: { robotsStatus: string | null; rows: AiAccessRow[] };
  llmsTxt: {
    status: "present" | "missing" | "invalid" | "unreachable" | string;
    httpStatus: number | null;
    contentType: string | null;
    firstLine: string | null;
  };
  flags: {
    siteBlocked: boolean;
    crawlStopped: boolean;
    hasShells: boolean;
    unreadRendered: boolean;
    linkGraphComplete: boolean;
    discoveryTruncated: boolean;
  };
};

export function useAuditSummary(auditId: string, enabled: boolean) {
  return useQuery<AuditSummary>({
    queryKey: keys.siteAuditSummary(auditId),
    queryFn: () =>
      fetchJson<AuditSummary>(`/api/customer/audit/${auditId}/summary`),
    enabled: Boolean(auditId) && enabled,
  });
}
