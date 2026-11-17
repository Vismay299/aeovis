"use client";

// F18 phase 4 — Lighthouse performance rows for a finished audit.

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";

export type AuditPerformanceRow = {
  id: string;
  pageId: string;
  pageUrl: string;
  pagePath: string;
  strategy: "mobile" | "desktop";
  performanceScore: number | null;
  accessibilityScore: number | null;
  bestPracticesScore: number | null;
  seoScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  ttfbMs: number | null;
  errorMessage: string | null;
  hasDetails: boolean;
};

export function useAuditPerformance(auditId: string, enabled: boolean) {
  return useQuery<{ rows: AuditPerformanceRow[] }>({
    queryKey: keys.siteAuditPerformance(auditId),
    queryFn: () =>
      fetchJson<{ rows: AuditPerformanceRow[] }>(
        `/api/customer/audit/${auditId}/performance`,
      ),
    enabled: Boolean(auditId) && enabled,
  });
}
