// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/rank-tracking/RankTrackingConfigModal.tsx (first-check step)
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PricedActionButton } from "@/components/app/cost/PricedActionButton";
import { fetchJson, isApiError } from "@/shared/query/fetchJson";
import { formatNextRun } from "@/shared/schedule";
import { trackRankEvent } from "./telemetry";

export function FirstCheckStep({
  brandKey,
  configId,
  nextCheckAt,
  keywordCount,
  onDone,
  onClose,
}: {
  brandKey: string;
  configId: string;
  nextCheckAt: string | null;
  keywordCount: number;
  onDone: () => void;
  onClose: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  async function handleRun(maxUsd: number) {
    setRunning(true);
    setRunError(null);
    try {
      await fetchJson<{ runId: string; jobId: string; status: string }>(
        `/api/customer/rank-tracking/configs/${encodeURIComponent(configId)}/check`,
        {
          method: "POST",
          body: { brand_key: brandKey, maxUsd },
        },
      );
      toast.success("Rank check started");
      trackRankEvent("rank_tracking:check_trigger", {
        keywords: keywordCount,
        subset: false,
      });
      onDone();
    } catch (err) {
      setRunError(
        isApiError(err)
          ? err.message
          : "The check could not start. Please retry.",
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Check rankings now?</DialogTitle>
        <DialogDescription>
          {nextCheckAt
            ? `Your first scheduled check runs ${formatNextRun(nextCheckAt)}. Check now to see positions right away.`
            : "Check now to see positions."}
        </DialogDescription>
      </DialogHeader>

      {runError ? (
        <Alert variant="destructive">
          <AlertDescription>{runError}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter className="items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <PricedActionButton
            label={`Check ${keywordCount} keywords now`}
            pendingLabel="Starting check…"
            brandKey={brandKey}
            action="rank_tracking.check.run"
            input={{ configId, method: "live" }}
            pending={running}
            onRun={(maxUsd) => void handleRun(maxUsd)}
            alwaysConfirm
            dialogTitle="Check rankings now"
            confirmLabel="Run check"
          />
          <Button variant="ghost" onClick={onClose} disabled={running}>
            Not now
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
