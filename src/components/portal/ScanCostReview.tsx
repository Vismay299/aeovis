"use client";

import * as React from "react";
import { usePortal } from "./PortalShell";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";

export function ScanCostReview() {
  const { brandKey, scan } = usePortal();
  const quote = usePriceQuote(
    {
      brandKey,
      action: "ai_visibility.scan.run",
      input: { panelKey: "default" },
    },
    { enabled: Boolean(brandKey && scan?.review?.open) },
  );

  if (!scan?.review) return null;

  return (
    <CostReviewDialog
      open={Boolean(scan.review.open)}
      title="Run scan"
      confirmLabel="Run scan"
      pendingLabel="Starting…"
      quote={quote}
      pending={Boolean(scan.starting)}
      priceChanged={scan.review.priceChanged}
      error={scan.review.error}
      onConfirm={scan.confirmStart}
      onClose={scan.cancelReview}
    />
  );
}
