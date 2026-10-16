/**
 * R03 — the scan's terminal outcome: what was MEASURED, not merely what ran.
 *
 * THE DEFECT THIS MODULE EXISTS TO REMOVE (finding A07).
 * A scan in which all 120 question/engine pairs failed finalized as
 * `scan_jobs.status = "complete"`. "Complete" meant "the worker finished
 * processing rows" and every reader — dashboard, report, export — rounded that
 * up to "we successfully measured your brand". A run that measured nothing was
 * indistinguishable from a healthy one.
 *
 * THE TWO STATE MACHINES, KEPT APART ON PURPOSE (R03.2a).
 *   * EXECUTION is what the worker did. It is a lifecycle: a scan is either
 *     still running or it has terminated. The worker process stopping is not a
 *     statement about data quality, and this module does not pretend otherwise.
 *   * COLLECTION is what the run actually measured, derived from the PERSISTED
 *     observations and never from an array length. `complete` here means every
 *     planned observation produced a usable result — an answer or a valid
 *     no-AIO SERP — and nothing else. A run whose every pair failed is `failed`
 *     forever, however cleanly its worker exited.
 *
 * WHY THE COUNTS COME FROM ROWS AND NOT FROM WHAT WAS DISPATCHED.
 * `planned` is the frozen work matrix. Whether each planned observation produced
 * a usable result is read off the persisted rows, one logical disposition per
 * (engine, query). The terminal rule that makes A07 unreproducible is
 * `deriveScanOutcome`'s: `outcome` is `failed` whenever zero usable results
 * were collected, regardless of how many rows were processed. A caller cannot
 * get `complete` out of an all-error scan by passing it a long array.
 *
 * THE CLOSED EQUATION (section D of the repair backlog).
 *   planned = answered + valid_no_aio + failed + not_attempted
 * Attempts may exceed planned (a pair retried is still one planned unit of
 * work); repeated attempts never expand the denominator. `deriveScanOutcome`
 * computes `equation.holds` and callers are expected to treat a false as a bug.
 *
 * PURE. No imports, no I/O, no clock. Everything here is a function of its
 * arguments so the honesty properties can be tested without a database.
 */

/** The vocabulary version. Bump when an outcome field changes meaning. */
export const SCAN_OUTCOME_VERSION = "r03-v1";

/** Execution lifecycle — deliberately orthogonal to collection quality. */
export const EXECUTION_PHASES = Object.freeze({
  RUNNING: "running",
  TERMINAL: "terminal",
});

/**
 * The terminal collection outcomes. `complete` is the ONLY success; everything
 * else is a specific, actionable failure of measurement.
 *
 * INVALID is not a failure of the provider — it is a scan that had no work to
 * do. It must never render as "0% collected" or "100% complete": there was no
 * denominator to divide by, which is a fact, not a zero.
 *
 * LEGACY is a historical record whose work matrix cannot be reconstructed. Its
 * quality is UNKNOWN and stays unknown; inventing a modern count for it (a
 * 100% collection, a mention rate) would be a lie about the past.
 */
export const COLLECTION_OUTCOMES = Object.freeze({
  COMPLETE: "complete",
  PARTIAL: "partial",
  FAILED: "failed",
  BLOCKED: "blocked",
  INVALID: "invalid",
  LEGACY: "legacy",
});

/** The four exclusive dispositions of one planned observation. */
export const DISPOSITIONS = Object.freeze({
  ANSWERED: "answered",
  VALID_NO_AIO: "valid_no_aio",
  FAILED: "failed",
  NOT_ATTEMPTED: "not_attempted",
});

/** Why a scan ended with the collection outcome it did. Closed vocabulary. */
export const OUTCOME_REASONS = Object.freeze({
  FULL_VALID_COLLECTION: "full_valid_collection",
  MIXED_USABLE_FAILING: "mixed_usable_failing",
  NO_USABLE_COLLECTION: "no_usable_collection",
  NOTHING_ATTEMPTED: "nothing_attempted",
  ZERO_PLANNED_WORK: "zero_planned_work",
  LEGACY_MATRIX_MISSING: "legacy_matrix_missing",
  BLOCKED_BEFORE_COMPLETION: "blocked_before_completion",
});

/**
 * Why execution stopped before the plan did. A blocked scan keeps its whole
 * `not_attempted` remainder; nothing is erased from the denominator to make a
 * stop look like a completion.
 */
export const BLOCK_REASONS = Object.freeze({
  PERMANENT_PROVIDER_FAILURE: "permanent_provider_failure",
  CONFIGURATION_UNAVAILABLE: "configuration_unavailable",
  ENGINE_NOT_REGISTERED: "engine_not_registered",
  ENGINE_SET_FALLBACK: "engine_set_fallback",
  SPEND_CAP_PER_SCAN: "spend_cap_per_scan",
  SPEND_CAP_PER_DAY: "spend_cap_per_day",
});

/** A measured count rounds for display only; the counts themselves stay exact. */
function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * The logical key one planned observation is matched to a persisted row by.
 *
 * Normalised on both sides: the sourcing phase persists `unbranded_texts` as
 * lowercased/trimmed text while a persisted row carries the query text as the
 * adapter returned it, so a raw comparison would find NO match on any prompt
 * with different casing and read a fully-successful scan as not-attempted. Two
 * questions that differ only by case are the same logical question.
 */
export function observationKey(engine, query) {
  return `${String(engine || "").toLowerCase()}|${String(query || "").toLowerCase().trim()}`;
}

/** Engine name from a plan entry, a row, or nothing — never invented. */
function engineOf(thing) {
  if (typeof thing === "string") return thing;
  return (thing && (thing.engine || thing.raw?.engine)) || null;
}

/** Query text from a plan entry or a row. */
function queryOf(thing) {
  if (!thing || typeof thing !== "object") return null;
  return thing.query ?? thing.text ?? thing.raw?.prompt ?? null;
}

/**
 * The frozen scoring work matrix: every prompt x every frozen engine. This is
 * the denominator and it is fixed BEFORE any outcome is observed (section D: a
 * denominator defined after the results is not a denominator).
 */
export function buildScorePlan({ prompts = [], engines = [] } = {}) {
  const plan = [];
  for (const prompt of prompts) {
    const query = queryOf(prompt) ?? (typeof prompt === "string" ? prompt : null);
    if (!query) continue;
    for (const engine of engines) {
      const name = engineOf(engine);
      if (!name) continue;
      plan.push({ engine: name, query, purpose: "scoring" });
    }
  }
  return plan;
}

/**
 * The separately-tagged branded diagnostics: four per engine by convention.
 * They are OBSERVATIONS but they are NOT scoring observations, and this module
 * keeps their count apart from the scoring denominator so a diagnostic can
 * never inflate or dilute a headline (R03-06).
 */
export function buildDiagnosticPlan({ brands = [], engines = [] } = {}) {
  const plan = [];
  for (const brand of brands) {
    const query = queryOf(brand) ?? (typeof brand === "string" ? brand : null);
    if (!query) continue;
    for (const engine of engines) {
      const name = engineOf(engine);
      if (!name) continue;
      plan.push({ engine: name, query, purpose: "diagnostic" });
    }
  }
  return plan;
}

/**
 * The terminal outcomes and reason codes a completed scan carries, as ONE
 * object that every surface reads. `diagnostics` is a plan/list for the
 * separately-counted branded checks.
 */
export function buildWorkMatrix({ prompts = [], engines = [], diagnosticBrands = [] } = {}) {
  const scoring = buildScorePlan({ prompts, engines });
  const diagnostics = buildDiagnosticPlan({ brands: diagnosticBrands, engines });
  return { scoring, diagnostics };
}

// ---------------------------------------------------------------------------
// One observation's disposition
// ---------------------------------------------------------------------------

/**
 * A coarse, closed classifier for the failure text a row carries. The provider
 * reason is only ever a LABEL — the point of the disposition is that the row is
 * `failed`, never that a failure means the brand was absent.
 */
export function failureCode(errorText) {
  const text = String(errorText || "").toLowerCase();
  if (!text) return null;
  if (/401|credential|unauthor|invalid.*key|api key/.test(text)) return "credential_rejection";
  if (/spend|quota|billing|credit|limit reached|insufficient/.test(text)) return "spend_limit";
  if (/429|rate limit|throttl/.test(text)) return "rate_limit";
  if (/timeout|timed out|deadline|abort/.test(text)) return "timeout";
  if (/cookie|no[- ]?ready|zone|proxy|session/.test(text)) return "provider_capacity";
  if (/502|503|504|bad gateway|unavailable/.test(text)) return "provider_unavailable";
  if (/parse|schema|malformed|invalid shape/.test(text)) return "parse_error";
  return "provider_failure";
}

const TRUTHY = new Set([true, "true", 1, "1"]);

/**
 * Classify ONE persisted observation row into an exclusive disposition.
 *
 * The rule that corrects A01: a row with NO error and NO answer is a VALID
 * no-AIO SERP — a legitimate "the assistant did not produce an overview" — not
 * a collection failure. Only a row that carries an error is `failed`.
 *
 * A row that cannot be read at all is `failed` with an explicit reason, never
 * silently dropped: a dropped row is indistinguishable from one never planned.
 */
export function classifyObservation(row) {
  if (!row || typeof row !== "object") {
    return { disposition: DISPOSITIONS.FAILED, reason: "unreadable_row" };
  }
  const raw = row.raw || {};
  const errorText = row.error || raw.error || null;
  if (errorText) {
    return { disposition: DISPOSITIONS.FAILED, reason: failureCode(errorText) };
  }
  const answered =
    TRUTHY.has(row.answered) ||
    TRUTHY.has(row.answer_present) ||
    TRUTHY.has(raw.answer_present) ||
    TRUTHY.has(raw.aio_present);
  if (answered) return { disposition: DISPOSITIONS.ANSWERED, reason: null };
  return { disposition: DISPOSITIONS.VALID_NO_AIO, reason: null };
}

/** True when an answered row actually carried an AI overview / AI answer. */
function hasAio(row) {
  const raw = row.raw || {};
  return TRUTHY.has(raw.aio_present) || TRUTHY.has(row.aio_present);
}

// ---------------------------------------------------------------------------
// The one derivation function
// ---------------------------------------------------------------------------

/**
 * Derive a scan's terminal collection outcome from its PERSISTED observations.
 *
 * @param {object} input
 * @param {Array<{engine:string,query:string}>} [input.plan] scoring work matrix.
 * @param {Array<object>} [input.rows] persisted scoring observation rows (may
 *   repeat a logical pair; repeats are attempts, counted once).
 * @param {Array<object>} [input.diagnostics] separately-tagged branded rows.
 * @param {{reason:string, detail?:string}|null} [input.blocked] set when
 *   execution stopped before the plan did.
 * @param {number|null} [input.attempts] explicit attempt count; defaults to the
 *   number of scoring rows supplied.
 * @param {string[]|null} [input.engineNames] the frozen engine order.
 * @returns {object} a versioned terminal outcome — the wire/persisted shape.
 */
export function deriveScanOutcome({
  plan = [],
  rows = [],
  diagnostics = [],
  blocked = null,
  attempts = null,
  engineNames = null,
} = {}) {
  const planIndex = new Map();
  for (const entry of plan) {
    const engine = engineOf(entry);
    const query = queryOf(entry);
    if (!engine || !query) continue;
    planIndex.set(observationKey(engine, query), { engine, query });
  }
  const planned = planIndex.size;

  // One logical disposition per planned pair. A duplicate delivery or a retried
  // observation matches a key already seen and is NOT counted again; it only
  // raises the attempt count. A row whose key is not in the frozen plan is an
  // extra attempt for work this scan never planned, so it cannot expand the
  // denominator either.
  const firstByKey = new Map();
  let scoringRows = 0;
  for (const row of rows) {
    const engine = engineOf(row);
    const query = queryOf(row);
    const key = observationKey(engine, query);
    scoringRows += 1;
    if (!planIndex.has(key)) continue;
    if (!firstByKey.has(key)) firstByKey.set(key, row);
  }

  const counts = { answered: 0, valid_no_aio: 0, failed: 0 };
  const failedReasons = {};
  const aioPresent = { count: 0 };
  const perEngine = new Map();

  for (const [key, row] of firstByKey) {
    const { engine } = planIndex.get(key);
    const { disposition, reason } = classifyObservation(row);
    counts[disposition] += 1;
    if (disposition === DISPOSITIONS.ANSWERED && hasAio(row)) aioPresent.count += 1;
    if (disposition === DISPOSITIONS.FAILED && reason) {
      failedReasons[reason] = (failedReasons[reason] || 0) + 1;
    }
    const e = perEngine.get(engine) || { answered: 0, valid_no_aio: 0, failed: 0 };
    e[disposition] += 1;
    perEngine.set(engine, e);
  }

  const answered = counts.answered;
  const validNoAio = counts.valid_no_aio;
  const failed = counts.failed;
  const valid = answered + validNoAio;
  const notAttempted = planned - (answered + validNoAio + failed);
  const equationHolds = planned === answered + validNoAio + failed + notAttempted;

  const isBlocked = Boolean(blocked && blocked.reason);

  // THE TERMINAL RULE (R03.2b). Order matters: a stop outranks a low count, and
  // an all-error collection is `failed` — never `complete` — even though every
  // planned pair produced a persisted row.
  let outcome;
  let outcomeReason;
  if (planned === 0) {
    outcome = COLLECTION_OUTCOMES.INVALID;
    outcomeReason = OUTCOME_REASONS.ZERO_PLANNED_WORK;
  } else if (isBlocked) {
    outcome = COLLECTION_OUTCOMES.BLOCKED;
    outcomeReason = OUTCOME_REASONS.BLOCKED_BEFORE_COMPLETION;
  } else if (valid === 0 && failed === 0 && notAttempted > 0) {
    outcome = COLLECTION_OUTCOMES.BLOCKED;
    outcomeReason = OUTCOME_REASONS.NOTHING_ATTEMPTED;
  } else if (valid === 0) {
    outcome = COLLECTION_OUTCOMES.FAILED;
    outcomeReason = OUTCOME_REASONS.NO_USABLE_COLLECTION;
  } else if (failed > 0 || notAttempted > 0) {
    outcome = COLLECTION_OUTCOMES.PARTIAL;
    outcomeReason = OUTCOME_REASONS.MIXED_USABLE_FAILING;
  } else {
    outcome = COLLECTION_OUTCOMES.COMPLETE;
    outcomeReason = OUTCOME_REASONS.FULL_VALID_COLLECTION;
  }

  // A percentage needs a denominator. Zero planned work has none, so there is no
  // completion percentage to publish — not 0, and certainly not 100.
  const completionPct = planned > 0 ? round1((valid / planned) * 100) : null;

  // AIO trigger is AIO-present / valid SERPs. Valid no-AIO is valid collection
  // with a zero trigger; a zero trigger is not the same as a missing headline,
  // so the conditional headline is null only when there is nothing to condition
  // on.
  const validSerps = valid;
  const triggerRate = validSerps > 0 ? round1((aioPresent.count / validSerps) * 100) : null;
  const conditionalHeadline = validSerps > 0 && aioPresent.count > 0 ? triggerRate : null;

  // A blocked or zero-work scan measured no mentions. Its mention rate is
  // UNKNOWN, never a measured zero — provider failures never mean brand absence.
  const mentionMeasured = valid > 0 && !isBlocked;

  const enginesOrdered = engineNames && engineNames.length ? engineNames : [...new Set(plan.map(engineOf).filter(Boolean))];
  const engineSummaries = enginesOrdered.map((name) => {
    let enginePlanned = 0;
    for (const entry of planIndex.values()) if (entry.engine === name) enginePlanned += 1;
    const e = perEngine.get(name) || { answered: 0, valid_no_aio: 0, failed: 0 };
    const engineValid = e.answered + e.valid_no_aio;
    const engineNotAttempted = enginePlanned - (e.answered + e.valid_no_aio + e.failed);
    let state;
    if (enginePlanned > 0 && engineValid === 0 && e.failed === 0 && engineNotAttempted === enginePlanned) {
      // Never dispatched at all (the engine lost its configuration, or a stop
      // landed before its first batch). Distinct from a partial run.
      state = DISPOSITIONS.NOT_ATTEMPTED;
    } else if (e.failed > 0 && engineValid === 0) state = COLLECTION_OUTCOMES.FAILED;
    else if (e.failed > 0 || engineNotAttempted > 0) state = COLLECTION_OUTCOMES.PARTIAL;
    else if (engineValid > 0) state = COLLECTION_OUTCOMES.COMPLETE;
    else state = DISPOSITIONS.NOT_ATTEMPTED;
    return {
      name,
      planned: enginePlanned,
      answered: e.answered,
      valid_no_aio: e.valid_no_aio,
      failed: e.failed,
      not_attempted: engineNotAttempted,
      valid: engineValid,
      state,
    };
  });

  return {
    version: SCAN_OUTCOME_VERSION,
    outcome,
    outcome_reason: outcomeReason,
    execution_phase: EXECUTION_PHASES.TERMINAL,
    blocked: isBlocked ? { reason: blocked.reason, detail: blocked.detail ?? null } : null,
    counts: {
      planned,
      answered,
      valid_no_aio: validNoAio,
      failed,
      not_attempted: notAttempted,
      valid,
      diagnostics: diagnostics.length,
      scoring_attempts: attempts === null ? scoringRows : attempts,
    },
    failed_reasons: failedReasons,
    equation: {
      holds: equationHolds,
      expression: `${planned} = ${answered} + ${validNoAio} + ${failed} + ${notAttempted}`,
    },
    metrics: {
      collection_completion_pct: completionPct,
      valid_observations: valid,
      measured: valid > 0,
      mention_measured: mentionMeasured,
      aio_trigger: {
        valid_serps: validSerps,
        aio_present: aioPresent.count,
        trigger_rate_pct: triggerRate,
        conditional_headline: conditionalHeadline,
      },
    },
    engines: engineSummaries,
  };
}

// ---------------------------------------------------------------------------
// Reading a persisted outcome — one vocabulary everywhere
// ---------------------------------------------------------------------------

/**
 * The terminal outcome of a record whose matrix cannot be reconstructed.
 *
 * R03.5b: a historical `scans` row written before this vocabulary existed has
 * no work matrix, so its collection quality is UNKNOWN. Every count is null,
 * never 0 and never 100 — "we cannot tell" is the honest answer, and defaulting
 * any of these to a number is how a fabricated 100% collection gets published.
 */
export function legacyTerminalOutcome() {
  return {
    version: SCAN_OUTCOME_VERSION,
    outcome: COLLECTION_OUTCOMES.LEGACY,
    outcome_reason: OUTCOME_REASONS.LEGACY_MATRIX_MISSING,
    execution_phase: EXECUTION_PHASES.TERMINAL,
    blocked: null,
    counts: {
      planned: null,
      answered: null,
      valid_no_aio: null,
      failed: null,
      not_attempted: null,
      valid: null,
      diagnostics: null,
      scoring_attempts: null,
    },
    failed_reasons: {},
    equation: { holds: null, expression: null },
    metrics: {
      collection_completion_pct: null,
      valid_observations: null,
      measured: false,
      mention_measured: false,
      aio_trigger: {
        valid_serps: null,
        aio_present: null,
        trigger_rate_pct: null,
        conditional_headline: null,
      },
    },
    engines: [],
    legacy: true,
  };
}

/** A stable wire projection of a derived outcome — identical counters on every surface. */
export function terminalOutcomeWire(outcome) {
  if (!outcome || outcome.version !== SCAN_OUTCOME_VERSION) return legacyTerminalOutcome();
  return {
    version: outcome.version,
    outcome: outcome.outcome,
    outcome_reason: outcome.outcome_reason,
    execution_phase: outcome.execution_phase,
    blocked: outcome.blocked,
    counts: { ...outcome.counts },
    failed_reasons: { ...outcome.failed_reasons },
    equation: { ...outcome.equation },
    metrics: {
      ...outcome.metrics,
      aio_trigger: { ...outcome.metrics.aio_trigger },
    },
    engines: outcome.engines.map((e) => ({ ...e })),
    ...(outcome.legacy ? { legacy: true } : {}),
  };
}

/**
 * The terminal outcome of a persisted record, in one shape.
 *
 * Accepts a derived outcome directly, a `scans`/job row with
 * `raw_results.summary_stats`, or an already-enriched scan carrying
 * `summary_stats`. Anything it cannot recognise is `legacy` — a record whose
 * quality is unknown is never dressed up as a modern 100% collection.
 *
 * This is THE reader the status route, the report route, history and export all
 * call, so the version, the outcome and every counter are identical wherever a
 * scan is shown.
 */
export function terminalOutcomeFromRecord(record) {
  if (!record || typeof record !== "object") return legacyTerminalOutcome();
  if (record.version === SCAN_OUTCOME_VERSION && record.outcome) {
    return terminalOutcomeWire(record);
  }
  const raw = record.raw_results || {};
  const stored =
    raw.summary_stats?.terminal_outcome ??
    record.summary_stats?.terminal_outcome ??
    record.terminal_outcome ??
    null;
  if (!stored || stored.version !== SCAN_OUTCOME_VERSION) return legacyTerminalOutcome();
  return terminalOutcomeWire(stored);
}
