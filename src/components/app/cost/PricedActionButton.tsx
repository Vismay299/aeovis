"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { stableStringify } from "@/shared/query/keys";
import { formatUsd, type PriceQuote } from "@/shared/pricing";

export type PricedActionButtonProps = {
  label: string;
  pendingLabel: string;
  brandKey: string;
  action: string;
  input: unknown;
  enabled?: boolean;
  pending: boolean;
  onRun(maxUsd: number): void;
  dialogThresholdUsd?: number; // default 0.25
  alwaysConfirm?: boolean; // default false; true forces CostReviewDialog (actions with requireApproval)
  dialogTitle: string;
  confirmLabel: string;
  variant?: "default" | "outline";
  className?: string;
  priceChanged?: { approvedMaxUsd: number; quote: PriceQuote } | null;
  error?: string | null;
  detail?: (q: PriceQuote) => React.ReactNode;
  onClose?: () => void;
};

export function PricedActionButton({
  label,
  pendingLabel,
  brandKey,
  action,
  input,
  enabled = true,
  pending,
  onRun,
  dialogThresholdUsd = 0.25,
  alwaysConfirm = false,
  dialogTitle,
  confirmLabel,
  variant = "default",
  className,
  priceChanged = null,
  error = null,
  detail,
  onClose,
}: PricedActionButtonProps): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [debouncedInput, setDebouncedInput] = React.useState(input);

  const inputKey = stableStringify(input);
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedInput(input);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [inputKey]);

  const quote = usePriceQuote(
    { brandKey, action, input: debouncedInput },
    { enabled: Boolean(enabled && brandKey && action) },
  );

  const quoteData = quote.data;
  // During the debounce the quote still prices the previous input; never run
  // directly on it (the dialog shows the refreshed quote instead).
  const isStale = inputKey !== stableStringify(debouncedInput);
  // A quote that prices this exact input: not mid-debounce and not the
  // previous input's placeholder. Only a fresh quote may become an approval.
  const isFresh = !isStale && !quote.isPlaceholderData;
  const isFirstLoading = quote.isPending && !quoteData && !quote.isError;
  const isBlocked = Boolean(quoteData?.blocked);
  const isError = quote.isError;

  const hasBlockingWarnings = Boolean(
    quoteData?.warnings?.some(
      (w) => w.code !== "cache_note" && w.code !== "recent_research",
    ),
  );

  const canDirectRun =
    !alwaysConfirm &&
    !isStale &&
    quoteData != null &&
    quoteData.totalUsd <= dialogThresholdUsd &&
    !hasBlockingWarnings &&
    !isBlocked;

  const handleClick = () => {
    if (pending || isFirstLoading || isBlocked || isError) return;
    if (quoteData != null && canDirectRun) {
      onRun(quoteData.totalUsd);
    } else {
      setDialogOpen(true);
    }
  };

  const isDialogOpen = dialogOpen || Boolean(priceChanged);

  let buttonText = label;
  if (pending) {
    buttonText = pendingLabel;
  } else if (isFirstLoading) {
    buttonText = label;
  } else if (quoteData != null && !isBlocked) {
    buttonText = `${label} · up to ${formatUsd(quoteData.totalUsd)}`;
  }

  const isButtonDisabled =
    !enabled || pending || isFirstLoading || isBlocked || isError;

  return (
    <div className="inline-flex flex-col gap-1">
      <Button
        type="button"
        variant={variant}
        className={className}
        disabled={isButtonDisabled}
        pending={pending || isFirstLoading}
        onClick={handleClick}
      >
        {buttonText}
      </Button>

      {/* Accessible price announcement */}
      {quoteData != null ? (
        <span className="sr-only" aria-live="polite">
          {`Price: up to ${formatUsd(quoteData.totalUsd)}`}
        </span>
      ) : null}

      {/* Blocked message */}
      {isBlocked && quoteData?.blocked ? (
        <p className="text-destructive text-xs">{quoteData.blocked.message}</p>
      ) : null}

      {/* Quote error retry link */}
      {isError ? (
        <p className="text-destructive text-xs">
          Price unavailable.{" "}
          <button
            type="button"
            onClick={() => quote.refetch()}
            className="underline hover:no-underline cursor-pointer"
          >
            Retry
          </button>
        </p>
      ) : null}

      {/* Review Dialog */}
      <CostReviewDialog
        open={isDialogOpen}
        title={dialogTitle}
        confirmLabel={confirmLabel}
        pendingLabel={pendingLabel}
        // Until the quote prices the current input the dialog shows it as
        // loading, so Confirm cannot approve the previous input's price.
        quote={
          isFresh
            ? quote
            : { ...quote, data: undefined, isPending: true, isError: false }
        }
        pending={pending}
        priceChanged={priceChanged}
        error={error}
        detail={detail}
        slideToConfirm
        onConfirm={(maxUsd) => {
          if (!isFresh && !priceChanged) return;
          onRun(maxUsd);
        }}
        onClose={() => {
          setDialogOpen(false);
          onClose?.();
        }}
      />
    </div>
  );
}
