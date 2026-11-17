import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AppError } from "../../shared/http/errors.ts";
import { cancelJob } from "./cancel.ts";
import { createMemoryJobStore } from "./memoryStore.ts";
import type { MemoryJob, MemoryJobStore } from "./memoryStore.ts";
import { defineJob } from "./registry.ts";
import { runJob, StepFailedError } from "./runner.ts";
import type { RunEnv, RunOutcome } from "./runner.ts";
import { DB_STEP, READ_STEP, SINGLE_ATTEMPT } from "./stepConfigs.ts";
import type { JobStore } from "./store.ts";
import type { JobRow } from "./types.ts";

const BRAND = "qa-brand.example";
const OWNER = "tick:qa";
const AT = Date.parse("2026-10-21T09:00:00.000Z");
const LEASE_SECONDS = 300;
const BUDGET_MS = 240_000;

type Harness = {
  store: MemoryJobStore;
  clock: { at(): number; advance(ms: number): void };
  continues: string[];
  logger: { lines: unknown[][]; error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
};

function harness(): Harness {
  let now = AT;
  const clock = {
    at: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
  const lines: unknown[][] = [];
  return {
    store: createMemoryJobStore({ now: clock.at }),
    clock,
    continues: [],
    logger: {
      lines,
      error: (...args: unknown[]) => {
        lines.push(args);
      },
      warn: (...args: unknown[]) => {
        lines.push(args);
      },
    },
  };
}

function env(h: Harness, overrides: Partial<RunEnv> = {}): RunEnv {
  return {
    store: h.store,
    owner: OWNER,
    deadlineMs: h.clock.at() + BUDGET_MS,
    now: h.clock.at,
    selfContinue: (jobId: string) => {
      h.continues.push(jobId);
    },
    logger: h.logger,
    ...overrides,
  };
}

function jobOf(h: Harness, jobId: string): MemoryJob {
  const job = h.store.jobs.get(jobId);
  assert.ok(job, "the job row must exist");
  return job;
}

async function claim(h: Harness, jobId: string): Promise<JobRow> {
  const claimed = await h.store.claimDue(OWNER, 1, LEASE_SECONDS, jobId);
  assert.equal(claimed.length, 1, "the job must be claimable");
  return claimed[0];
}

async function startJob(h: Harness, kind: string, payload: unknown = {}): Promise<JobRow> {
  const { jobId } = await h.store.enqueue({
    kind,
    brandKey: BRAND,
    payload,
    trigger: "manual",
    dedupeKey: null,
    singleActiveKey: null,
    runAt: null,
    createdBy: null,
    deadlineSeconds: 86_400,
    maxInvocations: null,
  });
  assert.ok(jobId, "the job must be enqueued");
  return await claim(h, jobId);
}

/** Puts a finished row back in the queue, as a crash before `job_finish` would. */
async function replay(h: Harness, jobId: string): Promise<JobRow> {
  const job = jobOf(h, jobId);
  job.status = "queued";
  job.lease_owner = null;
  job.lease_until = null;
  job.finished_at = null;
  job.run_at = h.clock.at();
  return await claim(h, jobId);
}

test("runner: a completed step is memoised and its function is never called again", async () => {
  const h = harness();
  let calls = 0;
  defineJob("test.memoise", async (ctx) => {
    const value = await ctx.step.do("count", READ_STEP, async () => {
      calls += 1;
      return { calls };
    });
    return { result: value };
  });

  const job = await startJob(h, "test.memoise");
  assert.equal(await runJob(job, env(h)), "completed");
  assert.equal(calls, 1);
  assert.deepEqual(jobOf(h, job.id).result, { calls: 1 });

  const first: RunOutcome = await runJob(await replay(h, job.id), env(h));
  assert.equal(first, "completed");
  assert.equal(calls, 1, "the memoised step is not run again");
  assert.deepEqual(jobOf(h, job.id).result, { calls: 1 });
  assert.equal(h.store.steps.get(job.id + ":count")?.attempts, 1);
});

test("runner: a billed step with retries is rejected before any store write", async () => {
  const h = harness();
  let caught: unknown;
  defineJob("test.billed_retries", async (ctx) => {
    try {
      await ctx.step.do("charge", { retries: 2, timeoutMs: 60_000, billed: true }, async () => "ok");
    } catch (err) {
      caught = err;
      throw err;
    }
    return {};
  });

  const job = await startJob(h, "test.billed_retries");
  assert.equal(await runJob(job, env(h)), "failed");
  assert.ok(caught instanceof AppError);
  assert.equal(caught.status, 500);
  assert.equal(caught.code, "billed_step_retries");
  assert.equal(jobOf(h, job.id).error_code, "billed_step_retries");
  assert.equal(h.store.steps.size, 0, "the definition check runs before any step write");
});

test("runner: a billed step found running on replay fails billed_step_interrupted and is not called again", async () => {
  const h = harness();
  let paidCalls = 0;
  defineJob("test.billed_interrupted", async (ctx) => {
    await ctx.step.do("charge", SINGLE_ATTEMPT, async () => {
      paidCalls += 1;
      return "charged";
    });
    return {};
  });

  const job = await startJob(h, "test.billed_interrupted");
  h.store.steps.set(job.id + ":charge", {
    job_id: job.id,
    name: "charge",
    step_kind: "do",
    status: "running",
    billed: true,
    attempts: 1,
    max_attempts: 1,
    timeout_ms: SINGLE_ATTEMPT.timeoutMs,
    output: null,
    error_code: null,
    error_message: null,
    wake_at: null,
    started_at: h.clock.at(),
    finished_at: null,
  });

  assert.equal(await runJob(job, env(h)), "failed");
  assert.equal(paidCalls, 0, "a billed call is never repeated");
  assert.equal(jobOf(h, job.id).error_code, "billed_step_interrupted");
  assert.equal(h.store.steps.get(job.id + ":charge")?.status, "failed");
  assert.equal(h.store.steps.get(job.id + ":charge")?.error_code, "billed_step_interrupted");
});

test("runner: a non-billed step retries with backoff, then fails step_attempts_exhausted", async () => {
  const h = harness();
  let attempts = 0;
  defineJob("test.retry", async (ctx) => {
    await ctx.step.do("flaky", { retries: 1, timeoutMs: 60_000 }, async () => {
      attempts += 1;
      if (attempts === 1) h.clock.advance(20_000);
      throw new Error("upstream 503");
    });
    return {};
  });

  const job = await startJob(h, "test.retry");
  assert.equal(await runJob(job, { ...env(h), deadlineMs: AT + 75_000 }), "yielded");
  const waiting = h.store.steps.get(job.id + ":flaky");
  assert.equal(waiting?.status, "retry_wait");
  assert.equal(waiting?.attempts, 1);
  assert.equal(waiting?.wake_at, AT + 24_000, "the retry is scheduled 2^attempt x 2 s out");
  assert.equal(jobOf(h, job.id).run_at, AT + 24_000);
  assert.deepEqual(h.continues, [job.id]);

  h.clock.advance(4_000);
  assert.equal(await runJob(await claim(h, job.id), env(h)), "failed");
  assert.equal(attempts, 2, "the retry re-runs the step once");
  assert.equal(jobOf(h, job.id).error_code, "step_attempts_exhausted");
  assert.equal(h.store.steps.get(job.id + ":flaky")?.status, "failed");
  assert.equal(h.store.steps.get(job.id + ":flaky")?.attempts, 2);
});

test("runner: step.sleep yields the job with run_at and resumes without re-running earlier steps", async () => {
  const h = harness();
  let before = 0;
  let after = 0;
  defineJob("test.sleep", async (ctx) => {
    await ctx.step.do("before", READ_STEP, async () => {
      before += 1;
      return { before };
    });
    await ctx.step.sleep("pause", 60);
    await ctx.step.do("after", READ_STEP, async () => {
      after += 1;
      return { after };
    });
    return { result: { before, after } };
  });

  const job = await startJob(h, "test.sleep");
  assert.equal(await runJob(job, env(h)), "yielded");
  assert.equal(jobOf(h, job.id).run_at, AT + 60_000);
  assert.equal(jobOf(h, job.id).lease_owner, null);
  assert.equal(h.store.steps.get(job.id + ":pause")?.status, "sleeping");

  h.clock.advance(60_000);
  assert.equal(await runJob(await claim(h, job.id), env(h)), "completed");
  assert.equal(before, 1, "the step before the sleep is not run again");
  assert.equal(after, 1);
  assert.deepEqual(jobOf(h, job.id).result, { before: 1, after: 1 });
  assert.equal(h.store.steps.get(job.id + ":pause")?.status, "completed");
});

test("runner: a step that cannot finish inside the invocation budget yields and fires one self-continue", async () => {
  const h = harness();
  let ran = 0;
  defineJob("test.budget", async (ctx) => {
    await ctx.step.do("long", DB_STEP, async () => {
      ran += 1;
      return {};
    });
    return {};
  });

  const job = await startJob(h, "test.budget");
  assert.equal(await runJob(job, { ...env(h), deadlineMs: AT + 20_000 }), "yielded");
  assert.equal(ran, 0, "the step is not started");
  assert.deepEqual(h.continues, [job.id], "exactly one self-continue");
  assert.equal(jobOf(h, job.id).run_at, AT);
  assert.equal(jobOf(h, job.id).lease_owner, null);
  assert.equal(h.store.steps.size, 0);
});

test("runner: a step output over 64 KB fails the step with step_output_too_large", async () => {
  const h = harness();
  defineJob("test.output_too_large", async (ctx) => {
    await ctx.step.do("blob", READ_STEP, async () => "x".repeat(70_000));
    return {};
  });

  const job = await startJob(h, "test.output_too_large");
  assert.equal(await runJob(job, env(h)), "failed");
  assert.equal(jobOf(h, job.id).error_code, "step_output_too_large");
  assert.equal(h.store.steps.get(job.id + ":blob")?.error_code, "step_output_too_large");
});

test("runner: a step output that is not JSON fails the step with step_output_not_json", async () => {
  const h = harness();
  defineJob("test.output_not_json", async (ctx) => {
    await ctx.step.do("circular", READ_STEP, async () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    });
    return {};
  });

  const job = await startJob(h, "test.output_not_json");
  assert.equal(await runJob(job, env(h)), "failed");
  assert.equal(jobOf(h, job.id).error_code, "step_output_not_json");
  assert.equal(h.store.steps.get(job.id + ":circular")?.error_code, "step_output_not_json");
});

test("runner: a cancellation requested mid-run stops the job before the next step", async () => {
  const h = harness();
  let second = 0;
  defineJob("test.cancel", async (ctx) => {
    await ctx.step.do("first", READ_STEP, async () => 1);
    const outcome = await cancelJob(ctx.jobId, { store: h.store });
    assert.equal(outcome, "cancel_requested");
    h.clock.advance(6_000);
    await ctx.step.do("second", READ_STEP, async () => {
      second += 1;
      return 2;
    });
    return {};
  });

  const job = await startJob(h, "test.cancel");
  assert.equal(await runJob(job, env(h)), "cancelled");
  assert.equal(second, 0, "the step after the cancellation check never runs");
  assert.equal(jobOf(h, job.id).status, "cancelled");
  assert.equal(jobOf(h, job.id).error_code, "cancelled");
  assert.equal(h.store.steps.has(job.id + ":second"), false);
});

test("runner: a cancellation requested mid-run stops the job before the next sleep", async () => {
  const h = harness();
  defineJob("test.cancel_sleep", async (ctx) => {
    await ctx.step.do("first", READ_STEP, async () => 1);
    const outcome = await cancelJob(ctx.jobId, { store: h.store });
    assert.equal(outcome, "cancel_requested");
    h.clock.advance(6_000);
    await ctx.step.sleep("wait", 3_600);
    return {};
  });

  const job = await startJob(h, "test.cancel_sleep");
  assert.equal(await runJob(job, env(h)), "cancelled");
  assert.equal(h.store.steps.has(job.id + ":wait"), false, "the sleep is never registered");
  assert.equal(jobOf(h, job.id).status, "cancelled");
  assert.equal(jobOf(h, job.id).error_code, "cancelled");
});

test("runner: ctx.cancelRequested() reads through the 5 s cache and sees the flag once it expires", async () => {
  const h = harness();
  const seen: boolean[] = [];
  defineJob("test.cancel_poll", async (ctx) => {
    const poll = ctx.cancelRequested;
    assert.ok(poll);
    seen.push(await poll());
    await cancelJob(ctx.jobId, { store: h.store });
    seen.push(await poll());
    h.clock.advance(5_001);
    seen.push(await poll());
    return { status: "partial", result: { stopped: true } };
  });

  const job = await startJob(h, "test.cancel_poll");
  assert.equal(await runJob(job, env(h)), "partial");
  assert.deepEqual(seen, [false, false, true]);
  assert.notEqual(jobOf(h, job.id).cancel_requested_at, null);
  assert.deepEqual(jobOf(h, job.id).result, { stopped: true });
});

test("runner: a StepFailedError caught by the handler lets the job finish partial", async () => {
  const h = harness();
  defineJob("test.step_failed", async (ctx) => {
    try {
      await ctx.step.do("boom", { retries: 0, timeoutMs: 60_000 }, async () => {
        throw new Error("provider down");
      });
    } catch (err) {
      assert.ok(err instanceof StepFailedError);
      assert.equal(err.code, "step_attempts_exhausted");
      return { status: "partial", result: { skipped: true } };
    }
    return {};
  });

  const job = await startJob(h, "test.step_failed");
  assert.equal(await runJob(job, env(h)), "partial");
  assert.equal(jobOf(h, job.id).status, "partial");
  assert.equal(jobOf(h, job.id).error_code, null);
  assert.deepEqual(jobOf(h, job.id).result, { skipped: true });
  const step = h.store.steps.get(job.id + ":boom");
  assert.equal(step?.status, "failed");
  assert.equal(step?.error_code, "step_attempts_exhausted");
  assert.equal(step?.error_message, "provider down");
});

test("runner: an unknown kind finishes failed with unknown_job_kind", async () => {
  const h = harness();
  const job = await startJob(h, "test.not_registered");
  assert.equal(await runJob(job, env(h)), "failed");
  assert.equal(jobOf(h, job.id).status, "failed");
  assert.equal(jobOf(h, job.id).error_code, "unknown_job_kind");
  assert.equal(h.store.steps.size, 0);
});

test("runner: a payload that fails payloadSchema finishes failed with invalid_payload", async () => {
  const h = harness();
  let handled = 0;
  defineJob(
    "test.payload",
    async () => {
      handled += 1;
      return {};
    },
    { payloadSchema: z.object({ query: z.string() }) }
  );

  const job = await startJob(h, "test.payload", { query: 42 });
  assert.equal(await runJob(job, env(h)), "failed");
  assert.equal(handled, 0);
  assert.equal(jobOf(h, job.id).error_code, "invalid_payload");
  assert.equal(h.store.steps.size, 0);
});

test("runner: a writer whose lease is gone stops on lost_lease without writing anything", async () => {
  const h = harness();
  let ran = 0;
  defineJob("test.lost_lease", async (ctx) => {
    await ctx.step.do("work", READ_STEP, async () => {
      ran += 1;
      return {};
    });
    return {};
  });

  const job = await startJob(h, "test.lost_lease");
  const before = { ...jobOf(h, job.id) };
  assert.equal(await runJob(job, env(h, { owner: "tick:someone-else" })), "lost_lease");
  assert.equal(ran, 0);
  assert.deepEqual(jobOf(h, job.id), before);
  assert.equal(h.store.steps.size, 0);
});

test("runner: a step completion the store refuses ends lost_lease and writes no finish", async () => {
  const h = harness();
  let ran = 0;
  let finishes = 0;
  defineJob("test.fence_complete", async (ctx) => {
    await ctx.step.do("work", READ_STEP, async () => {
      ran += 1;
      return { ok: true };
    });
    return {};
  });

  const job = await startJob(h, "test.fence_complete");
  const fenced: JobStore = {
    ...h.store,
    stepComplete: async () => false,
    finish: async (args) => {
      finishes += 1;
      return await h.store.finish(args);
    },
  };
  assert.equal(await runJob(job, env(h, { store: fenced })), "lost_lease");
  assert.equal(ran, 1);
  assert.equal(finishes, 0, "a lost lease never writes the finish");
  assert.equal(jobOf(h, job.id).status, "running");
  assert.equal(jobOf(h, job.id).finished_at, null);
  assert.equal(h.store.steps.get(job.id + ":work")?.status, "running");
});

test("runner: the last throttled progress is flushed before the job finishes", async () => {
  const h = harness();
  const writes: Array<{ done: number; total: number }> = [];
  defineJob("test.progress_flush", async (ctx) => {
    await ctx.progress(1, 10, "starting");
    // Inside the throttle window, so neither of these writes on its own.
    await ctx.progress(5, 10, "half");
    await ctx.progress(10, 10, "done");
    return {};
  });

  const job = await startJob(h, "test.progress_flush");
  const counted: JobStore = {
    ...h.store,
    progress: async (jobId, owner, done, total, label, leaseSeconds) => {
      writes.push({ done, total });
      return await h.store.progress(jobId, owner, done, total, label, leaseSeconds);
    },
  };
  assert.equal(await runJob(job, env(h, { store: counted })), "completed");
  assert.deepEqual(writes, [
    { done: 1, total: 10 },
    { done: 10, total: 10 },
  ]);
  assert.equal(jobOf(h, job.id).progress_done, 10);
  assert.equal(jobOf(h, job.id).progress_label, "done");
});

test("runner: a progress write the store fences ends lost_lease and writes no finish", async () => {
  const h = harness();
  let after = 0;
  let finishes = 0;
  defineJob("test.progress_fence", async (ctx) => {
    await ctx.progress(1, 2);
    after += 1;
    return {};
  });

  const job = await startJob(h, "test.progress_fence");
  const fenced: JobStore = {
    ...h.store,
    progress: async () => false,
    finish: async (args) => {
      finishes += 1;
      return await h.store.finish(args);
    },
  };
  assert.equal(await runJob(job, env(h, { store: fenced })), "lost_lease");
  assert.equal(after, 0, "a lost lease stops the handler");
  assert.equal(finishes, 0);
  assert.equal(jobOf(h, job.id).status, "running");
});

test("runner: a finish that throws is reported lost, not completed", async () => {
  const h = harness();
  defineJob("test.finish_throws", async () => ({}));

  const job = await startJob(h, "test.finish_throws");
  const broken: JobStore = {
    ...h.store,
    finish: async () => {
      throw new Error("PostgREST unreachable");
    },
  };
  assert.equal(await runJob(job, env(h, { store: broken })), "lost_lease");
  // The row is still the watchdog's to reconcile.
  assert.equal(jobOf(h, job.id).status, "running");
  assert.equal(jobOf(h, job.id).finished_at, null);
  assert.equal(h.logger.lines.length, 1);
});

test("runner: a retry the store calls exhausted fails with the code on the row", async () => {
  const h = harness();
  defineJob("test.exhausted_code", async (ctx) => {
    await ctx.step.do("work", { ...READ_STEP, retries: 2 }, async () => {
      throw new AppError(502, "provider_unavailable", "The provider is down.");
    });
    return {};
  });

  const job = await startJob(h, "test.exhausted_code");
  // The store's own budget is shorter than the step's, as a raised `retries`
  // leaves it after a deploy.
  const exhausted: JobStore = { ...h.store, stepFail: async () => "failed" };
  assert.equal(await runJob(job, env(h, { store: exhausted })), "failed");
  assert.equal(jobOf(h, job.id).error_code, "provider_unavailable");
});
