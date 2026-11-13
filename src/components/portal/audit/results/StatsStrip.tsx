// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/results/ResultsView.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — the results stats strip: crawled pages, issues, response time
// and, when the audit ran them, the Lighthouse averages.

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { MetricsTable } from "@/components/app/MetricsTable";
import type { AuditSummary } from "../hooks/useAuditSummary";
import { formatMs, formatScore, scoreClass } from "../shared";

export function StatsStrip({ summary }: { summary: AuditSummary }) {
  const { audit, stats, issueGroups } = summary;
  const totalIssues = issueGroups.reduce((sum, group) => sum + group.rows, 0);
  const critical = issueGroups
    .filter((group) => group.severity === "critical")
    .reduce((sum, group) => sum + group.rows, 0);
  const warning = issueGroups
    .filter((group) => group.severity === "warning")
    .reduce((sum, group) => sum + group.rows, 0);

  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: "Pages crawled",
      value: (
        <span>
          {audit.pagesCrawled.toLocaleString("en-US")}
          {audit.pagesSeen > audit.pagesCrawled ? (
            <span className="text-xs text-muted-foreground">
              {` of ${audit.pagesSeen.toLocaleString("en-US")} found`}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      label: "Issues found",
      value: (
        <span className="inline-flex flex-wrap items-center justify-end gap-1">
          {totalIssues.toLocaleString("en-US")}
          {critical > 0 ? (
            <Badge variant="destructive">{`Critical ${critical}`}</Badge>
          ) : null}
          {warning > 0 ? (
            <Badge variant="warning">{`Warning ${warning}`}</Badge>
          ) : null}
        </span>
      ),
    },
    {
      label: "Average response time",
      value: formatMs(stats.averageResponseMs),
    },
  ];

  if (audit.lighthouse) {
    rows.push(
      {
        label: "Lighthouse tests",
        value: stats.lighthouse.tests.toLocaleString("en-US"),
      },
      {
        label: "Lighthouse performance",
        value: (
          <span className={scoreClass(stats.lighthouse.avgPerformance)}>
            {formatScore(stats.lighthouse.avgPerformance)}
          </span>
        ),
      },
      {
        label: "Lighthouse SEO",
        value: (
          <span className={scoreClass(stats.lighthouse.avgSeo)}>
            {formatScore(stats.lighthouse.avgSeo)}
          </span>
        ),
      },
      {
        label: "Lighthouse accessibility",
        value: (
          <span className={scoreClass(stats.lighthouse.avgAccessibility)}>
            {formatScore(stats.lighthouse.avgAccessibility)}
          </span>
        ),
      },
      {
        label: "Lighthouse failures",
        value: stats.lighthouse.failed.toLocaleString("en-US"),
      },
    );
  }

  return (
    <Card className="max-w-xl">
      <CardContent className="p-0">
        <MetricsTable rows={rows} />
      </CardContent>
    </Card>
  );
}
