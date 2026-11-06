"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/AuditDetail.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { keys } from "@/lib/query/keys";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { isJobActive } from "@/lib/query/polling";
import { useServerPacedQuery } from "./useServerPacedQuery";

export type JobStatusResponse = {
  status: string;
  progress?: { done: number; total: number; label?: string };
  pollAfterSeconds?: number | null;
  result?: unknown;
  error?: { code: string; message: string };
};

export function useJobStatus(
  brandKey: string,
  jobId: string | null | undefined,
  options?: {
    onFinish?: (data: JobStatusResponse) => void;
  }
) {
  const enabled = Boolean(brandKey && jobId);

  return useServerPacedQuery<JobStatusResponse>({
    queryKey: keys.jobStatus(brandKey || "none", jobId || "none"),
    queryFn: ({ signal }) =>
      fetchJson<JobStatusResponse>(
        withBrand(`/api/customer/jobs/${encodeURIComponent(jobId!)}`, brandKey),
        { signal }
      ),
    enabled,
    isActive: isJobActive,
    pollAfterSeconds: (d) => d?.pollAfterSeconds,
    floorSeconds: 4,
    fallbackSeconds: 5,
    onFinish: options?.onFinish,
  });
}
