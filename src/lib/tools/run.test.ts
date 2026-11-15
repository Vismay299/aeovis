import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { runTool } from "./run.ts";
import type { ToolHandlerContext, ToolRegistration } from "./types.ts";

function context(): ToolHandlerContext {
  return {
    admin: {} as any,
    brand: {
      brandKey: "brand-a",
      role: "owner",
      display_name: "Brand A",
      website: "https://brand.test",
      website_host: "brand.test",
      aliases: [],
      is_active: true,
    },
    userId: "user-a",
    user: { id: "user-a", email: "owner@brand.test" },
    role: "owner",
    requestId: "request-a",
    source: "test",
  };
}

function registration(handler: ToolRegistration["def"]["handler"], output = z.looseObject({ value: z.number() })) {
  return {
    def: {
      name: "get_test_value",
      description: "Read a test value.",
      input: z.strictObject({ value: z.number(), maxUsd: z.number().positive().optional() }),
      output,
      handler,
    },
    area: "visibility",
    feature: null,
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    summarize: (value: any) => value.note ?? "value",
    example: { input: { value: 1 }, output: { value: 1 } },
  } as ToolRegistration;
}

test("invalid strict input is refused before the handler can make a provider call", async () => {
  let calls = 0;
  const reg = registration(async () => {
    calls++;
    return { value: 1 };
  });
  const result = await runTool(reg, context(), { value: 1, unknown: true });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_input");
  assert.equal(calls, 0);
});

test("runTool injects maxUsd into the validated handler input", async () => {
  let received: any;
  const reg = registration(async (_ctx, input: any) => {
    received = input;
    return { value: input.maxUsd };
  });
  const result = await runTool(reg, context(), { value: 1 }, { maxUsd: 0.25 });
  assert.equal(result.ok, true);
  assert.equal(received.maxUsd, 0.25);
});

test("handler timeout aborts the tool and returns tool_timeout", async () => {
  const reg = registration(
    async (ctx) => {
      const signal=ctx.signal; assert.ok(signal);
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { value: 1 };
    },
  );
  const keepAlive = setTimeout(() => {}, 50);
  const result = await runTool(reg, context(), { value: 1 }, { timeoutMs: 10 });
  clearTimeout(keepAlive);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "tool_timeout");
});

test("invalid output is refused and the log contains only the tool name", async () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const reg = registration(async () => ({ value: "bad", secret: "never log this" }) as any);
    const result = await runTool(reg, context(), { value: 1 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "tool_output_invalid");
    assert.deepEqual(logged, [["[tools] output invalid", { tool: "get_test_value" }]]);
  } finally {
    console.error = original;
  }
});

test("untrusted fields are cleaned, output is capped, and summary is at most 300 chars", async () => {
  const output = z.looseObject({
    value: z.number(),
    note: z.string(),
    rows: z.array(z.looseObject({ text: z.string() })),
  });
  const reg = registration(
    async () => ({
      value: 1,
      note: "s".repeat(500),
      rows: [{ text: "third\u200bparty" }, ...Array.from({ length: 10 }, () => ({ text: "x".repeat(5_000) }))],
    }),
    output,
  );
  reg.untrustedPaths = ["rows[*].text"];
  const result = await runTool(reg, context(), { value: 1 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(JSON.stringify(result.output).length <= 32_000);
  assert.equal(result.summary.length, 300);
  assert.deepEqual(result.untrusted, ["rows[0].text", ...Array.from({ length: 10 }, (_, i) => "rows[" + (i + 1) + "].text")]);
  assert.equal((result.output as any).rows[0].text, "thirdparty");
  assert.ok(result.truncated);
});
