import test from "node:test";
import assert from "node:assert/strict";
import { getJobDefinition } from "../jobs/registry.ts";
import { listPeriodics } from "../jobs/periodic.ts";
import "./jobs.ts";

test("periodic indexnow.retention is registered with 86400s", () => {
  const periodics = listPeriodics();
  const indexnowPeriodic = periodics.find((p) => p.name === "indexnow.retention");
  assert.ok(indexnowPeriodic);
  assert.equal(indexnowPeriodic.everySeconds, 86400);
});

test("job indexnow.retention runs prune loop and terminates when batch < 5000", async () => {
  const def = getJobDefinition("indexnow.retention");
  assert.ok(def);

  let calls = 0;
  const mockAdmin: any = {
    rpc: async (fn: string, params: any) => {
      assert.equal(fn, "prune_indexnow");
      assert.equal(params.p_limit, 5000);
      assert.ok(params.p_submissions_before);
      assert.ok(params.p_checks_before);
      calls++;
      if (calls === 1) {
        // First batch full
        return { data: { submissions: 5000, checks: 1200 }, error: null };
      }
      // Second batch partial -> should break
      return { data: { submissions: 320, checks: 45 }, error: null };
    },
  };

  const executedSteps: string[] = [];
  const fakeCtx: any = {
    jobId: "job-1",
    step: {
      do: async (name: string, _opts: any, fn: () => Promise<any>) => {
        executedSteps.push(name);
        return await fn();
      },
    },
  };

  // Re-register with mockAdmin for test
  const { registerIndexNowJobs } = await import("./jobs.ts");
  registerIndexNowJobs({ admin: mockAdmin });

  const result = await def.handler(fakeCtx);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.result, {
    submissions: 5320,
    checks: 1245,
  });
  assert.deepEqual(executedSteps, ["prune-1", "prune-20".replace("20", "2")]);
  assert.equal(calls, 2);
});
