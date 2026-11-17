"use client";

// F18 phase 4 — the audit status query. Polls only while the audit is active,
// at the server's `pollAfterSeconds` (floor 3 s), and invalidates the result
// reads the moment it finishes.

import { useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";
import { useServerPacedQuery } from "@/components/app/hooks/useServerPacedQuery";
import type { AuditPhase, AuditStatus } from "@/shared/audit";

export type AuditStatusResponse = {
  id: string;
  startUrl: string;
  status: AuditStatus;
  currentPhase: AuditPhase;
  pagesCrawled: number;
  pagesTotal: number;
  lighthouseTotal: number;
  lighthouseCompleted: number;
  lighthouseFailed: number;
  renderJavaScript: boolean;
  lighthouse: boolean;
  cancelRequested: boolean;
  errorCode: string | null;
  failedPhase: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  pollAfterSeconds: number | null;
};

export function isAuditActive(audit: { status: string } | undefined): boolean {
  return audit?.status === "queued" || audit?.status === "running";
}

export function useAuditStatus(auditId: string, brandKey: string) {
  const queryClient = useQueryClient();
  return useServerPacedQuery<AuditStatusResponse>({
    queryKey: keys.siteAudit(auditId),
    queryFn: () =>
      fetchJson<AuditStatusResponse>(`/api/customer/audit/${auditId}`),
    enabled: Boolean(auditId),
    isActive: (audit) => isAuditActive(audit),
    pollAfterSeconds: (audit) => audit.pollAfterSeconds,
    floorSeconds: 3,
    onFinish: () => {
      void queryClient.invalidateQueries({
        queryKey: keys.siteAudits(brandKey),
      });
      void queryClient.invalidateQueries({
        queryKey: keys.siteAuditSummary(auditId),
      });
      void queryClient.invalidateQueries({
        queryKey: keys.siteAuditPerformance(auditId),
      });
    },
  });
}
