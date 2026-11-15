"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/PromptExecutions.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { engineLabel } from "@/components/portal/scans/reportData";
import { MentionBadge } from "./MentionBadge";
import type { ExecutionItem } from "./hooks/useQuestionHistory";

export function Executions({
  executions,
  selectedAnswerId,
  onSelect,
}: {
  executions: ExecutionItem[];
  selectedAnswerId: string | null;
  onSelect: (answerId: string, engine?: string) => void;
}) {
  return (
    <section
      aria-label="Executions"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Executions</h2>
        <span className="text-xs text-muted-foreground">
          {executions.length} in this period
        </span>
      </div>

      <div
        className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px_140px] gap-3 border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground sm:grid"
        aria-hidden="true"
      >
        <span>Date</span>
        <span>Engine</span>
        <span>Brand mentioned</span>
        <span>Owned citation</span>
      </div>

      <ul
        className="max-h-64 overflow-y-auto sm:max-h-44"
        aria-label="Select an execution"
      >
        {executions.map((item) => {
          const isSelected = selectedAnswerId === item.answerId;
          const isAnswered = item.status === "answered";

          // Trigger badge
          let triggerTag = "";
          if (item.trigger === "scheduled") triggerTag = "Scheduled";
          else if (item.trigger === "explore" || item.source === "explore") triggerTag = "Explorer";
          else if (item.trigger === "legacy") triggerTag = "Legacy";

          // Unanswered status label
          let unearnedLabel = "Result unknown";
          let unearnedVariant: "destructive" | "secondary" = "secondary";
          if (item.status === "no_answer") {
            const isAio = item.engine === "aio" || item.engine === "google_ai_overview";
            unearnedLabel = isAio ? "No AI Overview shown" : "No substantive answer";
          } else if (item.status === "failed") {
            unearnedLabel = "Collection failed";
            unearnedVariant = "destructive";
          } else if (item.status === "blocked") {
            unearnedLabel = "Not attempted";
          }

          return (
            <li
              key={item.answerId}
              className="border-b border-border last:border-0"
            >
              <Button
                variant="ghost"
                aria-pressed={isSelected}
                onClick={() => onSelect(item.answerId, item.engine)}
                className="grid h-auto w-full grid-cols-2 justify-items-start gap-x-3 gap-y-2 rounded-none px-4 py-2.5 text-left font-normal aria-pressed:bg-primary/10 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px_140px]"
              >
                {/* Date + Tag */}
                <span className="whitespace-normal text-xs text-muted-foreground">
                  {new Date(item.collectedAt).toLocaleString()}
                  {triggerTag && (
                    <span className="ml-2 hidden rounded bg-muted px-1 py-0.5 text-[0.625rem] text-muted-foreground lg:inline">
                      {triggerTag}
                    </span>
                  )}
                </span>

                {/* Engine */}
                <span className="text-xs font-medium text-foreground">
                  {item.engineLabel || engineLabel(item.engine)}
                </span>

                {/* Answered columns or Status badge */}
                {isAnswered ? (
                  <>
                    <MentionBadge value={item.ownMentioned} size="sm" />
                    <MentionBadge
                      value={item.ownCited}
                      positive="Cited"
                      negative="Not cited"
                      size="sm"
                    />
                  </>
                ) : (
                  <Badge variant={unearnedVariant} className="col-span-2" size="sm">
                    {unearnedLabel}
                  </Badge>
                )}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
