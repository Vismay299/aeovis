// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/results/IssuesView.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — issues grouped by severity and sorted by pages affected, with
// the explanation, the fix and the affected URLs on expand.

import { useState } from "react";
import { ChevronDown, List, Sparkles, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SafeExternalLink } from "@/components/app/SafeExternalLink";
import { EmptyState } from "@/components/app/EmptyState";
import { SegmentedToggle } from "@/components/app/SegmentedToggle";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ISSUE_SEVERITY_ORDER,
  getIssueDescriptor,
  type IssueSeverity,
} from "@/shared/audit-issues";
import type { AuditSummary } from "../hooks/useAuditSummary";
import { useAuditIssues } from "../hooks/useAuditIssues";
import { QueryError } from "@/components/app/QueryState";
import { IssueDetails } from "./IssueDetails";
import { pathOf } from "../shared";

type IssueFilter = "all" | "ai" | "technical";

const AI_CATEGORIES = new Set([
  "ai_access",
  "structured_data",
  "social",
  "international",
]);

export function IssuesView({
  auditId,
  summary,
}: {
  auditId: string;
  summary: AuditSummary;
}) {
  const [filter, setFilter] = useState<IssueFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const issues = useAuditIssues(auditId, expanded ?? "", 0, expanded != null);
  const crawled = summary.audit.pagesCrawled;

  const groups = summary.issueGroups
    .filter((group) => {
      if (filter === "all") return true;
      const ai = AI_CATEGORIES.has(group.category);
      return filter === "ai" ? ai : !ai;
    })
    .slice()
    .sort(
      (a, b) =>
        ISSUE_SEVERITY_ORDER[a.severity] - ISSUE_SEVERITY_ORDER[b.severity] ||
        b.pages - a.pages ||
        (getIssueDescriptor(a.issueType)?.title ?? a.issueType).localeCompare(
          getIssueDescriptor(b.issueType)?.title ?? b.issueType,
        ),
    );

  if (summary.issueGroups.length === 0) {
    return (
      <EmptyState
        variant="plain"
        title="No issues found."
        description={`We checked ${crawled} pages and found nothing to fix.`}
      />
    );
  }

  if (groups.length === 0) {
    return (
      <EmptyState
        variant="plain"
        kind="filtered"
        title="No issues in this group."
        action={
          <Button variant="outline" size="sm" onClick={() => setFilter("all")}>
            Show all issues
          </Button>
        }
      />
    );
  }

  const severities: IssueSeverity[] = ["critical", "warning", "info"];

  return (
    <div className="space-y-3">
      <SegmentedToggle<IssueFilter>
        value={filter}
        onChange={(value) => {
          setFilter(value);
          setExpanded(null);
        }}
        showLabels
        items={[
          { value: "all", label: "All", icon: <List aria-hidden /> },
          {
            value: "ai",
            label: "AI & structured data",
            icon: <Sparkles aria-hidden />,
          },
          {
            value: "technical",
            label: "Technical SEO",
            icon: <Wrench aria-hidden />,
          },
        ]}
      />

      {severities.map((severity) => {
        const sectionGroups = groups.filter(
          (group) => group.severity === severity,
        );
        if (sectionGroups.length === 0) return null;
        const total = sectionGroups.reduce((sum, group) => sum + group.rows, 0);
        return (
          <section key={severity} className="space-y-1">
            <h3 className="text-sm font-semibold">
              {`${severity[0].toUpperCase()}${severity.slice(1)} (${total})`}
            </h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {sectionGroups.map((group) => {
                const descriptor = getIssueDescriptor(group.issueType);
                const isOpen = expanded === group.issueType;
                return (
                  <li key={group.issueType}>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() =>
                        setExpanded(isOpen ? null : group.issueType)
                      }
                      className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
                    >
                      <span className="min-w-0">
                        <span className="block font-medium">
                          {descriptor?.title ?? group.issueType}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {group.scope === "site"
                            ? "Site-wide"
                            : `${group.pages} of ${crawled} pages`}
                        </span>
                      </span>
                      <ChevronDown
                        aria-hidden
                        className={`mt-0.5 size-4 shrink-0 transition-transform ${
                          isOpen ? "rotate-180" : ""
                        }`}
                      />
                    </button>

                    {isOpen ? (
                      <div className="space-y-2 border-t border-border px-4 py-3">
                        {descriptor ? (
                          <p className="text-sm text-muted-foreground">
                            {descriptor.explanation}
                          </p>
                        ) : null}
                        {descriptor ? (
                          <p className="text-sm">
                            <span className="font-medium">How to fix:</span>{" "}
                            {descriptor.howToFix}
                          </p>
                        ) : null}

                        {issues.isLoading ? (
                          <div className="space-y-1.5" aria-busy="true">
                            <Skeleton className="h-4 w-full" />
                            <Skeleton className="h-4 w-2/3" />
                          </div>
                        ) : issues.isError ? (
                          <QueryError
                            error={issues.error}
                            fallback="Couldn't load the affected pages."
                            onRetry={() => void issues.refetch()}
                            isRetrying={issues.isFetching}
                          />
                        ) : (
                          <ul className="max-h-[320px] space-y-1 overflow-y-auto">
                            {(issues.data?.rows ?? []).map((row) => (
                              <li key={row.id}>
                                <SafeExternalLink
                                  url={row.pageUrl}
                                  label={pathOf(row.pageUrl)}
                                  className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
                                />
                                <IssueDetails
                                  issueType={group.issueType}
                                  details={row.details}
                                />
                              </li>
                            ))}
                          </ul>
                        )}

                        {issues.data &&
                        issues.data.total > issues.data.rows.length ? (
                          <p className="text-xs text-muted-foreground">
                            {`…and ${issues.data.total - issues.data.rows.length} more. Export the issues for the full list.`}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
