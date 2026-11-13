// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   (question history link affordance; spec F12 §6.6)
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import * as React from "react";
import Link from "next/link";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QUESTION_HISTORY_AVAILABLE } from "./historyAvailability";

export function QuestionHistoryLink({
  questionId,
  fromScan,
}: {
  questionId: string;
  fromScan?: string | null;
}) {
  if (!QUESTION_HISTORY_AVAILABLE) return null;
  const href = fromScan
    ? `/portal/questions/${encodeURIComponent(questionId)}?from_scan=${encodeURIComponent(fromScan)}`
    : `/portal/questions/${encodeURIComponent(questionId)}`;
  return (
    <Button
      variant="ghost"
      size="sm"
      nativeButton={false}
      render={<Link href={href} />}
      aria-label="Question history"
    >
      <History className="size-4" aria-hidden="true" />
      History
    </Button>
  );
}
