/**
 * Queue access for the fleet (R1.2.2).
 *
 * The fleet claims from `probe_tasks` (migration 010) through the Postgres
 * function `claim_probe_tasks`. It does NOT reimplement the claim in JS.
 *
 * WHY THE CLAIM IS A DATABASE FUNCTION
 * This workspace may not import from src/ — the container image does not ship
 * it, and src/lib/workerIsolation.test.mjs fails the build on any crossing
 * import. So the fleet cannot call `src/lib/jobLease.js`. The three options
 * were: copy the lease into this workspace (a second copy that drifts), extract
 * a shared package (heavier than this task), or put the claim in SQL. SQL wins
 * outright: one implementation, called by the app and by the fleet over RPC,
 * and the race is settled by `FOR UPDATE SKIP LOCKED` in Postgres rather than
 * by two JS processes agreeing to be careful.
 *
 * jobLease.js is still the authority for the LEASE. Its column names
 * (`lease_owner`, `lease_expires_at`), its free/expired/mine predicate, its
 * 3-minute TTL and its acquire/renew/release triple are what migration 010
 * implements. What could not be reused is the acquire STATEMENT: jobLease
 * claims one row whose id the caller already has, and a queue has to choose
 * which rows to take.
 *
 * WHAT IS STILL A STUB: nothing in this file. `probeBatch` in probe.js is the
 * remaining refusal (R1.3), and R1.2.3 adds the scan_runs ledger this queue
 * will report into.
 */

import { createClient } from "@supabase/supabase-js";

/**
 * Why a claim came back empty-handed.
 *
 * COPIED from src/lib/probeQueue.js, deliberately and unavoidably: this
 * workspace cannot import it. `src/lib/probeQueue.test.mjs` asserts the two
 * copies still agree, so the duplication is checked rather than trusted.
 *
 * The distinction is the point. Standing rule 1: "0 claimed because the queue
 * is empty" and "0 claimed because another worker holds every task" are
 * different facts, and a bare `[]` says neither. A fleet reporting "nothing to
 * do" while its queue fills is the false success this rebuild exists to remove.
 */
export const CLAIM_REASONS = Object.freeze({
  CLAIMED: "claimed",
  QUEUE_EMPTY: "queue_empty",
  ALL_LEASED: "all_leased",
});

let cachedClient = null;

/**
 * The Supabase client, built once from config. `deps.client` is test-only
 * injection; the real loop never passes it.
 *
 * EXPORTED for ./runLedger.js (R1.2.3), which needs the SAME memoised client
 * rather than a second one: two clients in one container are two connection
 * pools for no reason, and a ledger that reached the database by a different
 * route than the claim could report a run for a batch it could not have claimed.
 */
export function resolveClient(config, deps) {
  if (deps && Object.prototype.hasOwnProperty.call(deps, "client")) return deps.client;
  if (cachedClient) return cachedClient;
  if (!config || !config.supabaseUrl || !config.supabaseKey) return null;
  cachedClient = createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: false },
  });
  return cachedClient;
}

/** Test seam: forget the memoised client between cases. */
export function resetQueueClient() {
  cachedClient = null;
}

/**
 * No client is a refusal, never an empty batch.
 *
 * There is no in-memory queue mode on purpose. One process and one Map has no
 * second claimant to lose a race to, so a memory-mode queue would hand back a
 * clean claim for a race that never ran — a green result standing in for an
 * untested one. This is the same refusal the R1.2.1 stub made, kept for the
 * same reason and now narrowed to the case that actually warrants it.
 */
function requireClient(client, fn) {
  if (!client) {
    throw new Error(
      `${fn}: no Supabase client — the probe_tasks queue is unreachable. Refusing rather ` +
        `than returning an empty batch, because an unreachable queue and an empty one ` +
        `would otherwise look identical.`
    );
  }
  return client;
}

/**
 * Rethrow a PostgREST error with its code/details/hint intact (standing rule 2).
 * Exported for ./runLedger.js (R1.2.3): the envelope must survive identically
 * whichever of the fleet's two database modules the call went through.
 */
export function dbError(fn, error) {
  const err = new Error(
    `${fn}: ${error.message || "database error"}` +
      (error.code ? ` [${error.code}]` : "") +
      (error.details ? ` — ${error.details}` : "") +
      (error.hint ? ` (hint: ${error.hint})` : "")
  );
  err.code = error.code;
  err.details = error.details;
  err.hint = error.hint;
  err.cause = error;
  return err;
}

/**
 * Read the RPC's report into the shape the loop uses. PURE — copied from
 * src/lib/probeQueue.js's `normalizeClaim` for the reason above.
 */
export function normalizeClaim(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error(
      "normalizeClaim: claim_probe_tasks returned nothing. A claim with no report cannot " +
        "say whether the queue was empty or busy, which is the one thing it exists to say."
    );
  }
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const claimedCount = Number.isFinite(raw.claimed_count) ? raw.claimed_count : tasks.length;
  const outstanding = Number.isFinite(raw.outstanding) ? raw.outstanding : null;
  const leasedElsewhere = Number.isFinite(raw.leased_elsewhere) ? raw.leased_elsewhere : null;

  // Never `?? 0` on a metric: an absent count is unknown, and a missing
  // `outstanding` makes an empty queue and a fully leased one indistinguishable.
  if (outstanding === null) {
    throw new Error(
      "normalizeClaim: the claim report has no `outstanding` count, so an empty queue and " +
        "a fully leased one are indistinguishable. Refusing to guess."
    );
  }

  let reason;
  if (claimedCount > 0) reason = CLAIM_REASONS.CLAIMED;
  else if (outstanding === 0) reason = CLAIM_REASONS.QUEUE_EMPTY;
  else reason = CLAIM_REASONS.ALL_LEASED;

  return {
    owner: raw.owner ?? null,
    tasks,
    claimedCount,
    outstanding,
    leasedElsewhere,
    reason,
    leaseExpiresAt: raw.lease_expires_at ?? null,
    observedAt: raw.observed_at ?? null,
  };
}

/** One sentence for the log. An empty claim must not print an empty queue's line. */
export function describeClaim(claim) {
  if (claim.reason === CLAIM_REASONS.CLAIMED) {
    return `claimed ${claim.claimedCount} task(s); ${claim.outstanding} outstanding in scope`;
  }
  if (claim.reason === CLAIM_REASONS.QUEUE_EMPTY) {
    return "claimed 0 — the queue is empty (0 outstanding); there is nothing to do";
  }
  return (
    `claimed 0 — the queue is NOT empty: ${claim.outstanding} outstanding, ` +
    `${claim.leasedElsewhere ?? "an unknown number of"} held by another worker. ` +
    `This is contention, not idleness.`
  );
}

/**
 * Claim a batch of probe tasks for this worker.
 *
 * Returns the full claim report, not an array. The loop needs `reason` to tell
 * an idle fleet from a starved one, and a function that returned `[]` for both
 * would make that impossible at the seam.
 *
 * @returns {Promise<{tasks: Array, claimedCount: number, outstanding: number,
 *   leasedElsewhere: number|null, reason: string, leaseExpiresAt: string|null}>}
 */
export async function claimBatch(config, deps = {}) {
  const client = requireClient(resolveClient(config, deps), "claimBatch");
  if (!config || !config.workerId) {
    throw new Error("claimBatch: config.workerId is required — an unowned lease cannot be released");
  }

  const { data, error } = await client.rpc("claim_probe_tasks", {
    p_owner: config.workerId,
    p_engines: config.engines && config.engines.length ? config.engines : null,
    p_limit: config.batchSize,
    p_lease_ms: config.leaseMs,
    p_batch_id: config.batchId || null,
  });
  if (error) throw dbError("claimBatch", error);
  return normalizeClaim(data);
}

/**
 * Write typed outcomes back for a claimed batch and release the lease.
 *
 * Only the lease holder may report; the database enforces it. Ids this worker
 * no longer owns come back in `rejected` and are surfaced, never dropped — a
 * batch of five that wrote two is not a batch of five.
 *
 * @param {Array<{id: string, outcome: string, detail?: object}>} outcomes
 */
export async function reportBatch(outcomes, config, deps = {}) {
  const client = requireClient(resolveClient(config, deps), "reportBatch");
  const results = (outcomes || []).map((o) => ({
    id: o.id,
    outcome: o.outcome,
    detail: o.detail ?? null,
  }));

  const { data, error } = await client.rpc("complete_probe_tasks", {
    p_owner: config.workerId,
    p_results: results,
  });
  if (error) throw dbError("reportBatch", error);
  if (!data || !Number.isFinite(data.applied)) {
    throw new Error(
      "reportBatch: complete_probe_tasks returned no `applied` count, so how many outcomes " +
        "actually landed is unknown. Refusing to report it as a number."
    );
  }
  return {
    asked: data.asked,
    applied: data.applied,
    rejected: Array.isArray(data.rejected) ? data.rejected : [],
  };
}

/** Push the lease out for tasks this worker still holds. Returns how many. */
export async function renewBatch(taskIds, config, deps = {}) {
  const client = requireClient(resolveClient(config, deps), "renewBatch");
  const { data, error } = await client.rpc("renew_probe_lease", {
    p_owner: config.workerId,
    p_task_ids: taskIds,
    p_lease_ms: config.leaseMs,
  });
  if (error) throw dbError("renewBatch", error);
  return Number(data);
}

/**
 * Hand tasks back unclaimed. Called when a pass fails partway, so a crash does
 * not park the batch for the full TTL before anyone else can pick it up.
 */
export async function releaseBatch(taskIds, config, deps = {}) {
  const client = requireClient(resolveClient(config, deps), "releaseBatch");
  const { data, error } = await client.rpc("release_probe_tasks", {
    p_owner: config.workerId,
    p_task_ids: taskIds,
  });
  if (error) throw dbError("releaseBatch", error);
  return Number(data);
}
