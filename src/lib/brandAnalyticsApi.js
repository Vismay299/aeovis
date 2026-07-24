/**
 * Pure, dependency-free helpers for the P0.4 brand analytics API routes
 * (src/app/api/brands/[brand]/metrics, .../schedule — plan.md §4 P0.4).
 * Kept out of the route files so they're unit-testable with `node --test`
 * (see brandAnalyticsApi.test.mjs) without booting Next.js or a DB client.
 *
 * Brand-keying contract: every function here treats its `brand`/`key`
 * argument (where present) as an OPAQUE resolveBrandKey() output (see
 * scoring/brandKey.js) — the `[brand]` path param on these routes IS ALREADY
 * that resolved key (the dashboard passes the domain, not the display name).
 * Nothing in this file re-derives or re-normalizes it.
 */

// ---------------------------------------------------------------------------
// GET /metrics — query param parsing + summary calc
// ---------------------------------------------------------------------------

export const VALID_ENGINES = ["aio", "chatgpt", "perplexity", "all"];

/**
 * Defensive cap on GET /metrics series length (plan.md P0.4: "no pagination
 * needed, but cap defensively at, say, 400 rows"). Callers should keep the
 * MOST RECENT rows when a brand's history exceeds this (a trend chart cares
 * about recency over depth) — i.e. `rows.slice(-MAX_SERIES_ROWS)`.
 */
export const MAX_SERIES_ROWS = 400;

/**
 * Validates + normalizes the `engine` query param. Defaults to "all" (the
 * blended row brand_metrics_daily always carries per plan.md P0.1) when
 * absent/empty. Returns `{ engine, error }` — exactly one is non-null.
 */
export function parseEngineParam(raw) {
  if (raw == null || raw === "") return { engine: "all", error: null };
  const normalized = String(raw).trim().toLowerCase();
  if (!VALID_ENGINES.includes(normalized)) {
    return { engine: null, error: `engine must be one of: ${VALID_ENGINES.join(", ")}` };
  }
  return { engine: normalized, error: null };
}

/**
 * Validates + normalizes an ISO date query param (`from`/`to`) to a plain
 * YYYY-MM-DD string comparable against brand_metrics_daily's `date` column
 * (a full ISO datetime is accepted and truncated to its UTC calendar date).
 * Absent/empty input is valid and means "no bound" (returns `{ date: null }`,
 * matching "no range = all history").
 */
export function parseDateParam(raw, label) {
  if (raw == null || raw === "") return { date: null, error: null };
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { date: null, error: `${label} must be a valid ISO date.` };
  }
  return { date: parsed.toISOString().slice(0, 10), error: null };
}

/**
 * Overview trend header payload (plan.md P0.4): latest visibility_pct + delta
 * vs the previous point. Null-safe for empty/singleton series, and whenever
 * either point's visibility_pct itself is null. `series` must already be
 * ordered by date ascending (getBrandMetricsSeries guarantees this).
 */
export function computeVisibilitySummary(series) {
  const empty = {
    latest_date: null,
    latest_visibility_pct: null,
    previous_visibility_pct: null,
    delta_visibility_pct: null,
  };
  if (!Array.isArray(series) || series.length === 0) return empty;

  const latest = series[series.length - 1];
  const latest_visibility_pct = latest.visibility_pct ?? null;
  const latest_date = latest.date ?? null;

  if (series.length < 2) {
    return { latest_date, latest_visibility_pct, previous_visibility_pct: null, delta_visibility_pct: null };
  }

  const previous = series[series.length - 2];
  const previous_visibility_pct = previous.visibility_pct ?? null;
  const delta_visibility_pct =
    latest_visibility_pct != null && previous_visibility_pct != null
      ? Math.round((latest_visibility_pct - previous_visibility_pct) * 10) / 10
      : null;

  return { latest_date, latest_visibility_pct, previous_visibility_pct, delta_visibility_pct };
}

// ---------------------------------------------------------------------------
// GET|PUT /schedule — validation + next_run_at derivation
// ---------------------------------------------------------------------------

export const VALID_CADENCES = ["72h", "daily", "weekly", "off"];

const CADENCE_MS = {
  "72h": 72 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/**
 * INTENTIONAL TEMPORARY DUPLICATION (plan.md P0.4 spec, flagged explicitly):
 * scanWorker.js already exports a `computeNextRunAt` with the same
 * 72h/daily/weekly math, but that file is being rewritten by a parallel work
 * package right now, so this route package keeps its own copy rather than
 * importing from a file mid-rewrite. Behavior deliberately differs in one
 * way: scanWorker's version has no "off" case (its only call site — the
 * scheduler tick — filters `cadence:"off"` out before ever calling it),
 * while THIS route needs "off" to mean "clear next_run_at" directly (a user
 * can PUT `cadence:"off"` and the schedule must stop reading as due).
 * Consolidate into one shared export once the P0.2 scanWorker rewrite lands.
 */
export function computeNextRunAt(cadence, fromIso) {
  if (cadence === "off") return null;
  const ms = CADENCE_MS[cadence] ?? CADENCE_MS["72h"];
  const fromMs = new Date(fromIso || Date.now()).getTime();
  return new Date(fromMs + ms).toISOString();
}

/**
 * Validates a PUT /schedule request body against plan.md P0.4's rules.
 * Returns `{ error, updates }`: on success `error` is null and `updates`
 * holds ONLY the fields the caller actually supplied (never invents defaults
 * for omitted fields) — upsertScanSchedule's upsert is column-scoped (see
 * db/analytics.test.mjs "unrelated fields survive the upsert"), so omitting a
 * key here means "don't touch it," not "clear it."
 */
export function validateScheduleBody(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object.", updates: null };
  }

  const updates = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (has("cadence")) {
    if (!VALID_CADENCES.includes(body.cadence)) {
      return { error: `cadence must be one of: ${VALID_CADENCES.join(", ")}`, updates: null };
    }
    updates.cadence = body.cadence;
  }

  if (has("enabled")) {
    if (typeof body.enabled !== "boolean") {
      return { error: "enabled must be a boolean.", updates: null };
    }
    updates.enabled = body.enabled;
  }

  if (has("prompt_target")) {
    const n = body.prompt_target;
    if (!Number.isInteger(n) || n < 10 || n > 100) {
      return { error: "prompt_target must be an integer between 10 and 100.", updates: null };
    }
    updates.prompt_target = n;
  }

  if (has("geo")) {
    if (typeof body.geo !== "string" || !body.geo.trim()) {
      return { error: "geo must be a non-empty string.", updates: null };
    }
    updates.geo = body.geo.trim().toLowerCase();
  }

  if (has("engines")) {
    const e = body.engines;
    if (typeof e === "string" && e.trim()) {
      updates.engines = e.trim();
    } else if (Array.isArray(e) && e.length > 0 && e.every((x) => typeof x === "string" && x.trim())) {
      updates.engines = e.map((x) => x.trim()).join(",");
    } else {
      return { error: "engines must be a non-empty string or an array of non-empty strings.", updates: null };
    }
  }

  return { error: null, updates };
}

/**
 * First-ever write for a brand: `scan_schedules.enabled` defaults to `true`
 * at the DB column level, but the product default (GET /schedule's fallback
 * object, plan.md P0.4) is `enabled: false` — opt-in scheduling. Without
 * this, a PUT that only raises e.g. `prompt_target` on a brand-new brand
 * would silently insert a row that takes the DB's `true` default AND (with
 * `next_run_at` left NULL) reads as immediately "due" to the scheduler tick.
 * Only fires when there's no existing row and the caller didn't explicitly
 * decide `enabled` on this call.
 */
export function applyInsertDefaults(updates, existing) {
  if (existing) return updates;
  if (Object.prototype.hasOwnProperty.call(updates, "enabled")) return updates;
  return { ...updates, enabled: false };
}

/**
 * Derives `next_run_at` per plan.md P0.4: recomputed whenever `cadence`
 * changes OR the schedule is being enabled; left untouched otherwise (e.g. a
 * PUT that only changes prompt_target/geo/engines leaves any existing
 * next_run_at alone). `cadence: "off"` always clears it to null, whether or
 * not `enabled` is also changing.
 */
export function applyNextRunAt(updates, existing, nowIso = new Date().toISOString()) {
  const cadenceChanged = Object.prototype.hasOwnProperty.call(updates, "cadence");
  const enabling = updates.enabled === true;
  if (!cadenceChanged && !enabling) return updates;

  const resolvedCadence = cadenceChanged ? updates.cadence : existing?.cadence || "72h";
  return { ...updates, next_run_at: computeNextRunAt(resolvedCadence, nowIso) };
}
