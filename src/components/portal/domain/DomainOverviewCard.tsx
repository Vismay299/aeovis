"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/DomainOverviewPage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { HelpLabel } from "@/components/app/HelpLabel";
import { MetricsTable } from "@/components/app/MetricsTable";
import {
  RESEARCH_SCOPE_LABELS,
  type ResearchScope,
} from "@/shared/researchScope";
import type { DomainOverviewOkResponse } from "./hooks/useDomainOverviewQuery";

type Props = {
  data: DomainOverviewOkResponse;
  hasProjectMemory?: boolean;
};

function formatNumber(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat().format(Math.round(value));
}

function formatRelativeTime(dateString: string): string {
  try {
    const delta = Date.now() - new Date(dateString).getTime();
    if (delta < 60_000) return "just now";
    if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`;
    if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`;
    return `${Math.floor(delta / 86400_000)}d ago`;
  } catch {
    return "recently";
  }
}

export function DomainOverviewCard({
  data,
  hasProjectMemory = true,
}: Props) {
  const isNarrowerScope = data.scope !== "subdomains";

  const showAddCompetitor =
    hasProjectMemory && !data.isOwnSite && !data.isDeclaredCompetitor;

  const metricRows = [
    {
      label: (
        <span className="inline-flex items-center gap-1.5">
          Estimated organic traffic
          {isNarrowerScope ? (
            <HelpLabel
              label="Estimated organic traffic"
              helpText="Whole domain incl. subdomains"
            />
          ) : null}
        </span>
      ),
      value: data.hasData ? formatNumber(data.organicTraffic) : "—",
    },
    {
      label: (
        <span className="inline-flex items-center gap-1.5">
          Organic keywords
          {isNarrowerScope ? (
            <HelpLabel
              label="Organic keywords"
              helpText="Whole domain incl. subdomains"
            />
          ) : null}
        </span>
      ),
      value: data.hasData ? formatNumber(data.organicKeywords) : "—",
    },
  ];

  return (
    <Card>
      <CardContent className="space-y-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight">
              {data.displayTarget}
            </h2>
            <Badge variant="outline">
              {RESEARCH_SCOPE_LABELS[data.scope] ?? data.scope}
            </Badge>
            {data.isOwnSite ? <Badge variant="secondary">Your site</Badge> : null}
            {data.isDeclaredCompetitor ? (
              <Badge variant="secondary">Competitor</Badge>
            ) : null}
            <span className="text-xs text-muted-foreground">
              Updated {formatRelativeTime(data.fetchedAt)}
            </span>
          </div>

          {showAddCompetitor ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
            >
              <UserPlus data-icon="inline-start" />
              Add as competitor
            </Button>
          ) : null}
        </div>

        <div className="w-full max-w-xl rounded-lg border border-border">
          <MetricsTable rows={metricRows} />
        </div>
      </CardContent>
    </Card>
  );
}
