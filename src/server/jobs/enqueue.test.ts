import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../shared/http/errors.ts";
import { enqueueJob, enqueueSystemJob, MAX_PAYLOAD_BYTES } from "./enqueue.ts";
import type { EnqueueDeps } from "./enqueue.ts";
import { createMemoryJobStore } from "./memoryStore.ts";
import type { MemoryJob, MemoryJobStore } from "./memoryStore.ts";
import { defineJob } from "./registry.ts";

const BRAND = "qa-brand.example";
const AT = Date.parse("2026-10-21T09:00:00.000Z");

defineJob("test.enqueue", async () => ({}));
defineJob("test.enqueue_system", async () => ({}));

type Harness = {
  store: MemoryJobStore;
  continues: string[];
  deps: EnqueueDeps;
};

function harness(): Harness {
  const store = createMemoryJobStore({ now: () => AT });
  const continues: string[] = [];
  return {
    store,
    continues,
    deps: {
      store,
      now: () => AT,
      selfContinue: (jobId: string) => {
        continues.push(jobId);
      },
    },
  };
}

function jobOf(h: Harness, jobId: string): MemoryJob {
  const job = h.store.jobs.get(jobId);
  assert.ok(job, "the job row must exist");
  return job;
}

test("enqueue: a repeated dedupeKey returns the same job id with deduped: true", async () => {
  const h = harness();
  const first = await enqueueJob("test.enqueue", {}, { brandKey: BRAND, dedupeKey: "dedupe:1" }, h.deps);
  const again = await enqueueJob("test.enqueue", {}, { brandKey: BRAND, dedupeKey: "dedupe:1" }, h.deps);

  assert.equal(first.deduped, false);
  assert.equal(again.jobId, first.jobId);
  assert.equal(again.deduped, true);
  assert.equal(h.store.jobs.size, 1, "the dedupe writes no second row");
});

test("enqueue: a held singleActiveKey throws 409 job_already_running with the blocker id", async () => {
  const h = harness();
  const blocker = await enqueueJob("test.enqueue", {}, { brandKey: BRAND, singleActiveKey: "active:1" }, h.deps);

  await assert.rejects(
    enqueueJob("test.enqueue", {}, { brandKey: BRAND, singleActiveKey: "active:1" }, h.deps),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "job_already_running");
      assert.equal(err.details?.activeJobId, blocker.jobId);
      return true;
    }
  );
  assert.equal(h.store.jobs.size, 1, "the conflict writes no row");
});

test("enqueue: enqueueSystemJob writes a null brand and the system trigger", async () => {
  const h = harness();
  const { jobId } = await enqueueSystemJob("test.enqueue_system", {}, {}, h.deps);
  const job = jobOf(h, jobId);

  assert.equal(job.brand_key, null);
  assert.equal(job.trigger, "system");
});

test("enqueue: an unregistered kind throws unknown_job_kind", async () => {
  const h = harness();
  await assert.rejects(
    enqueueJob("test.not_registered", {}, { brandKey: BRAND }, h.deps),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "unknown_job_kind");
      return true;
    }
  );
  assert.equal(h.store.jobs.size, 0);
});

test("enqueue: a payload of 32 KB or more throws payload_too_large", async () => {
  const h = harness();
  await assert.rejects(
    enqueueJob("test.enqueue", { blob: "x".repeat(MAX_PAYLOAD_BYTES) }, { brandKey: BRAND }, h.deps),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "payload_too_large");
      return true;
    }
  );
  assert.equal(h.store.jobs.size, 0);
});

test("enqueue: the limit is bytes, so a multi-byte payload under 32 K characters is refused", async () => {
  const h = harness();
  // Three bytes per character in UTF-8, one UTF-16 unit each: this is well
  // under MAX_PAYLOAD_BYTES by `String.length` and well over it on the wire.
  const blob = "\u4e2d".repeat(Math.ceil(MAX_PAYLOAD_BYTES / 2));
  assert.ok(blob.length < MAX_PAYLOAD_BYTES, "the string must be short in UTF-16 units");
  await assert.rejects(
    enqueueJob("test.enqueue", { blob }, { brandKey: BRAND }, h.deps),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "payload_too_large");
      return true;
    }
  );
  assert.equal(h.store.jobs.size, 0);
});

test("enqueue: a fresh immediate enqueue fires one self-continue and a deduped one fires none", async () => {
  const h = harness();
  const first = await enqueueJob("test.enqueue", {}, { brandKey: BRAND, dedupeKey: "dedupe:2" }, h.deps);
  assert.deepEqual(h.continues, [first.jobId], "exactly one self-continue");

  const again = await enqueueJob("test.enqueue", {}, { brandKey: BRAND, dedupeKey: "dedupe:2" }, h.deps);
  assert.equal(again.deduped, true);
  assert.deepEqual(h.continues, [first.jobId], "a deduped enqueue schedules no run");
});
