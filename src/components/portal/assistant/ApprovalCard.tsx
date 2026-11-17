"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QueryError } from "@/components/app/QueryState";
import { SpendRefusedError } from "@/components/app/SpendRefusedError";
import { Spinner } from "@/components/ui/spinner";
import { keys } from "@/shared/query/keys";
import { ApiError, fetchJson } from "@/shared/query/fetchJson";
import { isSpendRefused } from "@/shared/query/errors";
import { formatUsd, type PriceQuote } from "@/shared/pricing";

export type ApprovalView = {
  id: string;
  toolName: string;
  label: string;
  kind: "price" | "confirm";
  status: string;
  quote: PriceQuote | null;
  approvedMaxUsd: number | null;
  expiresAt: string;
  decidedAt: string | null;
  result: unknown;
  errorCode: string | null;
};

const F09_ALERT_WARNINGS = new Set([
  "collection_paused",
  "daily_capacity_low",
  "workspace_limit_low",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function inputBullets(input: Record<string, unknown>): string[] {
  const bullets: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (key === "maxUsd" || value === null || value === undefined) continue;
    if (bullets.length >= 6) break;
    if (Array.isArray(value)) {
      bullets.push(`${key}: ${value.length} items`);
    } else if (typeof value === "object") {
      bullets.push(`${key}: ${JSON.stringify(value).slice(0, 80)}`);
    } else {
      bullets.push(`${key}: ${String(value).slice(0, 80)}`);
    }
  }
  return bullets;
}

function resultSummary(result: unknown): string | null {
  const record = asRecord(result);
  if (record.status === "success" && typeof record.summary === "string") return record.summary;
  return null;
}

function resultMessage(result: unknown): string | null {
  const record = asRecord(result);
  if (typeof record.message === "string") return record.message;
  return null;
}

/**
 * The human gate for a paid or external tool call: the action label, the F09
 * price, what it will do, and Approve/Decline. After a decision the card shows
 * the outcome and the caller sends the approval message so the assistant
 * continues from the stored result.
 */
export function ApprovalCard({
  brandKey,
  approvalId,
  kind,
  label,
  quote,
  expiresAt,
  toolInput = {},
  focusOnMount = false,
  onDecided,
}: {
  brandKey: string;
  approvalId: string;
  kind: "price" | "confirm";
  label: string;
  quote: unknown;
  expiresAt: string;
  /** The tool call input, for the "What it will do" bullets. */
  toolInput?: Record<string, unknown>;
  /** Focus the primary button on mount (a new card at the end of a reply). */
  focusOnMount?: boolean;
  /** The decide call returned 200: send the approval message. */
  onDecided?: (approvalId: string) => void;
}) {
  const queryClient = useQueryClient();
  const queryKey = keys.assistantApproval(approvalId);
  const approveRef = useRef<HTMLButtonElement>(null);
  const [priceChanged, setPriceChanged] = useState<{
    approvedMaxUsd: number;
    quote: PriceQuote;
  } | null>(null);
  const [decideError, setDecideError] = useState<ApiError | null>(null);
  const [, setTick] = useState(0);

  const approvalQuery = useQuery({
    queryKey,
    queryFn: () =>
      fetchJson<{ approval: ApprovalView }>(
        `/api/customer/assistant/approvals/${encodeURIComponent(approvalId)}?brand_key=${encodeURIComponent(brandKey)}`,
      ),
    enabled: Boolean(brandKey && approvalId),
    refetchInterval: (query) => {
      const status = query.state.data?.approval.status;
      return status === "pending" ? 15_000 : false;
    },
  });

  const view: ApprovalView | null = approvalQuery.data?.approval ?? null;
  const liveKind = view?.kind ?? kind;
  const liveLabel = view?.label ?? label;
  const currentQuote = (priceChanged?.quote ?? view?.quote ?? (quote as PriceQuote | null)) || null;
  const liveExpiresAt = view?.expiresAt ?? expiresAt;
  const status = priceChanged ? "pending" : (view?.status ?? "pending");

  // Countdown text ("Expires in {m} min") needs a tick while pending.
  useEffect(() => {
    if (status !== "pending") return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 30_000);
    return () => clearInterval(timer);
  }, [status]);

  const expired =
    status === "expired" ||
    (status === "pending" && Number.isFinite(new Date(liveExpiresAt).getTime()) && new Date(liveExpiresAt).getTime() <= Date.now());
  const minutesLeft = useMemo(() => {
    const then = new Date(liveExpiresAt).getTime();
    if (!Number.isFinite(then)) return null;
    return Math.max(0, Math.ceil((then - Date.now()) / 60_000));
  }, [liveExpiresAt]);

  useEffect(() => {
    if (focusOnMount && (status === "pending" || priceChanged)) {
      approveRef.current?.focus();
    }
  }, [focusOnMount, status, priceChanged]);

  const decide = useMutation({
    mutationFn: (decision: "approve" | "decline") =>
      fetchJson<{ approval: ApprovalView }>(
        `/api/customer/assistant/approvals/${encodeURIComponent(approvalId)}/decide`,
        {
          method: "POST",
          body: {
            brand_key: brandKey,
            decision,
            ...(decision === "approve" && liveKind === "price" && currentQuote
              ? { maxUsd: currentQuote.totalUsd }
              : {}),
          },
        },
      ),
    onSuccess: async ({ approval }) => {
      setPriceChanged(null);
      setDecideError(null);
      queryClient.setQueryData<{ approval: ApprovalView }>(queryKey, { approval });
      await queryClient.invalidateQueries({ queryKey });
      onDecided?.(approvalId);
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === "price_changed") {
        const details = error.details ?? {};
        const nextQuote = asRecord(details).quote as PriceQuote | undefined;
        const approvedMaxUsd = asRecord(details).approvedMaxUsd;
        if (nextQuote && typeof approvedMaxUsd === "number") {
          setPriceChanged({ approvedMaxUsd, quote: nextQuote });
          setDecideError(null);
          await queryClient.invalidateQueries({ queryKey });
          return;
        }
      }
      if (error instanceof ApiError && error.code === "approval_expired") {
        await queryClient.invalidateQueries({ queryKey });
      }
      setDecideError(error instanceof ApiError ? error : null);
    },
  });

  const deciding = decide.isPending;
  const titleId = `approval-${approvalId}-title`;
  const bullets = useMemo(() => inputBullets(toolInput), [toolInput]);
  const alertWarnings = (currentQuote?.warnings ?? []).filter((warning) => F09_ALERT_WARNINGS.has(warning.code));
  const bulletWarnings = (currentQuote?.warnings ?? []).filter((warning) => !F09_ALERT_WARNINGS.has(warning.code));

  return (
    <section aria-labelledby={titleId} className="rounded-xl border border-border bg-card px-3 py-2.5 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <Badge variant="warning">Needs your approval</Badge>
        <span id={titleId} className="font-medium">{liveLabel}</span>
      </p>

      {liveKind === "price" && currentQuote && !expired && status !== "declined" ? (
        <div className="mt-2 space-y-1">
          <p className="text-xl font-semibold tabular-nums" aria-live="polite">
            Up to {formatUsd(currentQuote.totalUsd)}
          </p>
          {currentQuote.lines.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
              {currentQuote.lines.map((line, index) => (
                <li key={index}>
                  {line.label}: {formatUsd(line.totalUsd)}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs text-muted-foreground">You pay only the provider's charge, up to this amount.</p>
        </div>
      ) : null}
      {liveKind === "confirm" ? (
        <p className="mt-1.5 text-xs text-muted-foreground">This acts outside Perceev.</p>
      ) : null}

      {alertWarnings.map((warning) => (
        <Alert key={warning.code} variant="warning" className="mt-2">
          <AlertDescription>{warning.message}</AlertDescription>
        </Alert>
      ))}

      {bullets.length > 0 && !expired && status !== "declined" && status !== "executed" && status !== "failed" ? (
        <div className="mt-2">
          <p className="text-xs font-medium text-muted-foreground">What it will do</p>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            {bullets.map((bullet, index) => (
              <li key={index} className="break-words">{bullet}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {bulletWarnings.length > 0 ? (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          {bulletWarnings.map((warning) => (
            <li key={warning.code}>{warning.message}</li>
          ))}
        </ul>
      ) : null}

      {priceChanged && status === "pending" && !expired ? (
        <Alert variant="warning" className="mt-2">
          <AlertTitle>The price changed</AlertTitle>
          <AlertDescription>
            This now costs up to {formatUsd(priceChanged.quote.totalUsd)}. You approved{" "}
            {formatUsd(priceChanged.approvedMaxUsd)}. Review the new price.
          </AlertDescription>
        </Alert>
      ) : null}

      {decideError && isSpendRefused(decideError) ? (
        <div className="mt-2">
          <SpendRefusedError error={decideError} variant="inline" />
        </div>
      ) : null}
      {decideError && !isSpendRefused(decideError) ? (
        <div className="mt-2">
          <QueryError error={decideError} fallback="The decision could not be saved." variant="inline" />
        </div>
      ) : null}

      {status === "pending" && !expired ? (
        <div className="mt-2.5 flex flex-col gap-2 sm:flex-row">
          <Button
            ref={approveRef}
            className="w-full sm:w-auto"
            pending={deciding}
            onClick={() => decide.mutate("approve")}
          >
            {deciding ? "Running…" : "Approve and run"}
          </Button>
          <Button
            variant="ghost"
            className="w-full sm:w-auto"
            disabled={deciding}
            onClick={() => decide.mutate("decline")}
          >
            Decline
          </Button>
          {minutesLeft !== null ? (
            <p className="text-xs text-muted-foreground sm:ml-auto sm:self-center">
              Expires in {minutesLeft} min
            </p>
          ) : null}
        </div>
      ) : null}

      {expired ? (
        <p className="mt-2 text-xs text-muted-foreground">
          This approval expired. Ask the assistant again for a fresh price.
        </p>
      ) : null}
      {status === "executed" ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs">
          <Check className="size-3.5 text-success" aria-hidden />
          <span className="font-medium">Approved · ran</span>
          {resultSummary(view?.result) ? (
            <span className="text-muted-foreground">{resultSummary(view?.result)}</span>
          ) : null}
        </p>
      ) : null}
      {status === "failed" ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          <span>
            Approved, but it did not run: {resultMessage(view?.result) ?? view?.errorCode ?? "unknown error"}
          </span>
        </p>
      ) : null}
      {status === "declined" ? (
        <p className="mt-2 text-xs text-muted-foreground">Declined</p>
      ) : null}

      {approvalQuery.isPending ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="size-3" /> Checking approval status…
        </p>
      ) : null}
    </section>
  );
}
