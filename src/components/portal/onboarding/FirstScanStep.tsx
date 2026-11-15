"use client";

import { useState, type ReactNode } from "react";
import { CheckCircle2, Circle, LoaderCircle, XCircle } from "lucide-react";
import { toast } from "sonner";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchJson, isApiError } from "@/lib/query/fetchJson";
import { describeError } from "@/lib/query/errors";
import { formatUsd } from "@/shared/pricing";
import { trackOnboardingEvent } from "./telemetry";
import type { OnboardingState } from "./hooks/useOnboardingState";

function StatusRow({ children, status = "todo" }: { children: ReactNode; status?: "todo" | "done" | "running" | "failed" }) {
  const Icon = status === "done" ? CheckCircle2 : status === "failed" ? XCircle : status === "running" ? LoaderCircle : Circle;
  return <li className="flex min-w-0 items-start gap-3 py-3"><Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${status === "running" ? "animate-spin" : status === "done" ? "text-success" : status === "failed" ? "text-destructive" : "text-muted-foreground"}`} /><span className="min-w-0 text-sm">{children}</span></li>;
}

export function FirstScanStep({ state, onBack, onSkipStep, onComplete, onRefresh }: {
  state: OnboardingState;
  onBack(): void;
  onSkipStep(): Promise<void>;
  onComplete(via: "wizard" | "first_scan"): Promise<string>;
  onRefresh(): Promise<unknown>;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [priceChanged, setPriceChanged] = useState<{ approvedMaxUsd: number; quote: any } | null>(null);
  const brandKey = state.workspace?.brandKey || "";
  const approved = state.questions?.approvedVersion != null;
  const quote = usePriceQuote({ brandKey, action: "ai_visibility.scan.run", input: { panelKey: "default" } }, { enabled: Boolean(brandKey && approved) });
  const audit = state.audit;
  const host = state.workspace?.websiteHost || "your website";

  async function finish(via: "wizard" | "first_scan") {
    const destination = await onComplete(via);
    window.location.assign(destination);
  }

  async function runScan(maxUsd: number) {
    if (!brandKey || !approved || !quote.data || quote.data.blocked) return;
    setPending(true);
    setError(null);
    try {
      await fetchJson("/api/customer/scan", {
        method: "POST",
        body: { brand_key: brandKey, maxUsd },
      });
      trackOnboardingEvent("onboarding:first_scan_started", {});
      await finish("first_scan");
    } catch (failure) {
      if (isApiError(failure) && failure.code === "scan_already_running") {
        await finish("first_scan");
        return;
      }
      if (isApiError(failure) && failure.code === "panel_not_approved") {
        await onRefresh();
      }
      if (isApiError(failure) && failure.code === "price_changed") {
        const nextQuote = failure.details?.quote;
        if (nextQuote && typeof nextQuote === "object") setPriceChanged({ approvedMaxUsd: maxUsd, quote: nextQuote });
      }
      setError(describeError(failure, "Could not start the scan. Please retry."));
    } finally {
      setPending(false);
    }
  }

  const research = state.research?.status || "none";
  const questionText = state.workspace?.hasScans
    ? "Your first scan is running."
    : research === "running"
      ? "Researching your website and competitors…"
      : research === "review"
        ? "Research is ready: review the proposed questions."
        : research === "failed"
          ? "Research couldn't finish. You can add questions yourself."
          : (state.handoff?.importedQuestions || state.prefill?.questionCount || state.questions?.paused || 0) > 0 && !approved
            ? `${state.handoff?.importedQuestions || state.prefill?.questionCount || state.questions?.paused} questions from your free scan are waiting for review.`
            : approved
              ? `Approved · version ${state.questions?.approvedVersion} · ${state.questions?.active || 0} questions`
              : "No questions yet.";
  const questionRowStatus = state.workspace?.hasScans || approved ? "done" : research === "running" ? "running" : research === "failed" ? "failed" : "todo";
  const auditStatus = audit?.status;
  const auditText = auditStatus === "running" || auditStatus === "queued"
    ? `Auditing ${host}: ${audit?.pagesCrawled ?? 0} of ${audit?.pagesTotal ?? 50} pages`
    : auditStatus === "completed" || auditStatus === "partial"
      ? "Audit finished. Open it from Site Audit."
      : auditStatus === "failed"
        ? "The audit couldn't finish."
        : null;
  const isBlocked = Boolean(quote.data?.blocked);

  return (
    <>
      <div className="space-y-6">
        <div className="space-y-2"><h1 className="text-2xl font-semibold tracking-tight">Review your questions and run your first scan</h1><p className="text-sm text-muted-foreground">Your first scan asks AI assistants the questions your buyers ask and shows which brands they name. You approve the questions and the price first.</p></div>
        <ul aria-live="polite" className="divide-y rounded-lg border px-4">
          <StatusRow status={questionRowStatus}>{questionText}</StatusRow>
          {auditText ? <StatusRow status={auditStatus === "running" || auditStatus === "queued" ? "running" : auditStatus === "failed" ? "failed" : "done"}>{auditText}</StatusRow> : null}
          <StatusRow status={approved && !isBlocked ? "done" : quote.isPending ? "running" : "todo"}>
            {approved ? quote.isPending && !quote.data ? <Skeleton className="h-4 w-24" /> : isBlocked ? quote.data?.blocked?.message : `Up to ${quote.data ? formatUsd(quote.data.totalUsd) : "…"}` : "Starts after you approve your questions."}
          </StatusRow>
        </ul>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Button variant="ghost" onClick={onBack}>Back</Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <Button variant="ghost" onClick={() => void finish("wizard")}>Finish</Button>
            <Button variant="ghost" onClick={() => void onSkipStep()}>Skip for now</Button>
            {!approved ? <Button onClick={() => void finish("wizard")}>Review questions</Button> : isBlocked ? null : <Button onClick={() => setDialogOpen(true)}>Run first scan</Button>}
          </div>
        </div>
      </div>
      <CostReviewDialog
        open={dialogOpen}
        title="Run your first scan"
        confirmLabel="Run first scan"
        pendingLabel="Starting…"
        quote={quote}
        pending={pending}
        priceChanged={priceChanged}
        error={error}
        onConfirm={(maxUsd) => void runScan(maxUsd)}
        onClose={() => setDialogOpen(false)}
      />
    </>
  );
}
