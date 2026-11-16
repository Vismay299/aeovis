"use client";

import { useState } from "react";
import { toast } from "sonner";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MonthlyProjection } from "@/components/app/cost/MonthlyProjection";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import type { BacklinksOverview } from "@/shared/backlinks";
import {
  useCreateSnapshotTarget,
  useDeleteSnapshotTarget,
  useSnapshotTargets,
  type SnapshotInterval,
} from "./hooks/useSnapshotTargets";

export function TrackHistoryControl({
  brandKey,
  data,
  isOwner,
  snapshotsEnabled,
}: {
  brandKey: string;
  data: BacklinksOverview;
  isOwner: boolean;
  snapshotsEnabled: boolean;
}) {
  const [interval, setInterval] = useState<SnapshotInterval>("weekly");
  const [confirmStop, setConfirmStop] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const canTrackScope = data.scope === "domain" || data.scope === "subdomains";
  const tracked = data.tracked;
  const targets = useSnapshotTargets(brandKey, snapshotsEnabled);
  const createTarget = useCreateSnapshotTarget(brandKey);
  const deleteTarget = useDeleteSnapshotTarget(brandKey);
  const quote = usePriceQuote(
    {
      brandKey,
      action: "backlinks.snapshots.track",
      input: { target: data.target, scope: data.scope, interval },
    },
    { enabled: Boolean(isOwner && snapshotsEnabled && canTrackScope && !tracked) },
  );
  const snapshotTarget = targets.data?.targets.find(
    (item) => item.enabled && item.target === data.target && item.scope === data.scope,
  );
  if (!snapshotsEnabled || !canTrackScope) return null;

  const handleCreate = async (maxUsd: number) => {
    try {
      await createTarget.mutateAsync({
        target: data.target,
        scope: data.scope as "domain" | "subdomains",
        interval,
        maxUsd,
      });
      setDialogOpen(false);
      setDialogError(null);
      toast.success(`Tracking backlink history for ${data.displayTarget}, ${interval}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start tracking backlink history.";
      setDialogError(message);
    }
  };

  const handleStop = async () => {
    if (!snapshotTarget) return;
    try {
      await deleteTarget.mutateAsync({
        id: snapshotTarget.id,
        target: data.target,
        scope: data.scope as "domain" | "subdomains",
      });
      setConfirmStop(false);
      toast.success(`Stopped tracking ${data.displayTarget}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not stop tracking backlink history.");
    }
  };

  if (!isOwner) {
    return tracked ? (
      <Badge variant="secondary">History tracked · {titleCase(tracked.interval)}</Badge>
    ) : null;
  }

  if (tracked) {
    return (
      <div className="flex items-center gap-1">
        <Badge variant="secondary">History tracked · {titleCase(tracked.interval)}</Badge>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="History tracking actions" />}
          >
            <MoreHorizontal aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!snapshotTarget || deleteTarget.isPending}
              onClick={() => setConfirmStop(true)}
            >
              Stop tracking
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Stop tracking history?</AlertDialogTitle>
              <AlertDialogDescription>
                Saved snapshots are kept for 25 months.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteTarget.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={!snapshotTarget || deleteTarget.isPending}
                onClick={handleStop}
              >
                {deleteTarget.isPending ? "Stopping…" : "Stop tracking"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={(!quote.data && !quote.isError) || quote.isPending || quote.isFetching || Boolean(quote.data?.blocked) || createTarget.isPending}
        pending={createTarget.isPending || quote.isPending}
        onClick={() => {
          setDialogError(null);
          setDialogOpen(true);
        }}
      >
        {createTarget.isPending
          ? "Starting…"
          : "Track history"}
      </Button>
      {quote.data?.blocked ? (
        <p className="text-xs text-destructive">{quote.data.blocked.message}</p>
      ) : null}
      <CostReviewDialog
        open={dialogOpen}
        title="Track backlink history"
        confirmLabel="Start tracking"
        pendingLabel="Starting…"
        quote={quote}
        pending={createTarget.isPending}
        priceChanged={null}
        error={dialogError}
        onConfirm={(maxUsd) => void handleCreate(maxUsd)}
        onClose={() => {
          setDialogOpen(false);
          setDialogError(null);
        }}
        detail={(currentQuote) => (
          <div className="space-y-3 pt-2">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Tracking interval</legend>
              <RadioGroup
                aria-label="Tracking interval"
                value={interval}
                onValueChange={(value) => setInterval(value as SnapshotInterval)}
                className="grid grid-cols-2 gap-3"
              >
                <Label className="flex min-h-10 items-center gap-2 rounded-md border border-border px-3">
                  <RadioGroupItem value="weekly" id="snapshot-weekly" />
                  Weekly
                </Label>
                <Label className="flex min-h-10 items-center gap-2 rounded-md border border-border px-3">
                  <RadioGroupItem value="monthly" id="snapshot-monthly" />
                  Monthly
                </Label>
              </RadioGroup>
            </fieldset>
            <MonthlyProjection monthly={currentQuote.monthly} />
            <p className="text-xs text-muted-foreground">
              Takes one backlink summary per period for {data.displayTarget}. Viewing saved history is free.
            </p>
          </div>
        )}
      />
    </>
  );
}

function titleCase(value: SnapshotInterval) {
  return value === "weekly" ? "Weekly" : "Monthly";
}
