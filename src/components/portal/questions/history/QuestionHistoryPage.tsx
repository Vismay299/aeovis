"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/PromptHistoryPage.tsx
//   src/client/features/ai-visibility/PromptAnalysis.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { BackLink, PageHeader } from "@/components/app/PageHeader";
import { EmptyState } from "@/components/app/EmptyState";
import { Alert, AlertAction, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePortal } from "@/components/portal/PortalShell";
import {
  HISTORY_RANGES,
  historyPeriod,
  periodToQuery,
  type HistoryPeriod,
  type HistoryRange,
} from "@/shared/question-history";
import { trackEvent } from "@/shared/telemetry/client";
import { isApiError } from "@/shared/query/fetchJson";
import { HistoryDateRange } from "./HistoryDateRange";
import { BrandComparison } from "./BrandComparison";
import { AnswerPanel } from "./AnswerPanel";
import { Executions } from "./Executions";
import { useQuestionHistory } from "./hooks/useQuestionHistory";

export function QuestionHistoryPage({ questionId }: { questionId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const { brandKey } = usePortal();

  // Read URL query parameters
  const rawRange = searchParams.get("range");
  const rawFrom = searchParams.get("from");
  const rawTo = searchParams.get("to");
  const urlEngine = searchParams.get("engine");
  const urlAnswer = searchParams.get("answer");
  const fromScan = searchParams.get("from_scan");

  // Resolve active period
  const period: HistoryPeriod = useMemo(() => {
    const preset = (
      HISTORY_RANGES.includes(rawRange as HistoryRange)
        ? rawRange
        : "last_28_days"
    ) as HistoryRange;

    if (preset === "custom") {
      return {
        preset: "custom",
        start: rawFrom || "",
        end: rawTo || "",
      };
    }
    if (preset === "all") {
      return { preset: "all", start: "", end: "" };
    }
    return historyPeriod(preset);
  }, [rawRange, rawFrom, rawTo]);

  // Map to ISO query parameters
  const queryBounds = useMemo(() => periodToQuery(period), [period]);
  const isPeriodValid = queryBounds !== null;

  // Query history
  const historyQuery = useQuestionHistory({
    brandKey,
    questionId,
    from: queryBounds?.from,
    to: queryBounds?.to,
    enabled: isPeriodValid,
  });

  const data = historyQuery.data ?? null;

  // Track telemetry on load
  useEffect(() => {
    if (data) {
      trackEvent("question_history:viewed", {
        executions: data.executions.length,
        range: period.preset,
      });
    }
  }, [data?.question?.id, data?.executions?.length, period.preset]);

  // Handle URL updates
  const updateUrl = (
    updater: (params: URLSearchParams) => void,
    mode: "push" | "replace" = "replace",
  ) => {
    const currentSearch = typeof window !== "undefined" ? window.location.search : searchParams.toString();
    const params = new URLSearchParams(currentSearch);
    updater(params);
    const newSearch = params.toString();
    const target = newSearch ? `${pathname}?${newSearch}` : pathname;
    if (mode === "push") {
      router.push(target);
    } else {
      router.replace(target);
    }
  };

  const handlePeriodChange = (nextPeriod: HistoryPeriod) => {
    updateUrl((params) => {
      params.set("range", nextPeriod.preset);
      if (nextPeriod.preset === "custom") {
        if (nextPeriod.start) params.set("from", nextPeriod.start);
        else params.delete("from");
        if (nextPeriod.end) params.set("to", nextPeriod.end);
        else params.delete("to");
      } else {
        params.delete("from");
        params.delete("to");
      }
    }, "replace");
  };

  const handleSelectAnswer = (answerId: string, engine?: string) => {
    updateUrl((params) => {
      params.set("answer", answerId);
      if (engine) params.set("engine", engine);
    }, "push");
  };

  // Back link
  const backLinkHref = fromScan
    ? `/portal/scans/${encodeURIComponent(fromScan)}`
    : "/portal/measurement";
  const backLinkLabel = fromScan ? "Back to scan report" : "All questions";

  // Check 404
  const isNotFound =
    !questionId ||
    (isApiError(historyQuery.error) && historyQuery.error.status === 404);

  if (isNotFound) {
    return (
      <div className="space-y-4">
        <PageHeader
          backLink={<BackLink href="/portal/measurement">All questions</BackLink>}
          title="Question not found"
        />
        <EmptyState
          kind="error"
          title="Question not found"
          description="This question does not exist, or it belongs to a workspace you cannot open."
          action={
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href="/portal/measurement" />}
            >
              All questions
            </Button>
          }
        />
      </div>
    );
  }

  // Initial loading state
  if (historyQuery.isPending && !data) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-96" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="space-y-4">
          <div className="h-40 rounded-xl border border-border bg-card p-4">
            <Skeleton className="h-full w-full" />
          </div>
          <div className="h-64 rounded-xl border border-border bg-card p-4">
            <Skeleton className="h-full w-full" />
          </div>
          <div className="h-48 rounded-xl border border-border bg-card p-4">
            <Skeleton className="h-full w-full" />
          </div>
        </div>
      </div>
    );
  }

  // Error without stale data
  if (historyQuery.isError && !data) {
    return (
      <div className="space-y-4">
        <PageHeader
          backLink={<BackLink href={backLinkHref}>{backLinkLabel}</BackLink>}
          title="Question history"
        />
        <Alert variant="destructive">
          <AlertTitle>Question history could not be loaded.</AlertTitle>
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              onClick={() => historyQuery.refetch()}
            >
              Retry
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );
  }

  if (!data) return null;

  const { question, executions, summary, coverage, truncated, latestScanId } = data;

  // Header status badge
  let statusBadgeVariant: "success" | "secondary" = "secondary";
  if (question.status === "active") statusBadgeVariant = "success";
  const statusLabel =
    question.status.charAt(0).toUpperCase() + question.status.slice(1);

  // Wording notices
  const hasReplaces = question.replaces && question.replaces.length > 0;
  const replacedBy = question.replacedBy;

  // Check overall empty vs filtered empty
  const hasAnyAnswersEver = coverage.total > 0;
  const hasAnswersInPeriod = executions.length > 0;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        backLink={<BackLink href={backLinkHref}>{backLinkLabel}</BackLink>}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="whitespace-pre-wrap" data-ph-mask>
              {question.text}
            </span>
            <Badge variant={statusBadgeVariant}>{statusLabel}</Badge>
            {question.branded && (
              <Tooltip>
                <TooltipTrigger delay={150} render={<span />}>
                  <Badge variant="outline">Branded</Badge>
                </TooltipTrigger>
                <TooltipContent>
                  Branded questions are diagnostics and are not counted in visibility.
                </TooltipContent>
              </Tooltip>
            )}
          </span>
        }
        description={
          question.topic
            ? `${question.topic} · Question history`
            : "Question history"
        }
        actions={
          latestScanId ? (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link href={`/portal/scans/${encodeURIComponent(latestScanId)}`} />}
            >
              View latest scan
            </Button>
          ) : null
        }
      />

      {/* Wording Notices */}
      {hasReplaces && (
        <Alert variant="info">
          <AlertTitle>
            This question replaced an earlier wording: “{question.replaces[0].text}”.{" "}
            <Link
              href={`/portal/questions/${encodeURIComponent(question.replaces[0].id)}`}
              className="font-medium underline hover:text-foreground"
            >
              View its history
            </Link>
          </AlertTitle>
        </Alert>
      )}

      {replacedBy && (
        <Alert variant="info">
          <AlertTitle>
            A newer wording replaced this question: “{replacedBy.text}”.{" "}
            <Link
              href={`/portal/questions/${encodeURIComponent(replacedBy.id)}`}
              className="font-medium underline hover:text-foreground"
            >
              View its history
            </Link>
          </AlertTitle>
        </Alert>
      )}

      {/* Body: Date range control */}
      <HistoryDateRange value={period} onChange={handlePeriodChange} />

      {/* Content depending on empty states */}
      {!hasAnyAnswersEver ? (
        <EmptyState
          title="No answers yet"
          description="This question is asked in your next scan after it is in an approved panel."
          action={
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href="/portal/measurement" />}
            >
              Go to Questions
            </Button>
          }
        />
      ) : !hasAnswersInPeriod ? (
        <EmptyState
          title="No answers in this period"
          description="Choose another date range to see this question’s answers."
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => handlePeriodChange(historyPeriod("all"))}
            >
              Show all available history
            </Button>
          }
        />
      ) : (
        <>
          {/* Brand Comparison */}
          <BrandComparison summary={summary} />

          {/* Answer Section */}
          <AnswerPanel
            brandKey={brandKey}
            questionId={question.id}
            currentQuestionText={question.text}
            executions={executions}
            selectedAnswerId={urlAnswer}
            selectedEngine={urlEngine}
            onSelectAnswer={handleSelectAnswer}
          />

          {/* Executions */}
          <Executions
            executions={executions}
            selectedAnswerId={urlAnswer}
            onSelect={handleSelectAnswer}
          />

          {/* Footnotes */}
          {truncated && (
            <p className="text-xs text-muted-foreground">
              History shows the latest 500 answers. Older answers are not included in this period’s numbers.
            </p>
          )}
        </>
      )}
    </div>
  );
}
