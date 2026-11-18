// The browser half of the chat contract, driven through the real AI SDK `Chat`
// (the class `useChat` wraps) and checked against the server's own request schema.
// A mocked transport cannot catch what these cases do: the SDK's `messageId`
// option replaces an existing message, so a send built the obvious way never left
// the browser.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Chat } from "@ai-sdk/react";
import { QueryClient } from "@tanstack/react-query";
import { assistantChatBodySchema } from "../../../../app/api/customer/assistant/sessions/[sessionId]/chat/route.ts";
import {
  assistantStreamUrl,
  createAssistantTransport,
  newMessageId,
  userMessage,
  type UserMessageMetadata,
} from "./chatTransport.ts";
import { SESSION_DETAIL_CACHE } from "./sessionDetailCache.ts";

const SESSION = "6c8f0000-0000-4000-8000-000000000001";
const BRAND = "10000000-0000-0000-0000-000000000001";
const APPROVAL = "9a1e0000-0000-4000-8000-000000000009";

type Captured = { url: string; method: string; body: unknown };

/** A server that refuses every send with a JSON 409, so no stream has to be faked. */
function makeChat(captured: Captured[], history: unknown[] = []) {
  const transport = createAssistantTransport({
    sessionId: SESSION,
    brandKey: BRAND,
    fetch: (async (url: unknown, init?: RequestInit) => {
      captured.push({
        url: String(url),
        method: String(init?.method ?? "GET"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ error: "Busy.", code: "turn_in_progress" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  const errors: unknown[] = [];
  const chat = new Chat({
    id: SESSION,
    messages: history as never,
    transport,
    onError: (error) => errors.push(error),
  });
  return { chat, errors };
}

const KINDS: Array<[string, string, UserMessageMetadata]> = [
  ["chat", "Where do AI answers name competitors?", { kind: "chat", source: "composer" }],
  ["suggestion", "Can AI crawlers read our website?", { kind: "chat", source: "suggestion" }],
  ["approval", "(approval)", { kind: "approval", approvalId: APPROVAL }],
  ["kickoff", "(kickoff)", { kind: "kickoff" }],
];

for (const [name, text, metadata] of KINDS) {
  test(`a ${name} send reaches the server in the shape its route accepts`, async () => {
    const captured: Captured[] = [];
    const { chat } = makeChat(captured);
    const message = userMessage(text, metadata);

    await chat.sendMessage(message as never);

    assert.equal(captured.length, 1, "exactly one request was made");
    assert.equal(captured[0]?.method, "POST");
    assert.equal(captured[0]?.url, `/api/customer/assistant/sessions/${SESSION}/chat`);
    const parsed = assistantChatBodySchema.safeParse(captured[0]?.body);
    assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
    assert.equal(parsed.data.brand_key, BRAND);
    assert.equal(parsed.data.message.id, message.id, "the client id is the id the server stores");
    assert.deepEqual(parsed.data.message.metadata, metadata);
    assert.equal(chat.messages.at(-1)?.id, message.id, "the message shows in the transcript at once");
  });
}

test("a send after earlier turns still sends only the new message", async () => {
  const captured: Captured[] = [];
  const history = [
    { id: "u-1", role: "user", parts: [{ type: "text", text: "hi" }], metadata: { kind: "chat", source: "composer" } },
    {
      id: "a_1",
      role: "assistant",
      parts: [
        { type: "text", text: "hello", state: "done" },
        { type: "data-notice", data: { code: "compacted", text: "Earlier messages were summarised." } },
      ],
      metadata: { turnId: "t1", costUsd: 0.01 },
    },
  ];
  const { chat } = makeChat(captured, history);

  await chat.sendMessage(userMessage("next", { kind: "chat", source: "composer" }) as never);

  const parsed = assistantChatBodySchema.safeParse(captured[0]?.body);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  assert.equal(parsed.data.message.parts[0]?.text, "next");
});

test("message ids are unique and satisfy the server's id pattern", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newMessageId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
});

test("the SDK's messageId option replaces an existing message and cannot create one", async () => {
  // Pins the behaviour userMessage() is written around, so an SDK change that
  // alters it fails here instead of silently breaking every send.
  const captured: Captured[] = [];
  const { chat } = makeChat(captured);
  await assert.rejects(
    chat.sendMessage({ text: "hi", metadata: { kind: "chat", source: "composer" }, messageId: newMessageId() } as never),
    /not found/,
  );
  assert.equal(captured.length, 0);
});

test("resuming asks the stream route for this session and workspace, and 204 means nothing to resume", async () => {
  const captured: Captured[] = [];
  const transport = createAssistantTransport({
    sessionId: SESSION,
    brandKey: BRAND,
    fetch: (async (url: unknown, init?: RequestInit) => {
      captured.push({ url: String(url), method: String(init?.method ?? "GET"), body: null });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });

  const stream = await transport.reconnectToStream({ chatId: SESSION });

  assert.equal(stream, null);
  assert.equal(captured[0]?.method, "GET");
  assert.equal(captured[0]?.url, assistantStreamUrl(SESSION, BRAND));
  assert.equal(
    captured[0]?.url,
    `/api/customer/assistant/sessions/${SESSION}/stream?brand_key=${encodeURIComponent(BRAND)}`,
  );
});

test("a finished reply reloads the transcript from the server even inside the app's stale window", async () => {
  // The app default is a five-minute staleTime. fetchQuery honours it, so without
  // SESSION_DETAIL_CACHE the reload returns the copy cached at page load.
  const key = ["assistantSession", SESSION] as const;
  let served = 0;
  const queryFn = async () => ({ messages: [`server copy ${(served += 1)}`] });

  const appDefault = new QueryClient({ defaultOptions: { queries: { staleTime: 300_000 } } });
  await appDefault.fetchQuery({ queryKey: key, queryFn });
  const stale = await appDefault.fetchQuery({ queryKey: key, queryFn });
  assert.deepEqual(stale.messages, ["server copy 1"], "the bug: the cached copy came back");

  served = 0;
  const fixed = new QueryClient({ defaultOptions: { queries: { staleTime: 300_000 } } });
  await fixed.fetchQuery({ queryKey: key, queryFn, ...SESSION_DETAIL_CACHE });
  const fresh = await fixed.fetchQuery({ queryKey: key, queryFn, ...SESSION_DETAIL_CACHE });
  assert.deepEqual(fresh.messages, ["server copy 2"]);
  assert.equal(SESSION_DETAIL_CACHE.staleTime, 0);
  assert.equal(SESSION_DETAIL_CACHE.gcTime, 0);
});
