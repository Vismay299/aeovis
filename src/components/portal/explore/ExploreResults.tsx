"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-search/components/PromptExplorerResults.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Link from "next/link";
import { Check, X, Globe, AlertTriangle, AlertCircle, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { MarkdownAnswer } from "@/components/app/markdown/MarkdownAnswer";
import { ExpandableList } from "@/components/app/ExpandableList";
import { formatUsd } from "@/shared/pricing";
import {
  countryLabel,
  exploreModelLabel,
  type ExploreModel,
  type ExploreCitation,
} from "@/shared/explore";
import type {
  ExploreGetResponse,
  ExploreModelResult,
  ExploreSuccessResult,
  ExploreErrorResult,
} from "@/server/explore/explore.contract";
import { ENGINE_ACCENTS } from "./engineAccents";
import { TrackQuestionButton } from "./TrackQuestionButton";
import { cn } from "@/shared/utils";

type Props = {
  run: ExploreGetResponse;
  brandKey: string;
  defaultBrandName: string;
  onAskAgain?: () => void;
};

function formatAskedDate(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return isoDate;
  }
}

function formatShortDate(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    return d.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return isoDate;
  }
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function SuccessCard({
  result,
  brandName,
}: {
  result: ExploreSuccessResult;
  brandName: string;
}) {
  const accent = ENGINE_ACCENTS[result.model as ExploreModel] ?? {
    borderClass: "border-l-border",
    dotClass: "bg-muted-foreground",
    badgeClass: "bg-secondary text-secondary-foreground",
  };

  const isReused = Boolean(result.reusedFrom);
  const providerLabel =
    result.route === "dataforseo" ? "DataForSEO" : "OpenRouter";

  return (
    <article
      className={cn(
        "rounded-xl border border-border bg-card p-5 shadow-sm border-l-4 space-y-4",
        accent.borderClass,
      )}
    >
      {/* Header row */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("size-2.5 rounded-full shrink-0", accent.dotClass)} />
          <h3 className="font-semibold text-base tracking-tight">
            {result.label || exploreModelLabel(result.model as ExploreModel)}
          </h3>
          {result.modelName ? (
            <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
              {result.modelName}
            </code>
          ) : null}

          {/* Reused badge */}
          {isReused && result.reusedFrom?.observedAt ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex cursor-help" />}>
                <Badge variant="secondary">
                  Reused
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                Reused answer from {formatShortDate(result.reusedFrom.observedAt)}. Ask again to get a new one.
              </TooltipContent>
            </Tooltip>
          ) : null}

          {/* Brand badge */}
          {result.brandMentioned ? (
            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 gap-1">
              <Check className="size-3" />
              <span>{brandName}</span>
            </Badge>
          ) : (
            <Badge variant="secondary" className="gap-1 text-muted-foreground">
              <X className="size-3" />
              <span>no {brandName}</span>
            </Badge>
          )}

          {/* Search indicator */}
          {result.webSearch === true ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Globe className="size-3.5" />
              <span>web search</span>
            </span>
          ) : result.webSearch === false ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Globe className="size-3.5 opacity-50" />
              <span>no web search</span>
            </span>
          ) : null}
        </div>

        {/* Right side: tokens and cost */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
          {result.outputTokens !== null ? (
            <span className="tabular-nums font-mono">
              {result.outputTokens} tokens
            </span>
          ) : null}
          <span className="font-medium text-foreground">
            {result.costState === "unknown"
              ? "Cost unknown"
              : formatUsd(result.costUsd ?? 0)}
          </span>
        </div>
      </header>

      {/* Body */}
      <div className="space-y-4">
        {/* Country hint line */}
        <div className="text-xs text-muted-foreground">
          {result.countryHint ? (
            <span>
              Country hint sent: {countryLabel(result.countryHint)}. This is not a verified search location.
            </span>
          ) : (
            <span>
              No country hint sent. Any search uses the provider’s default location.
            </span>
          )}
        </div>

        {/* Markdown Answer */}
        <div className="pt-1">
          <MarkdownAnswer text={result.text} collapse={true} />
          {result.truncated ? (
            <p className="text-xs text-muted-foreground italic mt-2">
              This answer was shortened for display.
            </p>
          ) : null}
        </div>

        {/* Cited sources */}
        {result.citations && result.citations.length > 0 ? (
          <div className="space-y-2 pt-2 border-t border-border/40">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Cited sources ({result.citations.length})
            </h4>
            <ExpandableList
              items={result.citations}
              className="space-y-1.5 text-sm"
              renderItem={(citation: ExploreCitation, index: number) => {
                const label = citation.title || citation.domain || citation.url;
                const safe = isSafeUrl(citation.url);

                return (
                  <li key={`${citation.url}-${index}`} className="flex items-center gap-2">
                    {safe ? (
                      <a
                        href={citation.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline truncate max-w-lg text-sm inline-flex items-center gap-1"
                      >
                        <span className="truncate">{label}</span>
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <span className="truncate max-w-lg text-sm text-foreground">
                        {label}
                      </span>
                    )}
                    {citation.matchedBrand ? (
                      <Badge variant="outline" className="border-emerald-500/30 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 text-[10px] px-1.5 py-0">
                        {brandName}
                      </Badge>
                    ) : null}
                  </li>
                );
              }}
            />
          </div>
        ) : null}

        {/* Fan-out queries */}
        <div className="space-y-2 pt-2 border-t border-border/40">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Related queries the model considered
          </h4>
          {result.fanOutReported ? (
            result.fanOutQueries && result.fanOutQueries.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {result.fanOutQueries.map((query: string, index: number) => (
                  <Badge key={index} variant="outline" className="font-normal text-xs">
                    {query}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                None reported.
              </p>
            )
          ) : (
            <p className="text-xs text-muted-foreground italic">
              This provider does not report the searches the model ran.
            </p>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="pt-3 border-t border-border/40 text-xs text-muted-foreground">
        Answered by {result.label || exploreModelLabel(result.model)} through {providerLabel} (model API)
      </footer>
    </article>
  );
}

function ErrorCard({ result }: { result: ExploreErrorResult }) {
  const accent = ENGINE_ACCENTS[result.model as ExploreModel] ?? {
    borderClass: "border-l-destructive",
    dotClass: "bg-destructive",
    badgeClass: "bg-destructive text-destructive-foreground",
  };

  const isSkipped = result.errorCode === "UNSUPPORTED_COUNTRY" || result.errorCode === "NOT_AVAILABLE";
  const badgeVariant = isSkipped ? "secondary" : "destructive";
  const badgeText = isSkipped ? "Skipped" : "Error";

  return (
    <article
      className={cn(
        "rounded-xl border border-border bg-card p-5 shadow-sm border-l-4 space-y-4",
        isSkipped ? "border-l-muted-foreground/40" : accent.borderClass,
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "size-2.5 rounded-full shrink-0",
              isSkipped ? "bg-muted-foreground" : accent.dotClass,
            )}
          />
          <h3 className="font-semibold text-base tracking-tight">
            {result.label || exploreModelLabel(result.model as ExploreModel)}
          </h3>
          <Badge variant={badgeVariant}>{badgeText}</Badge>
        </div>

        <div className="text-xs text-muted-foreground font-medium">
          {formatUsd(result.costUsd ?? 0)}
        </div>
      </header>

      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{result.message}</p>

        {result.errorCode === "UPSTREAM_ERROR" ? (
          <p className="text-xs text-muted-foreground">
            {result.costUsd > 0
              ? `You were charged ${formatUsd(result.costUsd)} for this attempt.`
              : "You were not charged for this model."}
          </p>
        ) : null}
      </div>
    </article>
  );
}

export function ExploreResults({
  run,
  brandKey,
  defaultBrandName,
  onAskAgain,
}: Props) {
  const brandName = run.highlightBrand || defaultBrandName;
  const isFailed = run.status === "failed";
  const isPartial = run.status === "partial";

  const totalModels = run.results.length;
  const failedCount = run.results.filter((r: ExploreModelResult) => r.status === "error").length;

  const costKnown = run.cost.knownUsd ?? 0;
  const hasUnknownCost = run.cost.unknownModels > 0;
  const costLabel = `${formatUsd(costKnown)}${hasUnknownCost ? " + unknown" : ""}`;

  const countryDisplay = run.country ? countryLabel(run.country) : "none";

  return (
    <div className="space-y-6">
      {/* Partial Alert */}
      {isPartial ? (
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertTitle>
            {failedCount} of {totalModels} models could not answer.
          </AlertTitle>
        </Alert>
      ) : null}

      {/* Failed Run Alert */}
      {isFailed ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>None of the models could answer this question.</AlertTitle>
          {onAskAgain ? (
            <AlertDescription className="mt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onAskAgain}
                className="gap-1.5"
              >
                <RotateCcw className="size-3.5" />
                <span>Ask again</span>
              </Button>
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}

      {/* Results Header */}
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="space-y-2 flex-1 min-w-0">
            <h2 className="text-lg font-semibold tracking-tight whitespace-pre-wrap">
              {run.prompt}
            </h2>
            <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>Asked {formatAskedDate(run.createdAt)}</span>
              <span>·</span>
              <span>Web search {run.webSearch ? "on" : "off"}</span>
              <span>·</span>
              <span>Country hint: {countryDisplay}</span>
              <span>·</span>
              <span>Cost {costLabel}</span>
            </div>
          </div>

          <div className="shrink-0">
            <TrackQuestionButton
              runId={run.runId}
              questionId={run.questionId}
              brandKey={brandKey}
            />
          </div>
        </div>
      </div>

      {/* Model Cards in selection order */}
      <div className="grid gap-5">
        {run.results.map((result: ExploreModelResult, index: number) => {
          if (result.status === "success") {
            return (
              <SuccessCard
                key={`${result.model}-${index}`}
                result={result}
                brandName={brandName}
              />
            );
          }
          return (
            <ErrorCard
              key={`${result.model}-${index}`}
              result={result as ExploreErrorResult}
            />
          );
        })}
      </div>
    </div>
  );
}
