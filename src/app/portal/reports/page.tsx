// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_app/p/$projectId/reports/index.tsx:20-82
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { notFound } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { usePortal } from "@/components/portal/PortalShell";
import { PageHeader } from "@/components/app/PageHeader";
import { QueryError } from "@/components/app/QueryState";
import { StatusScreen } from "@/components/app/StatusScreen";
import { SkeletonTableRows } from "@/components/app/SkeletonPresets";
import { Button } from "@/components/ui/button";
import { TableCard } from "@/components/ui/table";
import { ReportsList } from "@/components/portal/reports/ReportsList.tsx";
import { DeleteReportDialog } from "@/components/portal/reports/DeleteReportDialog.tsx";
import { GenerateReportDialog } from "@/components/portal/reports/GenerateReportDialog.tsx";
import {
  reportsQueryOptions,
  useDeleteReport,
  type ReportListItem,
} from "@/components/portal/reports/hooks/useReports.ts";

export default function ReportsRoutePage() {
  const { brandKey, brand, features } = usePortal();
  const router = useRouter();
  const [pendingDelete, setPendingDelete] = useState<ReportListItem | null>(
    null,
  );
  const [showGenerate, setShowGenerate] = useState(false);

  // The flag decides: with `reports` off the page does not exist.
  if (features && features.reports === false) {
    notFound();
  }

  const reportsQuery = useQuery(reportsQueryOptions(brandKey));
  const deleteMutation = useDeleteReport(brandKey, {
    onDeleted: () => setPendingDelete(null),
  });

  if (!features || !brandKey) {
    return <StatusScreen pending />;
  }

  const canGenerate =
    features.report_generate === true && features.assistant === true;
  // GAP-1: no route returns a workspace display name, so the description reads
  // it from the portal shell — the same source the Scans and Measurement pages
  // use for their display-name copy — and omits the "for X" clause when the
  // workspace has none.
  const displayName = brand?.display_name?.trim();
  const description = displayName
    ? `Reports the assistant wrote for ${displayName}. Open one to read, print or share it.`
    : "Reports the assistant wrote. Open one to read, print or share it.";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reports"
        description={description}
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => router.push("/portal/reports/templates")}
            >
              Templates
            </Button>
            {canGenerate ? (
              <Button onClick={() => setShowGenerate(true)}>
                <Sparkles data-icon="inline-start" />
                Generate report
              </Button>
            ) : null}
          </>
        }
      />

      {reportsQuery.isPending ? (
        <TableCard className="p-4">
          <SkeletonTableRows rows={6} />
        </TableCard>
      ) : reportsQuery.isError ? (
        <QueryError
          error={reportsQuery.error}
          fallback="Failed to load reports"
          onRetry={() => void reportsQuery.refetch()}
          isRetrying={reportsQuery.isFetching}
        />
      ) : (
        <ReportsList
          reports={reportsQuery.data?.reports ?? []}
          canGenerate={canGenerate}
          canOpenAssistant={features.assistant === true}
          onDelete={setPendingDelete}
          onGenerate={() => setShowGenerate(true)}
        />
      )}

      {pendingDelete ? (
        <DeleteReportDialog
          title={pendingDelete.title}
          isPending={deleteMutation.isPending}
          onClose={() => setPendingDelete(null)}
          onConfirm={() => deleteMutation.mutate(pendingDelete.id)}
        />
      ) : null}

      {showGenerate ? (
        <GenerateReportDialog
          brandKey={brandKey}
          onClose={() => setShowGenerate(false)}
        />
      ) : null}
    </div>
  );
}
