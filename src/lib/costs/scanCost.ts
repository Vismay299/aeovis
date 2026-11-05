/**
 * F03 §6.2 — the live cost of one scan, read from `probe_attempts`.
 *
 * The mapping below is the SAME mapping as SQL `f03_upsert_attempt_rows`, in
 * the same order, because AC-19 requires the two paths to agree for a synced
 * terminal job: a divergence would show two numbers for one scan.
 *
 *   1. Row scope   — `probe_observations.purpose = 'scan'` (a canary or an
 *                    explore observation is not this scan's answer).
 *   2. Attempt scope — `dispatch_state IN ('recorded','unknown','historical')`,
 *                    or `'intent'` once the job is terminal. A running job's
 *                    `intent` attempts are not counted twice.
 *   3. `confirmed_not_dispatched` → zero, and NOT counted as an attempt.
 *   4. `reconciliation_conflict` → unknown (reserved), even when `charged_usd`
 *                    is set: a disputed cost is not a known one.
 *   5. `charged_usd IS NULL` → unknown (reserved).
 *   6. otherwise → known: `knownUsd += charged_usd`.
 *   7. `totalAccountedUsd` = known + reserved-unknown.
 *   8. `byEngine[].knownUsd` — the same sum, per engine.
 *   9. `answers` — observations in state `answered` or `valid_no_aio`.
 *  10. `perAnswerUsd` = knownUsd / answers, only when there is no unknown
 *                    attempt and there is at least one answer.
 *  11. per-answer `usd` = knownUsd when there is no unknown attempt, else null.
 *  12. `state` — "final" for a terminal job, "running" otherwise, and
 *                    "unavailable" for a legacy scan (no job) or a job with no
 *                    observations.
 *  13. `heldUsd` — the open scan hold's estimate, else null.
 *  14. The brand is checked against `scan_jobs.brand_key` first; a job that is
 *                    not this workspace's is a 404, never another workspace's
 *                    numbers.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../http/appError.ts";
import { AI_ENGINE_LABELS } from "../../shared/ai-visibility-pricing.ts";
import type { AnswerCost, ScanCost } from "./types.ts";

/** The database slug for AI Overviews; the shared label map keys it differently. */
const ENGINE_LABEL_KEYS: Record<string, string> = { aio: "google_ai_overview" };

/** A job in one of these states is finished, so its `intent` attempts are real. */
const TERMINAL_JOB_STATES = new Set(["complete", "failed", "cancelled"]);

/** The dispatch states the sync counts; `intent` counts only once the job is terminal. */
const COUNTED_DISPATCH_STATES = new Set(["recorded", "unknown", "historical"]);

/** The observation states that count as an answer. */
const ANSWER_STATES = new Set(["answered", "valid_no_aio"]);

/** The label for a database engine slug; an unknown slug is its own label. */
export function engineLabel(engine: string): string {
  const key = ENGINE_LABEL_KEYS[engine] ?? engine;
  const labels = AI_ENGINE_LABELS as Record<string, string>;
  return labels[key] ?? engine;
}

type JobRow = { id: string; brand_key: string | null; status: string | null };
type ObservationRow = { id: string; engine: string; state: string | null };
type AttemptRow = {
  observation_id: string;
  attempt_no: number;
  reserved_usd: number | string | null;
  charged_usd: number | string | null;
  cost_state: string | null;
  dispatch_state: string | null;
};

function usd(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The cost of a scan that has no usable dispatch ledger: a legacy scan with
 * no job, or a job the workspace cannot attribute. Never zeros — the state is
 * "unavailable", so a caller can tell it apart from a free scan.
 */
export function unavailableScanCost(jobId: string | null): ScanCost {
  return {
    state: "unavailable",
    jobId,
    answers: 0,
    attempts: 0,
    knownUsd: 0,
    unknownAttempts: 0,
    reservedUnknownUsd: 0,
    totalAccountedUsd: 0,
    perAnswerUsd: null,
    byEngine: [],
    heldUsd: null,
  };
}

type ScanCostData = {
  job: JobRow;
  observations: ObservationRow[];
  attempts: AttemptRow[];
  heldUsd: number | null;
};

/**
 * The one read both exports share: the job, its scan observations, the counted
 * attempts and the open hold.
 */
async function readScanCostData(
  admin: SupabaseClient,
  jobId: string,
  brandKey: string
): Promise<ScanCostData> {
  const { data: job, error: jobError } = await admin
    .from("scan_jobs")
    .select("id, brand_key, status")
    .eq("id", jobId)
    .maybeSingle();
  if (jobError) throw jobError;
  if (!job || job.brand_key !== brandKey) {
    throw new AppError(404, "scan_not_found", "Scan not found.");
  }

  const { data: observationRows, error: observationError } = await admin
    .from("probe_observations")
    .select("id, engine, state")
    .eq("job_id", jobId)
    .eq("purpose", "scan");
  if (observationError) throw observationError;
  const observations = (observationRows ?? []) as ObservationRow[];

  const observationIds = observations.map((row) => row.id);
  let attempts: AttemptRow[] = [];
  if (observationIds.length > 0) {
    const { data: attemptRows, error: attemptError } = await admin
      .from("probe_attempts")
      .select("observation_id, attempt_no, reserved_usd, charged_usd, cost_state, dispatch_state")
      .in("observation_id", observationIds);
    if (attemptError) throw attemptError;
    const terminal = TERMINAL_JOB_STATES.has(String(job.status ?? ""));
    attempts = ((attemptRows ?? []) as AttemptRow[]).filter((row) =>
      COUNTED_DISPATCH_STATES.has(String(row.dispatch_state ?? "")) ||
      (row.dispatch_state === "intent" && terminal)
    );
  }

  const { data: holdRows, error: holdError } = await admin
    .from("spend_holds")
    .select("estimate_usd")
    .eq("brand_key", brandKey)
    .eq("subject_kind", "scan_job")
    .eq("subject_id", jobId)
    .eq("status", "held")
    .order("created_at", { ascending: false })
    .limit(1);
  if (holdError) throw holdError;

  return {
    job,
    observations,
    attempts,
    heldUsd: holdRows && holdRows.length > 0
      ? usd((holdRows[0] as { estimate_usd: number | string | null }).estimate_usd)
      : null,
  };
}

/** One attempt's contribution, by the shared mapping. */
type AttemptCost = { counted: boolean; knownUsd: number; unknown: boolean; reservedUsd: number };

function attemptCost(row: AttemptRow): AttemptCost {
  if (row.cost_state === "confirmed_not_dispatched") {
    // Never dispatched: zero, and not an attempt at all.
    return { counted: false, knownUsd: 0, unknown: false, reservedUsd: 0 };
  }
  if (row.cost_state === "reconciliation_conflict") {
    // A disputed cost is not a known one, even when the provider charged.
    const reserved = usd(row.reserved_usd);
    return { counted: true, knownUsd: 0, unknown: true, reservedUsd: reserved };
  }
  if (row.charged_usd === null || row.charged_usd === undefined) {
    const reserved = usd(row.reserved_usd);
    return { counted: true, knownUsd: 0, unknown: true, reservedUsd: reserved };
  }
  return { counted: true, knownUsd: usd(row.charged_usd), unknown: false, reservedUsd: 0 };
}

/**
 * The cost of one scan. `jobId` is `scans.origin_job_id`; a legacy scan has
 * none, and its cost is `unavailable` rather than zero.
 */
export async function getScanCost(
  admin: SupabaseClient,
  jobId: string | null,
  brandKey: string
): Promise<ScanCost> {
  if (!jobId) return unavailableScanCost(null);

  const data = await readScanCostData(admin, jobId, brandKey);
  const engineByObservation = new Map<string, string>();
  const answersByEngine = new Map<string, number>();
  for (const observation of data.observations) {
    engineByObservation.set(observation.id, observation.engine);
    if (ANSWER_STATES.has(String(observation.state ?? ""))) {
      answersByEngine.set(observation.engine, (answersByEngine.get(observation.engine) ?? 0) + 1);
    }
  }

  let knownUsd = 0;
  let unknownAttempts = 0;
  let reservedUnknownUsd = 0;
  let attempts = 0;
  const byEngine = new Map<
    string,
    { attempts: number; knownUsd: number; unknownAttempts: number; answers: number }
  >();
  for (const row of data.attempts) {
    const cost = attemptCost(row);
    if (!cost.counted) continue;
    const engine = engineByObservation.get(row.observation_id) ?? "unknown";
    const bucket = byEngine.get(engine) ?? { attempts: 0, knownUsd: 0, unknownAttempts: 0, answers: 0 };
    bucket.attempts += 1;
    // An unknown attempt is an attempt: it was made and it cost a reservation.
    // Only a `confirmed_not_dispatched` attempt is not counted at all.
    attempts += 1;
    if (cost.unknown) {
      bucket.unknownAttempts += 1;
      unknownAttempts += 1;
      reservedUnknownUsd += cost.reservedUsd;
    } else {
      bucket.knownUsd += cost.knownUsd;
      knownUsd += cost.knownUsd;
    }
    byEngine.set(engine, bucket);
  }

  const answers = [...answersByEngine.values()].reduce((sum, count) => sum + count, 0);
  const state = data.observations.length === 0
    ? "unavailable"
    : TERMINAL_JOB_STATES.has(String(data.job.status ?? ""))
      ? "final"
      : "running";

  return {
    state,
    jobId,
    answers,
    attempts,
    knownUsd,
    unknownAttempts,
    reservedUnknownUsd,
    totalAccountedUsd: knownUsd + reservedUnknownUsd,
    perAnswerUsd: unknownAttempts === 0 && answers > 0 ? knownUsd / answers : null,
    byEngine: [...byEngine.entries()]
      .map(([engine, bucket]) => ({
        engine,
        label: engineLabel(engine),
        answers: answersByEngine.get(engine) ?? 0,
        attempts: bucket.attempts,
        knownUsd: bucket.knownUsd,
        unknownAttempts: bucket.unknownAttempts,
        perAnswerUsd:
          bucket.unknownAttempts === 0 && (answersByEngine.get(engine) ?? 0) > 0
            ? bucket.knownUsd / (answersByEngine.get(engine) ?? 0)
            : null,
      }))
      .sort((a, b) => a.engine.localeCompare(b.engine)),
    heldUsd: data.heldUsd,
  };
}

/**
 * The per-answer costs of one scan, keyed by `observation_id` — the join key
 * the scan report carries on every result row.
 */
export async function getAnswerCosts(
  admin: SupabaseClient,
  jobId: string,
  brandKey: string
): Promise<Map<string, AnswerCost>> {
  const data = await readScanCostData(admin, jobId, brandKey);
  const engineByObservation = new Map<string, string>();
  for (const observation of data.observations) {
    engineByObservation.set(observation.id, observation.engine);
  }

  const costs = new Map<string, AnswerCost>();
  for (const row of data.attempts) {
    const cost = attemptCost(row);
    if (!cost.counted) continue;
    const existing = costs.get(row.observation_id) ?? {
      observationId: row.observation_id,
      engine: engineByObservation.get(row.observation_id) ?? "unknown",
      attempts: 0,
      knownUsd: 0,
      unknownAttempts: 0,
      reservedUnknownUsd: 0,
      usd: null,
    };
    existing.attempts += 1;
    if (cost.unknown) {
      existing.unknownAttempts += 1;
      existing.reservedUnknownUsd += cost.reservedUsd;
    } else {
      existing.knownUsd += cost.knownUsd;
    }
    costs.set(row.observation_id, existing);
  }

  for (const cost of costs.values()) {
    cost.usd = cost.unknownAttempts === 0 ? cost.knownUsd : null;
  }
  return costs;
}
