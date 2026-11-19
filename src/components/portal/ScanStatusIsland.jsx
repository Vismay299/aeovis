"use client";

/**
 * The app shell's background-work pill. It shows only work the app already
 * tracks — today that is the single running scan from the shell's tracker.
 * Exports are synchronous (`POST /api/customer/exports`) and are not tracked
 * client-side, so no export task is invented here. With nothing running the
 * island renders nothing at all.
 */

import { StatusIsland } from "@/components/kokonutui/status-island";

export function ScanStatusIsland({ scan }) {
  if (!scan?.active) return null;

  const jobId = scan.job?.id || "current";
  const label = scan.stage?.label || "Scan";
  const percent = scan.percent;
  const progress =
    typeof percent === "number" && Number.isFinite(percent)
      ? Math.min(1, Math.max(0, percent / 100))
      : undefined;

  return (
    <StatusIsland
      tasks={[
        {
          id: `scan-${jobId}`,
          label,
          detail: "Scan",
          status: "running",
          progress,
        },
      ]}
    />
  );
}

export default ScanStatusIsland;
