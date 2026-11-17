import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../shared/http/appError.ts";
import {
  COMPACTION_KEEP_LAST,
  COMPACTION_SYSTEM,
  assertInputFits,
  compactSession,
  shouldCompact,
} from "./compaction.ts";
import type { StoredMessage } from "./messages.ts";

const CFG = { compactAfterTokens: 120_000, maxInputTokens: 160_000 };

function msg(seq: number, role: "user" | "assistant", parts: unknown[]): StoredMessage {
  return {
    sessionId: "s1",
    id: `${role}-${seq}`,
    brandKey: "acme-tees",
    seq,
    role,
    parts,
    metadata: {},
    turnId: "t1",
    createdAt: "2026-11-17T00:00:00.000Z",
  };
}

function updateAdmin() {
  const updates: Array<Record<string, unknown>> = [];
  const admin = {
    from: () => {
      const builder: any = {
        update: (patch: Record<string, unknown>) => {
          updates.push(patch);
          return builder;
        },
        eq: () => builder,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
      };
      return builder;
    },
  } as any;
  return { admin, updates };
}

test("shouldCompact: strictly over the threshold", () => {
  assert.equal(shouldCompact(120_000, CFG), false);
  assert.equal(shouldCompact(120_001, CFG), true);
});

test("compactSession keeps the last 6 and renders no tool data", async () => {
  const messages: StoredMessage[] = [];
  for (let seq = 1; seq <= 8; seq += 1) {
    messages.push(msg(seq, seq % 2 === 1 ? "user" : "assistant", [{ type: "text", text: "text " + seq }]));
  }
  messages.push(
    msg(9, "assistant", [
      { type: "text", text: "Here is the result." },
      {
        type: "tool-get_scan_report",
        toolCallId: "call-1",
        state: "output-available",
        output: { status: "success", summary: "9 of 12 answers.", data: { secret: "NEVER SEND TOOL DATA" } },
      },
    ]),
  );
  const { admin, updates } = updateAdmin();
  const captured: { value: Record<string, unknown> | null } = { value: null };
  const result = await compactSession(
    { admin, brandKey: "acme-tees", sessionId: "s1", messages },
    {
      llmText: async (input: Record<string, unknown>) => {
        captured.value = input;
        return { text: "A summary.", usd: 0.001, model: "anthropic/claude-sonnet-4.5" };
      },
    },
  );
  assert.equal(COMPACTION_KEEP_LAST, 6);
  assert.equal(result.throughSeq, messages[messages.length - 7].seq);
  assert.equal(result.summary, "A summary.");
  assert.equal(captured.value?.feature, "assistant.compaction");
  assert.equal(captured.value?.system, COMPACTION_SYSTEM);
  assert.equal(captured.value?.maxOutputTokens, 2_000);
  assert.equal(captured.value?.timeoutMs, 60_000);
  assert.equal(
    captured.value?.idempotencyKey,
    "assistant.compaction:s1:" + messages[messages.length - 7].seq,
  );
  const prompt = String(captured.value?.prompt ?? "");
  assert.equal(prompt.includes("NEVER SEND TOOL DATA"), false);
  assert.equal(prompt.includes("secret"), false);
  assert.ok(prompt.includes("User: text 1"));
  assert.ok(prompt.includes("Assistant: text 2"));
  assert.equal(prompt.includes("text 8"), false, "the kept messages are not summarised");
  assert.deepEqual(updates, [
    { summary: "A summary.", compacted_through_seq: messages[messages.length - 7].seq },
  ]);
});

test("compactSession stops the transcript at the newest 200,000 characters", async () => {
  const long = "x".repeat(150_000);
  const messages = [
    msg(1, "user", [{ type: "text", text: long + "OLDEST" }]),
    msg(2, "assistant", [{ type: "text", text: long + "NEWER" }]),
  ];
  for (let seq = 3; seq <= 8; seq += 1) {
    messages.push(msg(seq, "user", [{ type: "text", text: "short " + seq }]));
  }
  const { admin } = updateAdmin();
  let prompt = "";
  await compactSession(
    { admin, brandKey: "acme-tees", sessionId: "s1", messages },
    {
      llmText: async (input: Record<string, unknown>) => {
        prompt = String(input.prompt);
        return { text: "summary", usd: null, model: "m" };
      },
    },
  );
  assert.equal(prompt.length, 200_000);
  assert.equal(prompt.startsWith("xxx"), true);
});

test("compactSession does nothing when there is nothing older than the kept window", async () => {
  const { admin, updates } = updateAdmin();
  const messages = [msg(1, "user", [{ type: "text", text: "hi" }])];
  const result = await compactSession(
    { admin, brandKey: "acme-tees", sessionId: "s1", messages },
    {
      llmText: async () => {
        throw new Error("must not be called");
      },
    },
  );
  assert.deepEqual(result, { summary: "", throughSeq: 0 });
  assert.deepEqual(updates, []);
});

test("assertInputFits: over maxInputTokens after compaction is conversation_too_long", () => {
  assert.doesNotThrow(() => assertInputFits(160_000, CFG));
  assert.throws(
    () => assertInputFits(160_001, CFG),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "conversation_too_long");
      assert.equal(
        error.message,
        "This conversation is too long to continue. Start a new chat; your memory and reports carry over.",
      );
      return true;
    },
  );
});
