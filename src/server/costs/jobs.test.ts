import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryJobStore } from "../jobs/memoryStore.ts";
import { registerCostJobs, slot5m, pruneCostReconciliations } from "./jobs.ts";
import { listPeriodics } from "../jobs/periodic.ts";
import { getJobDefinition } from "../jobs/registry.ts";
import { runJob } from "../jobs/runner.ts";
import { enqueueSystemJob } from "../jobs/enqueue.ts";

const AT = Date.parse("2026-10-21T09:00:00.000Z");

test("costs.sync: registerCostJobs registers one periodic and one job kind, idempotent on repeat call", () => {
  const store = createMemoryJobStore({ now: () => AT });
  registerCostJobs({ store });
  registerCostJobs({ store });

  const def = getJobDefinition("costs.sync");
  assert.ok(def, "costs.sync job kind must be registered");

  const matchingJobs = ["costs.sync"].filter((k) => getJobDefinition(k) !== undefined);
  assert.equal(matchingJobs.length, 1);

  const matchingPeriodics = listPeriodics().filter((p) => p.name === "costs.sync");
  assert.equal(matchingPeriodics.length, 1, "exactly one periodic registered");
  assert.equal(matchingPeriodics[0].everySeconds, 300);
});

test("costs.sync: periodic dedupe key is stable within a 5-minute slot and advances after", async () => {
  const store = createMemoryJobStore({ now: () => AT });
  registerCostJobs({ store });

  const periodic = listPeriodics().find((p) => p.name === "costs.sync");
  assert.ok(periodic, "costs.sync periodic must be found");

  const t0 = new Date(AT);
  const t2m = new Date(AT + 2 * 60_000);
  const t5m = new Date(AT + 5 * 60_000);

  assert.equal(slot5m(t0), slot5m(t2m), "same 5-minute slot has identical slot key");
  assert.notEqual(slot5m(t0), slot5m(t5m), "subsequent 5-minute slot advances slot key");

  await periodic.run(t0);
  await periodic.run(t2m);

  const queued1 = [...store.jobs.values()].filter((j) => j.kind === "costs.sync");
  assert.equal(queued1.length, 1, "same 5-minute slot enqueues once");
  assert.equal(queued1[0].dedupe_key, `costs.sync:${slot5m(t0)}`);

  await periodic.run(t5m);
  const queued2 = [...store.jobs.values()].filter((j) => j.kind === "costs.sync");
  assert.equal(queued2.length, 2, "next 5-minute slot enqueues a new job");
  assert.equal(queued2[1].dedupe_key, `costs.sync:${slot5m(t5m)}`);
});

test("costs.sync: execution calls settle_finished_scan_holds (limit 50) and sync_probe_attempt_costs (limit 1000) in order", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> | undefined }> = [];
  const fakeRpc = async (name: string, args?: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "settle_finished_scan_holds") return 3;
    if (name === "sync_probe_attempt_costs") return 42;
    return 0;
  };

  const store = createMemoryJobStore({ now: () => AT });
  registerCostJobs({ store, rpc: fakeRpc });

  const { jobId } = await enqueueSystemJob(
    "costs.sync",
    {},
    { dedupeKey: "costs.sync:test-run" },
    { store, now: () => AT, selfContinue: () => undefined }
  );
  assert.ok(jobId);

  await store.claimDue("test-owner", 1, 300, jobId);
  const claimed = (await store.getJob(jobId)) as NonNullable<Awaited<ReturnType<typeof store.getJob>>>;

  const outcome = await runJob(claimed, {
    store,
    owner: "test-owner",
    deadlineMs: AT + 120_000,
    now: () => AT,
    selfContinue: () => undefined,
  });

  assert.equal(outcome, "completed");

  assert.deepEqual(calls, [
    { name: "settle_finished_scan_holds", args: { p_limit: 50 } },
    { name: "sync_probe_attempt_costs", args: { p_limit: 1000 } },
  ]);

  const finished = await store.getJob(jobId);
  assert.deepEqual(finished?.result, { settled: 3, synced: 42 });

  const stepNames = [...store.steps.values()].filter((s) => s.job_id === jobId).map((s) => s.name);
  assert.deepEqual(stepNames, ["settle-scan-holds", "sync-attempts"]);
});

test("pruneCostReconciliations: invokes prune_cost_reconciliations RPC with correct before date and limit", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> | undefined }> = [];
  const fakeRpc = async (name: string, args?: Record<string, unknown>) => {
    calls.push({ name, args });
    return 15;
  };

  registerCostJobs({ rpc: fakeRpc });

  const cutoff = new Date(AT);
  const count = await pruneCostReconciliations(cutoff, 2500);

  assert.equal(count, 15);
  assert.deepEqual(calls, [
    {
      name: "prune_cost_reconciliations",
      args: { p_before: cutoff.toISOString(), p_limit: 2500 },
    },
  ]);
});
