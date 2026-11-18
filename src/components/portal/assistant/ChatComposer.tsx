// Portions copied from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/sam/ChatComposer.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";

export function ChatComposer({
  busy,
  onSend,
  onStop,
  value: controlledValue,
  onChange,
}: {
  busy: boolean;
  onSend: (text: string) => void;
  /** Cancels the running turn; while busy the send button becomes Stop. */
  onStop: () => void;
  /** When provided, the composer is controlled (so a failed send keeps its text). */
  value?: string;
  onChange?: (value: string) => void;
}) {
  const [uncontrolled, setUncontrolled] = useState("");
  const value = controlledValue ?? uncontrolled;
  const setValue = onChange ?? setUncontrolled;

  function submit() {
    const text = value.trim();
    if (!text || busy) return;
    onSend(text);
    setValue("");
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    submit();
  }

  function handleKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {/* InputGroup dims itself when it holds a disabled control. The empty
          composer disables only Send, so keep the field at full strength. */}
      <InputGroup className="items-end rounded-xl bg-card has-disabled:bg-card has-disabled:opacity-100 dark:has-disabled:bg-input/30">
        <InputGroupTextarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKey}
          rows={1}
          maxLength={8000}
          placeholder="Ask about your AI visibility, keywords or site…"
          className="max-h-40 min-h-0 px-3 leading-relaxed"
          aria-label="Message the assistant"
        />
        <InputGroupAddon align="inline-end">
          {busy ? (
            <InputGroupButton
              variant="secondary"
              size="icon-sm"
              className="rounded-full"
              aria-label="Stop"
              onClick={onStop}
            >
              <Square className="size-3.5 fill-current" />
            </InputGroupButton>
          ) : (
            <InputGroupButton
              type="submit"
              variant="default"
              size="icon-sm"
              className="rounded-full"
              aria-label="Send message"
              disabled={!value.trim()}
            >
              <ArrowUp />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
      {value.length > 7000 ? (
        <p className="mt-1 text-right text-xs text-muted-foreground tabular-nums">
          {value.length.toLocaleString("en-US")} / 8,000
        </p>
      ) : null}
    </form>
  );
}
