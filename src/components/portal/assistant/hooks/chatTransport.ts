// The client half of the chat wire contract, kept free of app aliases so a test
// can drive the real AI SDK `Chat` through it and check every request against the
// server's body schema (chatTransport.test.ts).

import { DefaultChatTransport } from "ai";

export type SendSource = "composer" | "suggestion" | "edit" | "retry";

export type UserMessageMetadata =
  | { kind: "chat"; source: SendSource }
  | { kind: "approval"; approvalId: string }
  | { kind: "kickoff" };

export function newMessageId(): string {
  return `u-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

/**
 * A complete new user message. It must be passed to `sendMessage` as a message,
 * not as `{ text, messageId }`: in the AI SDK `messageId` names an EXISTING user
 * message to replace, so a fresh id there throws "message with id … not found"
 * and nothing is ever sent. The server stores this id as the message's own id
 * (duplicate sends are refused on it), so it is set here, not left to the SDK.
 */
export function userMessage(text: string, metadata: UserMessageMetadata) {
  return {
    id: newMessageId(),
    role: "user" as const,
    parts: [{ type: "text" as const, text }],
    metadata,
  };
}

export function assistantChatUrl(sessionId: string): string {
  return `/api/customer/assistant/sessions/${encodeURIComponent(sessionId)}/chat`;
}

export function assistantStreamUrl(sessionId: string, brandKey: string): string {
  return `/api/customer/assistant/sessions/${encodeURIComponent(sessionId)}/stream?brand_key=${encodeURIComponent(brandKey)}`;
}

/** Sends only the newest message (the server holds the history) and resumes from the stream route. */
export function createAssistantTransport(input: {
  sessionId: string;
  brandKey: string;
  fetch?: typeof fetch;
}) {
  return new DefaultChatTransport({
    api: assistantChatUrl(input.sessionId),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    prepareSendMessagesRequest: ({ messages }) => ({
      body: { brand_key: input.brandKey, message: messages[messages.length - 1] },
    }),
    prepareReconnectToStreamRequest: () => ({
      api: assistantStreamUrl(input.sessionId, input.brandKey),
    }),
  });
}
