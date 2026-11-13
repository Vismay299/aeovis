// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/lighthouse/issues/LighthouseIssuesParts.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { BackLink } from "@/components/app/PageHeader";
import { ExportMenu } from "@/components/app/ExportMenu";
import { SkeletonTableRows } from "@/components/app/SkeletonPresets";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import type { CategoryTab, LighthouseIssue, LighthouseMetrics, LighthouseScores } from "./types.ts";
import { LighthouseIssueRow } from "./LighthouseIssueRow.tsx";
import { LighthouseIssuesSummary } from "./LighthouseIssuesSummary.tsx";
import { categoryLabel } from "./utils.ts";
import { categoryTabs } from "./types.ts";

export function LighthouseIssuesHeader({
  auditId,
  isLoading,
  scannedAt,
  finalUrl,
  scores,
  metrics,
  severityCounts,
}: {
  auditId: string;
  isLoading: boolean;
  scannedAt?: string;
  finalUrl?: string | null;
  scores?: LighthouseScores | null;
  metrics?: LighthouseMetrics | null;
  severityCounts: { critical: number; warning: number; info: number };
}) {
  let path = "";
  try {
    path = finalUrl ? new URL(finalUrl).pathname || "/" : "";
  } catch {
    path = finalUrl ?? "";
  }
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <BackLink href={`/portal/audit/${auditId}?view=performance`}>Back to audit</BackLink>
        <span className="text-xs text-muted-foreground">
          {scannedAt ? `Scanned ${new Date(scannedAt).toLocaleString()}` : isLoading ? "Reading latest issues..." : null}
        </span>
      </div>
      <Card>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold">
              {path} · {isLoading ? "…" : "Mobile"}
            </h1>
            <p className="text-sm text-muted-foreground break-all">{finalUrl ?? (isLoading ? "Loading URL..." : null)}</p>
          </div>
          <LighthouseIssuesSummary scores={scores} metrics={metrics} />
          <div className="flex flex-wrap gap-2">
            <Badge variant="destructive">Critical {severityCounts.critical}</Badge>
            <Badge variant="outline">Warning {severityCounts.warning}</Badge>
            <Badge variant="secondary">Info {severityCounts.info}</Badge>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

export function LighthouseIssuesToolbar({
  category,
  categoryCounts,
  onCategoryChange,
  onExport,
  busy,
}: {
  category: CategoryTab;
  categoryCounts: Record<CategoryTab, number>;
  onCategoryChange: (next: CategoryTab) => void;
  onExport: (mode: "full" | "issues" | "category") => void;
  busy: boolean;
}) {
  return (
    <div className="border-b border-border px-4 py-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={category} onValueChange={(next) => onCategoryChange(next as CategoryTab)}>
          <TabsList variant="line" className="h-auto! flex-wrap justify-start">
            {categoryTabs.map((tab) => (
              <TabsTrigger key={tab} value={tab}>
                {categoryLabel(tab)}
                <span className="text-xs text-muted-foreground">({categoryCounts[tab]})</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <ExportMenu
          actions={["json"]}
          busy={busy}
          onExport={() => onExport(category === "all" ? "issues" : "category")}
        />
      </div>
    </div>
  );
}

export function LighthouseIssueList({
  issues,
  isLoading,
  emptyMessage,
}: {
  issues: LighthouseIssue[];
  isLoading: boolean;
  emptyMessage?: string;
}) {
  if (isLoading) return <SkeletonTableRows className="p-4" rows={5} columns={3} />;
  if (!issues.length) {
    return <p className="p-4 text-sm text-muted-foreground">{emptyMessage ?? "No issues in this category."}</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" />
          <TableHead className="w-24">Severity</TableHead>
          <TableHead>Issue</TableHead>
          <TableHead className="hidden w-28 sm:table-cell">Category</TableHead>
          <TableHead className="hidden w-28 md:table-cell text-right">Impact</TableHead>
          <TableHead className="w-14 text-right">Score</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {issues.map((issue, i) => (
          <LighthouseIssueRow key={`${issue.category}-${issue.auditKey}-${i}`} issue={issue} />
        ))}
      </TableBody>
    </Table>
  );
}
