import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryJobStore } from "../jobs/memoryStore.ts";
import { enqueueSystemJob } from "../jobs/enqueue.ts";
import { listPeriodics } from "../jobs/periodic.ts";
import { getJobDefinition } from "../jobs/registry.ts";
import { runJob } from "../jobs/runner.ts";
import { createFakeAdmin } from "../../../tests/fixtures/f22/fakeAdmin.ts";
import {
  MAINTENANCE_INTERVAL_SECONDS,
  RETENTION_INTERVAL_SECONDS,
  registerAssistantJobs,
} from "./jobs.ts";

const AT = Date.parse("2026-11-17T10:00:00.000Z");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SSE_FIXTURE = readFileSync(
  path.resolve(HERE, "../../../tests/fixtures/f22/sse-turn.txt"),
  "utf8",
);

function seedAdmin(extra: Record<string, unknown[]> = {}) {
  const sessions = [
    {
      id: "s1",
      brand_key: "acme-tees",
      user_id: "user-1",
      title: "Stale chat",
      summary: null,
      compacted_through_seq: null,
      kickoff: null,
      archived_at: null,
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
    },
    ...((extra.assistant_sessions as unknown[]) ?? []),
  ];
  const admin = createFakeAdmin({
    ...extra,
    assistant_sessions: sessions,
  });
  admin.setNow(() => AT);
  return admin;
}

async function runDefined(
  admin: ReturnType<typeof createFakeAdmin>,
  kind: string,
  store: ReturnType<typeof createMemoryJobStore>,
) {
  registerAssistantJobs({ admin: admin as never, store });
  const { jobId } = await enqueueSystemJob(kind, {}, { dedupeKey: kind + ":qa" }, { store, now: () => AT, selfContinue: () => {} });
  await store.claimDue("qa-owner", 1, 300, jobId);
  const claimed = (await store.getJob(jobId)) as NonNullable<Awaited<ReturnType<typeof store.getJob>>>;
  const outcome = await runJob(claimed, {
    store,
    owner: "qa-owner",
    deadlineMs: AT + 240_000,
    now: () => AT,
    selfContinue: () => {},
  });
  return { outcome, jobId, finished: await store.getJob(jobId) };
}

test("jobs: both kinds are registered", () => {
  const store = createMemoryJobStore({ now: () => AT });
  registerAssistantJobs({ admin: seedAdmin() as never, store });
  assert.ok(getJobDefinition("assistant.maintenance"));
  assert.ok(getJobDefinition("assistant.retention"));
});

test("jobs: the maintenance periodic runs every 300 s with a slot dedupe key and one active job", async () => {
  const store = createMemoryJobStore({ now: () => AT });
  registerAssistantJobs({ admin: seedAdmin() as never, store });
  const periodic = listPeriodics().find((task) => task.name === "assistant.maintenance");
  assert.equal(periodic?.everySeconds, MAINTENANCE_INTERVAL_SECONDS);
  assert.equal(MAINTENANCE_INTERVAL_SECONDS, 300);

  await periodic?.run(new Date(AT));
  await periodic?.run(new Date(AT + 120_000));
  const first = [...store.jobs.values()].filter((job) => job.kind === "assistant.maintenance");
  assert.equal(first.length, 1);
  assert.equal(first[0].dedupe_key, "assistant.maintenance:" + Math.floor(AT / 300_000));
  assert.equal(first[0].single_active_key, "assistant.maintenance");

  // The slot job has run by the next slot; otherwise singleActiveKey would (correctly) refuse.
  first[0].status = "completed";
  await periodic?.run(new Date(AT + 300_000));
  assert.equal(
    [...store.jobs.values()].filter((job) => job.kind === "assistant.maintenance").length,
    2,
  );
});

test("jobs: retention is daily with a YYYY-MM-DD dedupe key", async () => {
  const store = createMemoryJobStore({ now: () => AT });
  registerAssistantJobs({ admin: seedAdmin() as never, store });
  const periodic = listPeriodics().find((task) => task.name === "assistant.retention");
  assert.equal(periodic?.everySeconds, RETENTION_INTERVAL_SECONDS);
  await periodic?.run(new Date(AT));
  const rows = [...store.jobs.values()].filter((job) => job.kind === "assistant.retention");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dedupe_key, "assistant.retention:2026-11-17");
});

test("jobs: maintenance expires approvals, rebuilds the interrupted reply, notices it and never re-runs a model", async () => {
  assert.equal(
    process.env.LLM_API_KEY,
    undefined,
    "this case proves no model call is needed: there is no key to call one with",
  );
  const admin = seedAdmin({
    assistant_turns: [
      {
        id: "t-stale",
        session_id: "s1",
        brand_key: "acme-tees",
        user_id: "user-1",
        status: "streaming",
        stop_reason: null,
        started_at: "2020-01-01T00:00:00.000Z",
        heartbeat_at: "2020-01-01T00:00:00.000Z",
        finished_at: null,
      },
      {
        id: "t-old",
        session_id: "s1",
        brand_key: "acme-tees",
        user_id: "user-1",
        status: "completed",
        stop_reason: "finished",
        started_at: "2020-01-01T00:00:00.000Z",
        heartbeat_at: "2020-01-01T00:00:10.000Z",
        finished_at: "2020-01-01T00:00:10.000Z",
      },
    ],
    assistant_stream_chunks: [
      { turn_id: "t-stale", seq: 0, brand_key: "acme-tees", data: SSE_FIXTURE },
      { turn_id: "t-old", seq: 0, brand_key: "acme-tees", data: "data: {}\n\n" },
      { turn_id: "t-old", seq: 1, brand_key: "acme-tees", data: "data: {}\n\n" },
    ],
    assistant_approvals: [
      {
        id: "ap-old",
        session_id: "s1",
        brand_key: "acme-tees",
        user_id: "user-1",
        tool_name: "research_keywords",
        tool_call_id: "call-old",
        kind: "price",
        priced_action: "keywords.research.run",
        input: {},
        input_sha256: "a".repeat(64),
        quote_input: {},
        quote: null,
        quoted_usd: null,
        approved_max_usd: null,
        label: "Old approval",
        status: "pending",
        result: null,
        error_code: null,
        decided_at: null,
        finished_at: null,
        expires_at: "2020-01-01T00:00:00.000Z",
        created_at: "2020-01-01T00:00:00.000Z",
      },
    ],
  });
  const store = createMemoryJobStore({ now: () => AT });
  const { outcome, finished } = await runDefined(admin, "assistant.maintenance", store);
  assert.equal(outcome, "completed");
  assert.deepEqual(finished?.result, {
    expired: 1,
    failed: 0,
    interrupted: 1,
    chunksDeleted: 2,
  });

  const turn = admin.rows("assistant_turns").find((row: any) => row.id === "t-stale");
  assert.equal(turn?.status, "interrupted");
  assert.equal(turn?.stop_reason, "interrupted");
  const reply = admin.rows("assistant_messages").find((row: any) => row.turn_id === "t-stale");
  assert.ok(reply);
  assert.ok(JSON.stringify(reply?.parts).includes("9 of 12 questions"));
  const last = (reply?.parts as Array<Record<string, unknown>>).at(-1);
  assert.deepEqual(last, {
    type: "data-notice",
    data: {
      code: "interrupted",
      text: "That reply was cut off before it finished. Everything above is saved. Ask again for a narrower piece (fewer keywords, competitors or pages), or tell me where to pick up.",
    },
  });

  // A second run must not add a second notice or a second reply.
  await runDefined(admin, "assistant.maintenance", store);
  const replies = admin.rows("assistant_messages").filter((row: any) => row.turn_id === "t-stale");
  assert.equal(replies.length, 1);
  assert.equal(
    (replies[0].parts as Array<Record<string, unknown>>).filter(
      (part) => part.type === "data-notice",
    ).length,
    1,
  );
});

test("jobs: retention prunes in 500s until a short batch and reports the total", async () => {
  const sessions = Array.from({ length: 1_200 }, (_, index) => ({
    id: "s-old-" + index,
    brand_key: "acme-tees",
    user_id: "user-1",
    title: "Old",
    summary: null,
    compacted_through_seq: null,
    kickoff: null,
    archived_at: null,
    created_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-01-01T00:00:00.000Z",
  }));
  const admin = seedAdmin({ assistant_sessions: sessions });
  const store = createMemoryJobStore({ now: () => AT });
  const { outcome, jobId, finished } = await runDefined(admin, "assistant.retention", store);
  assert.equal(outcome, "completed");
  assert.deepEqual(finished?.result, { sessions: 1_201 });
  const steps = [...store.steps.values()]
    .filter((step) => step.job_id === jobId)
    .map((step) => step.name);
  assert.deepEqual(steps, ["prune-1", "prune-2", "prune-3"]);
  assert.equal(admin.rows("assistant_sessions").length, 0, "every expired session is gone");
});

test("jobs: the interrupted-reply append also fits a >1 MB stored message", async () => {
  const bigParts = Array.from({ length: 200 }, (_, index) => ({
    type: "tool-get_scan_report",
    toolCallId: "call-" + index,
    state: "output-available",
    output: {
      status: "success",
      summary: "Rows " + index + ".",
      data: { rows: Array.from({ length: 40 }, () => "x".repeat(160)) },
      link: null,
      untrusted: [],
      truncated: null,
    },
  }));
  assert.ok(JSON.stringify(bigParts).length > 1_000_000);
  const admin = seedAdmin({
    assistant_turns: [
      {
        id: "t-fit",
        session_id: "s1",
        brand_key: "acme-tees",
        user_id: "user-1",
        status: "streaming",
        stop_reason: null,
        assistant_message_id: null,
        started_at: "2020-01-01T00:00:00.000Z",
        heartbeat_at: "2020-01-01T00:00:00.000Z",
        finished_at: null,
      },
    ],
    assistant_messages: [
      {
        session_id: "s1",
        id: "a_tfit",
        brand_key: "acme-tees",
        seq: 1,
        role: "assistant",
        parts: bigParts,
        metadata: {},
        turn_id: "t-fit",
        created_at: "2020-01-01T00:00:00.000Z",
      },
    ],
  });
  const store = createMemoryJobStore({ now: () => AT });
  const { outcome } = await runDefined(admin, "assistant.maintenance", store);
  assert.equal(outcome, "completed");
  const message = admin.rows("assistant_messages").find((row: any) => row.turn_id === "t-fit");
  assert.ok(JSON.stringify(message.parts).length <= 1_000_000);
  assert.deepEqual(message.parts[0].output.data, { omitted: true, reason: "size" });
  assert.deepEqual(message.parts.at(-1), {
    type: "data-notice",
    data: {
      code: "interrupted",
      text: "That reply was cut off before it finished. Everything above is saved. Ask again for a narrower piece (fewer keywords, competitors or pages), or tell me where to pick up.",
    },
  });
  const turn = admin.rows("assistant_turns").find((row: any) => row.id === "t-fit");
  assert.equal(turn.assistant_message_id, "a_tfit");
});
