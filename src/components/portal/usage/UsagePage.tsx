"use client";

import { useEffect, useRef } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/app/PageHeader";
import { ErrorState } from "@/components/app/ErrorState";
import { useUrlSearchState } from "@/components/app/hooks/useUrlSearchState";
import { formatUsd } from "@/shared/money";
import type { WorkspaceUsage } from "@/shared/costs";
import { trackEvent } from "@/shared/telemetry/client";
import {
  useUsage,
  viewerTimeZone,
  type UsageRange,
} from "./hooks/useUsage";
import { UsageLimits } from "./UsageLimits";
import { UsageChart } from "./UsageChart";
import { UsageByFeature } from "./UsageByFeature";
import { UsageRecent } from "./UsageRecent";
import { UsageSection } from "./UsageSection";

const RANGE_LABELS: Record<UsageRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

const RANGE_OPTIONS: { value: UsageRange; label: string }[] = [
  { value: "7d", label: RANGE_LABELS["7d"] },
  { value: "30d", label: RANGE_LABELS["30d"] },
  { value: "90d", label: RANGE_LABELS["90d"] },
];

type UsageSearchState = { range: UsageRange };

const DEFAULT_USAGE_SEARCH: UsageSearchState = { range: "30d" };

/** `?range=` is one of the three ranges; anything else falls back to 30 days. */
const usageSearchSchema = {
  safeParse(value: unknown) {
    const candidate =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>).range
        : undefined;
    const range: UsageRange =
      candidate === "7d" || candidate === "30d" || candidate === "90d"
        ? candidate
        : "30d";
    return { success: true as const, data: { range } };
  },
};

/** Two limit cards, the chart, four feature rows, then five table rows. */
function UsageSkeleton() {
  return (
    <div className="space-y-4" data-slot="usage-skeleton">
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-40 w-full rounded-xl" />
        <div className="space-y-2">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-4 w-full" />
          ))}
        </div>
      </div>
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton key={row} className="h-5 w-full" />
        ))}
      </div>
    </div>
  );
}

function UsageContent({
  usage,
  range,
}: {
  usage: WorkspaceUsage;
  range: UsageRange;
}) {
  const partial = usage.totals.unknownUsd > 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <UsageLimits position={usage.position} timeZone={usage.timeZone} />
        <p className="text-xs text-muted-foreground md:col-span-2">
          Limits reset at 00:00 UTC.
        </p>

        <Card className="md:col-span-2">
          <CardContent className="space-y-6">
            <UsageSection
              title="Spend"
              action={RANGE_LABELS[range]}
            >
              <div className="text-2xl font-semibold tabular-nums">
                {formatUsd(usage.totals.accountedUsd)}
              </div>
              {partial ? (
                <Alert variant="warning">
                  <Info aria-hidden />
                  <AlertTitle>Some costs are estimates</AlertTitle>
                  <AlertDescription>
                    {`${usage.totals.unknownCalls} calls did not report a cost, so they are counted at the amount reserved before they ran. Reported costs replace them when available.`}
                  </AlertDescription>
                </Alert>
              ) : null}
              <UsageChart days={usage.days} range={range} />
            </UsageSection>

            <UsageSection title="Spend by feature">
              <UsageByFeature features={usage.features} />
            </UsageSection>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            <UsageRecent recent={usage.recent} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function UsagePage({ brandKey }: { brandKey: string }) {
  const [search, setSearch] = useUrlSearchState<UsageSearchState>(
    usageSearchSchema,
    DEFAULT_USAGE_SEARCH,
  );
  const range = search.range;
  const timeZone = viewerTimeZone();
  const usageQuery = useUsage(brandKey, range, timeZone);

  const lastRangeRef = useRef<UsageRange | null>(null);
  useEffect(() => {
    const previous = lastRangeRef.current;
    if (previous === range) return;
    lastRangeRef.current = range;
    if (previous === null) {
      trackEvent("usage:page_viewed", { range });
      return;
    }
    trackEvent("usage:range_changed", { from: previous, to: range });
  }, [range]);

  const errorView = (
    <ErrorState
      variant="card"
      message="Usage could not be loaded."
      action={
        <Button
          variant="outline"
          size="sm"
          pending={usageQuery.isFetching}
          onClick={() => void usageQuery.refetch()}
        >
          Retry
        </Button>
      }
    />
  );

  let body;
  if (usageQuery.isPending) {
    body = <UsageSkeleton />;
  } else if (usageQuery.isError && !usageQuery.data) {
    body = errorView;
  } else if (usageQuery.data) {
    body = (
      <>
        {usageQuery.isError ? errorView : null}
        <UsageContent usage={usageQuery.data} range={range} />
      </>
    );
  } else {
    body = null;
  }

  return (
    <div className="overflow-x-hidden px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <PageHeader
          title="Usage"
          description="What this workspace has spent on paid data and AI calls, and how that compares with its limits."
          actions={
            <Select
              items={RANGE_OPTIONS}
              value={range}
              onValueChange={(value) => {
                if (value === "7d" || value === "30d" || value === "90d") {
                  setSearch({ range: value });
                }
              }}
            >
              <SelectTrigger aria-label="Date range" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        {body}
      </div>
    </div>
  );
}
