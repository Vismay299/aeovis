import test from "node:test";
import assert from "node:assert/strict";
import { buildModelInput, expandUserMessage } from "./context.ts";
import type { StoredMessage } from "./messages.ts";

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    sessionId: "s1",
    id: "u1",
    brandKey: "acme-tees",
    seq: 1,
    role: "user",
    parts: [{ type: "text", text: "Which competitors do AI answers name?" }],
    metadata: { kind: "chat", source: "composer" },
    turnId: "t1",
    createdAt: "2026-11-17T00:00:00.000Z",
    ...overrides,
  };
}

function approvalAdmin(row: Record<string, unknown> | null) {
  return {
    from: () => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: row, error: null }),
      };
      return builder;
    },
  } as any;
}

test("expandUserMessage: a chat message returns the stored text, never client text", async () => {
  const text = await expandUserMessage(message(), { admin: approvalAdmin(null) });
  assert.equal(text, "Which competitors do AI answers name?");
});

test("expandUserMessage: an executed approval becomes the approved continuation, ignoring the stored chip", async () => {
  const row = {
    id: "ap-1",
    session_id: "s1",
    label: "Research keywords for “oversized t shirt”",
    status: "executed",
    result: { status: "success", summary: "4 keyword ideas.", data: { rows: [] } },
  };
  const text = await expandUserMessage(
    message({
      parts: [{ type: "text", text: "Approved: A CLIENT CLAIM" }],
      metadata: { kind: "approval", approvalId: "ap-1" },
    }),
    { admin: approvalAdmin(row) },
  );
  assert.ok(text.startsWith("The user approved Research keywords for “oversized t shirt” (approval ap-1)."));
  assert.ok(text.includes('Result as JSON: {"status":"success","summary":"4 keyword ideas.","data":{"rows":[]}}'));
  assert.ok(text.endsWith("Continue from here; do not call the same tool for the same request again unless the user asks."));
  assert.equal(text.includes("A CLIENT CLAIM"), false);
});

test("expandUserMessage: a declined approval says it did not run", async () => {
  const row = { id: "ap-2", session_id: "s1", label: "Research keywords", status: "declined", result: null };
  const text = await expandUserMessage(
    message({ metadata: { kind: "approval", approvalId: "ap-2" } }),
    { admin: approvalAdmin(row) },
  );
  assert.equal(
    text,
    "The user declined Research keywords (approval ap-2). It did not run. Continue from here; do not call the same tool for the same request again unless the user asks.",
  );
});

test("expandUserMessage: an expired approval has its own expired variant (SPEC GAPS G5)", async () => {
  const row = { id: "ap-3", session_id: "s1", label: "Research keywords", status: "expired", result: null };
  const text = await expandUserMessage(
    message({ metadata: { kind: "approval", approvalId: "ap-3" } }),
    { admin: approvalAdmin(row) },
  );
  assert.equal(
    text,
    "The user did not approve Research keywords (approval ap-3); the approval expired. It did not run. Continue from here; do not call the same tool for the same request again unless the user asks.",
  );
});

test("expandUserMessage: a missing approval row asks the user what to do", async () => {
  const text = await expandUserMessage(
    message({ metadata: { kind: "approval", approvalId: "ap-missing" } }),
    { admin: approvalAdmin(null) },
  );
  assert.equal(text, "The approval ap-missing could not be found; ask the user what they want to do.");
});

test("expandUserMessage: a kickoff returns metadata.text built by the server", async () => {
  const text = await expandUserMessage(
    message({ parts: [{ type: "text", text: "Generate report" }], metadata: { kind: "kickoff", text: "Build the Q4 report." } }),
    { admin: approvalAdmin(null) },
  );
  assert.equal(text, "Build the Q4 report.");
});

test("buildModelInput: drops data-* parts and estimates tokens at 4 chars per token", async () => {
  const uiMessages = [
    {
      id: "u1",
      role: "user" as const,
      parts: [
        { type: "text" as const, text: "Hi" },
        { type: "data-notice" as const, data: { code: "step_limit", text: "Stopped after 25 steps." } },
      ],
    },
  ];
  const system = "You are the assistant.";
  const input = await buildModelInput({ system, uiMessages });
  assert.equal(input.system, system);
  assert.equal(JSON.stringify(input.messages).includes("data-notice"), false);
  assert.equal(JSON.stringify(input.messages).includes("Stopped after 25 steps"), false);
  const filtered = [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }];
  assert.equal(
    input.estimatedTokens,
    Math.ceil((system.length + JSON.stringify(filtered).length) / 4),
  );
});
