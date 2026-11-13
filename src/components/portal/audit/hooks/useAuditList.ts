"use client";

// F18 phase 4 — the audit history query. One list read carries the workspace's
// audits and the capabilities the launch form needs.

import { useQuery } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { keys } from "@/lib/query/keys";
import type { AuditStatus } from "@/shared/audit";

export type AuditListRow = {
  id: string;
  startUrl: string;
  status: AuditStatus;
  pagesCrawled: number;
  pagesTotal: number;
  maxPages: number;
  lighthouse: boolean;
  renderJavaScript: boolean;
  createdAt: string;
  completedAt: string | null;
  issueCounts: { critical: number; warning: number; info: number } | null;
};

export type AuditCapabilities = {
  lighthouse: boolean;
  render: boolean;
  renderReason: null | "flag_off" | "not_configured";
  maxPages: number;
  renderedMaxPages: number;
  monthlyPagesUsed: number;
  monthlyPagesCap: number;
  defaultUrl: string | null;
};

export type AuditListResponse = {
  audits: AuditListRow[];
  capabilities: AuditCapabilities;
};

const ACTIVE = new Set(["queued", "running"]);

export function useAuditList(brandKey: string) {
  const query = useQuery<AuditListResponse>({
    queryKey: keys.siteAudits(brandKey),
    queryFn: () => fetchJson<AuditListResponse>(withBrand("/api/customer/audit", brandKey)),
    enabled: Boolean(brandKey),
    refetchInterval: (q) =>
      (q.state.data?.audits ?? []).some((audit) => ACTIVE.has(audit.status))
        ? 5_000
        : false,
  });

  return {
    ...query,
    audits: query.data?.audits ?? [],
    capabilities: query.data?.capabilities ?? null,
  };
}
