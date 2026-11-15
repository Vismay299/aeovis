// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/rank-tracking/RankTrackingDomainDetail.tsx (AI Overview strip)
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Sparkles, Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function AiOverviewStrip({
  overviewCount,
  checkedCount,
  device = "mobile",
  onShowThem,
}: {
  overviewCount: number;
  checkedCount: number;
  device?: "desktop" | "mobile";
  onShowThem?: () => void;
}) {
  if (checkedCount < 1) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-2.5 text-xs text-foreground">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Sparkles className="size-3.5 text-primary shrink-0" />
        <span>
          AI Overview seen for <strong>{overviewCount}</strong> of{" "}
          <strong>{checkedCount}</strong> checked keywords on {device} (latest check).
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="inline-flex cursor-help text-muted-foreground hover:text-foreground"
                aria-label="AI Overview detection note"
              >
                <Info className="size-3.5" />
              </button>
            }
          >
            <Info className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-xs">
            Counts results pages where Google showed an AI Overview when we checked.
            Overviews that load after the page are not detected here; track a keyword as
            an AI question to measure it fully.
          </TooltipContent>
        </Tooltip>
      </div>

      {onShowThem && (
        <button
          type="button"
          onClick={onShowThem}
          className="font-medium text-primary hover:underline underline-offset-2 shrink-0 cursor-pointer"
        >
          Show them
        </button>
      )}
    </div>
  );
}
