import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../shared/http/appError.ts";
import { createFakeAdmin } from "../../../tests/fixtures/f22/fakeAdmin.ts";
import { assertTurnRate } from "./rateLimit.ts";

const CFG = { perUserHour: 3, perWorkspaceDay: 5 };

function turn(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    session_id: "s1",
    brand_key: "acme-tees",
    user_id: "user-1",
    status: "completed",
    started_at: "2026-11-17T09:30:00.000Z",
    heartbeat_at: "2026-11-17T09:30:00.000Z",
    finished_at: "2026-11-17T09:31:00.000Z",
    ...overrides,
  };
}

test("rate limit: under both limits is allowed", async () => {
  const admin = createFakeAdmin({ assistant_turns: [turn(), turn()] });
  await assert.doesNotReject(
    assertTurnRate(admin as never, { userId: "user-1", brandKey: "acme-tees" }, CFG, {
      now: () => new Date("2026-11-17T10:00:00.000Z"),
    }),
  );
});

test("rate limit: the 31st turn in a rolling hour is 429 with the exact copy", async () => {
  const admin = createFakeAdmin({
    assistant_turns: Array.from({ length: 30 }, (_, index) =>
      turn({ started_at: `2026-11-17T09:${String(index).padStart(2, "0")}:00.000Z` }),
    ),
  });
  await assert.rejects(
    assertTurnRate(admin as never, { userId: "user-1", brandKey: "acme-tees" }, { perUserHour: 30, perWorkspaceDay: 300 }, {
      now: () => new Date("2026-11-17T10:00:00.000Z"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 429);
      assert.equal(error.code, "assistant_rate_limited");
      assert.equal(error.message, "You have sent a lot of messages. Try again in a few minutes.");
      assert.equal(error.recovery, "Wait a few minutes, or start fewer parallel chats.");
      return true;
    },
  );
});

test("rate limit: a turn older than 60 minutes does not count against the user", async () => {
  const admin = createFakeAdmin({
    assistant_turns: [
      turn({ started_at: "2026-11-17T08:59:00.000Z" }),
      turn({ started_at: "2026-11-17T09:00:00.000Z" }),
      turn({ started_at: "2026-11-17T09:10:00.000Z" }),
    ],
  });
  await assert.doesNotReject(
    assertTurnRate(admin as never, { userId: "user-1", brandKey: "acme-tees" }, CFG, {
      now: () => new Date("2026-11-17T10:00:00.000Z"),
    }),
  );
});

test("rate limit: the workspace daily limit counts only since UTC midnight", async () => {
  const admin = createFakeAdmin({
    assistant_turns: [
      turn({ user_id: "other-1", started_at: "2026-11-17T00:05:00.000Z" }),
      turn({ user_id: "other-2", started_at: "2026-11-17T01:05:00.000Z" }),
      turn({ user_id: "other-3", started_at: "2026-11-17T02:05:00.000Z" }),
      turn({ user_id: "other-4", started_at: "2026-11-17T03:05:00.000Z" }),
      turn({ user_id: "other-5", started_at: "2026-11-17T04:05:00.000Z" }),
      turn({ user_id: "other-6", started_at: "2026-11-16T23:55:00.000Z" }),
    ],
  });
  await assert.rejects(
    assertTurnRate(admin as never, { userId: "user-1", brandKey: "acme-tees" }, CFG, {
      now: () => new Date("2026-11-17T10:00:00.000Z"),
    }),
    { status: 429, code: "assistant_rate_limited" },
  );
});
