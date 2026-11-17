// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/KeywordTrendModal.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Download, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { QueryState } from "@/components/app/QueryState";
import { Skeleton } from "@/components/ui/skeleton";
import { exportRows } from "@/shared/export/exportRows";
import { downloadFile } from "@/shared/export/download";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";
import { googleSerpUrl } from "@/shared/google-serp-url";
import { formatLocationLabel, LOCATION_OPTIONS } from "@/shared/keyword-locations";
import { csvChange, type ComparePeriod } from "@/shared/rank-tracking";
import {
  RankTrendChart,
  TrendEmptyState,
  TrendRangeToggle,
  type TrendSeries,
} from "./RankTrendChart";
import { DeviceRankCell } from "./RankTrackingTableParts";

export interface KeywordTrendTarget {
  trackingKeywordId: string;
  keyword: string;
}

export type KeywordHistoryPoint = {
  device: "desktop" | "mobile";
  checkedAt: string;
  position: number | null;
};

const DEVICE_STYLE = {
  desktop: { label: "Desktop", color: "#2563eb" },
  mobile: { label: "Mobile", color: "#14b8a6" },
} as const;

export function KeywordTrendModal({
  target,
  brandKey,
  configId,
  locationCode,
  languageCode,
  locationName,
  serpDepth = 40,
  onClose,
}: {
  target: KeywordTrendTarget;
  brandKey: string;
  configId: string;
  locationCode: number;
  languageCode: string;
  locationName?: string | null;
  serpDepth?: number;
  onClose: () => void;
}) {
  const [sinceDays, setSinceDays] = useState(730);

  const historyQuery = useQuery({
    queryKey: keys.rankKeywordHistory(
      brandKey,
      configId,
      target.trackingKeywordId,
      sinceDays,
    ),
    queryFn: ({ signal }) =>
      fetchJson<{ points: KeywordHistoryPoint[] }>(
        withBrand(
          `/api/customer/rank-tracking/configs/${encodeURIComponent(configId)}/keywords/${encodeURIComponent(target.trackingKeywordId)}/history?sinceDays=${encodeURIComponent(sinceDays)}`,
          brandKey,
        ),
        { signal },
      ),
    enabled: Boolean(brandKey && configId && target.trackingKeywordId),
  });

  const points = historyQuery.data?.points ?? [];

  const locationLabel = locationName
    ? formatLocationLabel(locationName, 2)
    : (LOCATION_OPTIONS.find((loc) => loc.code === locationCode)?.label ??
      String(locationCode));

  const serpUrl = googleSerpUrl(target.keyword, {
    locationCode,
    languageCode,
    locationName: locationName ?? undefined,
  });

  const { chartData, series, historyRows, devices } = useMemo(() => {
    const presentDevices = Array.from(new Set(points.map((p) => p.device)));
    const activeSeries: TrendSeries[] = presentDevices.map((d) => ({
      dataKey: d,
      name: DEVICE_STYLE[d].label,
      color: DEVICE_STYLE[d].color,
    }));

    // Group chart points by timestamp
    const byTime = new Map<number, Record<string, unknown>>();
    for (const p of points) {
      const ts = new Date(p.checkedAt).getTime();
      const row = byTime.get(ts) ?? { checkedAt: ts };
      row[p.device] = p.position === null ? serpDepth : p.position;
      byTime.set(ts, row);
    }
    const sortedChart = Array.from(byTime.values()).sort(
      (a, b) => (a.checkedAt as number) - (b.checkedAt as number),
    );

    // History table rows (newest first, with previousPosition calculated)
    const prevByDevice = new Map<"desktop" | "mobile", number | null>();
    const rowsWithDelta: Array<{
      device: "desktop" | "mobile";
      checkedAt: string;
      position: number | null;
      previousPosition: number | null;
    }> = [];

    // points are oldest-first from query
    for (const p of points) {
      const prev = prevByDevice.has(p.device) ? (prevByDevice.get(p.device) ?? null) : null;
      rowsWithDelta.push({
        device: p.device,
        checkedAt: p.checkedAt,
        position: p.position,
        previousPosition: prev,
      });
      prevByDevice.set(p.device, p.position);
    }

    return {
      chartData: sortedChart,
      series: activeSeries,
      historyRows: rowsWithDelta.reverse(),
      devices: presentDevices,
    };
  }, [points, serpDepth]);

  const handleCopy = () => {
    if (historyRows.length === 0) return;
    const lines = [
      `Date\tDevice\tPosition\tChange`,
      ...historyRows.map(
        (r) =>
          `${new Date(r.checkedAt).toLocaleDateString()}\t${DEVICE_STYLE[r.device].label}\t${r.position ?? "Not found"}\t${csvChange(r.position, r.previousPosition)}`,
      ),
    ];
    void navigator.clipboard.writeText(lines.join("\n"));
    toast.success("Keyword history copied to clipboard");
  };

  const handleExport = () => {
    if (historyRows.length === 0) return;
    void exportRows(
      {
        format: "csv",
        feature: "rank_tracking",
        headers: ["Date", "Device", "Position", "Change vs previous"],
        rows: historyRows.map((r) => [
          new Date(r.checkedAt).toISOString(),
          DEVICE_STYLE[r.device].label,
          r.position ?? "",
          csvChange(r.position, r.previousPosition),
        ]),
        filename: `rank-history-${target.keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      },
      {
        toastError: (m) => toast.error(m),
        toastSuccess: (m) => toast.success(m),
        download: (c, f, m) => downloadFile(c, f, m),
        writeText: async (t) => {
          await navigator.clipboard.writeText(t);
        },
        copyTable: async () => {},
        openSheetsModal: () => {},
        track: () => {},
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent fullScreenOnMobile className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2 pr-6">
            <DialogTitle className="text-base font-semibold">{target.keyword}</DialogTitle>
            <Button
              variant="outline"
              size="xs"
              onClick={() => window.open(serpUrl, "_blank", "noopener,noreferrer")}
              title="Search this keyword on Google with the tracked language, country, and city"
            >
              <ExternalLink data-icon="inline-start" className="size-3" />
              Open in Google
            </Button>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            {locationLabel} · {languageCode.toUpperCase()}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-end py-1">
          <TrendRangeToggle value={sinceDays} onChange={setSinceDays} />
        </div>

        <QueryState
          query={historyQuery}
          errorFallback="Failed to load keyword history"
          loading={<Skeleton className="h-56 w-full" />}
        >
          {() =>
            chartData.length <= 1 ? (
              <TrendEmptyState checks={chartData.length} />
            ) : (
              <div className="space-y-4">
                <RankTrendChart
                  data={chartData}
                  series={series}
                  serpDepth={serpDepth}
                  showBottomBand
                  valueFormatter={(value, item) => {
                    const payload = item?.payload as Record<string, unknown> | undefined;
                    const checkedAt = payload?.checkedAt;
                    const dataKey = item?.dataKey as string | undefined;
                    if (
                      typeof checkedAt === "number" &&
                      typeof dataKey === "string" &&
                      payload?.[dataKey] === serpDepth
                    ) {
                      return "Not found";
                    }
                    return String(value);
                  }}
                />

                <div className="flex items-center justify-end gap-2">
                  <Button variant="ghost" size="xs" onClick={handleCopy}>
                    <Copy data-icon="inline-start" className="size-3" />
                    Copy
                  </Button>
                  <Button variant="ghost" size="xs" onClick={handleExport}>
                    <Download data-icon="inline-start" className="size-3" />
                    Export CSV
                  </Button>
                </div>

                <div className="overflow-hidden rounded-lg border border-border">
                  <Table>
                    <TableHeader className="bg-muted/40">
                      <TableRow>
                        <TableHead className="text-xs">Date</TableHead>
                        {devices.length > 1 && <TableHead className="text-xs">Device</TableHead>}
                        <TableHead className="text-xs">Position</TableHead>
                        <TableHead className="text-xs">vs previous check</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {historyRows.map((r, idx) => (
                        <TableRow key={`${r.device}-${r.checkedAt}-${idx}`}>
                          <TableCell className="text-xs whitespace-nowrap">
                            {new Date(r.checkedAt).toLocaleDateString()}
                          </TableCell>
                          {devices.length > 1 && (
                            <TableCell className="text-xs">
                              {DEVICE_STYLE[r.device].label}
                            </TableCell>
                          )}
                          <TableCell className="text-xs">
                            {r.position === null ? (
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <span className="cursor-help text-xs text-muted-foreground underline decoration-dotted underline-offset-2">
                                      Not found
                                    </span>
                                  }
                                >
                                  Not found
                                </TooltipTrigger>
                                <TooltipContent>Not ranking, or incomplete results</TooltipContent>
                              </Tooltip>
                            ) : (
                              <span className="font-mono text-sm">{r.position}</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <DeviceRankCell
                              result={{
                                position: r.position,
                                previousPosition: r.previousPosition,
                                rankingUrl: null,
                                serpFeatures: [],
                                checkedAt: r.checkedAt,
                              }}
                              serpDepth={serpDepth}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )
          }
        </QueryState>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
