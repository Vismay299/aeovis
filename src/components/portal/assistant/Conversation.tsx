// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/sam/SamConversation.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain } from "lucide-react";
import { usePortal } from "@/components/portal/PortalShell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/app/ErrorState";
import { SpendRefusedError } from "@/components/app/SpendRefusedError";
import { SPEND_REFUSAL_CODES } from "@/shared/query/errors";
import { keys } from "@/shared/query/keys";
import { ChatComposer } from "./ChatComposer.tsx";
import { ChatMessage, assistantHasVisibleContent, isMachineUserMessage } from "./ChatMessage.tsx";
import { useStickToBottom } from "./useStickToBottom.ts";
import {
  assistantConfigQueryOptions,
  assistantSessionQueryOptions,
  type AssistantSessionDetail,
} from "./hooks/useAssistantSessions.ts";
import { toSpendApiError, useAssistantChat, type SendSource } from "./hooks/useAssistantChat.ts";

// Kickoffs sent this mount, so a remount (StrictMode, fast navigation) never
// sends "(kickoff)" twice into the same session.
const sentKickoffs = new Set<string>();

/**
 * One assistant session: the streaming transcript, the composer, and the
 * session header. History comes from the database (the `initial` payload);
 * the turn streams over HTTP/SSE with resume, and settles back to the
 * server-canonical messages when it finishes.
 */
export function Conversation({
  sessionId,
  brandKey,
  initial,
}: {
  sessionId: string;
  brandKey: string;
  initial: AssistantSessionDetail;
}) {
  const queryClient = useQueryClient();
  const { brand, features } = usePortal();
  const [draft, setDraft] = useState("");
  const [stoppedTurn, setStoppedTurn] = useState(false);
  const [resumed, setResumed] = useState(false);
  const mountInitial = useRef(initial);
  const wasBusy = useRef(false);

  const configQuery = useQuery(assistantConfigQueryOptions(brandKey));
  const skills = configQuery.data?.skills ?? [];
  const suggestions = configQuery.data?.suggestions ?? [];

  const chat = useAssistantChat({
    sessionId,
    brandKey,
    initial: mountInitial.current.messages,
    onTurnSettled: () => void refreshCanonical(),
    onRejectedDraft: (text) => setDraft(text),
  });
  const chatRef = useRef(chat);
  chatRef.current = chat;

  async function refreshCanonical() {
    const options = assistantSessionQueryOptions(brandKey, sessionId);
    try {
      const detail = await queryClient.fetchQuery({
        queryKey: options.queryKey,
        queryFn: options.queryFn,
      });
      chatRef.current.setMessages(detail.messages);
    } catch {
      // The local transcript already shows the finished reply; a failed
      // refresh must not take it down.
    }
    await queryClient.invalidateQueries({ queryKey: keys.assistantSessions(brandKey) });
  }

  const { scrollRef, onScroll, pinToBottom } = useStickToBottom(chat.messages, chat.status);

  // Kickoff: when the session carries one, send it once. The effect waits for
  // an idle chat so a resumed stream wins over a duplicate kickoff.
  useEffect(() => {
    if (!mountInitial.current.session.hasKickoff) return;
    if (sentKickoffs.has(sessionId)) return;
    if (chat.status !== "ready") return;
    sentKickoffs.add(sessionId);
    chat.sendKickoff();
  }, [sessionId, chat]);

  // A resumed stream that replays nothing (the route answered 204) settles a
  // busy cycle with no new messages; either way the notice goes away.
  useEffect(() => {
    if (chat.isBusy) {
      wasBusy.current = true;
      return;
    }
    if (wasBusy.current) {
      wasBusy.current = false;
      setResumed(true);
    }
  }, [chat.isBusy]);

  const grown = chat.messages.length > mountInitial.current.messages.length;
  const showReconnecting =
    Boolean(mountInitial.current.activeTurn) && !resumed && !grown && chat.status !== "error";

  const sendText = useCallback(
    (text: string, source: SendSource = "composer") => {
      pinToBottom();
      setStoppedTurn(false);
      chat.sendChat(text, source);
    },
    [chat, pinToBottom],
  );

  const handleStop = useCallback(() => {
    setStoppedTurn(true);
    void chat.stopTurn();
  }, [chat]);

  const lastMessage = chat.messages[chat.messages.length - 1];
  const showTyping =
    chat.isBusy &&
    (lastMessage?.role !== "assistant" || !assistantHasVisibleContent(lastMessage));
  const showSuggestions = chat.messages.length === 0 && !chat.isBusy;

  const sendError = chat.sendError;
  const spendApiError =
    sendError !== null &&
    (SPEND_REFUSAL_CODES as readonly string[]).includes(sendError.code)
      ? toSpendApiError(sendError)
      : null;

  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <span className="truncate text-sm font-medium text-foreground/80">
          {mountInitial.current.session.title}
        </span>
        {features?.project_memory ? (
          <Link
            href="/portal/context"
            className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <Brain className="size-3.5" />
            Workspace memory
          </Link>
        ) : null}
      </div>
      <div ref={scrollRef} onScroll={onScroll} role="log" aria-live="polite" className="flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto max-w-2xl space-y-6">
          {chat.messages.length === 0 ? (
            <div className="space-y-2 text-sm text-foreground/80">
              <p>
                Hi, I&apos;m the Perceev assistant. I can read your scans and questions, research keywords
                and competitors, check your site and Search Console, and turn it into next steps for{" "}
                {brand?.display_name || "your workspace"}. Paid lookups always show you the price first.
              </p>
              <p>Ask anything, or start with one of these:</p>
            </div>
          ) : null}

          {chat.messages.map((message, index) => (
            <ChatMessage
              key={message.id}
              message={message}
              brandKey={brandKey}
              streaming={
                chat.isBusy && index === chat.messages.length - 1 && message.role === "assistant"
              }
              stopped={
                stoppedTurn &&
                !chat.isBusy &&
                index === chat.messages.length - 1 &&
                message.role === "assistant"
              }
              onUndo={
                message.role === "user" && !isMachineUserMessage(message)
                  ? () => void chat.rewindTo(message.id)
                  : undefined
              }
              onEdit={
                message.role === "user" && !isMachineUserMessage(message)
                  ? (newText) => void chat.editAndResend(message.id, newText)
                  : undefined
              }
              onApprovalDecided={(approvalId) => chat.sendApproval(approvalId)}
            />
          ))}

          {showTyping ? (
            <div className="flex items-center gap-2 pt-1 text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
                <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
                <span className="size-1.5 animate-bounce rounded-full bg-current" />
              </span>
            </div>
          ) : null}

          {showReconnecting ? (
            <p className="text-xs text-muted-foreground">Reconnecting to the reply in progress…</p>
          ) : null}

          {chat.status === "error" && !sendError ? (
            <ErrorState
              variant="inline"
              message="The assistant stopped before finishing this reply."
              onRetry={chat.lastUserMessage ? chat.retryLast : undefined}
              isRetrying={chat.isBusy}
            />
          ) : null}

          {showSuggestions ? (
            <div className="flex flex-wrap gap-2">
              {suggestions.map((question) => (
                <Button
                  key={question}
                  variant="outline"
                  size="sm"
                  className="rounded-full text-xs text-muted-foreground"
                  onClick={() => sendText(question, "suggestion")}
                >
                  {question}
                </Button>
              ))}
            </div>
          ) : null}

          {showSuggestions && skills.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-foreground/80">Workflows I can run:</p>
              <div className="flex flex-wrap gap-2">
                {skills.map((skill) => (
                  <Button
                    key={skill.name}
                    variant="outline"
                    size="sm"
                    className="rounded-full text-xs text-muted-foreground"
                    title={skill.description}
                    onClick={() => sendText(`Run the ${skill.title} workflow.`)}
                  >
                    {skill.title}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex-shrink-0 border-t border-border px-5 py-3">
        <div className="mx-auto w-full max-w-2xl">
          {spendApiError ? (
            <div className="mb-2">
              <SpendRefusedError error={spendApiError} variant="inline" />
            </div>
          ) : null}
          {sendError && !spendApiError ? (
            <div className="mb-2">
              <Alert variant="warning">
                <AlertDescription>
                  {sendError.message}
                  {sendError.recovery ? ` ${sendError.recovery}` : ""}
                </AlertDescription>
              </Alert>
            </div>
          ) : null}
          <ChatComposer busy={chat.isBusy} value={draft} onChange={setDraft} onSend={sendText} onStop={handleStop} />
        </div>
      </div>
    </div>
  );
}
