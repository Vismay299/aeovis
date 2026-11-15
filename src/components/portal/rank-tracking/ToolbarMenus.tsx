// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/ToolbarMenus.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { MoreHorizontal, Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function ItemText({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  return (
    <span className="flex flex-col text-left">
      <span className="font-medium text-foreground">{label}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </span>
  );
}

export function MoreMenu({
  onCheckRankings,
  checkBusy,
  onRefreshMetrics,
  metricsRefreshing,
  trackedKeywordCount: _trackedKeywordCount,
  hasData,
}: {
  onCheckRankings: () => void;
  checkBusy: boolean;
  onRefreshMetrics: (opts?: { maxUsd?: number }) => void;
  metricsRefreshing: boolean;
  trackedKeywordCount: number;
  hasData: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="More actions"
            title="More actions"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        }
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="More actions"
          title="More actions"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem
          onClick={onCheckRankings}
          disabled={checkBusy || !hasData}
          className="flex items-start gap-2.5 p-2 cursor-pointer"
        >
          <Play className="size-4 mt-0.5 shrink-0 text-primary" />
          <ItemText
            label={checkBusy ? "Running…" : "Check rankings"}
            description="Fetch current Google positions"
          />
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onRefreshMetrics()}
          disabled={metricsRefreshing || !hasData}
          className="flex items-start gap-2.5 p-2 cursor-pointer"
        >
          <RefreshCw
            className={`size-4 mt-0.5 shrink-0 text-muted-foreground ${
              metricsRefreshing ? "animate-spin" : ""
            }`}
          />
          <ItemText
            label={metricsRefreshing ? "Refreshing…" : "Update keyword stats"}
            description="Volume, difficulty & CPC — not rankings"
          />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
