import test from "node:test";
import assert from "node:assert/strict";

import {
  SCHEDULE_TIMEZONE,
  WINDOW_DISPOSITION,
  resolveNextDailyWindow,
  resolveDstCadence,
  calculateBoundedCatchUp,
  assessOperationalHealth,
  evaluateScheduleTick,
  processScheduledScanWithCircuitBreaker,
  checkSpendCapAndDispatch,
  AlertIncidentManager,
} from "../continuousMeasurement.js";

test("R11-01 — Disabled customer schedule produces no job on scheduler ticks with off state accurately recorded (U)", () => {
  const disabledSchedule = {
    id: "sched-001",
    enabled: false,
    status: "disabled",
  };

  const tickResult = evaluateScheduleTick(disabledSchedule);

  assert.equal(tickResult.shouldDispatch, false);
  assert.equal(tickResult.status, "disabled");
  assert.equal(tickResult.job_created, false);
  assert.equal(tickResult.reason, "schedule_disabled_no_work");
});

test("R11-02 — Due schedule in Asia/Kolkata resolves next window agreeing across midnight between UTC and local time (U)", () => {
  // At 22:00 UTC (03:30 AM next day IST), the 02:00 AM IST slot for today has passed,
  // so next window must be 02:00 AM IST tomorrow, which is 20:30 UTC.
  const currentUtc = "2026-10-15T22:00:00.000Z";
  const nextWindowUtc = resolveNextDailyWindow(currentUtc, 2, 0);

  // 02:00 AM IST is 20:30 UTC previous calendar date
  assert.equal(nextWindowUtc, "2026-10-16T20:30:00.000Z");
});

test("R11-03 — Supported DST timezone transition applies declared policy once with no unbounded retry (U)", () => {
  const lastWindowUtc = "2026-11-01T06:00:00.000Z";
  const nextWindowUtc = resolveDstCadence({
    lastWindowUtc,
    intervalHours: 24,
    targetTz: "America/New_York",
  });

  assert.equal(nextWindowUtc, "2026-11-02T06:00:00.000Z");
});

test("R11-04 — Three missed windows calculate bounded catch-up retaining missed windows in ledger (U)", () => {
  const missedDueWindows = [
    "2026-10-13T02:00:00.000Z",
    "2026-10-14T02:00:00.000Z",
    "2026-10-15T02:00:00.000Z",
  ];

  const { toDispatch, missed } = calculateBoundedCatchUp({
    dueWindows: missedDueWindows,
    maxCatchUp: 1,
  });

  // Exactly 1 window dispatched (the most recent)
  assert.equal(toDispatch.length, 1);
  assert.equal(toDispatch[0], "2026-10-15T02:00:00.000Z");

  // Earlier 2 windows preserved in missed ledger, not erased
  assert.equal(missed.length, 2);
  assert.equal(missed[0].window, "2026-10-13T02:00:00.000Z");
  assert.equal(missed[0].disposition, WINDOW_DISPOSITION.MISSED);
  assert.equal(missed[1].window, "2026-10-14T02:00:00.000Z");
  assert.equal(missed[1].disposition, WINDOW_DISPOSITION.MISSED);
});

test("R11-08 — Healthy cron heartbeat with stale completed scan triggers successful-measurement alert independently (I)", () => {
  const now = Date.now();
  const lastHeartbeatAt = new Date(now - 2 * 60 * 1000).toISOString(); // 2 mins ago (healthy)
  const lastSuccessfulScanAt = new Date(now - 48 * 3600 * 1000).toISOString(); // 48 hours ago (stale!)

  const health = assessOperationalHealth({ lastHeartbeatAt, lastSuccessfulScanAt, maxStaleMs: 36 * 3600 * 1000 });

  assert.equal(health.heartbeat_ok, true);
  assert.equal(health.scan_ok, false);
  assert.ok(health.alert !== null);
  assert.equal(health.alert.type, "stale_successful_measurement");
  assert.equal(health.alert.severity, "critical");
});

test("R11-09 — Provider circuit opening reports blocked outcome and affected surface without endless retry loops (I)", () => {
  const result = processScheduledScanWithCircuitBreaker({
    surface: "chatgpt",
    circuitOpen: true,
    error: "503 Service Unavailable / Rate Limit Exceeded",
  });

  assert.equal(result.disposition, WINDOW_DISPOSITION.BLOCKED);
  assert.equal(result.surface, "chatgpt");
  assert.equal(result.loop_prevented, true);
  assert.equal(result.blocked_reason, "provider_circuit_open");
});

test("R11-10 — Daily spend cap reached blocks dispatch, makes zero calls, and retains scheduled denominator (I)", () => {
  const spendDecision = checkSpendCapAndDispatch({
    dailySpendUsd: 100.50,
    spendCapUsd: 100.00,
    scheduledWindow: "2026-10-16T02:00:00.000Z",
  });

  assert.equal(spendDecision.canDispatch, false);
  assert.equal(spendDecision.disposition, WINDOW_DISPOSITION.BLOCKED);
  assert.equal(spendDecision.excess_calls_made, 0);
  assert.equal(spendDecision.retained_in_denominator, true);
  assert.equal(spendDecision.reason, "daily_spend_cap_reached");
});

test("R11-14 — Duplicate notification evaluations for same missed window maintain single alert identity and resolve with evidence (I)", () => {
  const manager = new AlertIncidentManager();
  const alertPayload = {
    scheduleId: "sched-daily",
    window: "2026-10-15T02:00:00.000Z",
    alertType: "missed_window",
    details: { delayMinutes: 90 },
  };

  // First alert evaluation creates the incident
  const first = manager.recordAlert(alertPayload);
  assert.equal(first.is_duplicate, false);
  assert.equal(first.incident.status, "open");

  // Repeated evaluation for same window does NOT create duplicate incident
  const second = manager.recordAlert(alertPayload);
  assert.equal(second.is_duplicate, true);
  assert.equal(second.incident.incident_id, first.incident.incident_id);
  assert.equal(second.incident_count, 1);

  // Recovery resolves incident with evidence
  const resolution = manager.resolveAlert({
    scheduleId: "sched-daily",
    window: "2026-10-15T02:00:00.000Z",
    alertType: "missed_window",
    evidence: { scan_id: "scan-recovery-99", completed_at: new Date().toISOString() },
  });

  assert.equal(resolution.resolved, true);
  assert.equal(resolution.incident.status, "resolved");
  assert.ok(resolution.incident.resolution_evidence);
});
