"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/TrackingScheduleSummary.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { CalendarClock, Pause } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  formatNextRun,
  scheduleLabel,
  type ScheduleInterval,
} from "@/shared/schedule";

export type ScheduleSummaryProps = {
  interval: ScheduleInterval;
  nextRunAt: string | null;
  isOwner: boolean;
  onPause: () => void;
  pausePending?: boolean;
  onChangeSchedule?: () => void;
};

export function ScheduleSummary({
  interval,
  nextRunAt,
  isOwner,
  onPause,
  pausePending = false,
  onChangeSchedule,
}: ScheduleSummaryProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
      <p className="text-sm">
        {scheduleLabel(interval)}
        <span className="text-muted-foreground">
          {" · Next scan "}{nextRunAt ? formatNextRun(nextRunAt) : "—"}
        </span>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pausePending}
          onClick={onPause}
        >
          <Pause className="size-4" />
          Pause
        </Button>
        {isOwner && onChangeSchedule && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onChangeSchedule}
          >
            <CalendarClock className="size-4" />
            Change schedule
          </Button>
        )}
      </div>
    </div>
  );
}
