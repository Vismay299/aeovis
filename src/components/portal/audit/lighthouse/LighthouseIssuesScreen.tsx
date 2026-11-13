// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/lighthouse/issues/LighthouseIssuesScreen.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/query/fetchJson";
import { keys } from "@/lib/query/keys";
import { BackLink } from "@/components/app/PageHeader";
import { QueryError } from "@/components/app/QueryState";
import { SkeletonPage } from "@/components/app/SkeletonPresets";
import { ExportMenu } from "@/components/app/ExportMenu";
import { Card } from "@/components/ui/card";
import type { CategoryTab, LighthouseDetail } from "./types.ts";
import { LighthouseIssuesHeader, LighthouseIssueList, LighthouseIssuesToolbar } from "./LighthouseIssuesParts.tsx";

function downloadFile(content: string, filename: string) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function LighthouseIssuesScreen({
  auditId,
  resultId,
  category,
  onCategoryChange,
}: {
  auditId: string;
  resultId: string;
  category: CategoryTab;
  onCategoryChange: (next: CategoryTab) => void;
}) {
  const [busy, setBusy] = useState(false);
  const detailQuery = useQuery<LighthouseDetail>({
    queryKey: keys.siteAuditLighthouse(resultId),
    queryFn: () => fetchJson<LighthouseDetail>(`/api/customer/audit/${auditId}/lighthouse/${resultId}`),
    enabled: Boolean(auditId) && Boolean(resultId),
  });

  const issues = detailQuery.data?.issues ?? [];
  const visible = category === "all" ? issues : issues.filter((i) => i.category === category);
  const counts = {
    all: issues.length,
    performance: issues.filter((i) => i.category === "performance").length,
    accessibility: issues.filter((i) => i.category === "accessibility").length,
    "best-practices": issues.filter((i) => i.category === "best-practices").length,
    seo: issues.filter((i) => i.category === "seo").length,
  } as Record<CategoryTab, number>;
  const severityCounts = {
    critical: visible.filter((i) => i.severity === "critical").length,
    warning: visible.filter((i) => i.severity === "warning").length,
    info: visible.filter((i) => i.severity === "info").length,
  };

  async function runExport(mode: "full" | "issues" | "category") {
    setBusy(true);
    try {
      const params = mode === "category" ? `?mode=category&category=${category}` : `?mode=${mode}`;
      const res = await fetch(`/api/customer/audit/${auditId}/lighthouse/${resultId}/export${params}`);
      const content = await res.text();
      const disposition = res.headers.get("content-disposition") ?? "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `lighthouse-${mode}.json`;
      downloadFile(content, filename);
    } finally {
      setBusy(false);
    }
  }

  if (detailQuery.isPending) return <SkeletonPage />;
  if (detailQuery.isError) {
    return (
      <div className="px-4 py-4 md:px-6 md:py-6">
        <div className="mx-auto max-w-7xl space-y-4">
          <BackLink href={`/portal/audit/${auditId}?view=performance`}>Back to audit</BackLink>
          <QueryError error={detailQuery.error} fallback="Couldn't load this Lighthouse report." onRetry={() => detailQuery.refetch()} isRetrying={detailQuery.isFetching} />
        </div>
      </div>
    );
  }
  if (!detailQuery.data?.hasIssueDetails) {
    return (
      <div className="px-4 py-4 md:px-6 md:py-6">
        <div className="mx-auto max-w-7xl space-y-4">
          <BackLink href={`/portal/audit/${auditId}?view=performance`}>Back to audit</BackLink>
          <p className="text-sm text-muted-foreground">This Lighthouse run was saved without issue details. Run a new audit to see them.</p>
        </div>
      </div>
    );
  }

  const strategyLabel = detailQuery.data.strategy === "mobile" ? "Mobile" : "Desktop";
  let path = "";
  try {
    path = detailQuery.data.finalUrl ? new URL(detailQuery.data.finalUrl).pathname || "/" : "";
  } catch {
    path = detailQuery.data.finalUrl ?? "";
  }

  return (
    <div className="px-4 py-4 md:px-6 md:py-6 pb-24 md:pb-8 overflow-auto">
      <div className="mx-auto max-w-7xl space-y-4">
        <LighthouseIssuesHeader
          auditId={auditId}
          isLoading={false}
          scannedAt={detailQuery.data.createdAt}
          finalUrl={detailQuery.data.finalUrl}
          scores={detailQuery.data.scores}
          metrics={detailQuery.data.metrics}
          severityCounts={severityCounts}
        />
        <p className="sr-only">
          {path} · {strategyLabel}
        </p>
        <Card>
          <LighthouseIssuesToolbar
            category={category}
            categoryCounts={counts}
            onCategoryChange={onCategoryChange}
            onExport={runExport}
            busy={busy}
          />
          <div className="flex flex-wrap gap-2 px-4 py-2">
            <ExportMenu
              actions={["json"]}
              busy={busy}
              onExport={(action) => {
                if (action === "json") void runExport("full");
              }}
            />
            <span className="text-xs text-muted-foreground">Download full report (JSON) · Download issues (JSON) · Download this category (JSON)</span>
          </div>
          <LighthouseIssueList issues={visible} isLoading={false} emptyMessage={issues.length && !visible.length ? "No issues in this category." : undefined} />
        </Card>
      </div>
    </div>
  );
}
