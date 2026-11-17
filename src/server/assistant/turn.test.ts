import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { streamText } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModel } from "ai";
import { createMemoryStore } from "../../shared/spend/memoryStore.ts";
import { createFakeAdmin } from "../../../tests/fixtures/f22/fakeAdmin.ts";
import type { ToolRegistration } from "../tools/types.ts";
import { setAssistantEventTracker } from "./telemetry.ts";
import {
  GATEWAY_ERROR_TEXT,
  runAssistantTurn,
  storeAssistantReply,
  type TurnDeps,
  type TurnInput,
} from "./turn.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../../../tests/fixtures/f22");
const AT = Date.parse("2026-11-17T10:00:00.000Z");

type Fixture = { steps: Array<{ chunks: unknown[] }> };

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as Fixture;
}

const BRAND = {
  brandKey: "acme-tees",
  role: "owner" as const,
  display_name: "Acme Tees",
  website: "https://acme.example",
  website_host: "acme.example",
  aliases: [],
  is_active: true,
};

const echo: ToolRegistration = {
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

const paid: ToolRegistration = {
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
    label: "Research keywords for “shirts”",
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
    lines: [],
    monthly: null,
    warnings: [],
    blocked: null,
    priceVersion: "test",
    quotedAt: "2026-11-17T10:00:00.000Z",
    inputsHash: "a".repeat(64),
  };
}

function modelFromSteps(steps: Array<{ chunks: unknown[] }>, delayMs = 0): LanguageModel {
  return new MockLanguageModelV3({
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4.5",
    doStream: steps.map((step) => ({
      stream: simulateReadableStream({
        chunks: step.chunks as never[],
        initialDelayInMs: delayMs,
        chunkDelayInMs: delayMs,
      }),
    })) as never,
  }) as unknown as LanguageModel;
}

function control() {
  return { enabled: true, mode: "all" as const, brandAllowlist: [], dailyCapUsd: null, maxCallUsd: null };
}

function spendStore(withTurn = true) {
  return createMemoryStore({
    now: () => AT,
    controls: {
      ...(withTurn ? { "assistant.turn": control() } : {}),
      "assistant.compaction": control(),
    },
  });
}

function seed(extra: Record<string, unknown[]> = {}) {
  const admin = createFakeAdmin({
    assistant_sessions: [
      {
        id: "s1",
        brand_key: "acme-tees",
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
    ...extra,
  });
  admin.setNow(() => AT);
  return admin;
}

const ENV = {
  LLM_API_KEY: "test-key",
  ASSISTANT_MODEL: "anthropic/claude-sonnet-4.5",
  ASSISTANT_TURN_MAX_USD: "0.5",
};

function baseDeps(
  admin: ReturnType<typeof createFakeAdmin>,
  model: LanguageModel,
  store: ReturnType<typeof spendStore>,
  extra: TurnDeps = {},
): TurnDeps {
  return {
    model,
    spend: { store },
    env: ENV,
    now: () => AT,
    keepAlive: (() => Promise.resolve()) as never,
    heartbeatMs: 60_000,
    cancelPollMs: 60_000,
    availableTools: async () => [echo],
    isFeatureEnabled: async () => false,
    ...extra,
  };
}

function turnInput(overrides: Partial<TurnInput["message"]> = {}): TurnInput {
  return {
    ws: {
      user: { id: "user-1", email: "owner@acme.example" },
      brandKey: "acme-tees",
      brand: BRAND,
      role: "owner",
      admin: null as never,
    },
    sessionId: "s1",
    message: {
      id: "u_1",
      role: "user",
      parts: [{ type: "text", text: "How did our last scan go?" }],
      metadata: { kind: "chat", source: "composer" },
      ...overrides,
    },
  };
}

async function run(
  admin: ReturnType<typeof createFakeAdmin>,
  deps: TurnDeps,
  message: Partial<TurnInput["message"]> = {},
): Promise<Response> {
  const input = turnInput(message);
  input.ws.admin = admin as never;
  return await runAssistantTurn(input, deps);
}

async function waitForSettle(store: ReturnType<typeof spendStore>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const holds = [...store.holds.values()];
    if (holds.length > 0 && holds.every((hold) => hold.status !== "held")) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the spend hold never settled");
}

test("turn: streams a fixture end to end and settles the sum of step costs", async () => {
  const admin = seed();
  const store = spendStore();
  const events: Array<{ event: string; props: Record<string, unknown> }> = [];
  setAssistantEventTracker((event, props) => events.push({ event, props }));
  try {
    const response = await run(admin, baseDeps(admin, modelFromSteps(fixture("stream-text-steps.json").steps), store));
    assert.equal(response.headers.get("content-type")?.includes("text/event-stream"), true);
    assert.equal(response.headers.get("x-vercel-ai-ui-message-stream"), "v1");
    const body = await response.text();
    assert.ok(body.includes("9 of 12 questions for Acme Tees"));
    assert.ok(body.includes("Next, add the three missed questions to your panel."));
    await waitForSettle(store);

    const hold = [...store.holds.values()][0];
    assert.equal(hold.feature, "assistant.turn");
    assert.equal(hold.estimateUsd, 0.5);
    assert.equal(hold.maxUsd, 0.5);
    assert.equal(hold.expiresAt - hold.createdAt, 900_000);
    assert.equal(hold.status, "settled");
    assert.equal(hold.actualUsd, 0.0028);

    const turn = admin.rows("assistant_turns")[0];
    assert.equal(hold.idempotencyKey, "assistant.turn:" + turn.id);
    assert.equal(turn.status, "completed");
    assert.equal(turn.stop_reason, "finished");
    assert.equal(turn.steps, 2);
    assert.equal(turn.tool_calls, 1);
    assert.equal(Number(turn.cost_usd), 0.0028);    assert.equal(turn.cost_known, true);
    assert.equal(admin.rows("assistant_messages").filter((row: any) => row.role === "assistant").length, 1);
    assert.equal(admin.rows("assistant_messages").filter((row: any) => row.role === "user").length, 1);
    assert.equal(admin.rows("assistant_stream_chunks").length > 0, true);

    const turnEvent = events.find((entry) => entry.event === "assistant:turn");
    assert.ok(turnEvent);
    assert.equal(turnEvent?.props.status, "completed");
    assert.equal(turnEvent?.props.steps, 2);
    assert.equal(turnEvent?.props.cost_usd, 0.0028);
    assert.equal(JSON.stringify(events).includes("Acme Tees"), false, "telemetry must carry no text");
  } finally {
    setAssistantEventTracker(null);
  }
});

test("turn: an unknown step cost settles null, never zero", async () => {
  const admin = seed();
  const store = spendStore();
  const response = await run(admin, baseDeps(admin, modelFromSteps(fixture("stream-text-no-cost.json").steps), store));
  await response.text();
  await waitForSettle(store);
  const hold = [...store.holds.values()][0];
  assert.equal(hold.status, "settled");
  assert.equal(hold.actualUsd, null);
  const turn = admin.rows("assistant_turns")[0];
  assert.equal(turn.cost_usd, null);
  assert.equal(turn.cost_known, false);
  assert.equal(turn.status, "completed");
});

test("turn: reserves before the first streamText call; a refusal is JSON with no provider call", async () => {
  const admin = seed();
  const store = spendStore(false);
  const model = modelFromSteps(fixture("stream-text-steps.json").steps);
  let sawHold = false;
  const deps = baseDeps(admin, model, store, {
    streamText: ((args: unknown) => {
      sawHold = store.holds.size === 1;
      return streamText(args as never);
    }) as never,
  });
  await assert.rejects(run(admin, deps), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 403);
    assert.equal((error as { code?: string }).code, "feature_disabled");
    return true;
  });
  assert.equal(sawHold, false, "the reservation must be refused before any model call");
  assert.equal((model as unknown as { doStreamCalls: unknown[] }).doStreamCalls.length, 0);
  assert.equal(store.holds.size, 0);
  const turn = admin.rows("assistant_turns")[0];
  assert.equal(turn.status, "error");
  assert.equal(admin.rows("assistant_messages").length, 0, "the unanswered user message is removed");
});

test("turn: step limit stops with the exact notice and no extra model call", async () => {
  const admin = seed();
  const store = spendStore();
  const model = modelFromSteps(fixture("stream-text-steps.json").steps);
  const response = await run(
    admin,
    baseDeps(admin, model, store, { env: { ...ENV, ASSISTANT_MAX_STEPS: "1" } }),
  );
  const body = await response.text();
  await waitForSettle(store);
  assert.ok(
    body.includes("I stopped after 1 steps. Ask me to continue if you want me to go on."),
  );
  assert.equal((model as unknown as { doStreamCalls: unknown[] }).doStreamCalls.length, 1);
  const turn = admin.rows("assistant_turns")[0];
  assert.equal(turn.stop_reason, "step_limit");
  assert.equal(turn.status, "completed");
});

test("turn: 90% of the turn cap stops with the turn_cap notice", async () => {
  const admin = seed();
  const store = spendStore();
  const response = await run(
    admin,
    baseDeps(admin, modelFromSteps(fixture("stream-text-steps.json").steps), store, {
      env: { ...ENV, ASSISTANT_TURN_MAX_USD: "0.002" },
    }),
  );
  const body = await response.text();
  await waitForSettle(store);
  assert.ok(
    body.includes(
      "I stopped because this reply reached its spending limit of $0.002. Ask me to continue if you want me to go on.",
    ),
  );
  const turn = admin.rows("assistant_turns")[0];
  assert.equal(turn.stop_reason, "turn_cap");
});

test("turn: the deadline aborts with the deadline notice", async () => {
  const admin = seed();
  const store = spendStore();
  const model = modelFromSteps(fixture("stream-text-steps.json").steps, 60);
  const response = await run(admin, baseDeps(admin, model, store, { deadlineMs: 80 }));
  const body = await response.text();
  await waitForSettle(store);
  assert.ok(
    body.includes(
      "I stopped because this reply was taking too long. Ask me to continue, or ask for a narrower piece.",
    ),
  );
  const turn = admin.rows("assistant_turns")[0];
  assert.equal(turn.stop_reason, "deadline");
  assert.equal(turn.status, "completed");
});

test("turn: Stop marks the turn stopped and writes no notice", async () => {
  const admin = seed();
  const store = spendStore();
  const originalRpc = admin.rpc.bind(admin);
  admin.rpc = async (name: string, args: Record<string, unknown>) => {
    const result = await originalRpc(name, args);
    if (name === "begin_assistant_turn" && result.data) {
      const row = admin.rows("assistant_turns").find((candidate: any) => candidate.id === result.data);
      if (row) row.cancel_requested_at = new Date(AT).toISOString();
    }
    return result;
  };
  const response = await run(
    admin,
    baseDeps(admin, modelFromSteps(fixture("stream-text-steps.json").steps, 100), store, {
      cancelPollMs: 5,
    }),
  );
  const body = await response.text();
  await waitForSettle(store);
  assert.equal(body.includes("I stopped"), false);
  const turn = admin.rows("assistant_turns")[0];
  assert.equal(turn.stop_reason, "user_stop");
  assert.equal(turn.status, "stopped");
  assert.equal([...store.holds.values()][0].status, "released");
  assert.equal([...store.holds.values()][0].releaseReason, "not_billed");
});

test("turn: a step that leaves an approval waiting ends the reply with no notice", async () => {
  const admin = seed();
  const store = spendStore();
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
  const response = await run(
    admin,
    baseDeps(admin, modelFromSteps(approvalSteps), store, {
      availableTools: async () => [paid],
      approvalDeps: { quote: async () => quote() as never, now: () => new Date(AT) },
    }),
  );
  const body = await response.text();
  await waitForSettle(store);
  assert.equal(body.includes("data-notice"), false);
  const turn = admin.rows("assistant_turns")[0];
  assert.equal(turn.stop_reason, "awaiting_approval");
  assert.equal(turn.status, "completed");
  const assistant = admin.rows("assistant_messages").find((row: any) => row.role === "assistant");
  assert.equal(JSON.stringify(assistant?.parts).includes("awaiting_approval"), true);
  assert.equal(admin.rows("assistant_approvals").length, 1);
});

test("turn: streamText gets maxRetries 0, the output cap and four stop conditions", async () => {
  const admin = seed();
  const store = spendStore();
  const captured: { value: Record<string, unknown> | null } = { value: null };
  let holdsAtCall = 0;
  const response = await run(
    admin,
    baseDeps(admin, modelFromSteps(fixture("stream-text-steps.json").steps), store, {
      env: { ...ENV, ASSISTANT_MAX_OUTPUT_TOKENS: "1234" },
      streamText: ((args: Record<string, unknown>) => {
        captured.value = args;
        holdsAtCall = store.holds.size;
        return streamText(args as never);
      }) as never,
      availableTools: async () => [echo],
    }),
  );
  await response.text();
  await waitForSettle(store);
  // AC-13 success path: the assistant.turn hold is already open before the model.
  assert.equal(holdsAtCall, 1);
  assert.equal(captured.value?.maxRetries, 0);
  assert.equal(captured.value?.maxOutputTokens, 1234);
  assert.equal((captured.value?.stopWhen as unknown[]).length, 4);
  assert.ok(captured.value?.abortSignal);
});

test("turn: a model failure returns safe text and records an error turn", async () => {
  const admin = seed();
  const store = spendStore();
  const broken = new MockLanguageModelV3({
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4.5",
    doStream: () => {
      throw new Error("upstream exploded with a secret prompt");
    },
  }) as unknown as LanguageModel;
  const response = await run(admin, baseDeps(admin, broken, store));
  const body = await response.text();
  await waitForSettle(store);
  assert.ok(body.includes(GATEWAY_ERROR_TEXT));
  assert.equal(body.includes("secret prompt"), false);
  const turn = admin.rows("assistant_turns")[0];
  assert.equal(turn.status, "error");
  assert.equal(turn.stop_reason, "error");
  assert.equal(turn.error_code, "llm_failed");
});

test("turn: compaction summarises, stores the summary and writes the compacted notice", async () => {
  const history = Array.from({ length: 10 }, (_, index) => ({
    session_id: "s1",
    id: "m" + (index + 1),
    brand_key: "acme-tees",
    seq: index + 1,
    role: index % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: "x".repeat(600) + " message " + (index + 1) }],
    metadata: {},
    turn_id: "t0",
    created_at: "2026-11-17T09:00:00.000Z",
  }));
  const admin = seed({ assistant_messages: history });
  const store = spendStore();
  const compactionInput: { value: Record<string, unknown> | null } = { value: null };
  const response = await run(
    admin,
    baseDeps(admin, modelFromSteps(fixture("stream-text-no-cost.json").steps), store, {
      env: {
        ...ENV,
        ASSISTANT_COMPACT_AFTER_TOKENS: "1000",
        ASSISTANT_MAX_INPUT_TOKENS: "160000",
      },
      llmText: (async (input: Record<string, unknown>) => {
        compactionInput.value = input;
        return { text: "The user is checking scan results.", usd: 0.001, model: "m" };
      }) as never,
    }),
  );
  const body = await response.text();
  await waitForSettle(store);
  assert.equal(compactionInput.value?.feature, "assistant.compaction");
  assert.ok(
    body.includes("Earlier messages were summarised so the assistant stays fast. They are still shown here."),
  );
  const session = admin.rows("assistant_sessions")[0];
  assert.equal(session.summary, "The user is checking scan results.");
  assert.equal(session.compacted_through_seq, 5);
});

test("turn: conversation_too_long is a 409, deletes the user message and calls no model", async () => {
  const history = Array.from({ length: 20 }, (_, index) => ({
    session_id: "s1",
    id: "m" + (index + 1),
    brand_key: "acme-tees",
    seq: index + 1,
    role: index % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: "y".repeat(4000) }],
    metadata: {},
    turn_id: "t0",
    created_at: "2026-11-17T09:00:00.000Z",
  }));
  const admin = seed({ assistant_messages: history });
  const store = spendStore();
  const model = modelFromSteps(fixture("stream-text-no-cost.json").steps);
  await assert.rejects(
    run(
      admin,
      baseDeps(admin, model, store, {
        env: {
          ...ENV,
          ASSISTANT_COMPACT_AFTER_TOKENS: "1000",
          ASSISTANT_MAX_INPUT_TOKENS: "1000",
        },
        llmText: (async () => {
          throw new Error("compaction unavailable");
        }) as never,
      }),
    ),
    { status: 409, code: "conversation_too_long" },
  );
  assert.equal((model as unknown as { doStreamCalls: unknown[] }).doStreamCalls.length, 0);
  assert.equal(store.holds.size, 0);
  const turn = admin.rows("assistant_turns")[0];
  assert.equal(turn.status, "error");
  assert.equal(turn.error_code, "conversation_too_long");
  assert.equal(admin.rows("assistant_messages").some((row: any) => row.id === "u_1"), false);
});

test("turn: a setup failure after beginTurn finishes the turn row and drops the user message", async () => {
  const admin = seed();
  const store = spendStore();
  const model = modelFromSteps(fixture("stream-text-no-cost.json").steps);
  await assert.rejects(
    run(
      admin,
      baseDeps(admin, model, store, {
        availableTools: async () => {
          throw new Error("tool catalog unavailable");
        },
      }),
    ),
    { message: "tool catalog unavailable" },
  );
  const turns = admin.rows("assistant_turns");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, "error");
  assert.equal(turns[0].stop_reason, "error");
  assert.equal(turns[0].error_code, "turn_setup_failed");
  // No streaming row is left behind, so the user's next send is not a 409.
  assert.equal(turns.some((row: any) => row.status === "streaming"), false);
  assert.equal(admin.rows("assistant_messages").some((row: any) => row.id === "u_1"), false);
  assert.equal(store.holds.size, 0);
  assert.equal((model as unknown as { doStreamCalls: unknown[] }).doStreamCalls.length, 0);
});

test("turn: a repeated message id is 409 duplicate_message before a turn starts", async () => {
  const admin = seed({
    assistant_messages: [
      {
        session_id: "s1",
        id: "u_1",
        brand_key: "acme-tees",
        seq: 1,
        role: "user",
        parts: [{ type: "text", text: "hello" }],
        metadata: { kind: "chat" },
        turn_id: null,
        created_at: "2026-11-17T09:00:00.000Z",
      },
    ],
  });
  const store = spendStore();
  await assert.rejects(
    run(admin, baseDeps(admin, modelFromSteps(fixture("stream-text-steps.json").steps), store)),
    { status: 409, code: "duplicate_message" },
  );
  assert.equal(admin.rows("assistant_turns").length, 0);
  assert.equal(store.holds.size, 0);
});

test("turn: a 30th turn in the hour is 429 before any turn row", async () => {
  const admin = seed({
    assistant_turns: Array.from({ length: 30 }, (_, index) => ({
      id: "t" + index,
      session_id: "s0",
      brand_key: "acme-tees",
      user_id: "user-1",
      status: "completed",
      started_at: `2026-11-17T09:${String(index).padStart(2, "0")}:00.000Z`,
      heartbeat_at: "2026-11-17T09:59:00.000Z",
      finished_at: "2026-11-17T09:59:30.000Z",
    })),
  });
  const store = spendStore();
  await assert.rejects(
    run(admin, baseDeps(admin, modelFromSteps(fixture("stream-text-steps.json").steps), store)),
    { status: 429, code: "assistant_rate_limited" },
  );
  assert.equal(admin.rows("assistant_turns").length, 30);
  assert.equal(store.holds.size, 0);
});

test("AC-17: storeAssistantReply fits a >1 MB reply before insert", async () => {
  const admin = seed();
  const parts = Array.from({ length: 200 }, (_, index) => ({
    type: "tool-get_scan_report",
    toolCallId: "call-" + index,
    state: "output-available",
    output: {
      status: "success",
      summary: "Rows " + index + ".",
      data: { rows: Array.from({ length: 40 }, () => "x".repeat(160)) },
      link: null,
      untrusted: [],
      truncated: null,
    },
  }));
  assert.ok(JSON.stringify(parts).length > 1_000_000);
  await storeAssistantReply(admin as never, {
    sessionId: "s1",
    id: "a_big_reply",
    brandKey: "acme-tees",
    role: "assistant",
    parts,
    metadata: {},
    turnId: "t-big",
  });
  const rows = admin.rows("assistant_messages");
  assert.equal(rows.length, 1);
  const stored = rows[0].parts;
  assert.ok(JSON.stringify(stored).length <= 1_000_000);
  assert.deepEqual(stored[0].output.data, { omitted: true, reason: "size" });
  assert.deepEqual(stored[stored.length - 1].output.data, parts[parts.length - 1].output.data);
});

test("AC-15: the next turn rebuilds and notices the turn it interrupted, exactly once", async () => {
  const sse = readFileSync(path.join(FIXTURES, "sse-turn.txt"), "utf8");
  const admin = seed({
    assistant_turns: [
      {
        id: "t-stale",
        session_id: "s1",
        brand_key: "acme-tees",
        user_id: "user-1",
        status: "streaming",
        stop_reason: null,
        assistant_message_id: null,
        started_at: "2020-01-01T00:00:00.000Z",
        heartbeat_at: "2020-01-01T00:00:00.000Z",
        finished_at: null,
      },
    ],
    assistant_stream_chunks: [
      { turn_id: "t-stale", seq: 0, brand_key: "acme-tees", data: sse },
    ],
  });
  const store = spendStore();
  const model = modelFromSteps([
    ...fixture("stream-text-steps.json").steps,
    fixture("stream-text-steps.json").steps[1],
  ]);
  const first = await run(admin, baseDeps(admin, model, store));
  await first.text();
  await waitForSettle(store);

  const old = admin.rows("assistant_turns").find((row: any) => row.id === "t-stale");
  assert.equal(old?.status, "interrupted");
  assert.equal(old?.stop_reason, "interrupted");
  assert.ok(old?.assistant_message_id);
  const replies = admin.rows("assistant_messages").filter((row: any) => row.turn_id === "t-stale");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, old.assistant_message_id);
  assert.ok(JSON.stringify(replies[0].parts).includes("9 of 12 questions"));
  assert.deepEqual(replies[0].parts.at(-1), {
    type: "data-notice",
    data: {
      code: "interrupted",
      text: "That reply was cut off before it finished. Everything above is saved. Ask again for a narrower piece (fewer keywords, competitors or pages), or tell me where to pick up.",
    },
  });
  assert.equal(
    (model as unknown as { doStreamCalls: unknown[] }).doStreamCalls.length,
    2,
    "the interrupted turn is never re-run",
  );

  const store2 = spendStore();
  const second = await run(admin, baseDeps(admin, model, store2), { id: "u_3" });
  await second.text();
  await waitForSettle(store2);
  const after = admin.rows("assistant_messages").filter((row: any) => row.turn_id === "t-stale");
  assert.equal(after.length, 1, "a repeat adds no second reply");
  assert.equal(
    after[0].parts.filter((part: any) => part.type === "data-notice").length,
    1,
    "a repeat adds no second notice",
  );
});
