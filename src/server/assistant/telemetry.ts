export const ASSISTANT_EVENTS = [
  "assistant:session_create",
  "assistant:session_archive",
  "assistant:turn",
  "assistant:tool_call",
  "assistant:approval",
  "assistant:skill_activate",
  "assistant:message_send",
  "assistant:rewind",
  "assistant:stop",
  "assistant:client_error",
] as const;

export type AssistantEvent = (typeof ASSISTANT_EVENTS)[number];

export type AssistantEventProps = Record<string, string | number | boolean | null>;

export type AssistantEventTracker = (event: AssistantEvent, props: AssistantEventProps) => void;

// §6.7: names, codes, counts, durations and USD only. Every event's allow-list
// is exhaustive; an unlisted key rejects the whole event rather than being
// silently dropped, so a caller that tries to log text fails its own test.
const ALLOWED: Record<AssistantEvent, ReadonlySet<string>> = {
  "assistant:session_create": new Set(),
  "assistant:session_archive": new Set(),
  "assistant:turn": new Set([
    "status",
    "stop_reason",
    "steps",
    "tool_calls",
    "cost_usd",
    "cost_known",
    "model",
    "compacted",
    "error_code",
  ]),
  "assistant:tool_call": new Set([
    "tool",
    "effect",
    "success",
    "error_code",
    "duration_ms",
    "awaiting_approval",
  ]),
  "assistant:approval": new Set([
    "tool",
    "kind",
    "decision",
    "quoted_usd",
    "approved_max_usd",
    "outcome",
    "error_code",
  ]),
  "assistant:skill_activate": new Set(["skill", "version"]),
  "assistant:message_send": new Set(["source", "chars"]),
  "assistant:rewind": new Set(["kind"]),
  "assistant:stop": new Set(),
  "assistant:client_error": new Set(["kind"]),
};

const MAX_STRING = 200;

let tracker: AssistantEventTracker | null = null;

/** F26 §6.2.7 wires the real sink; until then this stays a no-op. */
export function setAssistantEventTracker(fn: AssistantEventTracker | null): void {
  tracker = fn;
}

export function assistantEventAllowed(event: string): event is AssistantEvent {
  return Object.prototype.hasOwnProperty.call(ALLOWED, event);
}

/**
 * Returns false when the event or a prop is not allowed. Nothing is emitted in
 * that case: a half-filtered event would look valid while carrying a field the
 * registry never approved.
 */
export function trackAssistantEvent(event: string, props: AssistantEventProps = {}): boolean {
  if (!assistantEventAllowed(event)) return false;
  const allowed = ALLOWED[event];
  for (const [key, value] of Object.entries(props)) {
    if (!allowed.has(key)) return false;
    if (value === null) continue;
    if (typeof value === "string") {
      if (value.length > MAX_STRING) return false;
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value === "boolean") continue;
    return false;
  }
  tracker?.(event, { ...props });
  return true;
}
