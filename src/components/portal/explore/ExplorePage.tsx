"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-search/PromptExplorerPage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useState, useEffect, useMemo, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { AlertCircle, Plus, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/app/PageHeader";
import { EmptyState } from "@/components/app/EmptyState";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { usePortal } from "@/components/portal/PortalShell";
import { useQuery } from "@tanstack/react-query";
import { panelQueryOptions } from "@/lib/query/portalQueries";
import { formatUsd } from "@/shared/pricing";
import type { PriceQuote } from "@/shared/pricing";
import type { ExploreModel } from "@/shared/explore";
import {
  useExploreRun,
  useStartExploreRun,
  type StartExploreInput,
} from "./hooks/useExplore";
import { ExploreForm } from "./ExploreForm";
import { ExploreResults } from "./ExploreResults";
import { ExploreLoadingState } from "./ExploreLoadingState";
import { RecentQuestions } from "./RecentQuestions";

export function ExplorePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { brandKey, brand, features } = usePortal();

  // Workspace panel country
  const panelQuery = useQuery(panelQueryOptions(brandKey));
  const defaultCountry = useMemo(() => {
    const items = panelQuery.data?.items ?? [];
    const itemWithContext = items.find(
      (i: any) => i.payload?.context?.country || i.payload?.country,
    );
    const country =
      (itemWithContext as any)?.payload?.context?.country ||
      (itemWithContext as any)?.payload?.country;
    if (typeof country === "string" && country.trim().length > 0) {
      return country.trim().toUpperCase();
    }
    return null;
  }, [panelQuery.data]);

  const runIdFromUrl = searchParams.get("run") || null;

  // Active run query
  const runQuery = useExploreRun(brandKey, runIdFromUrl);

  // Start run mutation
  const startMutation = useStartExploreRun(brandKey);

  // Form submission state
  const [pendingValues, setPendingValues] = useState<{
    prompt: string;
    models: ExploreModel[];
    webSearch: boolean;
    country: string | null;
    highlightBrand: string | null;
    fresh?: boolean;
  } | null>(null);

  // Dialog & Price state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [priceChanged, setPriceChanged] = useState<{
    approvedMaxUsd: number;
    quote: PriceQuote;
  } | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // 429 rate limit state
  const [rateLimitMessage, setRateLimitMessage] = useState<string | null>(null);
  const [rateLimitExpiresAt, setRateLimitExpiresAt] = useState<number | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(0);

  // Rate limit countdown effect
  useEffect(() => {
    if (!rateLimitExpiresAt) {
      setSecondsRemaining(0);
      return;
    }
    const updateCountdown = () => {
      const now = Date.now();
      const diff = Math.max(0, Math.ceil((rateLimitExpiresAt - now) / 1000));
      setSecondsRemaining(diff);
      if (diff <= 0) {
        setRateLimitExpiresAt(null);
        setRateLimitMessage(null);
      }
    };
    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [rateLimitExpiresAt]);

  const formatCountdown = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `Try again in ${m}:${s.toString().padStart(2, "0")}`;
  };

  // Quote input
  const quoteInput = useMemo(() => {
    if (!pendingValues) return null;
    return {
      prompt: pendingValues.prompt,
      models: pendingValues.models,
      webSearch: pendingValues.webSearch,
      country: pendingValues.country,
      fresh: pendingValues.fresh ?? false,
    };
  }, [pendingValues]);

  // Price quote hook
  const quoteQuery = usePriceQuote(
    {
      brandKey,
      action: "ai_visibility.explore.run",
      input: quoteInput ?? {},
    },
    { enabled: Boolean(brandKey && quoteInput && dialogOpen) },
  );

  // Start run execution
  const executeStart = useCallback(
    (maxUsd?: number) => {
      if (!pendingValues) return;

      const body: StartExploreInput = {
        prompt: pendingValues.prompt,
        models: pendingValues.models,
        webSearch: pendingValues.webSearch,
        country: pendingValues.country,
        highlightBrand: pendingValues.highlightBrand,
        fresh: pendingValues.fresh ?? false,
        maxUsd,
      };

      void (async () => {
        let res: Awaited<ReturnType<typeof startMutation.mutateAsync>>;
        try {
          res = await startMutation.mutateAsync(body);
        } catch (err: any) {
          if (err?.status === 409 && err?.code === "price_changed" && err?.details) {
            setPriceChanged({
              approvedMaxUsd: err.details.approvedMaxUsd,
              quote: err.details.quote,
            });
            return;
          }
          if (err?.status === 429) {
            setDialogOpen(false);
            const retryAfter = err?.details?.retryAfterSeconds ?? 60;
            setRateLimitExpiresAt(Date.now() + retryAfter * 1000);
            setRateLimitMessage(
              err?.message ||
                "You have asked a lot of questions recently. Try again later.",
            );
            return;
          }
          setDialogError(err?.message || "Could not start question run.");
          return;
        }
        setDialogOpen(false);
        setPriceChanged(null);
        setDialogError(null);
        setPendingValues(null);
        router.replace(`/portal/explore?run=${encodeURIComponent(res.runId)}`);
      })();
    },
    [pendingValues, startMutation, router],
  );

  // Form submit handler
  const handleFormSubmit = useCallback(
    (values: {
      prompt: string;
      models: ExploreModel[];
      webSearch: boolean;
      country: string | null;
      highlightBrand: string | null;
    }) => {
      setRateLimitMessage(null);
      setPendingValues({ ...values, fresh: false });
      setPriceChanged(null);
      setDialogError(null);
      setDialogOpen(true);
    },
    [],
  );

  // Ask again handler
  const handleAskAgain = useCallback(() => {
    if (!runQuery.data) return;
    const run = runQuery.data;
    setRateLimitMessage(null);
    setPendingValues({
      prompt: run.prompt,
      models: run.results.map((r: any) => r.model),
      webSearch: run.webSearch,
      country: run.country,
      highlightBrand: run.highlightBrand,
      fresh: true,
    });
    setPriceChanged(null);
    setDialogError(null);
    setDialogOpen(true);
  }, [runQuery.data]);

  // When quote lands: if totalUsd is 0 (all reused), no dialog opens and run starts immediately
  useEffect(() => {
    if (!dialogOpen || !quoteQuery.data) return;
    if (quoteQuery.data.totalUsd === 0 && !priceChanged && !startMutation.isPending) {
      setDialogOpen(false);
      executeStart(0);
    }
  }, [dialogOpen, quoteQuery.data, priceChanged, startMutation.isPending, executeStart]);

  // "New question" action
  const handleNewQuestion = () => {
    router.replace("/portal/explore");
    setPendingValues(null);
    setDialogOpen(false);
  };

  // Feature disabled state
  if (features && !features.prompt_explorer) {
    return (
      <div className="p-6">
        <EmptyState
          title="Prompt Explorer is not enabled for this workspace"
          description="Ask your Perceev contact to turn it on."
        />
      </div>
    );
  }

  const activeModelsCount = pendingValues?.models.length ?? 1;
  const isRunning =
    runQuery.data?.status === "queued" || runQuery.data?.status === "running";

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <PageHeader
        title="Prompt Explorer"
        description="Ask one question across ChatGPT, Gemini and Perplexity and compare their answers, sources and searches."
        actions={
          runIdFromUrl ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleNewQuestion}
              className="gap-1.5"
            >
              <Plus className="size-4" />
              <span>New question</span>
            </Button>
          ) : null
        }
      />

      {/* 429 Rate limited alert */}
      {rateLimitMessage ? (
        <Alert variant="warning">
          <AlertCircle className="size-4" />
          <AlertTitle>Rate limited</AlertTitle>
          <AlertDescription>
            {rateLimitMessage} {secondsRemaining > 0 ? `(${formatCountdown(secondsRemaining)})` : ""}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Run load error */}
      {runIdFromUrl && runQuery.isError && !runQuery.data ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Could not load this question.</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-4 mt-2">
            <span>Failed to fetch question details. Please retry.</span>
            <Button variant="outline" size="sm" onClick={() => runQuery.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Form (only when not viewing active results or if prefilled) */}
      {!runIdFromUrl && (
        <ExploreForm
          defaultWorkspaceName={brand?.display_name || ""}
          defaultCountry={defaultCountry}
          onSubmit={handleFormSubmit}
          disabled={startMutation.isPending || secondsRemaining > 0}
          submitDisabled={secondsRemaining > 0}
        />
      )}

      {/* Results or Loading or Recent questions */}
      {runIdFromUrl && runQuery.data ? (
        isRunning ? (
          <ExploreLoadingState
            models={runQuery.data.results.map((r: any) => r.model)}
          />
        ) : (
          <ExploreResults
            run={runQuery.data}
            brandKey={brandKey}
            defaultBrandName={brand?.display_name || ""}
            onAskAgain={handleAskAgain}
          />
        )
      ) : runIdFromUrl && runQuery.isLoading ? (
        <ExploreLoadingState models={["chatgpt", "gemini", "perplexity"]} />
      ) : (
        <RecentQuestions
          brandKey={brandKey}
          onSelectRun={(id) => router.replace(`/portal/explore?run=${encodeURIComponent(id)}`)}
        />
      )}

      {/* Cost Review Dialog */}
      <CostReviewDialog
        open={dialogOpen}
        title={`Ask ${activeModelsCount} ${activeModelsCount === 1 ? "model" : "models"}`}
        confirmLabel="Ask now"
        pendingLabel="Asking…"
        quote={quoteQuery}
        pending={startMutation.isPending}
        priceChanged={priceChanged}
        error={dialogError}
        onConfirm={(maxUsd) => executeStart(maxUsd)}
        onClose={() => {
          if (!startMutation.isPending) {
            setDialogOpen(false);
            setPriceChanged(null);
            setDialogError(null);
          }
        }}
        detail={(q) => (
          <div className="space-y-1.5 pt-2 border-t border-border/40">
            <div className="text-xs font-medium text-muted-foreground">Price breakdown</div>
            <ul className="space-y-1 text-xs">
              {q.lines.map((line, idx) => (
                <li key={idx} className="flex justify-between items-center text-muted-foreground">
                  <span>{line.label}</span>
                  <span className="font-mono">{formatUsd(line.totalUsd)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      />
    </div>
  );
}
