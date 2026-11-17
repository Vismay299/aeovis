import test from "node:test";
import assert from "node:assert/strict";
import { MAX_POLL_SECONDS, MIN_POLL_SECONDS, pollAfterFor } from "./status.ts";
import type { JobRow, JobStatus } from "./types.ts";

const NOW = Date.parse("2026-10-21T09:00:00.000Z");

function row(patch: Partial<JobRow> = {}): JobRow {
  return {
    id: "5b0d6f6e-9a8b-4a45-9a51-0e7e8f1c2d3a",
    brand_key: "qa-brand.example",
    kind: "test.job",
    payload: {},
    trigger: "manual",
    status: "running",
    dedupe_key: null,
    single_active_key: null,
    run_at: new Date(NOW - 1_000).toISOString(),
    deadline_at: new Date(NOW + 86_400_000).toISOString(),
    invocations: 1,
    max_invocations: 200,
    lease_owner: "tick:qa",
    lease_until: new Date(NOW + 300_000).toISOString(),
    progress_done: null,
    progress_total: null,
    progress_label: null,
    result: null,
    error_code: null,
    error_message: null,
    cancel_requested_at: null,
    created_by: null,
    created_at: new Date(NOW - 1_000).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    started_at: new Date(NOW - 1_000).toISOString(),
    heartbeat_at: new Date(NOW).toISOString(),
    finished_at: null,
    ...patch,
  };
}

const TERMINAL: JobStatus[] = ["completed", "partial", "failed", "cancelled"];

test("status: a terminal job polls never, even when the kind asks for an interval", () => {
  for (const status of TERMINAL) {
    const job = row({ status, run_at: new Date(NOW + 30_000).toISOString() });
    assert.equal(pollAfterFor(job, { pollAfterSeconds: 30 }, NOW), null, status);
  }
});

test("status: a job due later polls on its own delay, clamped to 5–60 s", () => {
  const sleeping = row({ status: "running", run_at: new Date(NOW + 20_000).toISOString() });
  assert.equal(pollAfterFor(sleeping, undefined, NOW), 20);

  const queued = row({ status: "queued", run_at: new Date(NOW + 1_000).toISOString() });
  assert.equal(pollAfterFor(queued, undefined, NOW), MIN_POLL_SECONDS);

  const far = row({ status: "queued", run_at: new Date(NOW + 300_000).toISOString() });
  assert.equal(pollAfterFor(far, undefined, NOW), MAX_POLL_SECONDS);
});

test("status: a running manual job polls every 5 s", () => {
  assert.equal(pollAfterFor(row({ status: "running", trigger: "manual" }), undefined, NOW), 5);
});

test("status: a running scheduled job polls every 20 s", () => {
  assert.equal(pollAfterFor(row({ status: "running", trigger: "scheduled" }), undefined, NOW), 20);
});

test("status: a kind's pollAfterSeconds overrides the trigger default", () => {
  assert.equal(pollAfterFor(row({ status: "running", trigger: "manual" }), { pollAfterSeconds: 30 }, NOW), 30);
  assert.equal(pollAfterFor(row({ status: "running", trigger: "scheduled" }), { pollAfterSeconds: 12 }, NOW), 12);
});

test("status: a kind's pollAfterSeconds is clamped to 5–60 s", () => {
  assert.equal(pollAfterFor(row({ status: "running" }), { pollAfterSeconds: 1 }, NOW), MIN_POLL_SECONDS);
  assert.equal(pollAfterFor(row({ status: "running" }), { pollAfterSeconds: 90 }, NOW), MAX_POLL_SECONDS);
});
