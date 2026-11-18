// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_app/p/$projectId/reports/$reportId.tsx:44-346
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  notFound,
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  ExternalLink,
  FileDown,
  Globe,
  Lock,
  Maximize2,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { usePortal } from "@/components/portal/PortalShell";
import { BackLink, PageHeader } from "@/components/app/PageHeader";
import { QueryError } from "@/components/app/QueryState";
import { RowActionsMenu } from "@/components/app/RowActionsMenu";
import { SkeletonPage } from "@/components/app/SkeletonPresets";
import { StatusScreen } from "@/components/app/StatusScreen";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isApiError } from "@/shared/query/fetchJson";
import { formatTimestamp, relativeTime } from "@/shared/format";
import { trackEvent } from "@/shared/telemetry/client";
import { ReportViewer } from "@/components/portal/reports/ReportViewer.tsx";
import { FullScreenReport } from "@/components/portal/reports/FullScreenReport.tsx";
import { ShareReportDialog } from "@/components/portal/reports/ShareReportDialog.tsx";
import { DeleteReportDialog } from "@/components/portal/reports/DeleteReportDialog.tsx";
import { formatWrittenBy } from "@/components/portal/reports/formatWrittenBy.ts";
import {
  reportQueryOptions,
  useDeleteReport,
} from "@/components/portal/reports/hooks/useReports.ts";

export default function ReportDetailRoutePage() {
  return (
    <Suspense fallback={<StatusScreen pending />}>
      <ReportDetailPage />
    </Suspense>
  );
}

function ReportDetailPage() {
  const params = useParams();
  const reportId = typeof params?.reportId === "string" ? params.reportId : "";
  const { brandKey, features } = usePortal();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showShare, setShowShare] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const openedRef = useRef<string | null>(null);

  // The flag decides: with `reports` off the page does not exist.
  if (features && features.reports === false) {
    notFound();
  }

  const reportQuery = useQuery(reportQueryOptions(brandKey, reportId));
  const deleteMutation = useDeleteReport(brandKey, {
    onDeleted: () => {
      setShowDelete(false);
      // `replace`, so Back does not return to the deleted report's URL.
      router.replace("/portal/reports");
    },
  });

  // One open event per report, once its metadata (and so its skill) is known.
  const loadedReport = reportQuery.data?.report;
  useEffect(() => {
    if (!loadedReport || openedRef.current === loadedReport.id) return;
    openedRef.current = loadedReport.id;
    if (loadedReport.skill) {
      trackEvent("report:opened", { skill: loadedReport.skill });
    }
  }, [loadedReport]);

  const exitFullScreen = useCallback(() => {
    router.replace(pathname, { scroll: false });
  }, [router, pathname]);

  if (!features || !brandKey || reportQuery.isPending) {
    if (reportQuery.isPending && features && brandKey) {
      return <SkeletonPage />;
    }
    return <StatusScreen pending />;
  }

  const notFoundError =
    !reportId ||
    (reportQuery.isError &&
      isApiError(reportQuery.error) &&
      reportQuery.error.status === 404);

  if (notFoundError || reportQuery.data === undefined) {
    return (
      <div className="space-y-4">
        <BackLink href="/portal/reports">Reports</BackLink>
        {/* A deleted report and another workspace's report are the same
            answer on purpose, so ids cannot be probed. Retrying either
            cannot help. */}
        {notFoundError ? (
          <QueryError
            variant="page"
            title="Report not found"
            fallback="This report does not exist or you do not have access to it."
          />
        ) : (
          <QueryError
            variant="page"
            title="Couldn't load the report"
            error={reportQuery.error}
            fallback="Couldn't load the report"
            onRetry={() => void reportQuery.refetch()}
            isRetrying={reportQuery.isFetching}
          />
        )}
      </div>
    );
  }

  const report = reportQuery.data.report;

  // `?print=1` serves the same document with a print() script appended, so the
  // new tab opens the print dialog itself.
  const exportPdf = () => {
    trackEvent("report:exported_pdf", {});
    window.open(`/r/${report.id}?print=1`, "_blank", "noopener");
  };

  const full = searchParams.get("full") === "1";
  if (full) {
    return (
      <FullScreenReport
        reportId={report.id}
        title={report.title}
        onExit={exitFullScreen}
      />
    );
  }

  const canShare = features.report_sharing === true;

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col gap-3">
      <PageHeader
        backLink={<BackLink href="/portal/reports">Reports</BackLink>}
        title={report.title}
        description={
          <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-foreground">
            <div className="flex items-baseline gap-1.5">
              <dt className="text-muted-foreground">Written by</dt>
              <dd>{formatWrittenBy(report)}</dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-muted-foreground">Type</dt>
              {/* As in the list's Type column: the template name when the
                  report followed one, else the skill, else an em dash. */}
              <dd>{report.templateName ?? report.skillTitle ?? "\u2014"}</dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-muted-foreground">Updated</dt>
              <dd title={formatTimestamp(report.updatedAt)}>
                {relativeTime(report.updatedAt)}
              </dd>
            </div>
          </dl>
        }
        actions={
          <>
            {canShare ? (
              <Button onClick={() => setShowShare(true)}>
                {report.shared ? (
                  <Globe data-icon="inline-start" />
                ) : (
                  <Lock data-icon="inline-start" />
                )}
                Share
              </Button>
            ) : (
              <Button onClick={exportPdf}>
                <FileDown data-icon="inline-start" />
                Export
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Report actions"
                  />
                }
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={exportPdf}>
                  <FileDown />
                  Export to PDF
                </DropdownMenuItem>
                {report.chatPath ? (
                  <DropdownMenuItem
                    onClick={() => router.push(report.chatPath as string)}
                  >
                    <ExternalLink />
                    Open the chat that wrote this
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setShowDelete(true)}
                >
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      {reportQuery.isError ? (
        <QueryError
          error={reportQuery.error}
          fallback="Couldn't load the report"
          onRetry={() => void reportQuery.refetch()}
          isRetrying={reportQuery.isFetching}
        />
      ) : null}

      {/* The viewer fills the width with a phone-tall minimum. */}
      <div className="relative min-h-[70dvh] min-w-0 flex-1">
        {/* View controls float over the top-right corner of the report frame.
            They belong to the viewer, not the document, so they overlay the
            iframe instead of being injected into it. Placed before the iframe
            so keyboard focus reaches them without tabbing through the report;
            inset from the edge so they clear a classic scrollbar. z-10 keeps
            them above the viewer, which is positioned and comes later. */}
        <div className="absolute top-1 right-5 z-10 flex items-center gap-0.5 rounded-md border border-border bg-card/95 p-0.5 shadow-sm backdrop-blur">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Full screen"
            title="Full screen"
            onClick={() =>
              router.replace(`${pathname}?full=1`, { scroll: false })
            }
          >
            <Maximize2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open in new tab"
            title="Open in new tab"
            onClick={() =>
              window.open(`/r/${report.id}`, "_blank", "noreferrer")
            }
          >
            <ExternalLink />
          </Button>
        </div>
        <ReportViewer src={`/r/${report.id}`} title={report.title} />
      </div>

      {showShare ? (
        <ShareReportDialog
          brandKey={brandKey}
          report={report}
          onClose={() => setShowShare(false)}
        />
      ) : null}

      {showDelete ? (
        <DeleteReportDialog
          title={report.title}
          isPending={deleteMutation.isPending}
          onClose={() => setShowDelete(false)}
          onConfirm={() => deleteMutation.mutate(report.id)}
        />
      ) : null}
    </div>
  );
}
