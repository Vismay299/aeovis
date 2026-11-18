// Phase 4 (the turn runtime) streaming into Phase 5 (the browser chat): the real
// `runAssistantTurn` with a mock model, its real SSE response, consumed by the real
// AI SDK `Chat` through the same transport the page uses. Neither phase's own tests
// cross this seam, and every unit on either side passed while the pieces did not
// fit, so this is where a stream-shape or message-shape mismatch shows up.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Chat } from "@ai-sdk/react";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModel } from "ai";
import { createMemoryStore } from "../../../../shared/spend/memoryStore.ts";
import { createFakeAdmin } from "../../../../../tests/fixtures/f22/fakeAdmin.ts";
import { assistantChatBodySchema } from "../../../../app/api/customer/assistant/sessions/[sessionId]/chat/route.ts";
import { toUIMessage, loadMessages } from "../../../../server/assistant/messages.ts";
import { runAssistantTurn, type TurnDeps } from "../../../../server/assistant/turn.ts";
import type { ToolRegistration } from "../../../../server/tools/types.ts";
import { createAssistantTransport, userMessage } from "./chatTransport.ts";
import { toToolPartView } from "../toolPartView.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../../../../../tests/fixtures/f22");
const AT = Date.parse("2026-11-17T10:00:00.000Z");
const SESSION = "6c8f0000-0000-4000-8000-000000000001";
const BRAND_KEY = "acme-tees";

const BRAND = {
  brandKey: BRAND_KEY,
  role: "owner" as const,
  display_name: "Acme Tees",
  website: "https://acme.example",
  website_host: "acme.example",
  aliases: [],
  is_active: true,
};

const echo = {
  def: {
    name: "qa_echo",
    description: "Echo a synthetic value.",
    input: z.strictObject({}),
    output: z.looseObject({ echo: z.boolean() }),
    handler: async () => ({ echo: true }),
  },
  area: "keywords",
  feature: null,
  effect: "read",
  approval: () => ({ kind: "none" }),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  summarize: () => "Echoed.",
  example: { input: {}, output: { echo: true } },
} as unknown as ToolRegistration;

const paid = {
  def: {
    name: "qa_paid",
    description: "Buy a synthetic lookup.",
    input: z.strictObject({ maxUsd: z.number().positive().max(1000) }),
    output: z.looseObject({ ok: z.boolean() }),
    handler: async () => ({ ok: true }),
  },
  area: "keywords",
  feature: null,
  effect: "paid",
  approval: () => ({
    kind: "price",
    action: "keywords.research.run",
    quoteInput: { keyword: "shirts" },
    label: "Research keywords for shirts",
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
  summarize: () => "Bought the lookup.",
  example: { input: { maxUsd: 0.1 }, output: { ok: true } },
} as unknown as ToolRegistration;

function quote() {
  return {
    action: "keywords.research.run",
    currency: "USD",
    totalUsd: 0.05,
    expectedUsd: null,
    units: [],
    lines: [{ label: "Phrase-match ideas", quantity: 1, unitUsd: 0.05, totalUsd: 0.05 }],
    monthly: null,
    warnings: [],
    blocked: null,
    priceVersion: "test",
    quotedAt: "2026-11-17T10:00:00.000Z",
    inputsHash: "a".repeat(64),
  };
}

function fixtureSteps(name: string): Array<{ chunks: unknown[] }> {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")).steps;
}

function modelFromSteps(steps: Array<{ chunks: unknown[] }>): LanguageModel {
  return new MockLanguageModelV3({
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4.5",
    doStream: steps.map((step) => ({
      stream: simulateReadableStream({ chunks: step.chunks as never[], initialDelayInMs: 0, chunkDelayInMs: 0 }),
    })) as never,
  }) as unknown as LanguageModel;
}

function server(model: LanguageModel, extra: Partial<TurnDeps> = {}) {
  const admin = createFakeAdmin({
    assistant_sessions: [
      {
        id: SESSION,
        brand_key: BRAND_KEY,
        user_id: "user-1",
        title: "New chat",
        summary: null,
        compacted_through_seq: null,
        kickoff: null,
        archived_at: null,
        created_at: "2026-11-17T09:00:00.000Z",
        updated_at: "2026-11-17T09:00:00.000Z",
      },
    ],
  });
  admin.setNow(() => AT);
  const control = { enabled: true, mode: "all" as const, brandAllowlist: [], dailyCapUsd: null, maxCallUsd: null };
  const store = createMemoryStore({
    now: () => AT,
    controls: { "assistant.turn": control, "assistant.compaction": control },
  });
  const deps: TurnDeps = {
    model,
    spend: { store },
    env: { LLM_API_KEY: "test-key", ASSISTANT_MODEL: "anthropic/claude-sonnet-4.5", ASSISTANT_TURN_MAX_USD: "0.5" },
    now: () => AT,
    keepAlive: (() => Promise.resolve()) as never,
    heartbeatMs: 60_000,
    cancelPollMs: 60_000,
    availableTools: async () => [echo],
    isFeatureEnabled: async () => false,
    ...extra,
  };
  return { admin, deps };
}

/** The chat route's job, minus authentication: validate the body, run the turn. */
function chatFor(admin: ReturnType<typeof createFakeAdmin>, deps: TurnDeps) {
  const errors: unknown[] = [];
  const transport = createAssistantTransport({
    sessionId: SESSION,
    brandKey: BRAND_KEY,
    fetch: (async (_url: unknown, init?: RequestInit) => {
      const body = assistantChatBodySchema.parse(JSON.parse(String(init?.body)));
      return await runAssistantTurn(
        {
          ws: { user: { id: "user-1", email: "owner@acme.example" }, brandKey: BRAND_KEY, brand: BRAND, role: "owner", admin: admin as never },
          sessionId: SESSION,
          message: body.message,
        },
        deps,
      );
    }) as typeof fetch,
  });
  const chat = new Chat({ id: SESSION, messages: [], transport, onError: (error) => errors.push(error) });
  return { chat, errors };
}

test("a streamed reply with a tool call lands in the browser transcript and matches what was stored", async () => {
  const { admin, deps } = server(modelFromSteps(fixtureSteps("stream-text-steps.json")));
  const { chat, errors } = chatFor(admin, deps);

  await chat.sendMessage(userMessage("How did our last scan go?", { kind: "chat", source: "composer" }) as never);

  assert.deepEqual(errors, []);
  assert.equal(chat.status, "ready");
  assert.deepEqual(chat.messages.map((message) => message.role), ["user", "assistant"]);

  const reply = chat.messages[1]!;
  assert.match(reply.id, /^a_[0-9a-f]{32}$/, "the id the server stored is the id the browser holds");
  const text = reply.parts.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join(" ");
  assert.ok(text.includes("9 of 12 questions for Acme Tees"));
  assert.ok(text.includes("Next, add the three missed questions to your panel."));

  const toolPart = reply.parts.find((part) => part.type.startsWith("tool-"));
  const view = toToolPartView(toolPart);
  assert.equal(view?.toolName, "qa_echo");
  assert.equal(view?.state, "output-available");
  assert.equal((view?.output as { status?: string }).status, "success");

  const meta = reply.metadata as { turnId?: string; costUsd?: number | null; costKnown?: boolean };
  assert.ok(meta.turnId);
  assert.equal(meta.costKnown, true);
  assert.equal(meta.costUsd, 0.0028);

  // The reload the page does when a reply finishes must agree with the live copy.
  const stored = (await loadMessages(admin as never, SESSION)).map(toUIMessage);
  assert.deepEqual(stored.map((message) => message.id), chat.messages.map((message) => message.id));
  assert.deepEqual(stored[0]?.metadata, { kind: "chat", source: "composer" });
  const storedText = stored[1]!.parts.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join(" ");
  assert.equal(storedText, text);
});

test("a step that needs approval reaches the browser as the data an approval card is built from", async () => {
  const approvalSteps = [
    {
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: "call-paid", toolName: "qa_paid" },
        { type: "tool-input-delta", id: "call-paid", delta: "{}" },
        { type: "tool-input-end", id: "call-paid" },
        { type: "tool-call", toolCallId: "call-paid", toolName: "qa_paid", input: "{}" },
        {
          type: "finish",
          usage: {
            inputTokens: { total: 300, noCache: 300, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 10, text: 0, reasoning: 0 },
          },
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          providerMetadata: { openrouter: { usage: { cost: 0.0009 } } },
        },
      ],
    },
  ];
  const { admin, deps } = server(modelFromSteps(approvalSteps), {
    availableTools: async () => [paid],
    approvalDeps: { quote: async () => quote() as never, now: () => new Date(AT) },
  });
  const { chat, errors } = chatFor(admin, deps);

  await chat.sendMessage(userMessage("Research keywords for shirts", { kind: "chat", source: "composer" }) as never);

  assert.deepEqual(errors, []);
  const toolPart = chat.messages.at(-1)!.parts.find((part) => part.type.startsWith("tool-"));
  const view = toToolPartView(toolPart);
  assert.equal(view?.state, "output-available");
  const envelope = view?.output as Record<string, unknown>;
  assert.equal(envelope.status, "awaiting_approval");
  assert.equal(envelope.kind, "price");
  assert.equal(envelope.label, "Research keywords for shirts");
  assert.equal((envelope.quote as { totalUsd: number }).totalUsd, 0.05);
  assert.equal(typeof envelope.approvalId, "string");
  assert.equal(typeof envelope.expiresAt, "string");

  // The id on the card is the id of a stored approval the decide route will find.
  const stored = admin.rows("assistant_approvals");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, envelope.approvalId);
});

test("a second send after a finished turn streams again and keeps both exchanges in order", async () => {
  const steps = fixtureSteps("stream-text-steps.json");
  const { admin, deps } = server(modelFromSteps([...steps, ...steps]));
  const { chat, errors } = chatFor(admin, deps);

  await chat.sendMessage(userMessage("First question", { kind: "chat", source: "composer" }) as never);
  await chat.sendMessage(userMessage("Second question", { kind: "chat", source: "composer" }) as never);

  assert.deepEqual(errors, []);
  assert.deepEqual(chat.messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(new Set(chat.messages.map((message) => message.id)).size, 4, "no two messages share an id");
});
