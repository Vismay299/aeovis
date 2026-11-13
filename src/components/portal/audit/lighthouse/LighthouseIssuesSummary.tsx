// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/lighthouse/issues/LighthouseIssuesParts.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { MetricsTable } from "@/components/app/MetricsTable";
import type { LighthouseMetrics, LighthouseScores } from "./types.ts";

function scoreClass(score: number | null): string {
  if (score == null) return "text-muted-foreground";
  if (score >= 90) return "text-green-600";
  if (score >= 50) return "text-amber-600";
  return "text-red-600";
}

function scoreText(score: number | null): string {
  return score == null ? "—" : String(score);
}

const METRIC_ROWS = [
  ["firstContentfulPaint", "FCP"],
  ["largestContentfulPaint", "LCP"],
  ["totalBlockingTime", "TBT"],
  ["cumulativeLayoutShift", "CLS"],
  ["speedIndex", "Speed Index"],
  ["timeToInteractive", "TTI"],
  ["interactionToNextPaint", "INP"],
  ["serverResponseTime", "Server response"],
] as const;

export function LighthouseIssuesSummary({
  scores,
  metrics,
}: {
  scores?: LighthouseScores | null;
  metrics?: LighthouseMetrics | null;
}) {
  const rows = METRIC_ROWS.map(([key, label]) => ({
    label,
    value: metrics?.[key]?.displayValue ?? "—",
  }));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        {(
          [
            ["Performance", scores?.performance],
            ["Accessibility", scores?.accessibility],
            ["Best practices", scores?.["best-practices"]],
            ["SEO", scores?.seo],
          ] as Array<[string, number | null | undefined]>
        ).map(([label, score]) => (
          <div key={label} className="flex items-baseline gap-2">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className={`text-2xl font-semibold ${scoreClass(score ?? null)}`}>{scoreText(score ?? null)}</span>
          </div>
        ))}
      </div>
      <MetricsTable rows={rows} />
    </div>
  );
}
