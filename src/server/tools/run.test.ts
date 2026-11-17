import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AppError } from "../../shared/http/appError.ts";
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

// ---------------------------------------------------------------------------
// F26 §6.2.8 — tool:call and error reports (F26-AC-12)
// ---------------------------------------------------------------------------

type RecordedEvent = {
  name: string;
  props: Record<string, unknown>;
  userId?: string | null;
  brandKey?: string | null;
};

type RecordedError = {
  error: unknown;
  props: Record<string, unknown>;
  userId?: string | null;
};

function recorder() {
  const events: RecordedEvent[] = [];
  const errors: RecordedError[] = [];
  return {
    events,
    errors,
    telemetry: {
      captureServerEvent: async (input: any) => {
        events.push(input);
      },
      captureServerError: async (
        error: unknown,
        props?: any,
        userId?: string | null,
      ) => {
        errors.push({ error, props: props ?? {}, userId });
      },
    },
  };
}

function liveContext(source: ToolHandlerContext["source"] = "assistant"): ToolHandlerContext {
  return { ...context(), source };
}

test("tool:call carries the seven registry props on success", async () => {
  const recorded = recorder();
  const reg = registration(async () => ({ value: 7 }));
  const result = await runTool(reg, liveContext(), { value: 1 }, { telemetry: recorded.telemetry });

  assert.equal(result.ok, true);
  assert.equal(recorded.events.length, 1);
  const [event] = recorded.events;
  assert.equal(event.name, "tool:call");
  assert.deepEqual(Object.keys(event.props).sort(), [
    "duration_ms",
    "error_code",
    "output_invalid",
    "source",
    "success",
    "tool",
    "truncated",
  ]);
  assert.equal(event.props.tool, "get_test_value");
  assert.equal(event.props.source, "assistant");
  assert.equal(event.props.success, true);
  assert.equal(event.props.error_code, null);
  assert.equal(event.props.output_invalid, false);
  assert.equal(event.props.truncated, false);
  assert.ok(Number.isInteger(event.props.duration_ms));
  assert.ok(Number(event.props.duration_ms) >= 0);
  assert.equal(event.userId, "user-a");
  assert.equal(event.brandKey, "brand-a");
  assert.deepEqual(recorded.errors, []);
});

test("a reportable handler exception emits tool:call and one error report with the tool", async () => {
  const recorded = recorder();
  const reg = registration(async () => {
    throw new AppError(500, "internal_error", "boom");
  });
  const result = await runTool(reg, liveContext(), { value: 1 }, { telemetry: recorded.telemetry });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "internal_error");
  assert.equal(recorded.events.length, 1);
  assert.equal(recorded.events[0].props.success, false);
  assert.equal(recorded.events[0].props.error_code, "internal_error");
  assert.equal(recorded.errors.length, 1);
  assert.equal(recorded.errors[0].props.tool, "get_test_value");
  assert.equal(recorded.errors[0].props.error_code, "internal_error");
  assert.equal(recorded.errors[0].userId, "user-a");
});

test("a non-reportable handler code still emits tool:call but no error report", async () => {
  const recorded = recorder();
  const reg = registration(async () => {
    throw new AppError(409, "price_changed", "Price changed");
  });
  const result = await runTool(reg, liveContext(), { value: 1 }, { telemetry: recorded.telemetry });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "price_changed");
  assert.equal(recorded.events.length, 1);
  assert.equal(recorded.events[0].props.success, false);
  assert.equal(recorded.events[0].props.error_code, "price_changed");
  assert.deepEqual(recorded.errors, []);
});

test("an output mismatch reports path-style issues and never the output value", async () => {
  const recorded = recorder();
  const output = z.looseObject({
    value: z.number(),
    data: z.looseObject({ rows: z.array(z.looseObject({ score: z.number() })) }),
  });
  const reg = registration(
    async () => ({ value: 1, data: { rows: [{ score: "never-report-this-value" }] } }) as any,
    output,
  );
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await runTool(reg, liveContext(), { value: 1 }, { telemetry: recorded.telemetry });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "tool_output_invalid");
    assert.equal(recorded.events.length, 1);
    assert.equal(recorded.events[0].props.error_code, "tool_output_invalid");
    assert.equal(recorded.events[0].props.output_invalid, true);
    assert.equal(recorded.errors.length, 1);
    assert.equal(recorded.errors[0].props.error_code, "tool_output_invalid");
    assert.equal(recorded.errors[0].props.issues, "data.rows.0.score");
    assert.ok(!JSON.stringify(recorded.errors[0].props).includes("never-report-this-value"));
  } finally {
    console.error = originalError;
  }
});

test("source test captures nothing", async () => {
  const recorded = recorder();
  const reg = registration(async () => ({ value: 1 }));
  const result = await runTool(reg, context(), { value: 1 }, { telemetry: recorded.telemetry });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.events, []);
  assert.deepEqual(recorded.errors, []);
});

test("a capture that throws leaves the returned outcome unchanged", async () => {
  const reg = registration(async () => ({ value: 3 }));
  const result = await runTool(
    reg,
    liveContext(),
    { value: 1 },
    {
      telemetry: {
        captureServerEvent: () => {
          throw new Error("capture boom");
        },
        captureServerError: () => {
          throw new Error("report boom");
        },
      },
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.output, { value: 3 });
  assert.equal(result.summary, "value");
  assert.equal(result.truncated, null);
});
