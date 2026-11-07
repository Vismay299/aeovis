"use client";

import Link from "next/link";
import { Play, Radar } from "lucide-react";
import { PrefetchLink } from "@/components/app/PrefetchLink";
import { scanReportQueryOptions } from "@/lib/query/portalQueries";
import { Badge, Button, Card, EmptyState, SkeletonRows, formatDate, formatPct } from "../ui";
import { countText, scanTimestamp, toNumber, visibilityTone } from "./overviewModel";

export default function RecentScans({ overview, scan }) {
  const scans = overview ? (overview.scans || []).slice(0, 5) : null;

  let body;
  if (!scans) {
    body = <SkeletonRows rows={3} />;
  } else if (!scans.length) {
    body = (
      <EmptyState
        icon={Radar}
        title="No scans yet"
        action={<Button icon={Play} loading={scan.starting} disabled={scan.active} onClick={scan.start}>Run scan</Button>}
      >
        Run your first scan to see how answer engines describe your brand.
      </EmptyState>
    );
  } else {
    body = (
      <div className="divide-y divide-border pv-list">
        {scans.map((item) => {
          const tracked = toNumber(item.prompts_tracked);
          const mentioned = toNumber(item.prompts_mentioned);
          const meta = tracked === null && mentioned === null
            ? "Results pending"
            : `${countText(tracked)} questions · ${countText(mentioned)} mentioned`;
          return (
            <PrefetchLink
              key={item.id}
              href={`/portal/scans/${encodeURIComponent(item.id)}`}
              prefetch={() => scanReportQueryOptions(item.id)}
              className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/50 pv-list__row"
            >
              <span className="flex flex-col min-w-0 pv-list__main">
                <span className="text-sm font-medium text-foreground truncate pv-list__title">
                  {formatDate(scanTimestamp(item))}
                </span>
                <span className="text-xs text-muted-foreground pv-list__meta">{meta}</span>
              </span>
              <Badge tone={visibilityTone(item.visibility_pct)}>{formatPct(item.visibility_pct)}</Badge>
            </PrefetchLink>
          );
        })}
      </div>
    );
  }

  return (
    <Card
      title="Recent scans"
      description="Your last five runs, newest first"
      flush
      actions={<Button variant="ghost" size="sm" href="/portal/scans">View all</Button>}
    >
      {body}
    </Card>
  );
}
