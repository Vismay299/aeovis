"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/Sidebar.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/shared/utils";
import { usePortal } from "@/components/portal/PortalShell";

/**
 * The card that appears above the footer while a scan is running.
 *
 * The percentage is shown as "—" when no progress has been reported yet, and
 * the bar pulses rather than pretending to know how far along the scan is.
 */
export function ScanRunningCard() {
  const { scan } = usePortal();
  if (!scan.active) return null;

  const percent = scan.percent === null ? null : Math.round(scan.percent);

  return (
    <Link href="/portal/scans" className="block">
      <Card size="sm" className="gap-2 py-3">
        <CardContent className="space-y-1.5 px-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Scan running</span>
            <span className="text-sm tabular-nums text-muted-foreground">
              {percent === null ? "—" : `${percent}%`}
            </span>
          </div>
          <Progress
            value={percent ?? null}
            aria-label="Scan progress"
            className={cn(
              "gap-0",
              percent === null &&
                "[&_[data-slot=progress-indicator]]:w-1/3 [&_[data-slot=progress-indicator]]:animate-pulse"
            )}
          />
          <span className="block text-xs text-muted-foreground">
            {scan.stage?.label || "Starting"}…
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}
