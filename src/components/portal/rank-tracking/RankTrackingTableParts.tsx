// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/RankTrackingTableParts.tsx:36-268
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Sparkles, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { exportRows } from "@/shared/export/exportRows";
import { downloadFile } from "@/shared/export/download";
import { copyTableToClipboard } from "@/shared/export/clipboard";
import { openSheetsModal } from "@/shared/export/sheetsModalStore";
import {
  SERP_FEATURE_SHORT_LABELS,
  SERP_FEATURE_TOOLTIPS,
  buildRankTrackingExport,
  type RankDeviceResult,
  type RankTrackingRow,
} from "@/shared/rank-tracking";
import { trackRankEvent } from "./telemetry";

export function SerpFeatureTags({
  features,
  onTrackAiQuestion,
}: {
  features: string[];
  onTrackAiQuestion?: () => void;
}) {
  const notable = features.filter((f) => f in SERP_FEATURE_SHORT_LABELS);
  if (notable.length === 0) return null;
  return (
    <div className="flex gap-1 flex-wrap items-center">
      {notable.map((f) => {
        if (f === "ai_overview") {
          return (
            <Tooltip key={f}>
              <TooltipTrigger
                render={
                  <Badge
                    variant="secondary"
                    size="sm"
                    className="cursor-help inline-flex items-center gap-1"
                  >
                    <Sparkles className="size-3" />
                    <span>{SERP_FEATURE_SHORT_LABELS[f]}</span>
                  </Badge>
                }
              >
                <Badge
                  variant="secondary"
                  size="sm"
                  className="cursor-help inline-flex items-center gap-1"
                >
                  <Sparkles className="size-3" />
                  <span>{SERP_FEATURE_SHORT_LABELS[f]}</span>
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs space-y-2">
                <p>{SERP_FEATURE_TOOLTIPS[f] ?? f}</p>
                {onTrackAiQuestion && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={(e: React.MouseEvent) => {
                      e.stopPropagation();
                      onTrackAiQuestion();
                    }}
                    className="w-full text-xs"
                  >
                    Track as AI question
                  </Button>
                )}
              </TooltipContent>
            </Tooltip>
          );
        }
        return (
          <Badge
            key={f}
            variant="secondary"
            size="sm"
            className="cursor-help inline-flex items-center gap-1"
            title={SERP_FEATURE_TOOLTIPS[f] ?? f}
          >
            <span>{SERP_FEATURE_SHORT_LABELS[f]}</span>
          </Badge>
        );
      })}
    </div>
  );
}

export function DeviceRankCell({
  result,
  serpDepth = 40,
}: {
  result: RankDeviceResult;
  serpDepth?: number;
}) {
  const { position, previousPosition, checkedAt } = result;

  // Never checked yet
  if (checkedAt === null && position === null && previousPosition === null) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="text-muted-foreground cursor-help underline decoration-dotted underline-offset-2">
              —
            </span>
          }
        >
          —
        </TooltipTrigger>
        <TooltipContent>Not checked yet</TooltipContent>
      </Tooltip>
    );
  }

  // Checked, not found, previous null
  if (position === null && previousPosition === null) {
    return (
      <span className="text-xs text-muted-foreground">
        Not in top {serpDepth}
      </span>
    );
  }

  // Was ranking, now lost
  if (position === null && previousPosition !== null) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="w-6 text-right font-mono text-xs text-muted-foreground">
          {previousPosition}
        </span>
        <span className="text-muted-foreground/60">→</span>
        <span
          aria-label="lost"
          className="font-mono rounded px-1.5 py-0.5 text-xs font-semibold bg-destructive/15 text-destructive"
        >
          lost
        </span>
      </span>
    );
  }

  // First check — no previous data
  if (previousPosition === null) {
    return <span className="font-mono text-sm">{position}</span>;
  }

  // Both exist — show old → new with colored badge
  const change = previousPosition - position!;
  let badgeClass = "bg-muted text-foreground";
  let label = "unchanged";
  if (change > 0) {
    badgeClass = "bg-success/20 text-success";
    label = "better";
  } else if (change < 0) {
    badgeClass = "bg-warning/20 text-warning";
    label = "worse";
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-6 text-right font-mono text-xs text-muted-foreground">
        {previousPosition}
      </span>
      <span className="text-muted-foreground/60">→</span>
      <span
        aria-label={label}
        className={`font-mono rounded px-1.5 py-0.5 text-xs font-semibold ${badgeClass}`}
      >
        {position}
      </span>
    </span>
  );
}

function toPath(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

function toFullUrl(url: string, domain: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `https://${domain}${url.startsWith("/") ? "" : "/"}${url}`;
}

export function DeviceUrlCell({
  result,
  domain,
}: {
  result: RankDeviceResult;
  domain: string;
}) {
  if (!result.rankingUrl) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const fullUrl = toFullUrl(result.rankingUrl, domain);
  const path = toPath(result.rankingUrl);
  return (
    <a
      href={fullUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 truncate text-xs hover:underline text-foreground max-w-full"
      title={result.rankingUrl}
    >
      <span className="truncate">{path}</span>
      <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
    </a>
  );
}

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function VolumeCell({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="font-mono text-sm tabular-nums">
      {compactFormatter.format(value)}
    </span>
  );
}

export function CpcCell({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="font-mono text-sm tabular-nums">${value.toFixed(2)}</span>
  );
}

export function exportRankTracking(args: {
  format: "csv" | "sheets";
  rows: RankTrackingRow[];
  showDesktop: boolean;
  showMobile: boolean;
  domain: string;
  locationName?: string | null;
  scope?: "selection";
}) {
  const { format, scope } = args;
  const { headers, rows } = buildRankTrackingExport(
    args.rows,
    args.showDesktop,
    args.showMobile,
    args.locationName,
  );

  const exportedRows =
    format === "csv"
      ? rows.map((row) =>
          row.map((cell, idx) =>
            idx === 3 && typeof cell === "number" ? cell.toFixed(2) : cell,
          ),
        )
      : rows;

  void exportRows(
    {
      format,
      feature: "rank_tracking",
      headers,
      rows: exportedRows,
      filename: `rank-tracking-${args.domain}${scope ? "-selected" : ""}`,
      scope,
    },
    {
      toastError: (m) => toast.error(m),
      toastSuccess: (m) => toast.success(m),
      download: (c, f, m) => downloadFile(c, f, m),
      writeText: async (t) => {
        await navigator.clipboard.writeText(t);
      },
      copyTable: async (h, r) => {
        await copyTableToClipboard(h, r);
      },
      openSheetsModal: (rc) => openSheetsModal(rc),
      track: () => {},
    },
  );

  if (format === "csv" && rows.length > 0) {
    trackRankEvent("rank_tracking:export_csv", { scope: scope ?? "all" });
  }
}
