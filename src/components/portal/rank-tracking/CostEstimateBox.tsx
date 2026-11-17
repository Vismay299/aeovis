// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/rank-tracking/RankTrackingConfigModal.tsx:378-412
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { stableStringify } from "@/shared/query/keys";
import { formatUsd } from "@/shared/pricing";
import type { Devices, RankSchedule } from "@/shared/rank-tracking";

type ConfigSaveInput = {
  draft: { keywordCount: number };
  devices: Devices;
  serpDepth: number;
  scheduleInterval: RankSchedule;
};

/**
 * The live server-priced cost box for the setup wizard: one quote prices a
 * single keyword per check, the other prices 50 keywords for the month.
 * The draft input is debounced 350 ms so typing does not spam quotes.
 */
export function CostEstimateBox({
  brandKey,
  devices,
  serpDepth,
  scheduleInterval,
}: {
  brandKey: string;
  devices: Devices;
  serpDepth: number;
  scheduleInterval: RankSchedule;
}) {
  const input: ConfigSaveInput = {
    draft: { keywordCount: 1 },
    devices,
    serpDepth,
    scheduleInterval,
  };
  const [debouncedInput, setDebouncedInput] = useState(input);
  const inputKey = stableStringify(input);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedInput(input), 350);
    return () => window.clearTimeout(timer);
    // Rebuild only when the serialised input changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey]);

  const enabled = Boolean(brandKey);
  const quote1 = usePriceQuote(
    {
      brandKey,
      action: "rank_tracking.config.save",
      input: debouncedInput,
    },
    { enabled },
  );
  const quote50 = usePriceQuote(
    {
      brandKey,
      action: "rank_tracking.config.save",
      input: { ...debouncedInput, draft: { keywordCount: 50 } },
    },
    { enabled },
  );

  const isRefreshing = quote1.isFetching || quote50.isFetching;
  const isError = quote1.isError || quote50.isError;
  const retry = () => {
    void quote1.refetch();
    void quote50.refetch();
  };

  return (
    <div className="space-y-0.5 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
      {isError ? (
        <div className="flex items-center justify-between gap-2">
          <span>Price unavailable.</span>
          <Button variant="outline" size="xs" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <div>
            <span className="font-mono font-semibold text-foreground">
              up to{" "}
              {quote1.data ? formatUsd(quote1.data.totalUsd) : "…"}
            </span>{" "}
            per keyword per check
          </div>
          {scheduleInterval !== "manual" && quote50.data?.monthly && (
            <div>
              50 keywords would cost up to{" "}
              <span className="font-mono font-semibold text-foreground">
                {formatUsd(quote50.data.monthly.totalUsd)}/month
              </span>
            </div>
          )}
          {isRefreshing && (
            <p
              aria-live="polite"
              className="inline-flex items-center gap-1 text-xs"
            >
              <Loader2 className="size-3.5 animate-spin" />
              Updating price…
            </p>
          )}
        </>
      )}
    </div>
  );
}
