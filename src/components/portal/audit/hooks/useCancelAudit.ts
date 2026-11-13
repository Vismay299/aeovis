"use client";

// F18 phase 4 — cancel a running audit. The server answers "cancelling" and the
// status query takes over from there.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/query/fetchJson";
import { keys } from "@/lib/query/keys";

export function useCancelAudit(brandKey: string, auditId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ status: string }, Error, void>({
    mutationFn: () =>
      fetchJson<{ status: string }>(
        `/api/customer/audit/${auditId}/cancel`,
        { method: "POST", body: { brand_key: brandKey } },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.siteAudit(auditId) });
      void queryClient.invalidateQueries({
        queryKey: keys.siteAudits(brandKey),
      });
    },
  });
}
