"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Info, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CardShell } from "@/components/app/CardShell";
import { ErrorState } from "@/components/app/ErrorState";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { MonthlyProjection } from "@/components/app/cost/MonthlyProjection";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { usePortal } from "@/components/portal/PortalShell";
import { isApiError } from "@/lib/query/fetchJson";
import { formatUsd, type PriceQuote } from "@/shared/pricing";
import {
  formatNextRun,
  type ScheduleInterval,
  type ScheduleTime,
} from "@/shared/schedule";
import { useSchedule, useSaveSchedule } from "./hooks/useSchedule";
import { ScheduleField, type ScheduleFieldValue } from "./ScheduleField";
import { ScheduleSummary } from "./ScheduleSummary";
import { ScheduleHistory } from "./ScheduleHistory";

export function ScheduleSettings() {
  const { brandKey, isOwner, features } = usePortal();
  const scheduleQuery = useSchedule(brandKey);
  const saveSchedule = useSaveSchedule(brandKey);

  const schedule = scheduleQuery.data;
  const status = schedule?.status ?? "off";

  // Interval & ScheduleTime draft state
  const [fieldValue, setFieldValue] = useState<ScheduleFieldValue>({
    interval: "weekly",
  });
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [priceChangedState, setPriceChangedState] = useState<{
    approvedMaxUsd: number;
    quote: PriceQuote;
  } | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const selectedInterval: ScheduleInterval =
    fieldValue.interval === "manual" ? "weekly" : fieldValue.interval;

  // Active interval for quote and saving
  const quoteInterval =
    status === "on" && !editingSchedule
      ? schedule?.interval ?? "weekly"
      : selectedInterval;

  const quote = usePriceQuote({
    brandKey,
    action: "ai_visibility.schedule.save",
    input: { scheduleInterval: quoteInterval },
  });

  const isPanelBlocked = quote.data?.blocked?.code === "panel_not_approved";
  const isCollectionPaused = quote.data?.warnings?.some(
    (w) => w.code === "collection_paused",
  );

  const hasRecentSkip = Boolean(
    schedule?.lastSkip &&
      (!schedule.lastRunAt ||
        new Date(schedule.lastSkip.at).getTime() >
          new Date(schedule.lastRunAt).getTime()),
  );

  async function handleConfirmSave(approvedMaxUsd: number) {
    setDialogError(null);
    try {
      const result = await saveSchedule.mutateAsync({
        brand_key: brandKey,
        enabled: true,
        interval: quoteInterval,
        scheduleTime: fieldValue.scheduleTime,
        maxUsd: approvedMaxUsd,
      });
      setDialogOpen(false);
      setEditingSchedule(false);
      setPriceChangedState(null);
      const nextRunStr = result.nextRunAt ? formatNextRun(result.nextRunAt) : "";
      toast.success(
        `Scheduled scans are on. Next scan ${nextRunStr}.`,
      );
    } catch (err: unknown) {
      if (isApiError(err) && err.code === "price_changed" && err.details?.quote) {
        setPriceChangedState({
          approvedMaxUsd,
          quote: err.details.quote as PriceQuote,
        });
      } else if (err instanceof Error) {
        setDialogError(err.message);
      } else {
        setDialogError("The schedule could not be saved. Please retry.");
      }
    }
  }

  async function handlePause() {
    try {
      await saveSchedule.mutateAsync({
        brand_key: brandKey,
        enabled: false,
      });
      toast.success("Scheduled scans are paused.");
    } catch {
      toast.error("Failed to pause scheduled scans.");
    }
  }

  return (
    <div className="space-y-6">
      <CardShell title="Scheduled scans">
        <p className="mb-4 text-sm text-muted-foreground">
          Scan your approved questions automatically. Each scan asks exactly the questions you approved.
        </p>
        {scheduleQuery.isLoading ? (
          <div className="space-y-3 py-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : scheduleQuery.isError ? (
          <ErrorState
            message="The schedule could not be loaded."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => scheduleQuery.refetch()}
              >
                Retry
              </Button>
            }
          />
        ) : (
          <div className="space-y-4">
            {/* Operator managed alert */}
            {status === "operator" && (
              <Alert>
                <Info className="size-4" />
                <AlertDescription>
                  {`Perceev support manages this workspace's schedule. Next scan ${
                    schedule?.nextRunAt ? formatNextRun(schedule.nextRunAt) : "—"
                  }.`}
                </AlertDescription>
              </Alert>
            )}

            {/* Recent skip alert */}
            {hasRecentSkip && schedule?.lastSkip && (
              <Alert variant="warning">
                <AlertTriangle className="size-4" />
                <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    {`The scheduled scan on ${formatNextRun(
                      schedule.lastSkip.at,
                    )} did not run. ${schedule.lastSkip.message}`}
                  </span>
                  <div>
                    {schedule.lastSkip.reason === "price_changed" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setPriceChangedState(null);
                          setDialogOpen(true);
                        }}
                      >
                        Review price
                      </Button>
                    )}
                    {schedule.lastSkip.reason === "panel_not_approved" && (
                      <Button
                        variant="outline"
                        size="sm"
                        nativeButton={false}
                        render={<a href="/portal/measurement" />}
                      >
                        Review questions
                      </Button>
                    )}
                    {(schedule.lastSkip.reason === "daily_cap" ||
                      schedule.lastSkip.reason === "workspace_cap") &&
                      features?.usage_page && (
                        <Button
                          variant="outline"
                          size="sm"
                          nativeButton={false}
                          render={<a href="/portal/usage" />}
                        >
                          View usage
                        </Button>
                      )}
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {/* No approved panel warning */}
            {isPanelBlocked && status !== "operator" && (
              <Alert variant="warning">
                <AlertTriangle className="size-4" />
                <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                  <span>Approve your questions before scheduling scans.</span>
                  <Button
                    variant="outline"
                    size="sm"
                    nativeButton={false}
                    render={<a href="/portal/measurement" />}
                  >
                    Review questions
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {/* ON state (when not editing) */}
            {status === "on" && !editingSchedule && (
              <ScheduleSummary
                interval={schedule?.interval ?? "weekly"}
                nextRunAt={schedule?.nextRunAt ?? null}
                isOwner={isOwner}
                onPause={handlePause}
                pausePending={saveSchedule.isPending}
                onChangeSchedule={() => {
                  if (schedule?.interval) {
                    setFieldValue({
                      interval: schedule.interval,
                      scheduleTime: schedule.scheduleTime
                        ? {
                            weekday: schedule.scheduleTime.weekday,
                            hour: schedule.scheduleTime.hour,
                            minute: schedule.scheduleTime.minute,
                            timeZone: schedule.scheduleTime.timeZone,
                          }
                        : undefined,
                    });
                  }
                  setEditingSchedule(true);
                }}
              />
            )}

            {/* OFF, PAUSED, or ON in edit mode */}
            {(status === "off" ||
              status === "paused" ||
              (status === "on" && editingSchedule)) && (
                <div className="space-y-4">
                  <ScheduleField
                    value={fieldValue}
                    onChange={setFieldValue}
                    disabled={!isOwner || isPanelBlocked || saveSchedule.isPending}
                  />

                  {/* Price block */}
                  <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
                    {quote.isLoading ? (
                      <Skeleton className="h-4 w-40" />
                    ) : quote.isError ? (
                      <div className="flex items-center justify-between gap-2 text-destructive">
                        <span>The price could not be calculated.</span>
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => quote.refetch()}
                        >
                          Retry
                        </Button>
                      </div>
                    ) : (
                      <>
                        {isCollectionPaused && (
                          <Alert variant="warning">
                            <AlertDescription>
                              Answer collection is paused for maintenance.
                              Scheduled scans will be skipped until it resumes.
                            </AlertDescription>
                          </Alert>
                        )}
                        {quote.data && !isPanelBlocked && (
                          <div className="space-y-1">
                            <p>
                              Up to <strong>{formatUsd(quote.data.totalUsd)}</strong>{" "}
                              per scan
                            </p>
                            <MonthlyProjection monthly={quote.data.monthly} />
                            {quote.data.expectedUsd !== null &&
                              quote.data.expectedUsd !== undefined && (
                                <p className="text-xs text-muted-foreground">
                                  Typically about{" "}
                                  {formatUsd(quote.data.expectedUsd)} per scan,
                                  based on recent answers.
                                </p>
                              )}
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {/* Action buttons or permission hint */}
                  {isOwner ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        disabled={
                          isPanelBlocked ||
                          saveSchedule.isPending ||
                          quote.isLoading ||
                          quote.isError
                        }
                        onClick={() => {
                          setPriceChangedState(null);
                          setDialogOpen(true);
                        }}
                      >
                        {saveSchedule.isPending ? (
                          <>
                            <Loader2 className="mr-1.5 size-4 animate-spin" />
                            Saving…
                          </>
                        ) : status === "on" ? (
                          "Save schedule"
                        ) : status === "paused" ? (
                          "Resume scheduled scans"
                        ) : (
                          "Turn on scheduled scans"
                        )}
                      </Button>
                      {editingSchedule && (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={saveSchedule.isPending}
                          onClick={() => setEditingSchedule(false)}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Only the workspace owner can schedule scans.
                    </p>
                  )}
                </div>
              )}
          </div>
        )}
      </CardShell>

      {/* History card below */}
      <ScheduleHistory windows={schedule?.windows ?? []} />

      {/* Cost review confirm dialog */}
      <CostReviewDialog
        open={dialogOpen}
        title="Schedule scans"
        confirmLabel="Approve and schedule"
        pendingLabel="Saving…"
        quote={{
          data: quote.data,
          isPending: quote.isPending,
          isFetching: quote.isFetching,
          isError: quote.isError,
          error: quote.error,
          refetch: () => quote.refetch(),
        }}
        pending={saveSchedule.isPending}
        priceChanged={priceChangedState}
        error={dialogError}
        onConfirm={handleConfirmSave}
        onClose={() => {
          setDialogOpen(false);
          setPriceChangedState(null);
          setDialogError(null);
        }}
        detail={(q) => (
          <div className="space-y-2 pt-2">
            <MonthlyProjection monthly={q.monthly} />
            <p className="text-xs text-muted-foreground">
              Each scheduled scan can reserve up to the approved amount. If the
              price rises above it, scheduled scans are skipped until you approve
              again.
            </p>
          </div>
        )}
      />
    </div>
  );
}
