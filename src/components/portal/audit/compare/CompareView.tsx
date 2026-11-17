"use client";

import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EmptyState } from "@/components/app/EmptyState";
import { NotFound } from "@/components/app/NotFound";
import { PageHeader, BackLink } from "@/components/app/PageHeader";
import { QueryError } from "@/components/app/QueryState";
import { SkeletonPage } from "@/components/app/SkeletonPresets";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePortal } from "@/components/portal/PortalShell";
import { ApiError, fetchJson, withBrand } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";
import type { IssueSeverity } from "@/shared/audit-issues";
import { SeverityBadge, formatAuditDate } from "../shared";

type AuditCompareInfo = {
  id: string;
  createdAt: string;
  pagesCrawled: number;
  maxPages: number;
  crawlCompleted: boolean;
};

type AuditCompareRow = {
  issueType: string;
  severity: IssueSeverity;
  basePages: number;
  headPages: number;
  newPages: string[];
  fixedPages: string[];
};

type AuditCompareResponse = {
  host: string;
  base: AuditCompareInfo;
  head: AuditCompareInfo;
  comparable: boolean;
  warnings: Array<{ code: string; message: string }>;
  rows: AuditCompareRow[];
};

function ChangePages({ row }: { row: AuditCompareRow }) {
  const change = row.headPages - row.basePages;
  const changeText =
    change > 0 ? `+${change}` : change < 0 ? `−${Math.abs(change)}` : "No change";
  const changeClass =
    change > 0
      ? "text-destructive"
      : change < 0
        ? "text-success"
        : "text-muted-foreground";

  return (
    <div className="space-y-2">
      <span className={`font-medium tabular-nums ${changeClass}`}>{changeText}</span>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          {`New (${row.newPages.length})`}
        </summary>
        <ul className="mt-1 max-w-xl space-y-1 break-all pl-4">
          {row.newPages.slice(0, 100).map((url) => (
            <li key={url}>
              <span>{url}</span>
            </li>
          ))}
        </ul>
      </details>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          {`Fixed (${row.fixedPages.length})`}
        </summary>
        <ul className="mt-1 max-w-xl space-y-1 break-all pl-4">
          {row.fixedPages.slice(0, 100).map((url) => (
            <li key={url}>
              <span>{url}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function CompareView() {
  const { brandKey, features } = usePortal();
  const searchParams = useSearchParams();
  const baseId = searchParams.get("base") ?? "";
  const headId = searchParams.get("head") ?? "";

  const compare = useQuery<AuditCompareResponse>({
    queryKey: keys.siteAuditCompare(baseId, headId),
    queryFn: () =>
      fetchJson<AuditCompareResponse>(
        withBrand("/api/customer/audit/compare", brandKey, {
          base: baseId,
          head: headId,
        }),
      ),
    enabled: Boolean(brandKey) && features?.site_audit === true,
    retry: false,
  });

  if (features === null) return <SkeletonPage />;
  if (features.site_audit !== true) return <NotFound />;
  if (!brandKey) {
    return (
      <EmptyState
        title="Workspace required"
        description="Select a workspace to compare audits."
      />
    );
  }

  const backLink = <BackLink href="/portal/audit">Back to audits</BackLink>;

  if (compare.isPending) return <SkeletonPage />;

  if (compare.error instanceof ApiError && compare.error.status === 422) {
    return (
      <div className="space-y-4">
        <PageHeader title="Compare audits" backLink={backLink} />
        <Alert variant="destructive">
          <AlertDescription className="space-y-2">
            <p>{compare.error.message}</p>
            <BackLink href="/portal/audit">Back to audits</BackLink>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (compare.isError || !compare.data) {
    return (
      <div className="space-y-4">
        <PageHeader title="Compare audits" backLink={backLink} />
        <QueryError
          error={compare.error}
          fallback="Couldn't compare these audits."
          onRetry={() => void compare.refetch()}
          isRetrying={compare.isFetching}
        />
      </div>
    );
  }

  const result = compare.data;
  const coverageWarning = result.warnings.find(
    (warning) => warning.code === "coverage_differs",
  );
  const dates = `${formatAuditDate(result.base.createdAt)} → ${formatAuditDate(result.head.createdAt)}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Compare audits"
        description={`${result.host}: ${dates}`}
        backLink={backLink}
      />

      {coverageWarning ? (
        <Alert variant="warning">
          <AlertDescription>{coverageWarning.message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Issue</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Before (pages)</TableHead>
              <TableHead>After (pages)</TableHead>
              <TableHead>Change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((row) => (
              <TableRow key={row.issueType}>
                <TableCell className="font-medium">{row.issueType}</TableCell>
                <TableCell>
                  <SeverityBadge severity={row.severity} />
                </TableCell>
                <TableCell className="tabular-nums">{row.basePages}</TableCell>
                <TableCell className="tabular-nums">{row.headPages}</TableCell>
                <TableCell className="min-w-48">
                  <ChangePages row={row} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
