import test from "node:test";
import assert from "node:assert/strict";
import {
  isRankRunActive,
  rankRunPollIntervalMs,
  isRankRunFinishTransition,
} from "./runPolling.ts";

test("isRankRunActive detects pending and running while excluding maybeStale and terminal states", () => {
  assert.equal(isRankRunActive(null), false);
  assert.equal(isRankRunActive(undefined), false);

  assert.equal(isRankRunActive({ status: "pending" }), true);
  assert.equal(isRankRunActive({ status: "running" }), true);

  assert.equal(
    isRankRunActive({ status: "pending", maybeStale: true }),
    false,
    "stale pending run is not polled actively",
  );
  assert.equal(
    isRankRunActive({ status: "running", maybeStale: true }),
    false,
    "stale running run is not polled actively",
  );

  assert.equal(isRankRunActive({ status: "completed" }), false);
  assert.equal(isRankRunActive({ status: "failed" }), false);
  assert.equal(isRankRunActive({ status: "cancelled" }), false);
});

test("rankRunPollIntervalMs enforces a 3-second floor and returns false when inactive", () => {
  assert.equal(rankRunPollIntervalMs(null), false);
  assert.equal(rankRunPollIntervalMs({ status: "completed" }), false);
  assert.equal(
    rankRunPollIntervalMs({ status: "running", maybeStale: true }),
    false,
  );

  // default fallback when pollAfterSeconds is omitted
  assert.equal(rankRunPollIntervalMs({ status: "running" }), 3000);
  assert.equal(
    rankRunPollIntervalMs({ status: "running", pollAfterSeconds: null }),
    3000,
  );

  // floor of 3 seconds applies when server requests less than 3s
  assert.equal(
    rankRunPollIntervalMs({ status: "running", pollAfterSeconds: 1 }),
    3000,
  );
  assert.equal(
    rankRunPollIntervalMs({ status: "running", pollAfterSeconds: 2 }),
    3000,
  );
  assert.equal(
    rankRunPollIntervalMs({ status: "running", pollAfterSeconds: 3 }),
    3000,
  );

  // larger values from server are respected
  assert.equal(
    rankRunPollIntervalMs({ status: "running", pollAfterSeconds: 5 }),
    5000,
  );
  assert.equal(
    rankRunPollIntervalMs({ status: "pending", pollAfterSeconds: 10 }),
    10000,
  );
});

test("isRankRunFinishTransition detects transition from active to finished for the same run", () => {
  const activeRun = { id: "run-1", status: "running" };
  const completedRun = { id: "run-1", status: "completed" };
  const failedRun = { id: "run-1", status: "failed" };
  const differentCompletedRun = { id: "run-2", status: "completed" };

  // active -> terminal transitions
  assert.equal(isRankRunFinishTransition(activeRun, completedRun), true);
  assert.equal(isRankRunFinishTransition(activeRun, failedRun), true);

  // not a finish transition
  assert.equal(isRankRunFinishTransition(null, completedRun), false);
  assert.equal(isRankRunFinishTransition(activeRun, activeRun), false);
  assert.equal(isRankRunFinishTransition(completedRun, completedRun), false);
  assert.equal(isRankRunFinishTransition(completedRun, activeRun), false);

  // run ID mismatch must not trigger finish transition
  assert.equal(
    isRankRunFinishTransition(activeRun, differentCompletedRun),
    false,
  );
});
