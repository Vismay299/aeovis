// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/chat/ChatMessage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UIMessage } from "ai";
import { Pencil, Undo2 } from "lucide-react";
import { CopyButton } from "@/components/app/CopyButton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatUsd } from "@/shared/pricing";
import { ToolResultCard, toToolPartView } from "./ToolResultCard.tsx";
import { NoticePart } from "./NoticePart.tsx";
import { ASSISTANT_MARKDOWN_COMPONENTS } from "./assistantMarkdown.tsx";

export type AssistantMessage = UIMessage;

type MessageMetadata = {
  kind?: string;
  source?: string;
  approvalId?: string;
  turnId?: string;
  costUsd?: number | null;
  costKnown?: boolean;
};

function metadataOf(message: AssistantMessage): MessageMetadata {
  const metadata = message.metadata;
  return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as MessageMetadata)
    : {};
}

type TextPart = { type: "text"; text: string };

// Plain text of a message for the clipboard: its visible text parts only (no
// tool payloads, no notices).
function messageText(message: AssistantMessage): string {
  return message.parts
    .filter((part): part is TextPart & { type: "text" } => part.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

// Whether an assistant message already shows something streamable — visible
// text or a tool card. Used to decide when the standalone typing indicator is
// still needed: a running tool card already reads as progress, so the dots
// would double up. Reasoning is hidden, so it never counts.
export function assistantHasVisibleContent(message: AssistantMessage): boolean {
  return message.parts.some(
    (part) =>
      (part.type === "text" && typeof (part as { text?: unknown }).text === "string" && ((part as { text: string }).text.trim().length > 0)) ||
      (typeof part.type === "string" && (part.type.startsWith("tool-") || part.type === "dynamic-tool")),
  );
}

// Centred chip text for the user messages the client sends for machine steps.
// The server stores the canonical "Approved: <label>" text; the chip shows
// that label while the turn streams.
function chipText(text: string): string {
  if (text === "(approval)") return "Approval decision sent";
  if (text === "(kickoff)") return "Starting your chat";
  if (text.startsWith("Approved: ")) return `You approved ${text.slice("Approved: ".length)}`;
  if (text.startsWith("Declined: ")) return `You declined ${text.slice("Declined: ".length)}`;
  if (text.startsWith("Expired: ")) return `Approval expired: ${text.slice("Expired: ".length)}`;
  return text;
}

// Hover action bar under a message: copy for every message, undo/edit for user
// messages when the chat wires up the handlers (rewinding needs server
// support, so chats opt in per handler).
function MessageActions({
  message,
  onUndo,
  onStartEdit,
}: {
  message: AssistantMessage;
  onUndo?: () => void;
  onStartEdit?: () => void;
}) {
  return (
    <div
      className={`flex gap-0.5 text-muted-foreground ${
        message.role === "user" ? "justify-end" : ""
      }`}
    >
      <CopyButton
        value={messageText(message)}
        successMessage="Message copied"
        label="Copy message"
        variant="ghost"
        size="icon-xs"
      />
      {onStartEdit ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Edit and resend"
          title="Edit and resend"
          onClick={onStartEdit}
        >
          <Pencil />
        </Button>
      ) : null}
      {onUndo ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Undo from this message"
          title="Undo — remove this message and everything after it"
          onClick={onUndo}
        >
          <Undo2 />
        </Button>
      ) : null}
    </div>
  );
}

function CostLine({ message }: { message: AssistantMessage }) {
  const metadata = metadataOf(message);
  const reported = typeof metadata.costUsd === "number" && Number.isFinite(metadata.costUsd);
  const line = reported
    ? `This reply: ${formatUsd(metadata.costUsd as number)}`
    : "Cost of this reply was not reported.";
  return (
    <Tooltip>
      <TooltipTrigger render={<p className="w-fit text-xs text-muted-foreground" />}>
        {line}
      </TooltipTrigger>
      <TooltipContent>Paid lookups you approved are charged separately and appear in Usage.</TooltipContent>
    </Tooltip>
  );
}

/**
 * One chat message. User turns render as a right-aligned bubble — except the
 * approval and kickoff machine messages, which render as a small centred
 * chip. Assistant turns render each part in document order: Markdown text,
 * tool result cards, and server notices. Reasoning is hidden (it is not
 * streamed to this UI).
 *
 * Every settled message gets a copy button. User messages additionally get
 * undo (rewind the conversation to before this message) and edit (rewind,
 * then resend the edited text) when the chat passes the handlers.
 */
export function ChatMessage({
  message,
  streaming,
  stopped,
  brandKey,
  onUndo,
  onEdit,
  onApprovalDecided,
}: {
  message: AssistantMessage;
  /** True while this message is still being generated: copy actions are held
   * back until it settles. */
  streaming?: boolean;
  /** The user stopped this reply: the assistant message ends with "Stopped.". */
  stopped?: boolean;
  brandKey: string;
  onUndo?: () => void;
  onEdit?: (newText: string) => void;
  onApprovalDecided?: (approvalId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (message.role === "user") {
    const kind = metadataOf(message).kind;
    if (kind === "approval" || kind === "kickoff") {
      return (
        <div className="flex justify-center">
          <p className="rounded-full border border-border bg-muted/60 px-3 py-1 text-center text-xs text-muted-foreground">
            {chipText(messageText(message))}
          </p>
        </div>
      );
    }
    if (editing && onEdit) {
      const submit = () => {
        const text = draft.trim();
        setEditing(false);
        if (text && text !== messageText(message)) onEdit(text);
      };
      return (
        <div className="flex flex-col items-end gap-1.5 pl-8 sm:pl-16">
          <Textarea
            className="max-h-36 max-w-xl"
            // Browsers without CSS field-sizing size the box from `rows`.
            rows={Math.min(6, Math.max(2, draft.split("\n").length))}
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
              if (event.key === "Escape") setEditing(false);
            }}
          />
          <div className="flex gap-1.5">
            <Button variant="ghost" size="xs" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="xs" onClick={submit}>
              Save & resend
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="group flex flex-col gap-1">
        <div className="flex justify-end pl-8 sm:pl-16">
          <div className="rounded-xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground">
            {message.parts.map((part, index) =>
              part.type === "text" ? (
                <span key={index} className="whitespace-pre-wrap">
                  {(part as TextPart).text}
                </span>
              ) : null,
            )}
          </div>
        </div>
        {streaming ? null : (
          <MessageActions
            message={message}
            onUndo={onUndo}
            onStartEdit={
              onEdit
                ? () => {
                    setDraft(messageText(message));
                    setEditing(true);
                  }
                : undefined
            }
          />
        )}
      </div>
    );
  }

  const parts = message.parts;
  let lastToolIndex = -1;
  for (let index = 0; index < parts.length; index++) {
    const type = (parts[index] as { type?: unknown }).type;
    if (typeof type === "string" && (type.startsWith("tool-") || type === "dynamic-tool")) {
      lastToolIndex = index;
    }
  }

  return (
    <div className="group flex flex-col gap-1">
      <div className="min-w-0 space-y-2 text-sm">
        {parts.map((part, index) => {
          const type = (part as { type?: unknown }).type;
          if (type === "text") {
            const text = (part as TextPart).text;
            return text.trim() ? (
              <ReactMarkdown key={index} remarkPlugins={[remarkGfm]} components={ASSISTANT_MARKDOWN_COMPONENTS}>
                {text}
              </ReactMarkdown>
            ) : null;
          }
          if (typeof type === "string" && type.startsWith("data-")) {
            const data = (part as { data?: unknown }).data;
            const record =
              data !== null && typeof data === "object" && !Array.isArray(data)
                ? (data as { code?: unknown; text?: unknown })
                : {};
            if (type === "data-notice") {
              return (
                <NoticePart
                  key={index}
                  code={String(record.code ?? "")}
                  text={typeof record.text === "string" ? record.text : undefined}
                />
              );
            }
            return null;
          }
          if (typeof type === "string" && (type.startsWith("tool-") || type === "dynamic-tool")) {
            return (
              <ToolResultCard
                key={index}
                part={part}
                live={Boolean(streaming)}
                openData={index === lastToolIndex}
                brandKey={brandKey}
                onApprovalDecided={onApprovalDecided}
              />
            );
          }
          // Reasoning, files and sources never render in this UI.
          return null;
        })}
        {stopped ? <p className="text-xs text-muted-foreground">Stopped.</p> : null}
      </div>
      {streaming ? null : (
        <>
          <MessageActions message={message} />
          <CostLine message={message} />
        </>
      )}
    </div>
  );
}

/** True for the machine user messages (approval/kickoff chips): no actions, centred. */
export function isMachineUserMessage(message: AssistantMessage): boolean {
  if (message.role !== "user") return false;
  const kind = metadataOf(message).kind;
  return kind === "approval" || kind === "kickoff";
}

export { toToolPartView };
