// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/TrackerPromptFields.tsx (row actions pattern)
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { QuestionHistoryLink } from "./history/QuestionHistoryLink";

export type QuestionRowQuestion = {
  id: string;
  text: string;
  topic: string;
  origin: string;
  status: "active" | "paused" | "archived";
  branded: boolean;
  createdAt: string;
};

export function QuestionRowActions({
  question,
  tab,
  onEdit,
  onPauseResume,
  onArchive,
  onRestore,
}: {
  question: any;
  tab: "active" | "paused" | "archived";
  onEdit?: (q: any) => void;
  onPauseResume?: (q: any) => void;
  onArchive?: (q: any) => void;
  onRestore?: (q: any) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <QuestionHistoryLink questionId={question.id} />
      {tab === "archived" ? (
        <Button variant="ghost" size="sm" onClick={() => onRestore?.(question)}>
          Restore
        </Button>
      ) : (
        <>
          <Button variant="ghost" size="sm" onClick={() => onEdit?.(question)}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onPauseResume?.(question)}>
            {question.status === "paused" ? "Resume" : "Pause"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onArchive?.(question)}>
            Archive
          </Button>
        </>
      )}
    </div>
  );
}

export function QuestionOriginBadge({ origin }: { origin: string }) {
  const label =
    origin === "manual"
      ? "Manual"
      : origin === "ai_setup"
        ? "From your website"
        : origin === "promptgen"
          ? "Search-grounded"
          : origin === "ai_generate"
            ? "Generated"
            : origin === "prompt_research"
              ? "From question research"
              : origin === "import"
                ? "Imported"
                : origin;
  return <Badge variant="outline">{label}</Badge>;
}
