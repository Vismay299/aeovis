// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/saved-keywords
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import {
  useJobStatus,
  type JobStatusResponse,
} from "@/components/app/hooks/useJobStatus";
import { fetchJson, isApiError } from "@/lib/query/fetchJson";
import { describeError } from "@/lib/query/errors";
import { formatUsd, type PriceQuote } from "@/shared/pricing";

export const REFRESH_STATS_DETAIL =
  "Fetches new volume, difficulty, and CPC for saved keywords not updated in the last 7 days. Keywords updated recently are skipped for free.";

type RefreshJobResult = {
  updated?: number;
  requested?: number;
  skippedFresh?: number;
  failedBatches?: number;
  totalBatches?: number;
};

export function useRefreshStats({
  brandKey,
  enabled,
}: {
  brandKey: string;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [priceChanged, setPriceChanged] = useState<{
    approvedMaxUsd: number;
    quote: PriceQuote;
  } | null>(null);

  // `nothing_to_refresh` and `refresh_running` arrive as a blocked quote
  // (HTTP 200), so the button never starts a job they refuse.
  const quote = usePriceQuote(
    { brandKey, action: "keywords.metrics_refresh.run", input: {} },
    { enabled: Boolean(brandKey && enabled) },
  );

  const invalidateList = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["savedKeywords", brandKey] }),
    [brandKey, queryClient],
  );

  const onFinish = useCallback(
    (data: JobStatusResponse) => {
      const result = (data.result ?? {}) as RefreshJobResult;
      const updated = Number(result.updated ?? 0);
      const skippedFresh = Number(result.skippedFresh ?? 0);
      if (data.status === "partial") {
        toast.warning(
          `Updated ${updated} keywords. Some requests failed; try again later.`,
        );
      } else if (data.status === "completed") {
        const already =
          skippedFresh > 0 ? ` · ${skippedFresh} already up to date` : "";
        toast.success(
          `Updated stats for ${updated} keyword${updated === 1 ? "" : "s"}${already}`,
        );
      } else {
        toast.error(
          data.error?.message ?? "Something went wrong. Please try again.",
        );
      }
      void invalidateList();
      setJobId(null);
    },
    [invalidateList],
  );

  const job = useJobStatus(brandKey, jobId, { onFinish });

  const blocked = quote.data?.blocked ?? null;
  const jobActive =
    job.data?.status === "queued" || job.data?.status === "running";
  const running = pending || Boolean(jobId) || jobActive;

  const label =
    quote.data && !blocked
      ? `Update keyword stats · up to ${formatUsd(quote.data.totalUsd)}`
      : "Update keyword stats";

  const canOpen =
    enabled &&
    !pending &&
    !jobId &&
    !quote.isError &&
    !blocked &&
    Boolean(quote.data);

  const run = async (maxUsd: number) => {
    setPending(true);
    setError(null);
    try {
      const result = await fetchJson<{
        jobId: string;
        status: string;
        pollAfterSeconds: number;
      }>("/api/customer/keywords/saved/refresh", {
        method: "POST",
        body: { brand_key: brandKey, maxUsd },
      });
      setJobId(result.jobId);
      setDialogOpen(false);
    } catch (caught) {
      if (isApiError(caught)) {
        if (caught.code === "price_changed") {
          const details = caught.details as
            | { approvedMaxUsd?: number; quote?: PriceQuote }
            | undefined;
          if (details?.quote) {
            setPriceChanged({
              approvedMaxUsd: Number(details.approvedMaxUsd ?? maxUsd),
              quote: details.quote,
            });
          }
        }
        // A race with another tab: adopt the job that won so progress and the
        // finish toast still work.
        if (caught.code === "job_already_running") {
          const activeJobId = (
            caught.details as { activeJobId?: unknown } | undefined
          )?.activeJobId;
          if (typeof activeJobId === "string") setJobId(activeJobId);
        }
        setError(caught.message);
      } else {
        setError(describeError(caught));
      }
    } finally {
      setPending(false);
    }
  };

  return {
    quote,
    label,
    blocked,
    error,
    priceChanged,
    pending,
    running,
    progress: jobActive ? job.data?.progress : undefined,
    openDialog: () => {
      setError(null);
      setPriceChanged(null);
      setDialogOpen(true);
    },
    closeDialog: () => {
      setDialogOpen(false);
      setError(null);
      setPriceChanged(null);
    },
    dialogOpen,
    canOpen,
    run,
  };
}

export type RefreshStatsController = ReturnType<typeof useRefreshStats>;
