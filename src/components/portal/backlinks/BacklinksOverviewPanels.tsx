"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/backlinks/BacklinksOverviewPanels.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { MetricsTable } from "@/components/app/MetricsTable";
import { HelpLabel } from "@/components/app/HelpLabel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { RESEARCH_SCOPE_LABELS } from "@/shared/researchScope";
import type { BacklinksOverview } from "@/shared/backlinks";
import { formatRelativeTimestamp } from "@/shared/backlinks";
import {
  BacklinksNewLostChart,
  BacklinksTrendChart,
} from "./BacklinksPageCharts";
import { TrackHistoryControl } from "./TrackHistoryControl";
import { TrackedHistoryPanel } from "./TrackedHistoryPanel";
import type { BacklinksSnapshot } from "@/shared/backlinks";
import type { SnapshotInterval } from "./hooks/useSnapshotTargets";

type SummaryStat = { label: string; value: string; description: string };

const SCOPE_NOTES: Partial<Record<BacklinksOverview["scope"], string>> = {
  exact_url:
    "Showing backlinks for this exact page. Switch the scope to Domain or Subdomains for site-wide results — trend charts need one of those.",
  subfolder:
    "Showing backlinks pointing into this subfolder. Counts come from filtered backlink totals; rank, trends, and the referring-domains breakdown need Domain or Subdomains scope.",
};

export function BacklinksScopeAlert({
  scope,
}: {
  scope: BacklinksOverview["scope"];
}) {
  const note = SCOPE_NOTES[scope];
  if (!note) return null;
  return (
    <Alert variant="info">
      <Info />
      <AlertDescription className="text-foreground">{note}</AlertDescription>
    </Alert>
  );
}
export function BacklinksOverviewPanels({
  data,
  summaryStats,
  brandKey,
  isOwner,
  snapshotsEnabled,
  snapshots,
  snapshotInterval,
}: {
  data: BacklinksOverview;
  summaryStats: SummaryStat[];
  brandKey: string;
  isOwner: boolean;
  snapshotsEnabled: boolean;
  snapshots: BacklinksSnapshot[];
  snapshotInterval?: SnapshotInterval | null;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold break-all">
            {data.displayTarget}
          </h2>
          <Badge variant="outline">{RESEARCH_SCOPE_LABELS[data.scope]}</Badge>
          {data.isOwnSite ? <Badge variant="secondary">Your site</Badge> : null}
          {data.isDeclaredCompetitor ? (
            <Badge variant="outline">Competitor</Badge>
          ) : null}
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {snapshotsEnabled ? (
            <TrackHistoryControl
              brandKey={brandKey}
              data={data}
              isOwner={isOwner}
              snapshotsEnabled={snapshotsEnabled}
            />
          ) : null}
          <p className="text-xs text-muted-foreground">
            Updated {formatRelativeTimestamp(data.fetchedAt)}
          </p>
        </div>
      </div>
      <div className="px-4 pb-4">
        <OverviewGrid
          data={data}
          summaryStats={summaryStats}
          snapshots={snapshots}
          snapshotInterval={snapshotInterval}
        />
      </div>
    </>
  );
}

function OverviewGrid({
  data,
  summaryStats,
  snapshots,
  snapshotInterval,
}: {
  data: BacklinksOverview;
  summaryStats: SummaryStat[];
  snapshots: BacklinksSnapshot[];
  snapshotInterval?: SnapshotInterval | null;
}) {
  const domainScope = data.scope === "domain" || data.scope === "subdomains";

  return (
    <div
      className={`grid grid-cols-1 gap-3 ${domainScope ? "md:grid-cols-2 xl:grid-cols-3" : ""}`}
    >
      <div
        className={`w-full max-w-xl rounded-lg border border-border p-3 ${domainScope ? "md:col-span-2 xl:col-span-1" : ""}`}
      >
        <MetricsTable
          rows={summaryStats.map((item) => ({
            label: <HelpLabel label={item.label} helpText={item.description} />,
            value: item.value,
          }))}
        />
      </div>
      {domainScope ? (
        <>
          <TrendPanel
            title="Backlink growth"
            description={
              data.scope === "domain"
                ? "Last year · Includes subdomains"
                : "Backlinks and referring domains over the last year"
            }
          >
            <BacklinksTrendChart data={data.trends} />
          </TrendPanel>
          <TrendPanel
            title="New vs lost"
            description="Backlink acquisition and attrition"
          >
            <BacklinksNewLostChart data={data.newLostTrends} />
          </TrendPanel>
        </>
      ) : null}
      {domainScope && snapshots.length > 0 ? (
        <div className="md:col-span-2 xl:col-span-3">
          <TrackedHistoryPanel
            snapshots={snapshots}
            interval={data.tracked?.interval ?? snapshotInterval}
          />
        </div>
      ) : null}
    </div>
  );
}

function TrendPanel({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
