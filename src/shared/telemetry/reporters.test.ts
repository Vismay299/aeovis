import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AppError } from "../http/appError.ts";
import { toErrorResponse } from "../http/errors.ts";
import { reportServerError, setServerErrorReporter } from "./reporters.ts";
import { currentTelemetryContext, runWithTelemetryContext } from "./context.ts";
import { createMemoryJobStore } from "../../server/jobs/memoryStore.ts";
import { defineJob } from "../../server/jobs/registry.ts";
import { runJob } from "../../server/jobs/runner.ts";
import type { JobRow } from "../../server/jobs/types.ts";

function silenceConsoleError() {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}

test("reportServerError is a no-op until set and never throws", () => {
  setServerErrorReporter(null);
  assert.doesNotThrow(() => reportServerError(new Error("boom"), { error_code: "internal_error" }));
  setServerErrorReporter(() => {
    throw new Error("reporter boom");
  });
  assert.doesNotThrow(() => reportServerError(new Error("x"), { error_code: "y" }));
  setServerErrorReporter(null);
});

test("F26-AC-10 toErrorResponse(new Error) reports 500 with internal_error", async () => {
  const calls: Array<{ err: unknown; props: Record<string, string> }> = [];
  setServerErrorReporter((err, props) => {
    calls.push({ err, props });
  });
  const restore = silenceConsoleError();
  try {
    const response = toErrorResponse(new Error("boom"));
    assert.equal(response.status, 500);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].props, { error_code: "internal_error" });
    assert.equal(calls[0].err instanceof Error, true);
  } finally {
    restore();
    setServerErrorReporter(null);
  }
});

test("F26-AC-10 AppError 404 does not report", async () => {
  const calls: unknown[] = [];
  setServerErrorReporter((err, props) => {
    calls.push({ err, props });
  });
  try {
    const response = toErrorResponse(new AppError(404, "not_found", "Missing."));
    assert.equal(response.status, 404);
    assert.equal(calls.length, 0);
  } finally {
    setServerErrorReporter(null);
  }
});

test("F26-AC-10 AppError 500 reports its code", async () => {
  const calls: Array<{ err: unknown; props: Record<string, string> }> = [];
  setServerErrorReporter((err, props) => {
    calls.push({ err, props });
  });
  const restore = silenceConsoleError();
  try {
    const response = toErrorResponse(new AppError(500, "internal_error", "Broken."));
    assert.equal(response.status, 500);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].props, { error_code: "internal_error" });
  } finally {
    restore();
    setServerErrorReporter(null);
  }
});

test("F26-AC-10 job throw reports with job_kind", async () => {
  const calls: Array<{ err: unknown; props: Record<string, string> }> = [];
  setServerErrorReporter((err, props) => {
    calls.push({ err, props });
  });
  const now = Date.parse("2026-10-21T09:00:00.000Z");
  const store = createMemoryJobStore({ now: () => now });
  defineJob("test.f26_reporter_throw", async () => {
    throw new Error("handler boom with secret should not be asserted");
  });
  const { jobId } = await store.enqueue({
    kind: "test.f26_reporter_throw",
    brandKey: "qa-brand",
    payload: {},
    trigger: "manual",
    dedupeKey: null,
    singleActiveKey: null,
    runAt: null,
    createdBy: "user-1",
    deadlineSeconds: 86_400,
    maxInvocations: null,
  });
  const claimed = await store.claimDue("tick:qa", 1, 300, jobId);
  assert.equal(claimed.length, 1);
  const job = claimed[0] as JobRow;
  try {
    const outcome = await runJob(job, {
      store,
      owner: "tick:qa",
      deadlineMs: now + 240_000,
      now: () => now,
      selfContinue: () => {},
    });
    assert.equal(outcome, "failed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].props.job_kind, "test.f26_reporter_throw");
    assert.equal(calls[0].props.error_code, "job_failed");
    // The report carries type/code only: assert the harness error object, not content.
    assert.ok(calls[0].err instanceof Error);
  } finally {
    setServerErrorReporter(null);
  }
});

test("F26-AC-10 onRequestError passes only routePath sliced to 64", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../../instrumentation.ts"), "utf8");
  assert.match(src, /route:\s*String\(context\?\.routePath \?\? "unknown"\)\.slice\(0,\s*64\)/);
  // The request (path, headers) is never read: no property access on the request arg.
  assert.equal(/_request\./.test(src), false);
  assert.equal(/request\.headers/.test(src), false);
  assert.equal(/request\.url/.test(src), false);
  assert.equal(src.includes("routePath"), true);
});

test("F26-AC-10 telemetry context isolation still holds", async () => {
  const seenA: string[] = [];
  const seenB: string[] = [];
  await Promise.all([
    runWithTelemetryContext({ userId: "user-a", brandKey: "brand-a" }, async () => {
      seenA.push(currentTelemetryContext().userId ?? "");
      await new Promise((r) => setTimeout(r, 10));
      seenA.push(currentTelemetryContext().userId ?? "");
    }),
    runWithTelemetryContext({ userId: "user-b", brandKey: "brand-b" }, async () => {
      seenB.push(currentTelemetryContext().userId ?? "");
      await new Promise((r) => setTimeout(r, 5));
      seenB.push(currentTelemetryContext().userId ?? "");
    }),
  ]);
  assert.deepEqual(seenA, ["user-a", "user-a"]);
  assert.deepEqual(seenB, ["user-b", "user-b"]);
});
