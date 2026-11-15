// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/RankTrackingColumns.tsx:20-301
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useMemo, type MutableRefObject } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Star, MoreHorizontal, History, ExternalLink, Trash2 } from "lucide-react";
import { makeSelectionColumn } from "@/components/app/table/DataTable";
import { ScoreBadge } from "@/components/app/table/ScoreBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SortableHeader } from "@/components/app/table/SortableHeader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatLocationLabel } from "@/shared/keyword-locations";
import { googleSerpUrl } from "@/shared/google-serp-url";
import type { RankTrackingRow } from "@/shared/rank-tracking";
import {
  CpcCell,
  DeviceRankCell,
  DeviceUrlCell,
  SerpFeatureTags,
  VolumeCell,
} from "./RankTrackingTableParts";
import type { SelectionAnchor } from "@/lib/table/tableSelection";

export const RANK_TRACKING_HEADER_CLASS =
  "text-xs uppercase tracking-wide text-muted-foreground";

const HEADER_TOOLTIPS: Record<string, string> = {
  keyword: "The search term being tracked in Google",
  volume: "Estimated monthly search volume from Google",
  kd: "Keyword difficulty score (0-100) — higher means harder to rank",
  cpc: "Average cost per click in Google Ads (USD)",
  desktopPosition:
    "Current Google ranking position, showing change from the comparison period",
  mobilePosition:
    "Current Google ranking position, showing change from the comparison period",
  url: "The page on your site that ranks for this keyword",
  serp: "Special result features appearing on the search results page (e.g. AI Overview, People Also Ask)",
};

export const PINNED_COLUMN_ID = "pinned";

const pinnedColumn: ColumnDef<RankTrackingRow> = {
  id: PINNED_COLUMN_ID,
  accessorFn: (row) => (row.pinned ? 0 : 1),
};

function PinButton({
  pinned,
  onClick,
}: {
  pinned: boolean;
  onClick: () => void;
}) {
  const label = pinned ? "Unpin keyword" : "Pin keyword to top";
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      aria-pressed={pinned}
      title={label}
      className={
        pinned ? "text-amber-500 hover:text-amber-600" : "text-muted-foreground hover:text-foreground"
      }
    >
      <Star className={`size-3.5 ${pinned ? "fill-current" : ""}`} />
    </Button>
  );
}

function makeKeywordColumn(
  onKeywordClick: (row: RankTrackingRow) => void,
  onSetPinned: (vars: { trackingKeywordId: string; pinned: boolean }) => void,
): ColumnDef<RankTrackingRow> {
  return {
    id: "keyword",
    accessorKey: "keyword",
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label="Keyword"
        title={HEADER_TOOLTIPS.keyword}
        className={RANK_TRACKING_HEADER_CLASS}
      />
    ),
    cell: ({ row }) => (
      <div className="flex items-center gap-1.5">
        <PinButton
          pinned={row.original.pinned}
          onClick={() =>
            onSetPinned({
              trackingKeywordId: row.original.trackingKeywordId,
              pinned: !row.original.pinned,
            })
          }
        />
        <button
          type="button"
          className="text-left font-medium text-foreground decoration-dotted underline-offset-2 hover:underline cursor-pointer"
          onClick={() => onKeywordClick(row.original)}
          title="View position history"
        >
          {row.original.keyword}
        </button>
        {row.original.matchCase && (
          <Badge
            variant="secondary"
            size="sm"
            className="cursor-help"
            title="Tracked exactly as typed, not lowercased"
          >
            Aa
          </Badge>
        )}
      </div>
    ),
    sortingFn: "alphanumeric",
  };
}

function makeDeviceColumn(
  device: "desktop" | "mobile",
  serpDepth: number,
): ColumnDef<RankTrackingRow> {
  const id = device === "desktop" ? "desktopPosition" : "mobilePosition";
  return {
    id,
    accessorFn: (row) => row[device].position ?? undefined,
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label="Position"
        title={HEADER_TOOLTIPS[id]}
        className={RANK_TRACKING_HEADER_CLASS}
      />
    ),
    size: 130,
    cell: ({ row }) => (
      <DeviceRankCell result={row.original[device]} serpDepth={serpDepth} />
    ),
    sortUndefined: "last",
  };
}

function makeUrlColumn(
  device: "desktop" | "mobile",
  domain: string,
): ColumnDef<RankTrackingRow> {
  return {
    id: device === "desktop" ? "desktopUrl" : "mobileUrl",
    enableSorting: false,
    header: () => (
      <span
        className="cursor-help text-xs font-medium tracking-wide uppercase text-muted-foreground"
        title={HEADER_TOOLTIPS.url}
      >
        URL
      </span>
    ),
    size: 220,
    cell: ({ row }) => (
      <DeviceUrlCell result={row.original[device]} domain={domain} />
    ),
  };
}

function makeVolumeColumn(locationLabel?: string): ColumnDef<RankTrackingRow> {
  return {
    id: "volume",
    accessorFn: (row) => row.searchVolume ?? undefined,
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label={locationLabel ? "Local volume" : "Volume"}
        title={
          locationLabel
            ? `Estimated monthly searches in ${locationLabel} from Google Ads`
            : HEADER_TOOLTIPS.volume
        }
        className={RANK_TRACKING_HEADER_CLASS}
      />
    ),
    size: 90,
    cell: ({ getValue }) => (
      <VolumeCell value={getValue<number | undefined>() ?? null} />
    ),
    sortUndefined: "last",
  };
}

const kdColumn: ColumnDef<RankTrackingRow> = {
  id: "kd",
  accessorFn: (row) => row.keywordDifficulty ?? undefined,
  header: ({ column }) => (
    <SortableHeader
      column={column}
      label="KD"
      title={HEADER_TOOLTIPS.kd}
      className={RANK_TRACKING_HEADER_CLASS}
    />
  ),
  size: 70,
  cell: ({ getValue }) => (
    <ScoreBadge value={getValue<number | undefined>() ?? null} />
  ),
  sortUndefined: "last",
};

const cpcColumn: ColumnDef<RankTrackingRow> = {
  id: "cpc",
  accessorFn: (row) => row.cpc ?? undefined,
  header: ({ column }) => (
    <SortableHeader
      column={column}
      label="CPC"
      title={HEADER_TOOLTIPS.cpc}
      className={RANK_TRACKING_HEADER_CLASS}
    />
  ),
  size: 80,
  cell: ({ getValue }) => (
    <CpcCell value={getValue<number | undefined>() ?? null} />
  ),
  sortUndefined: "last",
};

function makeSerpColumn(
  device: "desktop" | "mobile",
): ColumnDef<RankTrackingRow> {
  return {
    id: device === "desktop" ? "desktopSerp" : "mobileSerp",
    enableSorting: false,
    header: () => (
      <span
        className="cursor-help text-xs font-medium tracking-wide uppercase text-muted-foreground"
        title={HEADER_TOOLTIPS.serp}
      >
        SERP Features
      </span>
    ),
    cell: ({ row }) => {
      const features = row.original[device].serpFeatures;
      if (features.length === 0) return null;
      return <SerpFeatureTags features={features} />;
    },
  };
}

function makeActionsColumn(
  onKeywordClick: (row: RankTrackingRow) => void,
  onRemoveKeyword: (keywordId: string) => void,
  market: { locationCode: number; languageCode: string; locationName?: string | null },
): ColumnDef<RankTrackingRow> {
  return {
    id: "actions",
    enableSorting: false,
    size: 44,
    cell: ({ row }) => {
      const kw = row.original;
      const serpUrl = googleSerpUrl(kw.keyword, {
        locationCode: market.locationCode,
        languageCode: market.languageCode,
        locationName: market.locationName ?? undefined,
      });
      return (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Keyword actions"
                className="text-muted-foreground hover:text-foreground"
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            }
          >
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Keyword actions"
              className="text-muted-foreground hover:text-foreground"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => onKeywordClick(kw)}
              className="flex items-center gap-2 cursor-pointer"
            >
              <History className="size-3.5 text-muted-foreground" />
              <span>View history</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => window.open(serpUrl, "_blank", "noopener,noreferrer")}
              className="flex items-center gap-2 cursor-pointer"
            >
              <ExternalLink className="size-3.5 text-muted-foreground" />
              <span>Open in Google</span>
            </DropdownMenuItem>
            {/* Phase 6 column / action slot: Track as AI question */}
            <DropdownMenuItem
              onClick={() => onRemoveKeyword(kw.trackingKeywordId)}
              className="flex items-center gap-2 text-destructive focus:text-destructive cursor-pointer"
            >
              <Trash2 className="size-3.5" />
              <span>Remove</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    },
  };
}

export function useRankTrackingColumns(options: {
  showDesktop: boolean;
  showMobile: boolean;
  domain: string;
  serpDepth?: number;
  selectAnchorRef: MutableRefObject<SelectionAnchor | null>;
  onKeywordClick: (row: RankTrackingRow) => void;
  onSetPinned: (vars: { trackingKeywordId: string; pinned: boolean }) => void;
  onRemoveKeyword: (keywordId: string) => void;
  locationCode: number;
  languageCode: string;
  locationName?: string | null;
  /** Phase 6 slot for AI question column */
  aiQuestionColumn?: ColumnDef<RankTrackingRow>;
}): ColumnDef<RankTrackingRow>[] {
  const {
    showDesktop,
    showMobile,
    domain,
    serpDepth = 40,
    selectAnchorRef,
    onKeywordClick,
    onSetPinned,
    onRemoveKeyword,
    locationCode,
    languageCode,
    locationName,
    aiQuestionColumn,
  } = options;

  const locationLabel = locationName
    ? formatLocationLabel(locationName, 2)
    : undefined;

  return useMemo(() => {
    const cols: ColumnDef<RankTrackingRow>[] = [
      pinnedColumn,
      makeSelectionColumn<RankTrackingRow>(selectAnchorRef),
      makeKeywordColumn(onKeywordClick, onSetPinned),
    ];

    if (showDesktop) {
      cols.push(makeDeviceColumn("desktop", serpDepth));
      cols.push(makeUrlColumn("desktop", domain));
    }
    if (showMobile) {
      cols.push(makeDeviceColumn("mobile", serpDepth));
      cols.push(makeUrlColumn("mobile", domain));
    }

    cols.push(makeVolumeColumn(locationLabel), kdColumn, cpcColumn);

    if (showDesktop) {
      cols.push(makeSerpColumn("desktop"));
    }
    if (showMobile) {
      cols.push(makeSerpColumn("mobile"));
    }

    // Phase 6 column slot: AI question cell (aiVisibilityColumn)
    if (aiQuestionColumn) {
      cols.push(aiQuestionColumn);
    }

    cols.push(
      makeActionsColumn(onKeywordClick, onRemoveKeyword, {
        locationCode,
        languageCode,
        locationName,
      }),
    );

    return cols;
  }, [
    showDesktop,
    showMobile,
    domain,
    serpDepth,
    selectAnchorRef,
    onKeywordClick,
    onSetPinned,
    onRemoveKeyword,
    locationCode,
    languageCode,
    locationName,
    locationLabel,
    aiQuestionColumn,
  ]);
}
