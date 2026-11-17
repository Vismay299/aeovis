import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_SCAN_STATUSES,
  PANEL_NOT_APPROVED,
  SCAN_ALREADY_RUNNING,
  SCAN_STAGES,
  scanStageIndex,
  SCAN_POLL_SECONDS,
  SCAN_STALL_MS,
  initialTrackerState,
  scanTrackerReducer,
  trackerView,
} from "./scanTrackerModel.js";
import { isReconnecting } from "../../shared/scanProgress.js";

test("adoption of the first active unsettled job", () => {
  const state = initialTrackerState("brand-1");
  const jobs = [
    { id: "job-0", status: "complete", progress_pct: 100 },
    { id: "job-1", status: "probing", progress_pct: 35, created_at: "2026-01-01T00:00:00Z" },
    { id: "job-2", status: "pending", progress_pct: 0, created_at: "2026-01-01T00:01:00Z" },
  ];

  const next = scanTrackerReducer(state, { type: "jobsSeen", jobs });
  assert.equal(next.job?.id, "job-1");
  assert.equal(next.job?.status, "probing");
  assert.equal(next.job?.created_at, "2026-01-01T00:00:00Z");
  assert.equal(next.progress?.progress, 35);
});

test("404 settles and never re-adopts the same id on a later jobsSeen with a fresh array", () => {
  let state = initialTrackerState("brand-1");
  const jobs = [{ id: "job-gone", status: "probing", progress_pct: 40 }];

  state = scanTrackerReducer(state, { type: "jobsSeen", jobs });
  assert.equal(state.job?.id, "job-gone");

  state = scanTrackerReducer(state, {
    type: "statusReceived",
    jobId: "job-gone",
    httpStatus: 404,
    ok: false,
    body: {},
  });
  assert.equal(state.job, null);
  assert.ok(state.settledJobIds.includes("job-gone"));

  const freshJobs = [{ id: "job-gone", status: "probing", progress_pct: 40 }];
  const next = scanTrackerReducer(state, { type: "jobsSeen", jobs: freshJobs });
  assert.equal(next.job, null, "must not re-adopt settled 404 job");
});

test("complete and failed settle, set finished, bump notifySeq", () => {
  let state = initialTrackerState("brand-1");
  state = scanTrackerReducer(state, {
    type: "jobsSeen",
    jobs: [{ id: "job-1", status: "probing", progress_pct: 90 }],
  });

  const completeState = scanTrackerReducer(state, {
    type: "statusReceived",
    jobId: "job-1",
    httpStatus: 200,
    ok: true,
    body: { status: "complete", result_id: "res-1", terminal_outcome: "success" },
  });
  assert.equal(completeState.job?.status, "complete");
  assert.equal(completeState.finished?.status, "complete");
  assert.equal(completeState.finished?.resultId, "res-1");
  assert.equal(completeState.finished?.terminal_outcome, "success");
  assert.equal(completeState.notifySeq, 1);
  assert.ok(completeState.settledJobIds.includes("job-1"));

  const failedState = scanTrackerReducer(state, {
    type: "statusReceived",
    jobId: "job-1",
    httpStatus: 200,
    ok: true,
    body: { status: "failed", error_message: "Network exploded" },
  });
  assert.equal(failedState.job?.status, "failed");
  assert.equal(failedState.finished?.status, "failed");
  assert.equal(failedState.finished?.error, "Network exploded");
  assert.equal(failedState.notifySeq, 1);
  assert.ok(failedState.settledJobIds.includes("job-1"));
});

test("transient_error and status:unknown keep the job and mark progress unknown", () => {
  let state = initialTrackerState("brand-1");
  state = scanTrackerReducer(state, {
    type: "jobsSeen",
    jobs: [{ id: "job-1", status: "probing", progress_pct: 50 }],
  });

  const transient = scanTrackerReducer(state, {
    type: "statusReceived",
    jobId: "job-1",
    httpStatus: 200,
    ok: true,
    body: { status: "probing", transient_error: true },
  });
  assert.equal(transient.job?.id, "job-1");
  assert.ok(transient.progress?.unknownReason);
  assert.equal(isReconnecting(transient.progress), true);

  const unknownStatus = scanTrackerReducer(state, {
    type: "statusReceived",
    jobId: "job-1",
    httpStatus: 200,
    ok: true,
    body: { status: "unknown" },
  });
  assert.equal(unknownStatus.job?.id, "job-1");
  assert.equal(unknownStatus.progress?.unknownReason, "transient_error");
  assert.equal(isReconnecting(unknownStatus.progress), true);
});

test("statusReceived for another job id is ignored", () => {
  let state = initialTrackerState("brand-1");
  state = scanTrackerReducer(state, {
    type: "jobsSeen",
    jobs: [{ id: "job-1", status: "probing", progress_pct: 50 }],
  });

  const next = scanTrackerReducer(state, {
    type: "statusReceived",
    jobId: "job-other",
    httpStatus: 404,
    ok: false,
    body: {},
  });
  assert.equal(next, state, "must return exact same state object");
});

test("brandChanged resets settledJobIds", () => {
  let state = initialTrackerState("brand-1");
  state = { ...state, settledJobIds: ["job-old"] };

  const next = scanTrackerReducer(state, { type: "brandChanged", brandKey: "brand-2" });
  assert.equal(next.brandKey, "brand-2");
  assert.deepEqual(next.settledJobIds, []);
});

test("startResolved with a stale brandKey is ignored", () => {
  const state = initialTrackerState("brand-2");
  const next = scanTrackerReducer(state, {
    type: "startResolved",
    brandKey: "brand-1",
    outcome: { kind: "started", job_id: "job-stale" },
  });
  assert.equal(next, state, "must return same state object on stale brand");
});

test("alreadyRunning sets the notice and bumps notifySeq", () => {
  const state = initialTrackerState("brand-1");
  const next = scanTrackerReducer(state, {
    type: "startResolved",
    brandKey: "brand-1",
    outcome: { kind: "alreadyRunning" },
  });
  assert.equal(
    next.notice,
    "A scan is already running for this workspace \u2014 showing its progress."
  );
  assert.equal(next.notifySeq, 1);
});

test("panelNotApproved sets errorCode and today's sentence", () => {
  const state = initialTrackerState("brand-1");
  const next = scanTrackerReducer(state, {
    type: "startResolved",
    brandKey: "brand-1",
    outcome: { kind: "panelNotApproved" },
  });
  assert.equal(next.errorCode, PANEL_NOT_APPROVED);
  assert.equal(
    next.error,
    "Scans ask the questions in your approved question panel. Review and approve it on Questions & evidence, then run the scan."
  );
});

test("trackerView matches today's fields for a running job (percent 37, stageIndex 2)", () => {
  let state = initialTrackerState("brand-1");
  state = scanTrackerReducer(state, {
    type: "jobsSeen",
    jobs: [{ id: "job-1", status: "probing", progress_pct: 37 }],
  });

  const view = trackerView(state);
  assert.equal(view.active, true);
  assert.equal(view.percent, 37);
  assert.equal(view.stageIndex, 2);
  assert.equal(view.stage?.status, "probing");
  assert.equal(view.stage?.label, "Asking AI engines");
  assert.equal(view.job?.id, "job-1");
  assert.equal(view.reconnecting, false);
  assert.equal(view.stalled, false);
  assert.equal(view.finished, null);
  assert.equal(view.starting, false);
  assert.equal(view.error, "");
  assert.equal(view.errorCode, null);
  assert.equal(view.notice, "");
});
