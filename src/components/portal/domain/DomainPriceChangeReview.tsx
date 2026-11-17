"use client";

import { useState } from "react";
import { PricedActionButton } from "@/components/app/cost/PricedActionButton";
import type { PricedActionButtonProps } from "@/components/app/cost/PricedActionButton";
import { isApiError } from "@/shared/query/fetchJson";
import { priceQuoteSchema, type PriceQuote } from "@/shared/pricing";

export type DomainPriceChange = {
  approvedMaxUsd: number;
  quote: PriceQuote;
};

export function domainPriceChangeFromError(
  error: unknown,
): DomainPriceChange | null {
  if (!isApiError(error) || error.code !== "price_changed" || !error.details) {
    return null;
  }

  const approvedMaxUsd = error.details.approvedMaxUsd;
  const quote = priceQuoteSchema.safeParse(error.details.quote);
  if (
    typeof approvedMaxUsd !== "number" ||
    !Number.isFinite(approvedMaxUsd) ||
    !quote.success
  ) {
    return null;
  }

  return { approvedMaxUsd, quote: quote.data };
}

type Props = Omit<PricedActionButtonProps, "priceChanged" | "onClose"> & {
  priceChanged: DomainPriceChange | null;
  onClose?: () => void;
};

/** Shows a quote-review action for a request rejected after its price changed. */
export function DomainPriceChangeReview({
  priceChanged,
  onClose,
  ...buttonProps
}: Props) {
  const [dismissedQuote, setDismissedQuote] = useState<string | null>(null);
  const quoteIdentity = priceChanged
    ? `${priceChanged.approvedMaxUsd}:${priceChanged.quote.quotedAt}:${priceChanged.quote.inputsHash}`
    : null;
  const visiblePriceChange =
    quoteIdentity && dismissedQuote === quoteIdentity ? null : priceChanged;

  return (
    <PricedActionButton
      {...buttonProps}
      priceChanged={visiblePriceChange}
      onClose={() => {
        if (quoteIdentity) setDismissedQuote(quoteIdentity);
        onClose?.();
      }}
    />
  );
}
