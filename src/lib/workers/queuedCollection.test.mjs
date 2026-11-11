import assert from "node:assert/strict";
import test from "node:test";
import {
  COLLECT_WINDOW_MIN,
  POLL_OFFSETS_MIN,
  QUEUED_COLLECTION_READY,
  TASK_GET_CONCURRENCY,
  nextPollAt,
  runQueuedLane,
} from "./queuedCollection.js";

const BASE_MS = Date.parse("2026-11-11T00:00:00.000Z");
const env = { DATAFORSEO_API_KEY: "test-dfs-key" };

function checkpoint(rows, now = BASE_MS) {
  return {
    brand: "Acme",
    url: "https://acme.example",
    competitors: [],
    measurement_context: {
      country: "in",
      language: "en",
      device: "desktop",
      session_policy: "clean",
    },
    queries: rows.map((row) => ({ text: row.query, topic: "General", source: "test" })),
    dispatch: { deadline_at: new Date(now + 60 * 60_000).toISOString() },
    stats: { cost: 0 },
  };
}

function makeRows(count, engine = "chatgpt") {
  return Array.from({ length: count }, (_, index) => ({
    id: `observation-${index + 1}`,
    job_id: "job-queued-test",
    engine,
    query: `Question ${index + 1}?`,
    state: "pending",
    next_attempt_at: null,
    attempt_count: 0,
    total_cost: 0,
    unknown_cost_calls: 0,
  }));
}

function memoryStore(rows) {
  const calls = { claimed: [], posted: [], finished: [], collected: [], rescheduled: [] };
  const store = {
    calls,
    evidence: null,
    list: async () => rows,
    listPosted: async (jobId) => rows.filter((row) => row.job_id === jobId && row.state === "posted"),
    claim: async (id, budget) => {
      const row = rows.find((item) => item.id === id);
      calls.claimed.push({ id, budget });
      if (!row || !["pending", "retry"].includes(row.state)) return { granted: false, reason: row?.state || "missing" };
      row.state = "leased";
      row.attempt_count += 1;
      const lease_token = `token-${row.id}-${row.attempt_count}`;
      row.lease_token = lease_token;
      row.lease_until = new Date(BASE_MS + 120_000).toISOString();
      row.attempt = {
        lease_token,
        attempt_no: row.attempt_count,
        dispatch_state: "intent",
      };
      return { granted: true, lease_token, attempt_no: row.attempt_count };
    },
    post: async (id, token, taskId, cost, nextAt, collectUntil) => {
      const row = rows.find((item) => item.id === id);
      if (!row || row.state !== "leased" || row.lease_token !== token) {
        return { accepted: false, reason: "stale_lease" };
      }
      row.state = "posted";
      row.next_attempt_at = nextAt;
      row.total_cost += cost;
      row.attempt = {
        ...row.attempt,
        dispatch_state: "posted",
        provider_task_id: taskId,
        posted_at: new Date(BASE_MS).toISOString(),
        collect_until: collectUntil,
        charged_usd: cost,
      };
      calls.posted.push({ id, token, taskId, cost, nextAt, collectUntil });
      return { accepted: true, duplicate: false };
    },
    finish: async (id, token, result, decision) => {
      const row = rows.find((item) => item.id === id);
      row.state = decision.state;
      row.result = result;
      calls.finished.push({ id, token, result, decision });
      return { accepted: true };
    },
    collect: async (id, token, result, state, failure, nextAt, settledCost) => {
      const row = rows.find((item) => item.id === id);
      if (row.state === state && row.attempt?.dispatch_state === "recorded") {
        return { accepted: true, duplicate: true };
      }
      if (row.state !== "posted" || row.attempt?.lease_token !== token) {
        return { accepted: false, reason: "not_posted" };
      }
      const cost = Number.isFinite(settledCost) && settledCost >= 0 && settledCost <= row.attempt.charged_usd
        ? settledCost
        : row.attempt.charged_usd;
      row.total_cost += cost - row.attempt.charged_usd;
      row.state = state;
      row.next_attempt_at = nextAt;
      row.result = { ...result, cost };
      row.reason = failure?.kind ?? null;
      row.attempt = { ...row.attempt, dispatch_state: "recorded", charged_usd: cost, result: row.result };
      calls.collected.push({ id, token, result: row.result, state, failure, nextAt, settledCost });
      return { accepted: true, duplicate: false };
    },
    reschedule: async (id, token, nextAt) => {
      const row = rows.find((item) => item.id === id);
      assert.equal(row.state, "posted");
      assert.equal(row.attempt.lease_token, token);
      row.next_attempt_at = nextAt;
      calls.rescheduled.push({ id, token, nextAt });
      return true;
    },
  };
  return store;
}

function apiResponse(tasks) {
  return new Response(JSON.stringify({ status_code: 20000, tasks }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function runLane(rows, store, fetch, now = BASE_MS) {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await runQueuedLane({
      engine: rows[0]?.engine || "chatgpt",
      rows,
      cp: checkpoint(rows, now),
      store,
      budget: { reserve: 0.2, scanCap: 5, dayCap: null },
      now: () => now,
      env,
      chunkStartMs: now - 1000,
      budgetMs: 70_000,
      tally: {},
    });
  } finally {
    globalThis.fetch = priorFetch;
  }
}

test("F02-AC-28: one queued task_post accepts a 32-row engine lane", async () => {
  const rows = makeRows(32);
  const store = memoryStore(rows);
  let posts = 0;
  let postBody = [];
  await runLane(rows, store, async (_url, init) => {
    posts++;
    postBody = JSON.parse(String(init.body));
    return apiResponse(postBody.map((body) => ({
      id: `task-${body.tag}`,
      status_code: 20100,
      cost: 0.0012,
      data: { tag: body.tag },
    })));
  });
  assert.equal(QUEUED_COLLECTION_READY, true);
  assert.equal(TASK_GET_CONCURRENCY, 25);
  assert.equal(posts, 1);
  assert.equal(postBody.length, 32);
  assert.equal(store.calls.posted.length, 32);
  assert.equal(store.calls.finished.length, 0);
  assert.equal(store.calls.claimed[0].budget.leaseSeconds, 120);
  assert.equal(rows.every((row) => row.state === "posted"), true);
});

test("F02-AC-28: queued lanes over 100 rows post further batches while budget remains", async () => {
  const rows = makeRows(101);
  const store = memoryStore(rows);
  const batchSizes = [];
  await runLane(rows, store, async (_url, init) => {
    const body = JSON.parse(String(init.body));
    batchSizes.push(body.length);
    return apiResponse(body.map((entry) => ({
      id: `task-${entry.tag}`,
      status_code: 20100,
      cost: 0.0012,
      data: { tag: entry.tag },
    })));
  });
  assert.deepEqual(batchSizes, [100, 1]);
  assert.equal(store.calls.posted.length, 101);
  assert.equal(rows.every((row) => row.state === "posted"), true);
});

test("F02-AC-28: rejected task_post entries finish with the provider cost", async () => {
  const rows = makeRows(2);
  const store = memoryStore(rows);
  await runLane(rows, store, async (_url, init) => {
    const body = JSON.parse(String(init.body));
    return apiResponse(body.map((entry, index) => index === 0
      ? { id: `task-${entry.tag}`, status_code: 20100, cost: 0.0012, data: { tag: entry.tag } }
      : { status_code: 40501, status_message: "No Search Results.", cost: 0.0004, data: { tag: entry.tag } }));
  });
  assert.equal(store.calls.posted.length, 1);
  assert.equal(store.calls.finished.length, 1);
  assert.equal(store.calls.finished[0].result.cost, 0.0004);
  assert.equal(store.calls.finished[0].decision.state, "failed");
});

test("F02-AC-28: ambiguous task_post leaves leases unfinished for the SQL fence", async () => {
  const rows = makeRows(1);
  const store = memoryStore(rows);
  const result = await runLane(rows, store, async () => { throw new Error("connection lost"); });
  assert.equal(store.calls.finished.length, 0);
  assert.equal(store.calls.posted.length, 0);
  assert.equal(rows[0].state, "leased");
  assert.equal(result.budgetHit, true);
});

test("F02-AC-28: poll offsets are cumulative and stop at the 30-minute window", () => {
  assert.deepEqual(POLL_OFFSETS_MIN, [2, 4, 7, 10, 14, 18, 22, 26, 30]);
  assert.equal(COLLECT_WINDOW_MIN, 30);
  assert.equal(nextPollAt(BASE_MS, BASE_MS), new Date(BASE_MS + 2 * 60_000).toISOString());
  assert.equal(nextPollAt(BASE_MS, BASE_MS + 2 * 60_000), new Date(BASE_MS + 4 * 60_000).toISOString());
  assert.equal(nextPollAt(BASE_MS, BASE_MS + 30 * 60_000), null);
});

test("F02-AC-28: backend-failed task becomes a retry without losing the posted charge", async () => {
  const rows = makeRows(1);
  const store = memoryStore(rows);
  await runLane(rows, store, async (_url, init) => {
    const body = JSON.parse(String(init.body));
    return apiResponse([{ id: "task-1", status_code: 20100, cost: 0.0012, data: { tag: body[0].tag } }]);
  });
  const row = rows[0];
  row.next_attempt_at = new Date(BASE_MS).toISOString();
  await runLane(rows, store, async () => apiResponse([{
    id: "task-1",
    status_code: 50301,
    status_message: "Temporarily unavailable",
  }]), BASE_MS + 3 * 60_000);
  assert.equal(row.state, "retry");
  assert.equal(row.total_cost, 0.0012);
  assert.equal(row.attempt.dispatch_state, "recorded");
});

test("F02-AC-28: an uncollected task fails after 30 minutes at its posted cost", async () => {
  const rows = makeRows(1);
  const row = rows[0];
  row.state = "posted";
  row.lease_token = "posted-token";
  row.next_attempt_at = new Date(BASE_MS).toISOString();
  row.total_cost = 0.0012;
  row.attempt_count = 1;
  row.attempt = {
    lease_token: "posted-token",
    attempt_no: 1,
    dispatch_state: "posted",
    provider_task_id: "task-1",
    posted_at: new Date(BASE_MS - 31 * 60_000).toISOString(),
    charged_usd: 0.0012,
  };
  const store = memoryStore(rows);
  await runLane(rows, store, async () => { throw new Error("expiry must not issue task_get"); }, BASE_MS);
  assert.equal(store.calls.collected.length, 1);
  assert.equal(store.calls.collected[0].state, "failed");
  assert.equal(store.calls.collected[0].failure.kind, "not_collected");
  assert.equal(row.total_cost, 0.0012);
});
