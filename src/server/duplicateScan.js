/**
 * The duplicate-scan seal (R0.1.5, finding B11).
 *
 * `hasActiveScanForBrand` in db.js is a read-then-write guard with two holes:
 * it returns false on ANY DB error (a broken check silently permits every
 * duplicate), and even working it leaves a TOCTOU window in which two
 * concurrent POST /api/scan requests both see "nothing running" and both
 * enqueue. Each duplicate spends a full Bright Data + LLM scan budget.
 *
 * Migration 007 closes it in the database with a unique partial index. This
 * module holds the pure decision the application still has to make when that
 * index fires, because the index predicate cannot express heartbeat freshness
 * (a partial-index predicate must be IMMUTABLE, and freshness needs now()).
 * Without this, a job that crashed while in 'probing' would block its brand
 * from ever scanning again.
 */

/** Must match the index name in supabase/migrations/007_scan_seal.sql. */
export const DUPLICATE_SCAN_INDEX = "scan_jobs_one_running_per_brand";

/** Raised when a genuinely live scan already holds this brand. Maps to HTTP 409. */
export class DuplicateScanError extends Error {
  constructor(brand, blockingJobId) {
    super(`A scan for "${brand}" is already in progress.`);
    this.name = "DuplicateScanError";
    this.brand = brand;
    this.blockingJobId = blockingJobId || null;
    this.status = 409;
  }
}

/**
 * True when `error` is our unique-index violation rather than any other
 * failure. Deliberately narrow: a different constraint, or a connection
 * error, must NOT be mistaken for "someone else is scanning" — that would be
 * fail-soft on a create, which is the bug class this rebuild exists to close.
 */
export function isDuplicateScanViolation(error) {
  if (!error) return false;
  const code = error.code || error.details?.code;
  if (code !== "23505") return false;
  const haystack = `${error.message || ""} ${error.details || ""} ${error.constraint || ""}`;
  return haystack.includes(DUPLICATE_SCAN_INDEX) || haystack.includes("scan_jobs_one_running_per_workspace");
}

/**
 * Decide what to do when the index rejects an insert.
 *
 * @param {Array<object>} blockingJobs the running scan_jobs rows for this brand
 * @param {(job: object) => boolean} isAlive heartbeat-freshness predicate (db.js isJobAlive)
 * @returns {{action: "reject"|"reclaim", liveJobId: string|null, deadJobIds: string[]}}
 *   `reject` — a live scan genuinely holds the brand; the caller raises
 *   DuplicateScanError. `reclaim` — every blocking job is dead; the caller
 *   fails those rows and retries the insert once.
 */
export function resolveDuplicateScan(blockingJobs, isAlive) {
  const jobs = Array.isArray(blockingJobs) ? blockingJobs.filter(Boolean) : [];
  const live = jobs.find((job) => isAlive(job));
  if (live) {
    return { action: "reject", liveJobId: live.id || null, deadJobIds: [] };
  }
  // No blocking rows at all still means "reclaim": the conflicting job was
  // finished or deleted between the violation and this read, so a retry is
  // the right move. Never reject on an empty list — that would turn a race
  // we already won into a spurious 409.
  return { action: "reclaim", liveJobId: null, deadJobIds: jobs.map((j) => j.id).filter(Boolean) };
}

/** The error_message stamped on a job reclaimed from a stale heartbeat. */
export function reclaimReason(nowIso) {
  return (
    `Marked failed at ${nowIso}: heartbeat went stale while the job held the ` +
    `one-running-scan-per-brand lock, and a new scan was requested for this brand.`
  );
}
