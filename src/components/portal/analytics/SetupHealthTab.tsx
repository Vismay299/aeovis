"use client";

import Link from "next/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/app/EmptyState";
import { ExportMenu } from "@/components/app/ExportMenu";
import { useExportRows } from "@/components/app/export/useExportRows";
import { GA4_HEALTH_ISSUE_LABELS } from "@/shared/ga4";
import { Ga4ErrorState, ga4ErrorCode } from "./Ga4ErrorState";
import { useGa4Health } from "./hooks/useGa4Health";

type HealthData = {
  summary?: {
    dataStreamCount?: number;
    webStreamCount?: number;
    keyEventCount?: number;
    customDimensionCount?: number;
    customMetricCount?: number;
    issueCount?: number;
  };
  issues?: string[];
  webStreams?: {
    streamId?: string;
    displayName?: string;
    measurementId?: string | null;
    defaultUri?: string | null;
    enhancedMeasurement?: {
      streamEnabled?: boolean;
      siteSearchEnabled?: boolean;
    };
  }[];
  keyEvents?: { eventName?: string }[];
};

/** Setup health tab (§6.6.3): read-only measurement inventory and issues. */
export function SetupHealthTab({
  brandKey,
  canManage,
}: {
  brandKey: string;
  canManage: boolean;
}) {
  const query = useGa4Health(brandKey);
  const exportRows = useExportRows();
  const data = query.data as unknown as HealthData | undefined;

  if (query.isPending) {
    return (
      <div className="space-y-3 px-4 py-4" aria-busy>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  }

  if (query.isError && !query.data) {
    const code = ga4ErrorCode(query.error);
    if (code === "gsc_not_connected") {
      return (
        <EmptyState
          title="Connect Search Console to see search opportunities."
          action={
            <Link
              href="/portal/search-console"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Open Search Console
            </Link>
          }
        />
      );
    }
    return (
      <div className="px-4 py-4">
        <Ga4ErrorState
          error={query.error}
          canManage={canManage}
          onRetry={() => void query.refetch()}
          isRetrying={query.isFetching}
        />
      </div>
    );
  }

  const summary = data?.summary;
  const issues = data?.issues ?? [];
  const webStreams = data?.webStreams ?? [];
  const keyEvents = data?.keyEvents ?? [];

  return (
    <div className="space-y-4 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Perceev only reads these settings. Change them in Google Analytics.
          {query.isFetching ? (
            <Spinner className="ml-2 inline size-3.5" aria-label="Refreshing" />
          ) : null}
        </p>
        <ExportMenu
          actions={["sheets", "csv", "excel", "json"]}
          disabled={webStreams.length === 0 && keyEvents.length === 0}
          onExport={(action) =>
            void exportRows({
              format: action,
              feature: "ga4_setup_health",
              headers: ["Stream", "Measurement ID", "URL", "Enhanced measurement", "Site search"],
              rows: webStreams.map((stream) => [
                stream.displayName ?? stream.streamId ?? null,
                stream.measurementId ?? null,
                stream.defaultUri ?? null,
                stream.enhancedMeasurement?.streamEnabled ? "on" : "off",
                stream.enhancedMeasurement?.siteSearchEnabled ? "on" : "off",
              ]),
              filename: `${brandKey}-analytics-setup-health`,
              records: webStreams,
            })
          }
        />
      </div>

      {summary ? (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {(
            [
              ["Streams", summary.dataStreamCount],
              ["Web streams", summary.webStreamCount],
              ["Key events", summary.keyEventCount],
              ["Custom dimensions", summary.customDimensionCount],
              ["Custom metrics", summary.customMetricCount],
            ] as const
          ).map(([label, value]) => (
            <div
              key={label}
              className="rounded-lg border border-border bg-card p-3"
            >
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {typeof value === "number" ? value.toLocaleString() : "—"}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {issues.length === 0 ? (
        <Alert>
          <AlertDescription>No setup problems found.</AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-2">
          {issues.map((issue) => (
            <Alert key={issue} variant="warning">
              <AlertDescription>
                {GA4_HEALTH_ISSUE_LABELS[issue] ?? issue}
              </AlertDescription>
            </Alert>
          ))}
        </div>
      )}

      {webStreams.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Measurement ID</th>
                <th className="px-3 py-2 font-medium">URL</th>
                <th className="px-3 py-2 font-medium">Enhanced measurement</th>
                <th className="px-3 py-2 font-medium">Site search</th>
              </tr>
            </thead>
            <tbody>
              {webStreams.map((stream) => (
                <tr
                  key={stream.streamId ?? stream.displayName}
                  className="border-b border-border last:border-0"
                >
                  <td className="break-words px-3 py-2">
                    {stream.displayName ?? stream.streamId ?? "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {stream.measurementId ?? "—"}
                  </td>
                  <td className="break-all px-3 py-2">
                    {stream.defaultUri ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline">
                      {stream.enhancedMeasurement?.streamEnabled ? "on" : "off"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline">
                      {stream.enhancedMeasurement?.siteSearchEnabled ? "on" : "off"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {keyEvents.length > 0 ? (
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Key events</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {keyEvents.map((event, index) => (
              <li key={`${event.eventName ?? ""}${index}`}>
                {event.eventName ?? "—"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
