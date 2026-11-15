import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { callToolForMcp, toMcpToolDescriptors } from "./mcp.ts";
import type { ToolHandlerContext, ToolRegistration } from "./types.ts";

function context(): ToolHandlerContext {
  return {
    admin: {} as any,
    brand: { brandKey: "brand-a", role: "owner", display_name: "Brand A", website: "", website_host: "", aliases: [], is_active: true },
    userId: "user-a",
    user: { id: "user-a", email: "owner@brand.test" },
    role: "owner",
    requestId: "req",
    source: "test",
  };
}

function tool(effect: "read" | "paid", handler: ToolRegistration["def"]["handler"]) {
  return {
    def: {
      name: "get_test_value",
      title: "Test value",
      description: "Read a value.",
      input: z.strictObject({ maxUsd: effect === "paid" ? z.number().positive() : z.number().optional() }),
      output: z.looseObject({ value: z.number(), rows: z.array(z.looseObject({ id: z.string() })).optional() }),
      handler,
    },
    area: "visibility",
    feature: null,
    effect,
    approval: () => ({ kind: "none" }),
    annotations: { readOnlyHint: effect === "read", destructiveHint: false, openWorldHint: effect === "paid", idempotentHint: effect === "read" },
    summarize: () => "Value.",
    example: { input: effect === "paid" ? { maxUsd: 1 } : {}, output: { value: 1 } },
  } as ToolRegistration;
}

test("descriptors expose JSON schemas and do not close output objects", () => {
  const reg = tool("read", async () => ({ value: 1, rows: [{ id: "r1", extra: "ok" }] }));
  const descriptors = toMcpToolDescriptors([reg]);
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].name, "get_test_value");
  assert.equal((descriptors[0].inputSchema as any).additionalProperties, false);
  assert.notEqual((descriptors[0].outputSchema as any).additionalProperties, false);
  assert.deepEqual(descriptors[0].annotations, reg.annotations);
});

test("paid MCP tool refuses missing maxUsd before the handler can run", async () => {
  let calls = 0;
  const reg = tool("paid", async () => { calls++; return { value: 1 }; });
  const result = await callToolForMcp(reg, context(), {}, { baseUrl: "https://app.test" });
  assert.equal(calls, 0);
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as any).code, "approval_required");
});

test("paid MCP tool passes an explicit approved maximum through to the handler", async () => {
  let received: unknown;
  const reg = tool("paid", async (_ctx, input: any) => { received = input.maxUsd; return { value: 1 }; });
  const result = await callToolForMcp(reg, context(), { maxUsd: 0.25 }, { baseUrl: "https://app.test" });
  assert.equal(result.isError, undefined);
  assert.equal(received, 0.25);
});
