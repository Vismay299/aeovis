import { supabase } from "./db.js";
import { LEASE_TTL_MS } from "./jobLease.js";

/**
 * The probe_tasks queue, from the web app's side (R1.2.2).
 *
 * The app is the PRODUCER: it enqueues one task per (scan, engine, query).
 * The fleet in worker/ is the consumer. Both claim through the same Postgres
 * function, `claim_probe_tasks` (migration 010).
 *
 * WHY THE CLAIM IS IN SQL AND NOT IN THIS FILE
 * The fleet may not import from src/ — the container image does not ship it,
 * and src/server/workerIsolation.test.mjs fails the build on any crossing import.
 * So a JS claim would have to exist twice, in two workspaces, and drift. The
 * claim lives in the database instead: one implementation, two callers, nothing
 * copied. jobLease.js is still the authority for the LEASE ITSELF — the column
 * names (`lease_owner`, `lease_expires_at`), the free/expired/mine predicate,
 * the TTL below, and the acquire/renew/release triple are all its semantics,
 * expressed in SQL because a queue must also choose WHICH rows to take, and
 * choosing is what `FOR UPDATE SKIP LOCKED` does that a conditional UPDATE on a
 * known id cannot.
 *
 * `deps.client` is test-only injection, matching db.js and jobLease.js.
 */

/**
 * The claim's TTL. Deliberately the same number as jobLease.LEASE_TTL_MS and
 * imported rather than retyped, so the two notions of "this worker is dead"
 * cannot drift apart. Migration 010's `p_lease_ms` default is the same value.
 */
export const PROBE_LEASE_TTL_MS = LEASE_TTL_MS;

/**
 * Why a claim came back with nothing. The whole reason the RPC returns a report
 * instead of a rowset: standing rule 1 — an empty queue and a queue whose every
 * task is held by another worker are different facts, and a bare `[]` says
 * neither. `unclaimed` additionally distinguishes both from "the queue does not
 * exist yet", which is what the R1.2.1 stub threw for.
 */
export const CLAIM_REASONS = Object.freeze({
  CLAIMED: "claimed",
  QUEUE_EMPTY: "queue_empty",
  ALL_LEASED: "all_leased",
});

/** The typed outcomes a probe may report. Mirrors worker/src/lib/probe.js and migration 010's CHECK. */
export const PROBE_OUTCOMES = Object.freeze([
  "answered",
  "no_answer",
  "blocked",
  "captcha",
  "login_wall",
  "timeout",
  "parse_error",
  "skipped",
]);

function resolveClient(deps) {
  return deps && Object.prototype.hasOwnProperty.call(deps, "client") ? deps.client : supabase;
}

/**
 * No client is a refusal, never an empty batch.
 *
 * There is deliberately no in-memory mode here, unlike jobLease's. An
 * in-process Map cannot lose a race to another process, so a memory-mode queue
 * would report a clean claim for a race that never happened — a green result
 * standing for an unrun test. The queue is durable or it is absent.
 */
function requireClient(client, fn) {
  if (!client) {
    throw new Error(
      `${fn}: no Supabase client is configured, so the probe_tasks queue is unreachable. ` +
        `Refusing rather than returning an empty batch: an unreachable queue and an ` +
        `empty one must never look the same.`
    );
  }
  return client;
}

/**
 * Rethrow a PostgREST error with its envelope intact.
 *
 * Standing rule 2. Returning `{ error }` where the caller expects a value, or
 * flattening the error to its message, is how a failed write reads downstream
 * as a legitimate zero. code/details/hint are carried on the thrown Error and
 * the original is kept as `cause`.
 */
function throwDbError(fn, error) {
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
 * Read the RPC's report into the shape both callers use.
 *
 * PURE — no client, no network — so the empty/leased distinction that standing
 * rule 1 turns on is testable without a database. `worker/src/lib/queue.js`
 * carries a byte-identical copy (it may not import this file); a guard test
 * asserts the two agree.
 */
export function normalizeClaim(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error(
      "normalizeClaim: claim_probe_tasks returned nothing. A claim with no report " +
        "cannot say whether the queue was empty or busy, which is the one thing it exists to say."
    );
  }
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const claimedCount = Number.isFinite(raw.claimed_count) ? raw.claimed_count : tasks.length;
  const outstanding = Number.isFinite(raw.outstanding) ? raw.outstanding : null;
  const leasedElsewhere = Number.isFinite(raw.leased_elsewhere) ? raw.leased_elsewhere : null;

  // `outstanding` is the field that separates the two empty-handed cases, so an
  // absent one is a broken report, not a zero. Never `?? 0` on a metric.
  if (outstanding === null) {
    throw new Error(
      "normalizeClaim: the claim report has no `outstanding` count, so an empty queue " +
        "and a fully leased one are indistinguishable. Refusing to guess."
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

/**
 * One sentence a human can read in a log. An empty claim must never print the
 * same line as an empty queue — that sentence is the false success itself.
 */
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

// An owner id is `jobLease.newLeaseOwner()`. Not re-exported here: the app CAN
// import jobLease, and a second generator would be a second thing to keep in
// step for no gain. (The fleet cannot import it and uses `config.workerId`.)

/**
 * Enqueue probe tasks. Returns the inserted rows.
 *
 * Throws on failure and returns nothing on success but the rows — standing
 * rule 2. A producer that swallowed an insert error would leave a scan with a
 * queue of zero tasks, which the fleet would then correctly report as "queue
 * empty", and the scan would score a confident zero off work never enqueued.
 */
export async function enqueueProbeTasks(
  { batchId, scanJobId = null, engine, queries, priority = 0 },
  deps = {}
) {
  const client = requireClient(resolveClient(deps), "enqueueProbeTasks");
  if (!batchId) throw new Error("enqueueProbeTasks: batchId is required");
  if (!engine) throw new Error("enqueueProbeTasks: engine is required");
  const list = (queries || []).filter((q) => typeof q === "string" && q.trim());
  if (!list.length) {
    throw new Error(
      "enqueueProbeTasks: no queries to enqueue. Writing zero tasks would leave the " +
        "scan with an empty queue that reads as finished work."
    );
  }

  const rows = list.map((query) => ({
    batch_id: batchId,
    scan_job_id: scanJobId,
    engine,
    query,
    priority,
  }));

  const { data, error } = await client.from("probe_tasks").insert(rows).select();
  if (error) throw throwDbError("enqueueProbeTasks", error);
  if (!data || data.length !== rows.length) {
    throw new Error(
      `enqueueProbeTasks: asked for ${rows.length} task(s), the insert returned ` +
        `${data ? data.length : 0}. A partial enqueue is a silently short scan.`
    );
  }
  return data;
}

/**
 * Claim a batch. The app claims through the same function the fleet does, so
 * the two can never disagree about who holds what.
 *
 * @returns {Promise<ReturnType<typeof normalizeClaim>>}
 */
export async function claimProbeTasks(
  { owner, engines = null, limit = 5, leaseMs = PROBE_LEASE_TTL_MS, batchId = null },
  deps = {}
) {
  const client = requireClient(resolveClient(deps), "claimProbeTasks");
  if (!owner) throw new Error("claimProbeTasks: owner is required — an unowned lease cannot be released");

  const { data, error } = await client.rpc("claim_probe_tasks", {
    p_owner: owner,
    p_engines: engines,
    p_limit: limit,
    p_lease_ms: leaseMs,
    p_batch_id: batchId,
  });
  if (error) throw throwDbError("claimProbeTasks", error);
  return normalizeClaim(data);
}

/** Push the lease out for tasks this owner still holds. Returns how many. */
export async function renewProbeLease(
  { owner, taskIds, leaseMs = PROBE_LEASE_TTL_MS },
  deps = {}
) {
  const client = requireClient(resolveClient(deps), "renewProbeLease");
  const { data, error } = await client.rpc("renew_probe_lease", {
    p_owner: owner,
    p_task_ids: taskIds,
    p_lease_ms: leaseMs,
  });
  if (error) throw throwDbError("renewProbeLease", error);
  return Number(data);
}

/**
 * Write typed outcomes and drop the lease.
 *
 * Rejected ids are RETURNED, not swallowed: a worker whose lease expired
 * mid-probe has had its tasks reassigned, and its late result is refused. The
 * caller must be able to see that "5 reported" became "2 written, 3 lost".
 */
export async function completeProbeTasks({ owner, results }, deps = {}) {
  const client = requireClient(resolveClient(deps), "completeProbeTasks");
  for (const r of results || []) {
    if (!PROBE_OUTCOMES.includes(r.outcome)) {
      throw new Error(
        `completeProbeTasks: "${r.outcome}" is not a probe outcome. The vocabulary is closed ` +
          `(${PROBE_OUTCOMES.join(", ")}) so a blocked probe can never be written as a non-mention.`
      );
    }
  }
  const { data, error } = await client.rpc("complete_probe_tasks", {
    p_owner: owner,
    p_results: results,
  });
  if (error) throw throwDbError("completeProbeTasks", error);
  // No `?? 0` on `applied`: a missing count is unknown, not zero, and reading
  // it as zero would report every write as lost. Standing rule 5.
  if (!data || !Number.isFinite(data.applied)) {
    throw new Error(
      "completeProbeTasks: complete_probe_tasks returned no `applied` count, so how many " +
        "outcomes actually landed is unknown. Refusing to report it as a number."
    );
  }
  return {
    owner: data.owner ?? owner,
    asked: data.asked,
    applied: data.applied,
    rejected: Array.isArray(data.rejected) ? data.rejected : [],
  };
}

/** Hand tasks back unclaimed, with no result. Returns how many were released. */
export async function releaseProbeTasks({ owner, taskIds }, deps = {}) {
  const client = requireClient(resolveClient(deps), "releaseProbeTasks");
  const { data, error } = await client.rpc("release_probe_tasks", {
    p_owner: owner,
    p_task_ids: taskIds,
  });
  if (error) throw throwDbError("releaseProbeTasks", error);
  return Number(data);
}
