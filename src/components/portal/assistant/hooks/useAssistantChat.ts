// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/sam/useSamSessions.ts (session sync)
//   src/client/features/sam/SamConversation.tsx (send/rewind/stop flows)
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { ApiError, fetchJson } from "@/shared/query/fetchJson";
import type { SpendRefusalCode } from "@/shared/query/errors";
import { createAssistantTransport, userMessage, type SendSource } from "./chatTransport.ts";

export type AssistantChatMessage = UIMessage;

export type { SendSource } from "./chatTransport.ts";

export type AssistantSendError = {
  code: string;
  message: string;
  recovery?: string;
};

const SPEND_STATUS: Record<string, number> = {
  feature_disabled: 403,
  daily_cap: 402,
  workspace_cap: 402,
  over_approved_max: 402,
};

// The server's pre-stream JSON refusals: the typed text stays in the composer
// because nothing was accepted. Anything else is a mid-stream failure and the
// message already belongs to the transcript (rewind + resend to retry).
const REJECTED_BEFORE_STREAM = new Set([
  "assistant_not_configured",
  "assistant_rate_limited",
  "turn_in_progress",
  "approval_pending",
  "no_kickoff",
  "conversation_too_long",
  "duplicate_message",
  "invalid_request",
  ...Object.keys(SPEND_STATUS),
]);

/** The transport throws the raw JSON error body as the message; recover the fields. */
export function parseSendError(error: unknown): AssistantSendError {
  if (error instanceof Error && error.message) {
    try {
      const body = JSON.parse(error.message) as Record<string, unknown>;
      if (typeof body.error === "string" && typeof body.code === "string") {
        return {
          code: body.code,
          message: body.error,
          recovery: typeof body.recovery === "string" ? body.recovery : undefined,
        };
      }
    } catch {
      // Not a JSON route error (network failure, stream failure): plain text.
    }
    return { code: "request_failed", message: error.message };
  }
  return { code: "request_failed", message: "The assistant could not be reached. Try again." };
}

export function toSpendApiError(
  sendError: AssistantSendError,
): ApiError & { code: SpendRefusalCode } {
  const status = SPEND_STATUS[sendError.code] ?? 402;
  // Callers gate on the refusal codes first; the cast carries that knowledge.
  return new ApiError(status, sendError.code, sendError.message, {
    recovery: sendError.recovery,
  }) as ApiError & { code: SpendRefusalCode };
}

/**
 * The streaming chat for one assistant session: `useChat` over HTTP/SSE with
 * resume, on top of the Phase 4 routes. The server is the source of truth —
 * history comes from the database, sends carry the client message id, and
 * undo/edit go through the rewind route.
 */
export function useAssistantChat({
  sessionId,
  brandKey,
  initial,
  onTurnSettled,
  onRejectedDraft,
}: {
  sessionId: string;
  brandKey: string;
  initial: AssistantChatMessage[];
  /** The assistant reply finished: refetch the server-canonical transcript. */
  onTurnSettled?: () => void;
  /** A send was refused before streaming: restore this text to the composer. */
  onRejectedDraft?: (text: string) => void;
}) {
  const [sendError, setSendError] = useState<AssistantSendError | null>(null);
  const lastSubmittedText = useRef("");
  const settledRef = useRef(onTurnSettled);
  settledRef.current = onTurnSettled;
  const rejectedRef = useRef(onRejectedDraft);
  rejectedRef.current = onRejectedDraft;

  const transport = useMemo(
    () => createAssistantTransport({ sessionId, brandKey }),
    [sessionId, brandKey],
  );

  const chat = useChat({
    id: sessionId,
    messages: initial,
    resume: true,
    experimental_throttle: 50,
    transport,
    onError: (error) => {
      const parsed = parseSendError(error);
      setSendError(parsed);
      if (REJECTED_BEFORE_STREAM.has(parsed.code) && lastSubmittedText.current) {
        rejectedRef.current?.(lastSubmittedText.current);
      }
      lastSubmittedText.current = "";
    },
    onFinish: () => {
      lastSubmittedText.current = "";
      settledRef.current?.();
    },
  });

  const { sendMessage, setMessages, status } = chat;
  const isBusy = status === "submitted" || status === "streaming";

  const sendChat = useCallback(
    (text: string, source: SendSource = "composer") => {
      setSendError(null);
      lastSubmittedText.current = text;
      void sendMessage(userMessage(text, { kind: "chat", source }));
    },
    [sendMessage],
  );

  // After a decision the client sends an approval message and the assistant
  // continues from the stored result (§6.6.4).
  const sendApproval = useCallback(
    (approvalId: string) => {
      setSendError(null);
      lastSubmittedText.current = "";
      void sendMessage(userMessage("(approval)", { kind: "approval", approvalId }));
    },
    [sendMessage],
  );

  const sendKickoff = useCallback(() => {
    setSendError(null);
    lastSubmittedText.current = "";
    void sendMessage(userMessage("(kickoff)", { kind: "kickoff" }));
  }, [sendMessage]);

  // Rewind the server-side conversation to before `messageId`: the route
  // cancels a streaming turn, then deletes the message and everything after
  // it. Sync the local view from the server afterwards rather than slicing
  // locally — an aborted turn may have persisted more than we can see.
  const rewindTo = useCallback(
    async (messageId: string): Promise<AssistantChatMessage[] | null> => {
      let response: { removed: number; messages: AssistantChatMessage[] };
      try {
        response = await fetchJson<{ removed: number; messages: AssistantChatMessage[] }>(
          `/api/customer/assistant/sessions/${encodeURIComponent(sessionId)}/rewind`,
          { method: "POST", body: { brand_key: brandKey, messageId } },
        );
      } catch {
        toast.error("Couldn't change the conversation. Try again.");
        return null;
      }
      setMessages(response.messages);
      toast("Removed. Actions already taken are not undone.");
      return response.messages;
    },
    [brandKey, sessionId, setMessages],
  );

  const lastUserMessage = useMemo(
    () => [...chat.messages].reverse().find((message) => message.role === "user"),
    [chat.messages],
  );

  const userMessageText = useCallback((message: AssistantChatMessage): string => {
    return message.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }, []);

  // Retry after a failed turn goes through the same rewind-then-resend path
  // as edit, so the failed partial reply is deleted server-side before the
  // new one streams in.
  const retryLast = useCallback(() => {
    if (!lastUserMessage || isBusy) return;
    const text = userMessageText(lastUserMessage);
    if (!text.trim()) return;
    void rewindTo(lastUserMessage.id).then((messages) => {
      if (messages) sendChat(text, "retry");
    });
  }, [lastUserMessage, isBusy, rewindTo, userMessageText, sendChat]);

  const editAndResend = useCallback(
    (messageId: string, newText: string) => {
      if (isBusy) return;
      void rewindTo(messageId).then((messages) => {
        if (messages) sendChat(newText, "edit");
      });
    },
    [isBusy, rewindTo, sendChat],
  );

  // Stop is explicit: the route marks the turn so the server stops, and the
  // local request is aborted. The typed text stays where it is.
  const stopTurn = useCallback(async () => {
    try {
      await fetchJson(`/api/customer/assistant/sessions/${encodeURIComponent(sessionId)}/stop`, {
        method: "POST",
        body: { brand_key: brandKey },
      });
    } catch {
      // The local abort below still ends the visible stream.
    }
    await chat.stop();
  }, [brandKey, sessionId, chat]);

  useEffect(() => {
    lastSubmittedText.current = "";
    setSendError(null);
  }, [sessionId]);

  return {
    messages: chat.messages,
    setMessages,
    status,
    isBusy,
    sendError,
    clearSendError: () => setSendError(null),
    sendChat,
    sendApproval,
    sendKickoff,
    rewindTo,
    retryLast,
    editAndResend,
    stopTurn,
    resumeStream: chat.resumeStream,
    lastUserMessage,
    userMessageText,
  };
}
