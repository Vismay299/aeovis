// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { QuestionHistoryLink } from "../questions/history/QuestionHistoryLink";
import type { RankTrackingRow } from "@/shared/rank-tracking";

const STATUS_CONFIG: Record<
  string,
  {
    label: string;
    variant: "default" | "soft" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" | "ghost" | "link";
  }
> = {
  cited: {
    label: "Cited in AI Overview",
    variant: "success",
  },
  mentioned: {
    label: "Named in AI Overview",
    variant: "soft",
  },
  absent: {
    label: "AI Overview without you",
    variant: "warning",
  },
  no_overview: {
    label: "No AI Overview",
    variant: "secondary",
  },
  not_measured: {
    label: "Not measured yet",
    variant: "secondary",
  },
};

export function AiVisibilityCell({ row }: { row: RankTrackingRow }) {
  const ai = row.aiQuestion;
  if (!ai) return null;

  const config = STATUS_CONFIG[ai.status] ?? STATUS_CONFIG.not_measured;
  const badge = (
    <Badge
      variant={config.variant}
      size="sm"
      className="cursor-help inline-flex items-center gap-1"
      title={ai.measuredAt ? `Measured ${new Date(ai.measuredAt).toLocaleDateString()}` : undefined}
    >
      <span>{config.label}</span>
    </Badge>
  );

  return (
    <div className="flex items-center gap-1.5">
      {ai.measuredAt ? (
        <Tooltip>
          <TooltipTrigger render={badge}>
            {badge}
          </TooltipTrigger>
          <TooltipContent>
            Measured {new Date(ai.measuredAt).toLocaleDateString()}
          </TooltipContent>
        </Tooltip>
      ) : (
        badge
      )}
      <QuestionHistoryLink questionId={ai.questionId} />
    </div>
  );
}
