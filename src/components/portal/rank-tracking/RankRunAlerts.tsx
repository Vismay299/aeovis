// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/RankRunAlerts.tsx:8-62
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { rankSkipReasonMessage } from "@/shared/rank-tracking";
import type { RankRunView } from "./hooks/useRankRunPolling";
import type { RankTrackerSummary } from "./hooks/useRankTrackers";

const SPEND_ERROR_CODES = new Set([
  "daily_cap",
  "workspace_cap",
  "feature_disabled",
  "insufficient_funds",
  "spend_refused",
  "INSUFFICIENT_CREDITS",
]);

export function RankRunAlerts({
  run,
  tracker,
  onReviewPrice,
}: {
  run: RankRunView | null | undefined;
  tracker?: RankTrackerSummary | null;
  onReviewPrice?: () => void;
}) {
  const isSkipWarning =
    tracker?.lastSkipReason === "price_changed" ||
    tracker?.lastSkipReason === "approval_missing";

  return (
    <div className="space-y-3">
      {isSkipWarning && (
        <Alert variant="warning">
          <AlertTriangle className="size-4 shrink-0" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-foreground">
            <span>
              {tracker?.lastSkipMessage ||
                rankSkipReasonMessage(tracker?.lastSkipReason || "")}
            </span>
            {onReviewPrice && (
              <Button
                variant="outline"
                size="xs"
                className="font-medium text-foreground"
                onClick={onReviewPrice}
              >
                Review price
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {run?.maybeStale && (
        <Alert variant="warning">
          <AlertTriangle className="size-4 shrink-0" />
          <AlertDescription className="text-foreground">
            This check may be unresponsive and will be cleaned up automatically.
          </AlertDescription>
        </Alert>
      )}

      {run?.status === "failed" &&
        (run.errorCode && SPEND_ERROR_CODES.has(run.errorCode) ? (
          <Alert variant="destructive">
            <AlertTriangle className="size-4 shrink-0" />
            <AlertDescription className="text-foreground">
              <span className="font-medium">Your last rank check didn't run.</span>{" "}
              {run.errorMessage || "Spend limit reached or feature disabled."}
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <AlertTriangle className="size-4 shrink-0" />
            <AlertDescription className="text-foreground">
              <span className="font-medium">Last check failed.</span>{" "}
              {run.errorMessage || "An unexpected error occurred during the check."}
            </AlertDescription>
          </Alert>
        ))}

      {run?.status === "completed" && run.errorMessage && (
        <Alert variant="warning">
          <AlertTriangle className="size-4 shrink-0" />
          <AlertDescription className="text-foreground">
            <span className="font-medium">Your last check was incomplete.</span>{" "}
            Our search data provider had errors, so some keywords show their previous position.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
