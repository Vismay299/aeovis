"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/PromptAnswers.tsx
//   src/client/features/ai-visibility/PromptAnalysis.tsx:124-198
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import React, { useEffect } from "react";
import { Alert, AlertAction, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { engineLabel } from "@/components/portal/scans/reportData";
import { trackEvent } from "@/lib/telemetry/client";
import { AnswerEvidence } from "./AnswerEvidence";
import {
  useQuestionAnswer,
  type ExecutionItem,
} from "./hooks/useQuestionHistory";

export function AnswerPanel({
  brandKey,
  questionId,
  currentQuestionText,
  executions,
  selectedAnswerId,
  selectedEngine,
  onSelectAnswer,
}: {
  brandKey: string;
  questionId: string;
  currentQuestionText: string;
  executions: ExecutionItem[];
  selectedAnswerId: string | null;
  selectedEngine?: string | null;
  onSelectAnswer: (answerId: string, engine?: string) => void;
}) {
  // Determine selected execution
  const selectedExecution =
    executions.find((e) => e.answerId === selectedAnswerId) ||
    executions.find((e) => e.status === "answered") ||
    executions[0] ||
    null;

  const currentEngine = selectedEngine || selectedExecution?.engine || executions[0]?.engine || "";

  // Query the answer detail
  const answerQuery = useQuestionAnswer({
    brandKey,
    questionId,
    answerId: selectedExecution?.answerId,
    enabled: Boolean(selectedExecution?.answerId),
  });

  // Track telemetry on answer open
  useEffect(() => {
    if (!selectedExecution) return;
    const engine = selectedExecution.engine;
    if (engine === "chatgpt" || engine === "gemini" || engine === "perplexity" || engine === "aio") {
      trackEvent("question_history:answer_opened", {
        engine,
        source: selectedExecution.source,
      });
    }
  }, [selectedExecution?.answerId, selectedExecution?.engine, selectedExecution?.source]);

  // Available engine options from executions in range
  const availableEngines = Array.from(new Set(executions.map((e) => e.engine)));

  // Available executions for current engine
  const engineExecutions = executions.filter((e) => e.engine === currentEngine);

  // Status label for answer date dropdown
  const statusLabel = (item: ExecutionItem): string => {
    let suffix = "";
    if (item.status === "no_answer") suffix = " · No answer";
    else if (item.status === "failed") suffix = " · Failed";
    else if (item.status === "blocked") suffix = " · Blocked";
    else if (item.status === "unknown") suffix = " · Unknown";

    if (item.source === "explore") suffix += " · Explorer";
    return suffix;
  };

  const handleEngineChange = (nextEngine: string | null) => {
    if (!nextEngine) return;
    const forEngine = executions.filter((e) => e.engine === nextEngine);
    if (!forEngine.length) return;

    // upstream rule: keep same scan when that engine answered it, else newest answered, else newest
    const sameScan = forEngine.find(
      (e) => Boolean(e.scanId && selectedExecution?.scanId && e.scanId === selectedExecution.scanId),
    );
    const answered = forEngine.find((e) => e.status === "answered");
    const chosen = sameScan || answered || forEngine[0];
    if (chosen) {
      onSelectAnswer(chosen.answerId, nextEngine);
    }
  };

  return (
    <section
      aria-label="Answer"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold">Answer</h2>

        <div className="flex flex-wrap items-center gap-2">
          {/* Engine Select */}
          {availableEngines.length > 0 && (
            <Select
              value={currentEngine}
              onValueChange={handleEngineChange}
            >
              <SelectTrigger size="sm" aria-label="Engine" className="w-auto">
                <SelectValue placeholder="Engine" />
              </SelectTrigger>
              <SelectContent>
                {availableEngines.map((engine) => (
                  <SelectItem key={engine} value={engine}>
                    {engineLabel(engine)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Date Select */}
          {engineExecutions.length > 0 && (
            <Select
              value={selectedExecution?.answerId || ""}
              onValueChange={(val) => {
                if (val) onSelectAnswer(val, currentEngine);
              }}
            >
              <SelectTrigger size="sm" aria-label="Answer date" className="w-auto">
                <SelectValue placeholder="Answer date" />
              </SelectTrigger>
              <SelectContent>
                {engineExecutions.map((item) => (
                  <SelectItem key={item.answerId} value={item.answerId}>
                    {new Date(item.collectedAt).toLocaleString()}
                    {statusLabel(item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* Body */}
      {engineExecutions.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          No answers from {engineLabel(currentEngine)} in this period.
        </div>
      ) : answerQuery.isPending ? (
        <div className="space-y-3 p-6" aria-busy="true">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      ) : answerQuery.isError ? (
        <div className="p-6">
          <Alert variant="destructive">
            <AlertTitle>This answer could not be loaded.</AlertTitle>
            <AlertAction>
              <Button
                size="sm"
                variant="outline"
                onClick={() => answerQuery.refetch()}
              >
                Retry
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ) : answerQuery.data ? (
        <AnswerEvidence
          answer={answerQuery.data}
          askedText={selectedExecution?.askedText}
          currentQuestionText={currentQuestionText}
        />
      ) : null}
    </section>
  );
}
