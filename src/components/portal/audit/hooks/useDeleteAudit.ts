"use client";

// F18 phase 4 — delete a finished audit from the history table.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/query/fetchJson";
import { keys } from "@/lib/query/keys";

export function useDeleteAudit(brandKey: string) {
  const queryClient = useQueryClient();
  return useMutation<{ deleted: true }, Error, string>({
    mutationFn: (auditId) =>
      fetchJson<{ deleted: true }>(`/api/customer/audit/${auditId}`, {
        method: "DELETE",
      }),
    onSuccess: (_data, auditId) => {
      queryClient.removeQueries({ queryKey: keys.siteAudit(auditId) });
      queryClient.removeQueries({ queryKey: keys.siteAuditFeed(auditId) });
      queryClient.removeQueries({ queryKey: keys.siteAuditSummary(auditId) });
      queryClient.removeQueries({ queryKey: keys.siteAuditPerformance(auditId) });
      return queryClient.invalidateQueries({
        queryKey: keys.siteAudits(brandKey),
      });
    },
  });
}
