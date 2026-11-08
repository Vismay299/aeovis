// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/TrackerSetupReview.tsx:100-110
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import * as React from "react";
import { formatUsd } from "@/shared/pricing";
import type { PriceQuote } from "@/shared/pricing";

export type MonthlyProjectionProps = {
  monthly: PriceQuote["monthly"] | null | undefined;
  className?: string;
};

export function MonthlyProjection({ monthly, className }: MonthlyProjectionProps) {
  if (!monthly) return null;

  return (
    <p className={className}>
      <strong>{formatUsd(monthly.totalUsd)}</strong> estimated per month if it runs {monthly.interval}.
    </p>
  );
}
