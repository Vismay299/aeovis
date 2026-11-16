import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../http/appError.ts";
import {
  beginTurn,
  cancelRequested,
  finishTurn,
  heartbeat,
  markInterrupted,
  requestCancel,
} from "./turns.ts";

type Row = Record<string, any>;

function makeAdmin(seed: Record<string, Row[]> = {}, rpcError: { message: string } | null = null) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  const rpcCalls: Array<{ name: string; args: Row }> = [];

  function query(table: string) {
    const filters: Array<[string, any, string]> = [];
    let patch: Row | null = null;
    const run = () => {
      const rows = (tables[table] ??= []);
      if (patch) {
        const hit = rows.filter((row) =>
          filters.every(([column, value, op]) => {
            if (op === "lt") return row[column] < value;
            return row[column] === value;
          }),
        );
        for (const row of hit) Object.assign(row, patch);
        return { data: hit.map((row) => ({ ...row })), error: null };
      }
      return {
        data: rows.filter((row) =>
          filters.every(([column, value, op]) => {
            if (op === "lt") return row[column] < value;
            return row[column] === value;
          }),
        ),
        error: null,
      };
    };
    const builder: any = {
      select() {
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value, "eq"]);
        return builder;
      },
      lt(column: string, value: unknown) {
        filters.push([column, value, "lt"]);
        return builder;
      },
      update(next: Row) {
        patch = next;
        return builder;
      },
      maybeSingle() {
        const result = run();
        return Promise.resolve({ data: result.data[0] ?? null, error: null });
      },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from: (table: string) => query(table),
    rpc: (name: string, args: Row) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(rpcError ? { data: null, error: rpcError } : { data: "turn-1", error: null });
    },
  } as any;
  return { admin, tables, rpcCalls };
}

test("beginTurn calls the RPC with snake_case arguments", async () => {
  const { admin, rpcCalls } = makeAdmin();
  assert.equal(await beginTurn(admin, { sessionId: "s1", brandKey: "brand-a", userId: "user-1" }), "turn-1");
  assert.deepEqual(rpcCalls, [
    { name: "begin_assistant_turn", args: { p_session: "s1", p_brand: "brand-a", p_user: "user-1" } },
  ]);
});

test("beginTurn maps turn_in_progress to AppError 409 with the exact copy", async () => {
  const { admin } = makeAdmin({}, { message: "turn_in_progress" });
  await assert.rejects(
    () => beginTurn(admin, { sessionId: "s1", brandKey: "brand-a", userId: "user-1" }),
    (error) =>
      error instanceof AppError &&
      error.status === 409 &&
      error.code === "turn_in_progress" &&
      error.message === "The assistant is still answering. Wait for it to finish or press Stop.",
  );
});

test("beginTurn maps session_not_found to 404 and rethrows anything else", async () => {
  const missing = makeAdmin({}, { message: "session_not_found" });
  await assert.rejects(
    () => beginTurn(missing.admin, { sessionId: "s1", brandKey: "brand-a", userId: "user-1" }),
    (error) => error instanceof AppError && error.status === 404 && error.code === "session_not_found",
  );
  const other = makeAdmin({}, { message: "connection reset" });
  await assert.rejects(
    () => beginTurn(other.admin, { sessionId: "s1", brandKey: "brand-a", userId: "user-1" }),
    (error) => !(error instanceof AppError) && (error as Error).message === "connection reset",
  );
});

test("heartbeat refreshes heartbeat_at and writes the supplied stats", async () => {
  const { admin, tables } = makeAdmin({
    assistant_turns: [{ id: "t1", status: "streaming", steps: 0, tool_calls: 0 }],
  });
  await heartbeat(admin, "t1", {
    steps: 2,
    toolCalls: 1,
    inputTokens: 120,
    outputTokens: 40,
    costUsd: 0.0021,
    costKnown: true,
    model: "qa/model",
    compacted: false,
  });
  const row = tables.assistant_turns[0];
  assert.equal(row.steps, 2);
  assert.equal(row.tool_calls, 1);
  assert.equal(row.input_tokens, 120);
  assert.equal(row.output_tokens, 40);
  assert.equal(row.cost_usd, 0.0021);
  assert.equal(row.cost_known, true);
  assert.equal(row.model, "qa/model");
  assert.ok(row.heartbeat_at);
});

test("requestCancel sets the flag only on this user's streaming turn", async () => {
  const { admin, tables } = makeAdmin({
    assistant_turns: [
      { id: "t1", session_id: "s1", user_id: "user-1", status: "streaming", cancel_requested_at: null },
      { id: "t2", session_id: "s1", user_id: "user-2", status: "streaming", cancel_requested_at: null },
      { id: "t3", session_id: "s2", user_id: "user-1", status: "completed", cancel_requested_at: null },
    ],
  });
  assert.equal(await requestCancel(admin, { sessionId: "s1", userId: "user-1" }), true);
  assert.ok(tables.assistant_turns[0].cancel_requested_at);
  assert.equal(tables.assistant_turns[1].cancel_requested_at, null);
  assert.equal(tables.assistant_turns[2].cancel_requested_at, null);
  assert.equal(await requestCancel(admin, { sessionId: "s2", userId: "user-2" }), false);
});

test("cancelRequested reads the stored flag", async () => {
  const { admin } = makeAdmin({
    assistant_turns: [
      { id: "t1", cancel_requested_at: "2026-11-01T00:00:00.000Z" },
      { id: "t2", cancel_requested_at: null },
    ],
  });
  assert.equal(await cancelRequested(admin, "t1"), true);
  assert.equal(await cancelRequested(admin, "t2"), false);
  assert.equal(await cancelRequested(admin, "missing"), false);
});

test("finishTurn writes the terminal status, stop reason and stats", async () => {
  const { admin, tables } = makeAdmin({
    assistant_turns: [{ id: "t1", status: "streaming", assistant_message_id: null, error_code: null }],
  });
  await finishTurn(admin, "t1", {
    status: "error",
    stopReason: "error",
    assistantMessageId: "a_1",
    errorCode: "llm_failed",
    costUsd: null,
    costKnown: false,
    steps: 1,
    toolCalls: 0,
  });
  const row = tables.assistant_turns[0];
  assert.equal(row.status, "error");
  assert.equal(row.stop_reason, "error");
  assert.equal(row.assistant_message_id, "a_1");
  assert.equal(row.error_code, "llm_failed");
  assert.equal(row.cost_usd, null);
  assert.equal(row.cost_known, false);
  assert.equal(row.steps, 1);
  assert.ok(row.finished_at);
});

test("markInterrupted marks only stale streaming turns and reports the count", async () => {
  const stale = new Date(Date.now() - 120_000).toISOString();
  const fresh = new Date(Date.now() - 5_000).toISOString();
  const { admin, tables } = makeAdmin({
    assistant_turns: [
      { id: "stale", status: "streaming", heartbeat_at: stale, stop_reason: null, finished_at: null },
      { id: "fresh", status: "streaming", heartbeat_at: fresh, stop_reason: null, finished_at: null },
      { id: "done", status: "completed", heartbeat_at: stale, stop_reason: "finished", finished_at: stale },
    ],
  });
  assert.equal(await markInterrupted(admin, 90), 1);
  const byId = Object.fromEntries(tables.assistant_turns.map((row) => [row.id, row]));
  assert.equal(byId.stale.status, "interrupted");
  assert.equal(byId.stale.stop_reason, "interrupted");
  assert.ok(byId.stale.finished_at);
  assert.equal(byId.fresh.status, "streaming");
  assert.equal(byId.done.status, "completed");
});
