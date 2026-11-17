/**
 * R3.1.6 — the two production failures found by the 2026-09-15 scan
 * (job 8e25a0fe, stuck at 90% with three skipped finalize runs):
 *
 *   1. A finalize claim held by a DEAD instance never expired, so every
 *      rescue lost the claim and the job could never complete.
 *   2. The self-continue request carried no Deployment Protection bypass, so
 *      with Vercel Authentication on it was answered by an SSO redirect and
 *      the next chunk never started.
 *
 * No network, no database: the Supabase client and the clock are injected.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { HEARTBEAT_STALE_MS, reclaimStaleFinalize } from "../db.js";
import { buildSelfContinueInit, runFinalizePhase } from "./scanWorker.js";

// ---------------------------------------------------------------------------
// 1. The stale finalize claim
// ---------------------------------------------------------------------------

/** A client whose scan_jobs UPDATE honours eq/lt filters against one row. */
function clientForJob(row) {
  const calls = [];
  return {
    calls,
    client: {
      from(table) {
        const state = { table, values: null, filters: [] };
        const builder = {
          update(values) {
            state.values = values;
            return builder;
          },
          eq(col, val) {
            state.filters.push(["eq", col, val]);
            return builder;
          },
          lt(col, val) {
            state.filters.push(["lt", col, val]);
            return builder;
          },
          select() {
            return builder;
          },
          then(resolve) {
            calls.push({ table: state.table, values: state.values, filters: state.filters });
            const matches = state.filters.every(([op, col, val]) =>
              op === "eq" ? row[col] === val : new Date(row[col]).getTime() < new Date(val).getTime()
            );
            if (!matches) return resolve({ data: [], error: null });
            Object.assign(row, state.values);
            return resolve({ data: [{ ...row }], error: null });
          },
        };
        return builder;
      },
    },
  };
}

test("a finalize claim whose owner stopped heartbeating can be taken over", async () => {
  const row = {
    id: "job-1",
    status: "scoring",
    heartbeat_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  };
  const { client, calls } = clientForJob(row);

  const taken = await reclaimStaleFinalize("job-1", { client });
  assert.ok(taken, "a dead claim must be reclaimable, or the job can never finish");
  assert.equal(calls[0].table, "scan_jobs");
  assert.deepEqual(
    calls[0].filters,
    [
      ["eq", "id", "job-1"],
      ["eq", "status", "scoring"],
      ["lt", "heartbeat_at", calls[0].filters[2][2]],
    ],
    "the takeover must be ONE conditional update — status still scoring AND the beat stale"
  );
  assert.ok(calls[0].values.heartbeat_at, "taking over must stamp a fresh heartbeat");
  assert.equal(Object.keys(calls[0].values).length, 1, "it must not change status or anything else");
});

test("a LIVE finalize is never stolen", async () => {
  const row = { id: "job-1", status: "scoring", heartbeat_at: new Date().toISOString() };
  const { client } = clientForJob(row);
  assert.equal(await reclaimStaleFinalize("job-1", { client }), null);
});

test("a job that is not in scoring is not a finalize claim at all", async () => {
  const row = { id: "job-1", status: "probing", heartbeat_at: new Date(0).toISOString() };
  const { client } = clientForJob(row);
  assert.equal(await reclaimStaleFinalize("job-1", { client }), null);
});

test("two racers: the first takeover stamps a beat, so the second finds nothing to take", async () => {
  const row = {
    id: "job-1",
    status: "scoring",
    heartbeat_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  };
  const { client } = clientForJob(row);
  const first = await reclaimStaleFinalize("job-1", { client });
  const second = await reclaimStaleFinalize("job-1", { client });
  assert.ok(first);
  assert.equal(second, null, "exactly one instance may own the finalize");
});

test("the takeover window is the shared heartbeat staleness definition, and is overridable", async () => {
  const row = {
    id: "job-1",
    status: "scoring",
    heartbeat_at: new Date(Date.now() - HEARTBEAT_STALE_MS - 1000).toISOString(),
  };
  const { client } = clientForJob(row);
  assert.ok(await reclaimStaleFinalize("job-1", { client }), "just past the window is stale");

  const fresh = { id: "j2", status: "scoring", heartbeat_at: new Date(Date.now() - 30_000).toISOString() };
  const c2 = clientForJob(fresh);
  assert.equal(await reclaimStaleFinalize("j2", { client: c2.client }), null);
  assert.ok(
    await reclaimStaleFinalize("j2", { client: c2.client, staleAfterMs: 10_000 }),
    "a caller may narrow the window explicitly"
  );
});

test("memory mode (no client) takes over a stale claim and refuses a live one", async () => {
  global.memoryJobs = global.memoryJobs || new Map();
  global.memoryJobs.set("mem-1", { id: "mem-1", status: "scoring", heartbeat_at: new Date(0).toISOString() });
  assert.ok(await reclaimStaleFinalize("mem-1", { client: null }));
  global.memoryJobs.set("mem-2", { id: "mem-2", status: "scoring", heartbeat_at: new Date().toISOString() });
  assert.equal(await reclaimStaleFinalize("mem-2", { client: null }), null);
  global.memoryJobs.delete("mem-1");
  global.memoryJobs.delete("mem-2");
});

// ---------------------------------------------------------------------------
// runFinalizePhase's use of it — the actual stuck-job path
// ---------------------------------------------------------------------------

/** Deps that make runFinalizePhase reach the claim and stop there. */
function finalizeDeps(overrides) {
  return {
    getPromptResultsForJob: async () => [], // nothing stamped => the claim matters
    claimJobStatus: async () => null, // the claim is lost: someone owns "scoring"
    ...overrides,
  };
}

test("THE STUCK JOB — a lost claim that cannot be taken over still bails", async () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    const result = await runFinalizePhase("job-1", {}, finalizeDeps({ reclaimStaleFinalize: async () => null }));
    assert.equal(result, null, "a LIVE finalize elsewhere must still win");
    assert.ok(warnings.some((w) => /lost the finalize claim/.test(w)));
  } finally {
    console.warn = origWarn;
  }
});

test("THE FIX — a lost claim whose owner is dead is taken over, and finalize proceeds past the claim", async () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  let reclaimedFor = null;
  let proceeded = false;
  try {
    await runFinalizePhase(
      "job-1",
      {},
      finalizeDeps({
        reclaimStaleFinalize: async (jobId) => {
          reclaimedFor = jobId;
          return { id: jobId, status: "scoring", heartbeat_at: "2026-09-15T14:10:44.000Z" };
        },
        // Reached only if the claim branch did NOT return null. Throwing here
        // is how this test proves it got past the claim without running a real
        // finalize (which would need the whole scoring pipeline).
        updateScanJob: async () => {
          proceeded = true;
          throw new Error("STOP: past the claim");
        },
      })
    ).catch((err) => {
      if (!/STOP: past the claim/.test(err.message)) throw err;
    });
  } finally {
    console.warn = origWarn;
  }
  assert.equal(reclaimedFor, "job-1");
  assert.equal(proceeded, true, "the job that nothing could finish must now be finishable");
  assert.ok(
    warnings.some((w) => /TOOK OVER a finalize claim/.test(w)),
    "a takeover is a real event and must not be silent"
  );
});

// ---------------------------------------------------------------------------
// 2. The self-continue request's headers
// ---------------------------------------------------------------------------

test("self-continue carries the cron secret AND the protection bypass", () => {
  const { init, missingBypass } = buildSelfContinueInit({
    CRON_SECRET: "cron-value",
    VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-value",
    VERCEL: "1",
  });
  assert.deepEqual(init.headers, {
    "x-cron-secret": "cron-value",
    "x-vercel-protection-bypass": "bypass-value",
  });
  assert.equal(missingBypass, false);
});

test("on Vercel with no bypass secret the risk is disclosed, not assumed away", () => {
  const { init, missingBypass } = buildSelfContinueInit({ CRON_SECRET: "c", VERCEL: "1" });
  assert.deepEqual(init.headers, { "x-cron-secret": "c" });
  assert.equal(missingBypass, true, "this is the 2026-09-15 production failure — it must be visible");
});

test("off Vercel there is no protection in front of the function, so no warning", () => {
  const { missingBypass } = buildSelfContinueInit({ CRON_SECRET: "c" });
  assert.equal(missingBypass, false);
});

test("with nothing configured the request goes out bare rather than not at all", () => {
  const { init } = buildSelfContinueInit({});
  assert.equal(init, undefined);
});
