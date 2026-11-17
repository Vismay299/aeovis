"use client";

import { Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

export type NoticeCode =
  | "step_limit"
  | "turn_cap"
  | "deadline"
  | "interrupted"
  | "compacted";

const NOTICE_FALLBACK: Record<NoticeCode, string> = {
  step_limit: "I stopped before finishing. Ask me to continue if you want me to go on.",
  turn_cap: "I stopped because this reply reached its spending limit. Ask me to continue if you want me to go on.",
  deadline: "I stopped because this reply was taking too long. Ask me to continue, or ask for a narrower piece.",
  interrupted:
    "That reply was cut off before it finished. Everything above is saved. Ask again for a narrower piece (fewer keywords, competitors or pages), or tell me where to pick up.",
  compacted:
    "Earlier messages were summarised so the assistant stays fast. They are still shown here.",
};

/**
 * A server-written `data-notice` part: the turn stopped for a reason the user
 * should know about (step or spend cap, deadline, interruption, compaction).
 * Always muted info, never an error.
 */
export function NoticePart({ code, text }: { code: string; text?: string }) {
  const body =
    typeof text === "string" && text.trim().length > 0
      ? text
      : (NOTICE_FALLBACK[code as NoticeCode] ?? code);
  return (
    <Alert variant="info">
      <Info aria-hidden />
      <AlertDescription>{body}</AlertDescription>
    </Alert>
  );
}
