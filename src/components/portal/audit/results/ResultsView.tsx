// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/results/ResultsView.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — the results card: banners, the stats strip, the Issues / Pages
// / Performance / AI access tabs and the client export of the visible rows.

import { z } from "zod";
import type { UseQueryResult } from "@tanstack/react-query";
import { TabsTrigger } from "@/components/ui/tabs";
import { DataTableTabs } from "@/components/app/table/DataTableToolbar";
import { ExportMenu } from "@/components/app/ExportMenu";
import { useExportRows } from "@/components/app/export/useExportRows";
import { QueryState } from "@/components/app/QueryState";
import { SkeletonPage } from "@/components/app/SkeletonPresets";
import { useUrlSearchState } from "@/components/app/hooks/useUrlSearchState";
import { exportFilename } from "@/lib/export/filenames";
import type { ExportFormat } from "@/lib/export/exportRows";
import type { AuditSummary } from "../hooks/useAuditSummary";
import { useAuditPerformance } from "../hooks/useAuditPerformance";
import { trackAuditEvent } from "../telemetry";
import { hostOf } from "../shared";
import { AuditBanners } from "../AuditBanners";
import { StatsStrip } from "./StatsStrip";
import { IssuesView } from "./IssuesView";
import { PagesTable } from "./PagesTable";
import { PerformanceTable } from "./PerformanceTable";
import { AiAccessView } from "./AiAccessView";
import {
  aiAccessExport,
  issuesExport,
  performanceExport,
} from "./export";

const VIEW_SCHEMA = z.object({ view: z.string().optional() });
const VIEW_DEFAULTS = { view: "issues" };
const VIEWS = new Set(["issues", "pages", "performance", "ai"]);
type View = "issues" | "pages" | "performance" | "ai";

export function ResultsView({
  brandKey,
  auditId,
  summary,
  canRender,
}: {
  brandKey: string;
  auditId: string;
  summary: UseQueryResult<AuditSummary>;
  canRender: boolean;
}) {
  const [state, setState] = useUrlSearchState(VIEW_SCHEMA, VIEW_DEFAULTS);
  const view: View = VIEWS.has(state.view ?? "")
    ? (state.view as View)
    : "issues";
  const performance = useAuditPerformance(auditId, true);
  const exportRows = useExportRows();
  const perfRows = performance.data?.rows ?? [];

  function setView(next: string) {
    if (!VIEWS.has(next)) return;
    trackAuditEvent("site_audit:view_change", { view: next });
    setState({ view: next });
  }

  return (
    <QueryState
      query={summary}
      errorFallback="We couldn't load the audit results."
      loading={<SkeletonPage />}
    >
      {(data) => {
        const host = hostOf(data.audit.startUrl);
        const issueRows = data.issueGroups.reduce(
          (sum, group) => sum + group.rows,
          0,
        );
        const filenameParts = (suffix: string) => [
          brandKey,
          "site-audit",
          host,
          suffix,
        ];

        function exportView(format: ExportFormat) {
          if (view === "issues") {
            const table = issuesExport(data.issueGroups);
            void exportRows({
              format,
              feature: "audit_issues",
              headers: table.headers,
              rows: table.rows,
              filename: exportFilename(filenameParts("issues")),
              records: data.issueGroups,
            });
            return;
          }
          if (view === "performance") {
            const table = performanceExport(perfRows);
            void exportRows({
              format,
              feature: "audit_performance",
              headers: table.headers,
              rows: table.rows,
              filename: exportFilename(filenameParts("performance")),
              records: perfRows,
            });
            return;
          }
          if (view === "ai") {
            const table = aiAccessExport(data.aiAccess.rows);
            void exportRows({
              format,
              feature: "audit_ai_access",
              headers: table.headers,
              rows: table.rows,
              filename: exportFilename(filenameParts("ai-access")),
              records: data.aiAccess.rows,
            });
          }
        }

        return (
          <div className="space-y-4">
            <AuditBanners summary={data} canRender={canRender} />
            <StatsStrip summary={data} />

            <div className="space-y-3">
              <DataTableTabs
                value={view}
                onValueChange={setView}
                actions={
                  view === "pages" ? null : (
                    <ExportMenu
                      actions={["sheets", "csv", "excel", "json"]}
                      onExport={(action) => exportView(action)}
                    />
                  )
                }
              >
                <TabsTrigger value="issues">
                  {`Issues (${issueRows.toLocaleString("en-US")})`}
                </TabsTrigger>
                <TabsTrigger value="pages">
                  {`Pages (${data.audit.pagesCrawled.toLocaleString("en-US")})`}
                </TabsTrigger>
                {perfRows.length > 0 ? (
                  <TabsTrigger value="performance">
                    {`Performance (${perfRows.length.toLocaleString("en-US")})`}
                  </TabsTrigger>
                ) : null}
                <TabsTrigger value="ai">AI access</TabsTrigger>
              </DataTableTabs>

              {view === "issues" ? (
                <div className="rounded-lg border border-border p-3">
                  <IssuesView auditId={auditId} summary={data} />
                </div>
              ) : null}

              {view === "pages" ? (
                <PagesTable
                  brandKey={brandKey}
                  auditId={auditId}
                  host={host}
                />
              ) : null}

              {view === "performance" ? (
                <PerformanceTable
                  auditId={auditId}
                  rows={perfRows}
                  isLoading={performance.isLoading}
                  isError={performance.isError}
                  error={performance.error}
                  onRetry={() => void performance.refetch()}
                  isRetrying={performance.isFetching}
                />
              ) : null}

              {view === "ai" ? <AiAccessView summary={data} /> : null}
            </div>
          </div>
        );
      }}
    </QueryState>
  );
}
