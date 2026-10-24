import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  AppError,
  WorkspaceError,
  readJsonBody,
  toErrorResponse,
  jsonOk,
  NO_STORE,
} from "./errors.ts";
import { SpendRefused } from "../spend/errors.ts";

function catchOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

async function bodyOf(err: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = toErrorResponse(err);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("AppError keeps its status, code, recovery and details", async () => {
  const err = new AppError(418, "teapot", "I am a teapot.", {
    recovery: "Use a coffee machine.",
    details: { pot: 1 },
  });
  const { status, body } = await bodyOf(err);
  assert.equal(status, 418);
  assert.deepEqual(body, {
    error: "I am a teapot.",
    code: "teapot",
    recovery: "Use a coffee machine.",
    details: { pot: 1 },
  });
});

test("WorkspaceError is an AppError and keeps its own name", () => {
  const err = new WorkspaceError(401, "unauthenticated", "Please sign in.");
  assert.ok(err instanceof AppError);
  assert.equal(err.status, 401);
  assert.equal(err.name, "WorkspaceError");
});

test("ZodError becomes 400 invalid_request with path and message only", async () => {
  const err = catchOf(() =>
    z.strictObject({ a: z.strictObject({ b: z.string() }) }).parse({ a: { b: 1 } })
  );
  const { status, body } = await bodyOf(err);
  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
  assert.equal(body.error, "The request was not valid.");
  const issues = (body.details as { issues: { path: string; message: string }[] }).issues;
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, "a.b");
  assert.equal(typeof issues[0].message, "string");
  assert.equal("received" in issues[0], false);
});

test("each SpendRefused reason maps to its status, code and copy", async () => {
  const cases: Array<{
    reason: "feature_disabled" | "daily_cap" | "workspace_cap" | "over_approved_max";
    status: number;
    message: string;
    recovery?: string;
    details?: Record<string, unknown>;
  }> = [
    {
      reason: "feature_disabled",
      status: 403,
      message: "This feature is not enabled for your workspace.",
    },
    {
      reason: "daily_cap",
      status: 402,
      message: "Today's spend limit for this workspace has been reached.",
      recovery: "Try again tomorrow or ask the workspace owner to raise the limit.",
    },
    {
      reason: "workspace_cap",
      status: 402,
      message: "This month's spend limit for this workspace has been reached.",
    },
    {
      reason: "over_approved_max",
      status: 409,
      message: "This now costs more than you approved. Review the new price.",
      details: { estimateUsd: 0.4 },
    },
  ];
  for (const entry of cases) {
    const { status, body } = await bodyOf(
      new SpendRefused(entry.reason, entry.details ? { estimateUsd: 0.4 } : undefined)
    );
    assert.equal(status, entry.status, entry.reason);
    assert.equal(body.code, entry.reason);
    assert.equal(body.error, entry.message);
    assert.equal(body.recovery, entry.recovery);
    if (entry.details) assert.deepEqual(body.details, entry.details);
  }
});

test("an unparseable request body becomes 400 invalid_json", async () => {
  const request = new Request("https://app.test/api/x", { method: "POST", body: "{" });
  const err = await readJsonBody(request).then(
    () => {
      throw new Error("expected a throw");
    },
    (thrown: unknown) => thrown
  );
  const { status, body } = await bodyOf(err);
  assert.equal(status, 400);
  assert.equal(body.code, "invalid_json");
  assert.equal(body.error, "The request body must be JSON.");
});

test("readJsonBody returns the parsed body", async () => {
  const request = new Request("https://app.test/api/x", { method: "POST", body: '{"a":1}' });
  assert.deepEqual(await readJsonBody(request), { a: 1 });
});

test("a body failure that is not a parse failure is rethrown, not a 400", async () => {
  const request = new Request("https://app.test/api/x", { method: "POST", body: '{"a":1}' });
  await request.json();
  const err = await readJsonBody(request).then(
    () => {
      throw new Error("expected a throw");
    },
    (thrown: unknown) => thrown
  );
  assert.equal(err instanceof AppError, false);
  const { status } = await bodyOf(err);
  assert.equal(status, 500);
});

test("an internal SyntaxError is a 500, not a client error", async () => {
  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const err = catchOf(() => JSON.parse("{"));
    const { status, body } = await bodyOf(err);
    assert.equal(status, 500);
    assert.equal(body.code, "internal_error");
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], "[http] unhandled");
    assert.equal(String(logged[0][1]).startsWith("SyntaxError:"), true);
  } finally {
    console.error = original;
  }
});

test("an unknown error becomes 500 without leaking its message", async () => {
  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const { status, body } = await bodyOf(new Error("secret-ish detail"));
    assert.equal(status, 500);
    assert.equal(body.code, "internal_error");
    assert.equal(body.error, "Something went wrong. Please retry.");
    assert.equal(JSON.stringify(body).includes("secret-ish"), false);
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], "[http] unhandled");
  } finally {
    console.error = original;
  }
});

test("every response carries Cache-Control: no-store and JSON", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const responses = [
      toErrorResponse(new AppError(400, "bad", "Bad.")),
      toErrorResponse(catchOf(() => z.object({ a: z.string() }).parse({}))),
      toErrorResponse(new AppError(400, "invalid_json", "The request body must be JSON.")),
      toErrorResponse(new Error("boom")),
      jsonOk({ ok: true }),
    ];
    for (const response of responses) {
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    }
  } finally {
    console.error = original;
  }
  assert.deepEqual(NO_STORE, { "Cache-Control": "no-store" });
});
