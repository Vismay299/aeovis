"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/billing/BillingFeatureBreakdown.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * F03 §6.6.1 — what the range cost, per feature, largest first. A row whose
 * spend includes an unpriced call says so in a badge: the estimate is counted
 * in the amount, and the reader is told rather than left to infer it.
 */

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatUsd } from "@/shared/money";
import type { WorkspaceUsage } from "@/shared/costs";

const ESTIMATED_TOOLTIP =
  "Some providers did not report a cost. Those calls are counted at the amount reserved before they ran.";

export function UsageByFeature({
  features,
}: {
  features: WorkspaceUsage["features"];
}) {
  if (features.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No usage recorded yet</p>
    );
  }

  const largest = features[0]?.usd ?? 0;

  return (
    <ul className="space-y-3">
      {features.map((feature) => {
        const width = largest > 0 ? Math.min(100, (feature.usd / largest) * 100) : 0;

        return (
          <li key={feature.feature} className="space-y-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate">{feature.label}</span>
                {feature.unknownUsd > 0 ? (
                  <Tooltip>
                    <TooltipTrigger delay={150} render={<span />}>
                      <Badge variant="outline">
                        {`includes ${formatUsd(feature.unknownUsd)} estimated`}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>{ESTIMATED_TOOLTIP}</TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
              <span className="tabular-nums">{formatUsd(feature.usd)}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${width}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
