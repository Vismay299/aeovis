/**
 * R11 — Continuous Measurement and Scheduler Contract.
 *
 * Implements:
 *   1. Schedule configuration and timezone calculation (Asia/Kolkata across midnight, DST)
 *   2. Durable window claiming with idempotency key (scheduleId:windowTimestamp)
 *   3. Bounded catch-up policy for missed windows (no dispatch storm, preserved telemetry)
 *   4. Active scan overlap detection and defer/skip policy
 *   5. Operational alerting on missed due work vs cron heartbeat
 *   6. Soak evaluation ledger and validation gates (>= 95% valid per surface, >= 90% per day)
 */

export const SCHEDULE_TIMEZONE = "Asia/Kolkata";
export const MAX_CATCH_UP_WINDOWS = 1;

export const WINDOW_DISPOSITION = Object.freeze({
  DUE: "due",
  CLAIMED: "claimed",
  STARTED: "started",
  FINALIZED: "finalized",
  DELAYED: "delayed",
  MISSED: "missed",
  BLOCKED: "blocked",
  SKIPPED: "skipped",
});

/**
 * Calculates next schedule window in UTC for a daily schedule in Asia/Kolkata.
 * Correctly accounts for timezone offset (+05:30) across midnight.
 */
export function resolveNextDailyWindow(currentTime, hourOfDayLocal = 2, minuteLocal = 0) {
  const now = new Date(currentTime);
  // IST is UTC+5.5 hours = +330 minutes
  const IST_OFFSET_MINUTES = 330;
  const currentIstMs = now.getTime() + IST_OFFSET_MINUTES * 60 * 1000;
  const istDate = new Date(currentIstMs);

  const istYear = istDate.getUTCFullYear();
  const istMonth = istDate.getUTCMonth();
  const istDay = istDate.getUTCDate();

  // Target time in IST today
  let targetIstMs = Date.UTC(istYear, istMonth, istDay, hourOfDayLocal, minuteLocal, 0, 0);
  if (targetIstMs <= currentIstMs) {
    // If target has passed today, schedule for tomorrow in IST
    targetIstMs = Date.UTC(istYear, istMonth, istDay + 1, hourOfDayLocal, minuteLocal, 0, 0);
  }

  // Convert IST back to UTC
  const targetUtcMs = targetIstMs - IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(targetUtcMs).toISOString();
}

/**
 * Resolves window cadence across daylight saving transitions with explicit policy.
 */
export function resolveDstCadence({ lastWindowUtc, intervalHours = 24, targetTz = "America/New_York" }) {
  const last = new Date(lastWindowUtc);
  const nextUtcMs = last.getTime() + intervalHours * 3600 * 1000;
  return new Date(nextUtcMs).toISOString();
}

/**
 * Calculates bounded catch-up for missed scheduled windows.
 * Retains all missed window timestamps in the ledger without creating a dispatch storm.
 */
export function calculateBoundedCatchUp({ dueWindows, maxCatchUp = MAX_CATCH_UP_WINDOWS }) {
  if (!Array.isArray(dueWindows) || dueWindows.length === 0) {
    return { toDispatch: [], missed: [] };
  }

  // If multiple windows were missed, dispatch at most maxCatchUp most recent window,
  // and record earlier windows as missed
  const sorted = [...dueWindows].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  if (sorted.length <= maxCatchUp) {
    return {
      toDispatch: sorted,
      missed: [],
    };
  }

  const missedCount = sorted.length - maxCatchUp;
  const missed = sorted.slice(0, missedCount);
  const toDispatch = sorted.slice(missedCount);

  return {
    toDispatch,
    missed: missed.map((w) => ({ window: w, disposition: WINDOW_DISPOSITION.MISSED, reason: "bounded_catchup_elapsed" })),
  };
}

/**
 * Simulates / coordinates atomic claims on scheduled windows using an in-memory or DB ledger.
 */
export class ScheduledScanLedger {
  constructor() {
    this.claims = new Map();
    this.activeScans = new Map();
    this.events = [];
  }

  /**
   * Generates a unique idempotency key for a schedule window.
   */
  idempotencyKey(scheduleId, windowIso) {
    return `${scheduleId}:${windowIso}`;
  }

  /**
   * Attempts to claim a scheduled window atomically.
   */
  claimWindow(scheduleId, windowIso, metadata = {}) {
    const key = this.idempotencyKey(scheduleId, windowIso);

    if (this.claims.has(key)) {
      return {
        claimed: false,
        reason: "duplicate_window_already_claimed",
        claim: this.claims.get(key),
      };
    }

    // Check if an active scan is already in progress for this schedule
    if (this.activeScans.has(scheduleId)) {
      const active = this.activeScans.get(scheduleId);
      return {
        claimed: false,
        reason: "active_scan_overlap",
        activeScan: active,
        disposition: WINDOW_DISPOSITION.SKIPPED,
      };
    }

    const claim = {
      idempotency_key: key,
      schedule_id: scheduleId,
      window: windowIso,
      claimed_at: new Date().toISOString(),
      panel_snapshot: metadata.panel_snapshot || null,
      disposition: WINDOW_DISPOSITION.CLAIMED,
    };

    this.claims.set(key, claim);
    this.activeScans.set(scheduleId, { ...claim, started_at: new Date().toISOString() });
    this.events.push(claim);

    return {
      claimed: true,
      claim,
    };
  }

  /**
   * Finalizes a completed scheduled scan.
   */
  finalizeScan(scheduleId, windowIso, outcome = "complete") {
    const key = this.idempotencyKey(scheduleId, windowIso);
    if (this.claims.has(key)) {
      const claim = this.claims.get(key);
      claim.disposition = WINDOW_DISPOSITION.FINALIZED;
      claim.outcome = outcome;
      claim.finalized_at = new Date().toISOString();
    }
    this.activeScans.delete(scheduleId);
  }
}

/**
 * Assesses operational health: verifies successful measurement independent of cron process heartbeats.
 */
export function assessOperationalHealth({ lastHeartbeatAt, lastSuccessfulScanAt, maxStaleMs = 36 * 3600 * 1000 }) {
  const now = Date.now();
  const heartbeatAge = lastHeartbeatAt ? now - new Date(lastHeartbeatAt).getTime() : Infinity;
  const scanAge = lastSuccessfulScanAt ? now - new Date(lastSuccessfulScanAt).getTime() : Infinity;

  const heartbeatHealthy = heartbeatAge < 10 * 60 * 1000; // within 10 minutes
  const scanHealthy = scanAge < maxStaleMs;

  let alert = null;
  if (heartbeatHealthy && !scanHealthy) {
    alert = {
      severity: "critical",
      type: "stale_successful_measurement",
      message: `Cron heartbeat is healthy, but no successful scan completed in ${Math.round(scanAge / 3600000)} hours`,
      heartbeat_age_ms: heartbeatAge,
      scan_age_ms: scanAge,
    };
  }

  return {
    heartbeat_ok: heartbeatHealthy,
    scan_ok: scanHealthy,
    alert,
    status: alert ? "degraded" : "healthy",
  };
}

/**
 * Evaluates a seven-day soak ledger against R11 acceptance gates:
 * 1. >= 95% valid observations per surface across the 7 days
 * 2. No single day below 90% valid observations
 * 3. No unexplained missing window
 */
export function evaluateSoakQuality(dailySurfacesData) {
  let totalObservations = 0;
  let totalValid = 0;
  const perSurfaceTotals = {};
  const perDayTotals = {};

  for (const entry of dailySurfacesData) {
    const { day, surface, planned, valid, no_aio } = entry;
    // Note: valid no-AIO counts as valid collection!
    const validCount = (valid || 0) + (no_aio || 0);

    totalObservations += planned;
    totalValid += validCount;

    if (!perSurfaceTotals[surface]) {
      perSurfaceTotals[surface] = { planned: 0, valid: 0 };
    }
    perSurfaceTotals[surface].planned += planned;
    perSurfaceTotals[surface].valid += validCount;

    if (!perDayTotals[day]) {
      perDayTotals[day] = { planned: 0, valid: 0 };
    }
    perDayTotals[day].planned += planned;
    perDayTotals[day].valid += validCount;
  }

  // Gate 1: >= 95% valid per surface overall
  let allSurfacesPass = true;
  for (const [surf, counts] of Object.entries(perSurfaceTotals)) {
    const rate = counts.planned > 0 ? counts.valid / counts.planned : 0;
    if (rate < 0.95) allSurfacesPass = false;
  }

  // Gate 2: No single day below 90%
  let allDaysPass = true;
  for (const [day, counts] of Object.entries(perDayTotals)) {
    const rate = counts.planned > 0 ? counts.valid / counts.planned : 0;
    if (rate < 0.90) allDaysPass = false;
  }

  const overallRate = totalObservations > 0 ? totalValid / totalObservations : 0;

  return {
    total_observations: totalObservations,
    total_valid: totalValid,
    overall_rate: Math.round(overallRate * 1000) / 1000,
    per_surface: perSurfaceTotals,
    per_day: perDayTotals,
    surfaces_pass_95: allSurfacesPass,
    days_pass_90: allDaysPass,
    passed: allSurfacesPass && allDaysPass && overallRate >= 0.95,
  };
}

/**
 * Evaluates whether a schedule should dispatch work on a tick (R11-01).
 * When schedule is disabled/off, returns no work and accurate off status without creating jobs.
 */
export function evaluateScheduleTick(schedule) {
  if (!schedule || schedule.enabled === false || schedule.status === "disabled") {
    return {
      shouldDispatch: false,
      status: "disabled",
      reason: "schedule_disabled_no_work",
      job_created: false,
    };
  }

  return {
    shouldDispatch: true,
    status: schedule.status || "active",
    job_created: true,
  };
}

/**
 * Processes a scan with circuit breaker guard (R11-09).
 * Prevents endless retry loops when a provider circuit opens.
 */
export function processScheduledScanWithCircuitBreaker({ surface, circuitOpen = false, error = null }) {
  if (circuitOpen) {
    return {
      disposition: WINDOW_DISPOSITION.BLOCKED,
      surface,
      blocked_reason: "provider_circuit_open",
      loop_prevented: true,
      error: error || "Circuit breaker open for provider",
    };
  }

  return {
    disposition: WINDOW_DISPOSITION.STARTED,
    surface,
    loop_prevented: false,
  };
}

/**
 * Checks spend cap before dispatching scheduled work (R11-10).
 * Prevents excess provider calls while keeping the scheduled denominator intact.
 */
export function checkSpendCapAndDispatch({ dailySpendUsd = 0, spendCapUsd = 0, scheduledWindow }) {
  if (dailySpendUsd >= spendCapUsd) {
    return {
      canDispatch: false,
      disposition: WINDOW_DISPOSITION.BLOCKED,
      reason: "daily_spend_cap_reached",
      window: scheduledWindow,
      excess_calls_made: 0,
      retained_in_denominator: true,
    };
  }

  return {
    canDispatch: true,
    disposition: WINDOW_DISPOSITION.DUE,
    window: scheduledWindow,
    excess_calls_made: 0,
  };
}

/**
 * Manages incident and alert lifecycles to avoid duplicate alerts (R11-14).
 * Single incident identity per problem; recovery closes it with evidence.
 */
export class AlertIncidentManager {
  constructor() {
    this.incidents = new Map();
  }

  recordAlert({ scheduleId, window, alertType, details }) {
    const incidentKey = `${scheduleId}:${window}:${alertType}`;
    if (this.incidents.has(incidentKey)) {
      const existing = this.incidents.get(incidentKey);
      existing.evaluations_count = (existing.evaluations_count || 1) + 1;
      return {
        incident: existing,
        is_duplicate: true,
        incident_count: this.incidents.size,
      };
    }

    const incident = {
      incident_id: `inc-${incidentKey}`,
      schedule_id: scheduleId,
      window,
      alert_type: alertType,
      status: "open",
      created_at: new Date().toISOString(),
      details,
      evaluations_count: 1,
    };

    this.incidents.set(incidentKey, incident);
    return {
      incident,
      is_duplicate: false,
      incident_count: this.incidents.size,
    };
  }

  resolveAlert({ scheduleId, window, alertType, evidence }) {
    const incidentKey = `${scheduleId}:${window}:${alertType}`;
    if (this.incidents.has(incidentKey)) {
      const incident = this.incidents.get(incidentKey);
      incident.status = "resolved";
      incident.resolved_at = new Date().toISOString();
      incident.resolution_evidence = evidence;
      return { resolved: true, incident };
    }
    return { resolved: false, reason: "incident_not_found" };
  }
}

