"use client";

// F18 phase 4 — start an audit. The caller supplies `maxUsd` only after the
// cost dialog approval; a free audit omits it.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";

export type StartAuditInput = {
  startUrl?: string;
  maxPages: number;
  lighthouse: boolean;
  renderJavaScript: boolean;
  maxUsd?: number;
};

export type StartAuditResponse = {
  auditId: string;
  jobId: string;
  status: "queued";
  pollAfterSeconds: number;
  approvedMaxUsd: number | null;
};

export function useStartAudit(brandKey: string) {
  const queryClient = useQueryClient();
  return useMutation<StartAuditResponse, Error, StartAuditInput>({
    mutationFn: (input) =>
      fetchJson<StartAuditResponse>(
        withBrand("/api/customer/audit", brandKey),
        { method: "POST", body: { brand_key: brandKey, ...input } },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keys.siteAudits(brandKey) }),
  });
}
