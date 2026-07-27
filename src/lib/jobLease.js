import { supabase } from "./db.js";

/**
 * Durable job lease — structural single-flight for fire-and-forget workers
 * (plan: docs/plans/2026-07-28-agent-control-plane.md, T1 / L1).
 *
 * WHY A LEASE AND NOT A STATUS CAS
 * `claimJobStatus()` in db.js claims a scan job by *entering* a phase
 * (pending → generating_prompts), which works because each phase is claimed
 * exactly once. A content job passes through eight statuses and must be
 * resumable IN PLACE, so the same trick degenerates to `drafting → drafting`:
 * always wins, grants no exclusivity. A time-bounded lease is orthogonal to
 * status, so it works for both a fresh start and a mid-pipeline resume.
 *
 * WHY IT IS ATOMIC
 * Acquisition is ONE statement:
 *
 *   UPDATE <table>
 *      SET lease_owner = $me, lease_expires_at = now() + ttl
 *    WHERE id = $id
 *      AND (lease_owner IS NULL OR lease_expires_at < now() OR lease_owner = $me)
 *  RETURNING *
 *
 * Of two callers racing this against the same row, the second blocks on the
 * row lock, then re-evaluates its WHERE clause against the committed new row
 * version (Postgres EvalPlanQual) — so it matches 0 rows and loses. Exactly
 * one winner, no lock table, no advisory lock, no in-process Map (which would
 * be useless on serverless: every invocation is a fresh process). This is the
 * same atomicity argument as claimJobStatus()'s doc comment, and the same
 * mechanism Paperclip uses for `issues.checkoutRunId`.
 *
 * TTL AND RENEWAL (L3)
 * TTL matches the heartbeat staleness window. `renewLease` is called on every
 * job write, so a worker that is genuinely progressing never loses its lease,
 * while a crashed worker's lease expires one window later and the job becomes
 * rescuable. Re-acquiring your OWN lease is allowed (`lease_owner = $me`), so
 * acquisition is idempotent within one worker.
 *
 * FAILURE POLICY (L4)
 * A DB error THROWS — a lease is correctness-critical and must never silently
 * degrade into "everyone wins". LOSING a race is not an error: it returns
 * `null`, the expected and common outcome.
 *
 * MEMORY MODE (L7)
 * With no Supabase configured (local dev, `npm run test:scoring`) there is
 * exactly one process and one Map, so there is no concurrent caller to lose a
 * race to. We still lock what we can see: a row present in the map gets a real
 * lease, so local dev exercises the same code path. A row that is NOT in the
 * map has no lock to contend — callers that inject a job directly (the worker
 * tests pass `deps.job` and never touch the store) get a synthetic grant
 * rather than a spurious "already leased" refusal.
 *
 * `deps.client` is test-only injection (defaults to the module-level
 * `supabase`), matching db.js — real call sites never pass it.
 */

/** Lease lifetime. Matches HEARTBEAT_STALE_MS so both notions of "dead" agree. */
export const LEASE_TTL_MS = 3 * 60 * 1000;

/**
 * Per-table memory stores, resolved lazily — the owning module creates the
 * global, and this module must not import it (db/content.js imports db.js,
 * which imports this file's sibling; a static import here would cycle).
 */
const MEMORY_STORES = {
  scan_jobs: () => global.memoryJobs,
  content_jobs: () => global.memoryContentJobs,
};

function resolveClient(deps) {
  return deps && Object.prototype.hasOwnProperty.call(deps, "client") ? deps.client : supabase;
}

function resolveMemory(table, deps) {
  if (deps && deps.memory) return deps.memory;
  const get = MEMORY_STORES[table];
  return (get && get()) || null;
}

/** A fresh, unguessable lease owner id for one worker invocation. */
export function newLeaseOwner(prefix = "run") {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Pure predicate: is this row's lease available to `owner` right now? Used to
 * pre-filter candidate lists cheaply — the conditional UPDATE is still the
 * only authority, so a false positive here just means a lost race later.
 */
export function leaseIsFree(row, owner = null, nowMs = Date.now()) {
  if (!row) return false;
  if (!row.lease_owner) return true;
  if (owner && row.lease_owner === owner) return true;
  const expiresMs = new Date(row.lease_expires_at || 0).getTime();
  return !Number.isFinite(expiresMs) || expiresMs < nowMs;
}

/**
 * Take the lease on `jobId`. Returns the updated row if THIS caller won, else
 * `null` (someone else holds a live lease). Throws only on a real DB error.
 */
export async function acquireLease(table, jobId, owner, deps = {}) {
  const client = resolveClient(deps);
  const ttl = deps.ttlMs || LEASE_TTL_MS;
  const nowMs = deps.nowMs || Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const expiresIso = new Date(nowMs + ttl).toISOString();

  if (!client) {
    const memory = resolveMemory(table, deps);
    const row = memory?.get(jobId);
    // Not in the store → nothing to contend; grant synthetically (see header).
    if (!row) return { id: jobId, lease_owner: owner, lease_expires_at: expiresIso };
    if (!leaseIsFree(row, owner, nowMs)) return null;
    Object.assign(row, { lease_owner: owner, lease_expires_at: expiresIso });
    return row;
  }

  // Values are double-quoted so the ISO timestamp's reserved characters can
  // never be read as PostgREST `or` syntax.
  const { data, error } = await client
    .from(table)
    .update({ lease_owner: owner, lease_expires_at: expiresIso })
    .eq("id", jobId)
    .or(`lease_owner.is.null,lease_expires_at.lt."${nowIso}",lease_owner.eq."${owner}"`)
    .select();

  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

/**
 * Push the expiry out. Only the current holder can renew — if the lease was
 * stolen after expiry, this returns `null` and the caller has lost ownership.
 */
export async function renewLease(table, jobId, owner, deps = {}) {
  const client = resolveClient(deps);
  const ttl = deps.ttlMs || LEASE_TTL_MS;
  const nowMs = deps.nowMs || Date.now();
  const expiresIso = new Date(nowMs + ttl).toISOString();

  if (!client) {
    const memory = resolveMemory(table, deps);
    const row = memory?.get(jobId);
    if (!row) return { id: jobId, lease_owner: owner, lease_expires_at: expiresIso };
    if (row.lease_owner !== owner) return null;
    row.lease_expires_at = expiresIso;
    return row;
  }

  const { data, error } = await client
    .from(table)
    .update({ lease_expires_at: expiresIso })
    .eq("id", jobId)
    .eq("lease_owner", owner)
    .select();

  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

/**
 * Drop the lease so the job is immediately available again. Called on every
 * terminal outcome, success or failure — without it a crashed-then-restarted
 * job waits out the full TTL for no reason. Returns true if we held it.
 */
export async function releaseLease(table, jobId, owner, deps = {}) {
  const client = resolveClient(deps);

  if (!client) {
    const memory = resolveMemory(table, deps);
    const row = memory?.get(jobId);
    if (!row) return true; // nothing to release
    if (row.lease_owner !== owner) return false;
    row.lease_owner = null;
    row.lease_expires_at = null;
    return true;
  }

  const { data, error } = await client
    .from(table)
    .update({ lease_owner: null, lease_expires_at: null })
    .eq("id", jobId)
    .eq("lease_owner", owner)
    .select();

  if (error) throw error;
  return !!(data && data[0]);
}
