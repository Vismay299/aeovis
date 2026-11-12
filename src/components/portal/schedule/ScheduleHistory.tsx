"use client";

import { CardShell } from "@/components/app/CardShell";
import { Badge } from "@/components/ui/badge";
import { formatNextRun } from "@/shared/schedule";
import type { CustomerScheduleView } from "@/lib/schedules/schedule.contract";

type WindowItem = CustomerScheduleView["windows"][number];

function dispositionBadge(disposition: string) {
  switch (disposition) {
    case "started":
      return <Badge variant="info">Running</Badge>;
    case "finalized":
      return <Badge variant="success">Finished</Badge>;
    case "blocked":
      return <Badge variant="warning">Skipped</Badge>;
    case "missed":
      return <Badge variant="secondary">Missed</Badge>;
    case "overlap":
      return <Badge variant="warning">Skipped</Badge>;
    default:
      return <Badge variant="outline">{disposition}</Badge>;
  }
}

export function ScheduleHistory({
  windows,
}: {
  windows: readonly WindowItem[];
}) {
  return (
    <CardShell title="Recent scheduled scans">
      {windows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No scheduled scans yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {windows.map((win, idx) => (
            <li
              key={win.windowAt || idx}
              className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  {formatNextRun(win.windowAt)}
                </span>
                {dispositionBadge(win.disposition)}
              </div>
              {win.message && (
                <p className="text-xs text-muted-foreground">{win.message}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}
