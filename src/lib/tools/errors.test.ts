import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AppError } from "../http/appError.ts";
import { SpendRefused } from "../spend/errors.ts";
import { toToolError } from "./errors.ts";

test("AppError retains safe code, message, recovery and approved detail keys", () => {
  const result = toToolError(
    new AppError(409, "price_changed", "The price changed.", {
      recovery: "Review the price.",
      details: { quote: { totalUsd: 1 }, privateValue: "omit", approvedMaxUsd: 2 },
    }),
  );
  assert.deepEqual(result, {
    code: "price_changed",
    message: "The price changed.",
    recovery: "Review the price.",
    retryable: false,
    details: { quote: { totalUsd: 1 }, approvedMaxUsd: 2 },
  });
});

test("SpendRefused uses its F01 copy and is not retryable", () => {
  const result = toToolError(new SpendRefused("daily_cap"));
  assert.equal(result.code, "daily_cap");
  assert.equal(result.message, "Today's spend limit for this workspace has been reached.");
  assert.equal(result.recovery, "Try again tomorrow or ask the workspace owner to raise the limit.");
  assert.equal(result.retryable, false);
});

test("Zod errors map to invalid_input with issue paths and bounded text", () => {
  const schema = z.strictObject({ count: z.number() });
  const result = toToolError(schema.safeParse({ count: "x", unexpected: true }).error);
  assert.equal(result.code, "invalid_input");
  assert.match(result.message, /count:/);
  assert.match(result.message, /Unrecognized key/);
  assert.ok(result.message.length <= 500);
  assert.equal(result.retryable, false);
});

test("unknown error copy and logs never contain the thrown text", () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const result = toToolError(new Error("private provider response"));
    assert.deepEqual(result, {
      code: "internal_error",
      message: "The tool failed. Try again or narrow the request.",
      recovery: null,
      retryable: true,
    });
    assert.equal(JSON.stringify(result).includes("private provider response"), false);
    assert.equal(JSON.stringify(logged).includes("private provider response"), false);
    assert.deepEqual(logged[0], ["[tools] failed", { code: "internal_error", name: "Error" }]);
  } finally {
    console.error = original;
  }
});

test("timeout errors map to tool_timeout", () => {
  const error = new Error("late");
  error.name = "TimeoutError";
  assert.equal(toToolError(error).code, "tool_timeout");
});
