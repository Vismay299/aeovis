// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/TrackingCostReview.tsx:86-239
//   src/client/features/ai-visibility/TrackerSetupReview.tsx:100-110
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import * as React from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUsd } from "@/shared/pricing";
import type { PriceQuote } from "@/shared/pricing";

export type CostReviewDialogProps = {
  open: boolean;
  title: string;
  confirmLabel: string;
  pendingLabel: string;
  quote: {
    data?: PriceQuote;
    isPending?: boolean;
    isFetching?: boolean;
    isError?: boolean;
    error?: unknown;
    refetch?: () => unknown;
  };
  pending: boolean;
  priceChanged: { approvedMaxUsd: number; quote: PriceQuote } | null;
  error: string | null;
  blockedAction?: React.ReactNode;
  onConfirm(maxUsd: number): void;
  onClose(): void;
  detail?: (q: PriceQuote) => React.ReactNode;
};

const ALERT_WARNING_CODES = new Set([
  "collection_paused",
  "daily_capacity_low",
  "workspace_limit_low",
]);

export function CostReviewDialog({
  open,
  title,
  confirmLabel,
  pendingLabel,
  quote,
  pending,
  priceChanged,
  error,
  blockedAction,
  onConfirm,
  onClose,
  detail,
}: CostReviewDialogProps) {
  const currentQuote = priceChanged ? priceChanged.quote : quote.data;
  const isLoading = Boolean(quote.isPending && !currentQuote);
  const isError = Boolean(quote.isError && !currentQuote);
  const isRefreshing = Boolean(currentQuote && quote.isFetching && !pending);
  const isBlocked = Boolean(currentQuote?.blocked);

  // Only scan-shaped quotes (ai_visibility.scan, ai_visibility.schedule.save)
  // count answers. Every other priced action (keywords, SERP, domain,
  // backlinks, local, site audit) prices other units, so the zero-answer
  // guard and the answers × engines breakdown apply to scan quotes only;
  // applying them to all quotes disabled Confirm for every non-scan action.
  const answersUnit = currentQuote?.units?.find((u) => u.key === "answers");
  const isScanQuote = Boolean(answersUnit);
  const answers = answersUnit?.count ?? 0;
  const questions =
    currentQuote?.units?.find((u) => u.key === "questions")?.count ?? 0;
  const engines =
    currentQuote?.units?.find((u) => u.key === "engines")?.count ?? 0;
  const isZeroAnswers = Boolean(currentQuote && isScanQuote && !isBlocked && answers === 0);
  const unitSummary = (currentQuote?.units ?? [])
    .filter((u) => u.count > 0)
    .map((u) => `${u.count.toLocaleString("en-US")} ${u.label}`)
    .join(" · ");

  const confirmDisabled =
    isLoading ||
    isRefreshing ||
    pending ||
    isBlocked ||
    isZeroAnswers ||
    !currentQuote;

  const alertWarnings = (currentQuote?.warnings ?? []).filter((w) =>
    ALERT_WARNING_CODES.has(w.code),
  );
  const bulletWarnings = (currentQuote?.warnings ?? []).filter(
    (w) => !ALERT_WARNING_CODES.has(w.code),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent
        fullScreenOnMobile
        showCloseButton={!pending}
      >
        <DialogHeader>
          <DialogTitle autoFocus tabIndex={-1}>
            {title}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {isLoading ? (
            <div aria-busy="true" className="space-y-3 py-2">
              <Skeleton className="h-8 w-32" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ) : isError ? (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center justify-between gap-2">
                <span>The price could not be calculated.</span>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => quote.refetch?.()}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : currentQuote ? (
            <>
              {priceChanged && (
                <Alert variant="warning">
                  <AlertTitle>The price changed</AlertTitle>
                  <AlertDescription>
                    {`${isScanQuote ? "This scan now costs" : "This now costs"} up to ${formatUsd(
                      priceChanged.quote.totalUsd,
                    )}. You approved ${formatUsd(
                      priceChanged.approvedMaxUsd,
                    )}. Review the new price and run again.`}
                  </AlertDescription>
                </Alert>
              )}

              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {isBlocked && (
                <Alert variant="destructive">
                  <AlertDescription className="space-y-2">
                    <p>{currentQuote.blocked?.message}</p>
                    {currentQuote.blocked?.code === "panel_not_approved" &&
                      (blockedAction ?? (
                        <Button
                          variant="outline"
                          size="sm"
                          nativeButton={false}
                          render={<a href="/portal/measurement" />}
                        >
                          Review questions
                        </Button>
                      ))}
                  </AlertDescription>
                </Alert>
              )}

              {alertWarnings.map((w) => (
                <Alert key={w.code} variant="warning">
                  <AlertDescription>{w.message}</AlertDescription>
                </Alert>
              ))}

              {isZeroAnswers ? (
                <p className="text-sm text-muted-foreground">
                  This scan has no answers to collect.
                </p>
              ) : (
                !isBlocked && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-muted-foreground">
                      Cost
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className="text-2xl font-semibold tabular-nums"
                        aria-live="polite"
                      >
                        {`Up to ${formatUsd(currentQuote.totalUsd)}`}
                      </span>
                      {isRefreshing && (
                        <span
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                          aria-live="polite"
                        >
                          <Loader2 className="size-3.5 animate-spin" />
                          Updating price…
                        </span>
                      )}
                    </div>
                    {isScanQuote ? (
                      <p className="text-xs text-muted-foreground">
                        {`${answers} ${
                          answers === 1 ? "answer" : "answers"
                        } (${questions} ${
                          questions === 1 ? "question" : "questions"
                        } × ${engines} ${
                          engines === 1 ? "engine" : "engines"
                        })`}
                      </p>
                    ) : unitSummary ? (
                      <p className="text-xs text-muted-foreground">{unitSummary}</p>
                    ) : null}
                    {currentQuote.lines?.[0]?.label && (
                      <p className="text-xs text-muted-foreground">
                        {currentQuote.lines[0].label}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground pt-1">
                      {isScanQuote
                        ? "You are only charged the provider cost of answers collected. Unused reservation is released when the scan finishes."
                        : "This is the most it can cost. You are charged only what the provider bills, up to this amount."}
                    </p>
                  </div>
                )
              )}

              {bulletWarnings.length > 0 && (
                <ul className="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                  {bulletWarnings.map((w) => (
                    <li key={w.code}>{w.message}</li>
                  ))}
                </ul>
              )}

              {detail?.(currentQuote)}
            </>
          ) : null}
        </div>

        <DialogFooter className="flex flex-col sm:flex-row gap-2 sm:justify-end">
          <Button
            type="button"
            className="order-1 sm:order-2"
            disabled={confirmDisabled}
            onClick={() => {
              if (currentQuote && !confirmDisabled) {
                onConfirm(currentQuote.totalUsd);
              }
            }}
          >
            {pending && <Loader2 className="size-4 animate-spin mr-1.5" />}
            {pending ? pendingLabel : confirmLabel}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="order-2 sm:order-1"
            disabled={pending}
            onClick={() => {
              if (!pending) onClose();
            }}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
