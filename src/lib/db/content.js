import crypto from "crypto";
import { supabase } from "../db.js";
import { leaseIsFree } from "../jobLease.js";
import { builtinAgents } from "../content/agents/model.js";

/**
 * Error thrown when a content DB read cannot be performed — mirrors
 * ScansUnavailableError in db.js. A read that could not be performed must
 * never return [] or null, which are indistinguishable from a genuine empty.
 *
 * @param {string} message
 * @param {{ cause?: Error, code?: string }} options
 */
export class ContentReadError extends Error {
  constructor(message, { cause, code = "content_read_failed" } = {}) {
    super(message);
    this.name = "ContentReadError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * DB helpers for the Agent Content OS (content_jobs, content_items,
 * content_feedback, brand_briefs, content_lessons).
 *
 * content_jobs / content_items are DB-authoritative and fail-loud (P0.0,
 * mirrors db.js's scan_jobs fix): when Supabase is configured it is the ONLY
 * source of truth and a DB error THROWS instead of silently degrading to the
 * in-memory map — that fallback was a poison pill where one transient DB
 * failure on create tipped a job/item into memory forever on that instance.
 * Every other helper below (feedback / brief / lesson / agent) is unchanged:
 * fail-soft, Supabase when configured, hot-reload-safe in-memory fallback
 * otherwise.
 */

global.memoryContentJobs = global.memoryContentJobs || new Map();
global.memoryContentItems = global.memoryContentItems || new Map();
global.memoryContentFeedback = global.memoryContentFeedback || new Map();
global.memoryBrandBriefs = global.memoryBrandBriefs || new Map();
global.memoryContentLessons = global.memoryContentLessons || new Map();
global.memoryContentAgents = global.memoryContentAgents || new Map();

/**
 * Test-only client injection for the DB-authoritative helpers below. Real
 * call sites never pass `deps`, so `resolveClient({})` always returns the
 * module-level `supabase` — every production/dev call behaves exactly as
 * `hasDb = !!supabase`.
 */
function resolveClient(deps) {
  if (deps && Object.prototype.hasOwnProperty.call(deps, "client")) return deps.client;
  if (deps && Object.prototype.hasOwnProperty.call(deps, "supabase")) return deps.supabase;
  return supabase;
}

/** Worker-active statuses. awaiting_approval and beyond are human-side. */
export const CONTENT_JOB_RUNNING = [
  "pending",
  "coordinating",
  "researching",
  "benchmarking",
  "drafting",
  "reviewing",
];

/**
 * Two staleness windows, deliberately different — they answer different
 * questions and conflating them is what produced D1 (see the plan doc).
 *
 *  - STALE_CONTENT_JOB_MS (20 min) — DEDUPE. "Should I refuse to create a
 *    second job for this brand+agent+query?" Wants a GENEROUS window: a user
 *    re-clicking Generate should be blocked even while the worker is briefly
 *    quiet mid-block.
 *  - CONTENT_HEARTBEAT_STALE_MS (3 min) — RESCUE. "Is this job's worker dead,
 *    so I may resume it?" Wants a TIGHT window so a genuinely crashed job
 *    becomes resumable quickly. Matches db.js's HEARTBEAT_STALE_MS so both
 *    pipelines use one definition of "the worker died".
 */
const STALE_CONTENT_JOB_MS = 20 * 60 * 1000;

export const CONTENT_HEARTBEAT_STALE_MS = 3 * 60 * 1000;

/**
 * Canonical liveness check for content jobs — the mirror of db.js's
 * isJobAlive(). updateContentJob() stamps heartbeat_at on every call, so a
 * worker that is genuinely progressing keeps its job alive between blocks.
 */
export function isContentJobAlive(job, nowMs = Date.now()) {
  if (!job || !CONTENT_JOB_RUNNING.includes(job.status)) return false;
  const heartbeatMs = new Date(job.heartbeat_at || 0).getTime();
  return Number.isFinite(heartbeatMs) && nowMs - heartbeatMs < CONTENT_HEARTBEAT_STALE_MS;
}

/**
 * May the cron resume this job? Mirrors scanWorker's shouldRescueJob():
 * running status, no live lease held by anyone, and a stale heartbeat.
 *
 * The lease check is the belt to the heartbeat's braces — the conditional
 * UPDATE in jobLease.acquireLease() is the real authority, this just avoids
 * dispatching work we are certain to lose.
 *
 * NOTE ON `pending`: the previous implementation treated every `pending` job
 * as resumable unconditionally, which is exactly how D1 fired — POST
 * /api/content dispatches startContentJob() itself, so a job it had *just*
 * started (still inside its first block, no status write yet) was re-picked by
 * the very next cron tick and run twice. Both dispatch paths now agree on
 * heartbeat liveness: a pending job whose creator died is rescued one
 * heartbeat window later instead of within seconds of a healthy start.
 *
 * NOTE ON `item_id` (R3.5.6): a job that already carries an item_id has
 * DELIVERED. The only writer of that column in the pipeline is contentWorker's
 * terminal write, which sets `item_id` and `status: "awaiting_approval"` in the
 * SAME update (src/lib/content/contentWorker.js:805-809) — so a job sitting in
 * a RUNNING status WITH an item_id is, by construction, a delivered job whose
 * status was rewound afterwards by a second execution (writeJob at
 * contentWorker.js:554 / :638 / :714 writes a running status with no regard for
 * what the row already holds). Production, 2026-09-18: job 355b0237 reached
 * awaiting_approval with an item at 19:17:51 and was still being re-dispatched
 * at 21:57, re-running review and re-paying for it. Re-running such a job can
 * only duplicate spend and fight its own item row, so it is refused here —
 * LOUDLY, because a refusal to rescue is not the same as nothing to rescue
 * (standing rule 1), and the row needs an operator's eye.
 */
export function shouldRescueContentJob(job, nowMs = Date.now()) {
  if (!job || !CONTENT_JOB_RUNNING.includes(job.status)) return false;
  if (job.item_id) {
    console.warn(
      `[content-db] job ${job.id} is in running status "${job.status}" but already has ` +
        `item_id ${job.item_id} — NOT resumable: it already delivered an item, so its ` +
        `status was rewound after the terminal write. Left for an operator; re-running ` +
        `it would re-pay for a draft that exists.`
    );
    return false;
  }
  if (!leaseIsFree(job, null, nowMs)) return false;
  return !isContentJobAlive(job, nowMs);
}

// ---------------------------------------------------------------------------
// content_jobs
// ---------------------------------------------------------------------------

export async function createContentJob({ brand, playbook, input, agent_id, agent_snapshot }, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    id: jobId,
    brand,
    playbook,
    status: "pending",
    progress_pct: 0,
    input: input || {},
    item_id: null,
    error_message: null,
    cost_total: 0,
    agent_id: agent_id || null,
    agent_snapshot: agent_snapshot || null,
    agent_trace: [],
    checkpoint: null,           // R3.5.1 — per-block checkpoint for resume
    created_at: now,
    heartbeat_at: now,
  };

  if (!hasDb) {
    global.memoryContentJobs.set(jobId, job);
    return job;
  }

  const { data, error } = await client.from("content_jobs").insert([job]).select();
  if (error) throw error;
  return data[0];
}

export async function getContentJob(jobId, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!hasDb) {
    return global.memoryContentJobs.get(jobId) || null;
  }

  const { data, error } = await client
    .from("content_jobs")
    .select("*")
    .eq("id", jobId);
  if (error) throw error;
  return data[0] || null;
}

export async function updateContentJob(jobId, updates, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;
  // Any update means the worker is alive — stamp on every call.
  const stamped = { ...updates, heartbeat_at: new Date().toISOString() };

  if (!hasDb) {
    const memJob = global.memoryContentJobs.get(jobId);
    if (memJob) {
      Object.assign(memJob, stamped);
      return memJob;
    }
    const created = { id: jobId, ...stamped };
    global.memoryContentJobs.set(jobId, created);
    return created;
  }

  const { data, error } = await client
    .from("content_jobs")
    .update(stamped)
    .eq("id", jobId)
    .select();
  if (error) throw error;
  return data[0];
}

function queryKeyLower(text) {
  return String(text || "").toLowerCase().trim();
}

/**
 * Freshness check for the dedupe guard below: prefers heartbeat_at (stamped
 * by every updateContentJob call) and falls back to created_at for rows
 * written before migration 005 added the column.
 */
function isContentJobFresh(job, nowMs = Date.now()) {
  const stampSource = job.heartbeat_at || job.created_at;
  const stampMs = new Date(stampSource || 0).getTime();
  return Number.isFinite(stampMs) && nowMs - stampMs < STALE_CONTENT_JOB_MS;
}

/**
 * Precise duplicate guard. Concurrency across *different* agents is a feature
 * (the user watches several agents work at once), so this only blocks an
 * EXACT re-fire: the same brand + same agent + same target query already
 * running. Stale jobs (see isContentJobFresh) are ignored so a crash can't
 * block forever.
 *
 * Back-compat: called as (brand, playbook) it blocks brand+playbook, matching
 * the v1 trigger which had no agents.
 */
export async function hasActiveContentJobForBrand(brand, opts, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;
  const key = String(brand || "").trim().toLowerCase();
  if (!key) return false;

  // Normalize args: string → {playbook}; object → {playbook, agentId, query}.
  const { playbook, agentId, query } =
    typeof opts === "string" ? { playbook: opts } : opts || {};
  const qKey = queryKeyLower(query);

  const matches = (job) => {
    if (String(job.brand || "").trim().toLowerCase() !== key) return false;
    if (!CONTENT_JOB_RUNNING.includes(job.status)) return false;
    if (!isContentJobFresh(job)) return false;
    // With an agent + query, block only the exact same combination.
    if (agentId) {
      if (job.agent_id !== agentId) return false;
      if (qKey && queryKeyLower(job.input?.query) !== qKey) return false;
      return true;
    }
    // No agent → v1 behavior: block same playbook.
    if (playbook && job.playbook !== playbook) return false;
    return true;
  };

  if (!hasDb) {
    for (const job of global.memoryContentJobs.values()) {
      if (matches(job)) return true;
    }
    return false;
  }

  try {
    let q = client
      .from("content_jobs")
      .select("id, agent_id, playbook, input, status, heartbeat_at, created_at")
      .ilike("brand", key)
      .in("status", CONTENT_JOB_RUNNING);
    if (agentId) q = q.eq("agent_id", agentId);
    else if (playbook) q = q.eq("playbook", playbook);
    const { data, error } = await q.limit(20);
    if (error) throw error;
    return (data || []).some(matches);
  } catch (err) {
    console.warn("[content-db] duplicate check failed, allowing job:", err.message);
    return false;
  }
}

/** Recent jobs for a brand — Studio's "generating…" cards. */
export async function listContentJobs(brand, limit = 20) {
  const key = String(brand || "").trim().toLowerCase();
  if (!supabase) {
    return Array.from(global.memoryContentJobs.values())
      .filter((j) => !key || j.brand.toLowerCase() === key)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);
  }
  try {
    let query = supabase
      .from("content_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (key) query = query.ilike("brand", key);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.warn("[content-db] listContentJobs failed, checking memory:", err.message);
    return Array.from(global.memoryContentJobs.values())
      .filter((j) => !key || j.brand.toLowerCase() === key)
      .slice(0, limit);
  }
}

/**
 * Jobs the cron may rescue (mirrors /api/scan/worker's sweep).
 *
 * Retrieves every not-yet-finished job and lets shouldRescueContentJob decide
 * which ones actually need a kick — heartbeat staleness plus a free lease, NOT
 * a fixed `created_at` window. The old `created_at`-based filter re-picked
 * healthy in-flight jobs and was the direct cause of D1 (double-run,
 * double-spend); see shouldRescueContentJob's note.
 *
 * CONTRACT (R2.8.13): fail-loud, same shape as getScansForBrand / getScansByDomain
 * in db.js. The returned array means "the database answered". A read that could
 * not be performed THROWS ContentReadError — it never fabricates [].
 *
 * This function used to catch every failure and return [], so the content-worker
 * cron pass reported "resumed 0 jobs" when the resume list could not be read —
 * half the endpoint telling the truth (R2.8.5 fixed the brand-list half) and
 * half still lying. A dead resume stage that reports itself healthy is
 * indistinguishable from a genuinely idle pass.
 *
 * @throws {ContentReadError} db_not_configured | db_read_failed
 */
export async function listResumableContentJobs(limit = 5, deps = {}) {
  const client = resolveClient(deps);
  if (!client) {
    throw new ContentReadError(
      "Supabase is not configured — resumable content jobs cannot be read. " +
        "This is a refusal to look, not a workspace with no resumable jobs.",
      { code: "db_not_configured" }
    );
  }
  const { data, error } = await client
    .from("content_jobs")
    .select("*")
    .in("status", CONTENT_JOB_RUNNING)
    .limit(Math.max(limit * 4, 20));
  if (error) {
    throw new ContentReadError(
      `Could not read resumable content jobs: ${error.message || error.code || "unknown database error"}`,
      { cause: error, code: "db_read_failed" }
    );
  }
  return (data || []).filter((job) => shouldRescueContentJob(job)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// content_runs — per-block execution ledger (T3)
//
// FAILURE POLICY, deliberately different from content_jobs/content_items:
// the ledger is OBSERVABILITY, not correctness. A ledger write that fails must
// never take down a job that is otherwise producing a good draft, so every
// function here is fail-soft (warn + return null) rather than fail-loud. The
// cost CAP is enforced from `stats` in contentWorker, never from these rows,
// so a missing ledger row cannot let a job overspend.
// ---------------------------------------------------------------------------

global.memoryContentRuns = global.memoryContentRuns || new Map();

/** Open a ledger row for one block execution. Returns the row, or null. */
export async function insertContentRun({ job_id, brand, block, cycle = 1 }, deps = {}) {
  const client = resolveClient(deps);
  const run = {
    id: crypto.randomUUID(),
    job_id: job_id || null,
    brand,
    block,
    cycle,
    status: "running",
    cost: 0,
    tokens: 0,
    duration_ms: null,
    error: null,
    started_at: new Date().toISOString(),
    ended_at: null,
    created_at: new Date().toISOString(),
  };

  if (!client) {
    global.memoryContentRuns.set(run.id, run);
    return run;
  }

  try {
    const { data, error } = await client.from("content_runs").insert([run]).select();
    if (error) throw error;
    return data[0];
  } catch (err) {
    console.warn(`[content-db] insertContentRun(${block}) failed:`, err.message);
    return null;
  }
}

/**
 * Close a ledger row. `duration_ms` is derived from the row's own started_at
 * so a caller never has to thread a start timestamp around.
 */
export async function finishContentRun(runId, { status, cost = 0, tokens = 0, error = null }, deps = {}) {
  if (!runId) return null;
  const client = resolveClient(deps);
  const endedAt = new Date();

  if (!client) {
    const run = global.memoryContentRuns.get(runId);
    if (!run) return null;
    Object.assign(run, {
      status,
      cost,
      tokens,
      error,
      ended_at: endedAt.toISOString(),
      duration_ms: endedAt.getTime() - new Date(run.started_at).getTime(),
    });
    return run;
  }

  try {
    const { data: existing } = await client
      .from("content_runs")
      .select("started_at")
      .eq("id", runId);
    const startedAt = existing?.[0]?.started_at;
    const patch = {
      status,
      cost,
      tokens,
      error,
      ended_at: endedAt.toISOString(),
      duration_ms: startedAt ? endedAt.getTime() - new Date(startedAt).getTime() : null,
    };
    const { data, error: updateError } = await client
      .from("content_runs")
      .update(patch)
      .eq("id", runId)
      .select();
    if (updateError) throw updateError;
    return data?.[0] || null;
  } catch (err) {
    console.warn(`[content-db] finishContentRun(${runId}) failed:`, err.message);
    return null;
  }
}

/**
 * The execution history of one job, oldest first.
 *
 * CONTRACT (R2.8.13): the returned array means "the database answered". A read
 * that could not be performed THROWS ContentReadError — it never fabricates [].
 *
 * The no-client path preserves the in-memory fallback used by the content_runs
 * ledger's local dev mode (insertContentRun / finishContentRun write to memory
 * when there is no client, so reads must too — a one-sided contract would break
 * the only mode where writes succeed). The DB-error path used to catch and
 * return [], which made the status poll at /api/content/[job_id]/status show
 * zero runs during an outage — identical on screen to "this job has never run".
 *
 * @throws {ContentReadError} db_read_failed
 */
export async function listContentRunsForJob(jobId, deps = {}) {
  const client = resolveClient(deps);

  if (!client) {
    return Array.from(global.memoryContentRuns.values())
      .filter((r) => r.job_id === jobId)
      .sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
  }

  const { data, error } = await client
    .from("content_runs")
    .select("*")
    .eq("job_id", jobId)
    .order("started_at", { ascending: true });
  if (error) {
    throw new ContentReadError(
      `Could not read content runs for job ${jobId}: ${error.message || error.code || "unknown database error"}`,
      { cause: error, code: "db_read_failed" }
    );
  }
  return data || [];
}

// ---------------------------------------------------------------------------
// content_items
// ---------------------------------------------------------------------------

export async function insertContentItem(item, deps = {}) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryContentItems;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // R3.5.6 — DELIBERATELY NO `id` AND NO `created_at`. This object is both the
  // INSERT payload and, on conflict, the UPDATE SET list of the upsert below,
  // so every key here is a column a conflict OVERWRITES on the existing row.
  // `id` in that list made a conflict run `UPDATE ... SET id = <fresh uuid>`,
  // which content_jobs.item_id references → Postgres 23503 (production,
  // 2026-09-18 21:57 UTC). Both columns have table defaults (migration 002:
  // `id uuid DEFAULT gen_random_uuid()`, `created_at timestamptz DEFAULT
  // now()`), so an INSERT still mints them; a conflict now preserves the
  // originals, exactly as the memory branch below does.
  const record = {
    job_id: item.job_id || null,
    brand: item.brand,
    playbook: item.playbook,
    title: item.title || null,
    body_md: item.body_md || "",
    research_pack: item.research_pack || null,
    benchmark_notes: item.benchmark_notes || null,
    rubric: item.rubric || null,
    cycle: item.cycle || 1,
    revision: item.revision || 0,
    revisions: item.revisions || [],
    target_queries: item.target_queries || [],
    agent_id: item.agent_id || null,
    agent_snapshot: item.agent_snapshot || null,
    status: item.status || "draft",
    updated_at: now,
  };

  if (!client) {
    // Memory mode: deduplicate by (job_id, cycle) key. `id` and `created_at`
    // are minted here because there is no column default to do it — and, on a
    // repeat, the EXISTING row keeps both. The DB branch below matches by
    // leaving both out of the upsert payload entirely.
    const key = `${record.job_id || ""}|${record.cycle}`;
    const existing = [...memory.values()].find(
      (r) => `${r.job_id || ""}|${r.cycle}` === key
    );
    if (existing) {
      Object.assign(existing, { ...record, id: existing.id, created_at: existing.created_at });
      return existing;
    }
    const fresh = { id, ...record, created_at: now };
    memory.set(id, fresh);
    return fresh;
  }

  // R3.5.2 — upsert on the natural key (job_id, cycle). A crash between
  // insertContentItem and the status write left the job without an item_id,
  // so a resume re-inserted instead of updating. With the unique constraint,
  // a repeated insert in the crash window returns the existing row.
  //
  // R3.5.6 — one statement, on purpose: `INSERT ... ON CONFLICT (job_id,cycle)
  // DO UPDATE` is atomic, so two concurrent callers yield exactly ONE row (the
  // loser blocks on the unique index, then updates the winner's row and reads
  // back the winner's id). The rejected alternative was
  // `ignoreDuplicates: true` plus a follow-up select: it needs two round trips,
  // and the loser's draft would be dropped on the floor with no row written and
  // nothing said about it — a silent no-op (standing rule 1). Select-first is
  // worse still: the gap between the select and the insert is the race.
  const { data, error } = await client
    .from("content_items")
    .upsert(record, { onConflict: "job_id,cycle" })
    .select();
  if (error) throw error;
  // A create that wrote nothing must never be returned as a value (standing
  // rule 2): the caller writes `content_jobs.item_id = item.id` next, and an
  // undefined row there would null out a job's only deliverable pointer.
  const row = (data || [])[0];
  if (!row) {
    throw new Error(
      `insertContentItem: upsert on (job_id=${record.job_id}, cycle=${record.cycle}) ` +
        `returned no row — the item was NOT written`
    );
  }
  return row;
}

export async function updateContentItem(id, updates, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;
  const withTimestamp = { ...updates, updated_at: new Date().toISOString() };

  if (!hasDb) {
    const memory = deps?.memory || global.memoryContentItems;
    const memItem = memory.get(id);
    if (memItem) Object.assign(memItem, withTimestamp);
    return memItem || null;
  }

  const { data, error } = await client
    .from("content_items")
    .update(withTimestamp)
    .eq("id", id)
    .select();
  if (error) throw error;
  return data[0];
}

export async function getContentItem(id, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!hasDb) {
    const memory = deps?.memory || global.memoryContentItems;
    return memory.get(id) || null;
  }

  const { data, error } = await client
    .from("content_items")
    .select("*")
    .eq("id", id);
  if (error) throw error;
  return data[0] || null;
}

export async function listContentItems(brand, deps = {}) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryContentItems;
  const key = String(brand || "").trim().toLowerCase();

  if (!client) {
    const list = Array.from(memory.values());
    const filtered = key
      ? list.filter((i) => i.brand.toLowerCase() === key)
      : list;
    return filtered.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  }

  let query = client
    .from("content_items")
    .select("*")
    .order("updated_at", { ascending: false });
  if (key) query = query.ilike("brand", key);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// ---------------------------------------------------------------------------
// content_feedback
// ---------------------------------------------------------------------------

export async function insertContentFeedback(
  { item_id, brand, verdict, comment },
  deps = {}
) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryContentFeedback;
  const id = crypto.randomUUID();
  const record = {
    id,
    item_id,
    brand,
    verdict,
    comment: comment || null,
    created_at: new Date().toISOString(),
  };

  if (!client) {
    memory.set(id, record);
    return record;
  }

  const { data, error } = await client
    .from("content_feedback")
    .insert([record])
    .select();
  if (error) throw error;
  return data[0];
}

// ---------------------------------------------------------------------------
// brand_briefs
// ---------------------------------------------------------------------------

function briefKey(brand) {
  return String(brand || "").trim().toLowerCase();
}

export async function getBrandBrief(brand, deps = {}) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryBrandBriefs;
  const key = briefKey(brand);
  if (!client) {
    return memory.get(key) || null;
  }
  const { data, error } = await client
    .from("brand_briefs")
    .select("*")
    .ilike("brand", key)
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

export async function upsertBrandBrief(brand, brief, deps = {}) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryBrandBriefs;
  const key = briefKey(brand);
  const now = new Date().toISOString();

  if (!client) {
    const existing = memory.get(key);
    const record = existing
      ? { ...existing, brief, updated_at: now }
      : { id: crypto.randomUUID(), brand, brief, created_at: now, updated_at: now };
    memory.set(key, record);
    return record;
  }

  const existing = await getBrandBrief(brand, deps);
  if (existing?.id && !memory.has(key)) {
    const { data, error } = await client
      .from("brand_briefs")
      .update({ brief, updated_at: now })
      .eq("id", existing.id)
      .select();
    if (error) throw error;
    return data[0];
  }
  const { data, error } = await client
    .from("brand_briefs")
    .insert([{ brand, brief, created_at: now, updated_at: now }])
    .select();
  if (error) throw error;
  return data[0];
}

// ---------------------------------------------------------------------------
// content_lessons
// ---------------------------------------------------------------------------

export async function listLessons(brand, playbook, { activeOnly = true } = {}, deps = {}) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryContentLessons;
  const key = briefKey(brand);
  if (!client) {
    return Array.from(memory.values()).filter(
      (l) =>
        l.brand.toLowerCase() === key &&
        (!playbook || l.playbook === playbook) &&
        (!activeOnly || l.active)
    );
  }
  let query = client
    .from("content_lessons")
    .select("*")
    .ilike("brand", key)
    .order("created_at", { ascending: false });
  if (playbook) query = query.eq("playbook", playbook);
  if (activeOnly) query = query.eq("active", true);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function insertLessons(brand, playbook, lessons, sourceFeedbackId, deps = {}) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryContentLessons;
  const records = (lessons || [])
    .filter((l) => l && l.trim())
    .map((lesson) => ({
      id: crypto.randomUUID(),
      brand,
      playbook,
      lesson: lesson.trim().slice(0, 200),
      source_feedback_id: sourceFeedbackId || null,
      active: true,
      created_at: new Date().toISOString(),
    }));
  if (records.length === 0) return [];

  if (!client) {
    records.forEach((r) => memory.set(r.id, r));
    return records;
  }

  const { data, error } = await client
    .from("content_lessons")
    .insert(records)
    .select();
  if (error) throw error;
  return data;
}

export async function setLessonActive(id, active, deps = {}) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryContentLessons;
  if (!client) {
    const memLesson = memory.get(id);
    if (memLesson) memLesson.active = active;
    return memLesson || null;
  }

  const { data, error } = await client
    .from("content_lessons")
    .update({ active })
    .eq("id", id)
    .select();
  if (error) throw error;
  return data?.[0] || null;
}

/** Deactivate a lesson by exact text match (learn step `supersedes`). */
export async function deactivateLessonByText(brand, playbook, lessonText, deps = {}) {
  const target = String(lessonText || "").trim();
  if (!target) return;
  const all = await listLessons(brand, playbook, { activeOnly: true }, deps);
  const match = all.find((l) => l.lesson.trim() === target);
  if (match) await setLessonActive(match.id, false, deps);
}

// ---------------------------------------------------------------------------
// content_agents (custom agents)
// ---------------------------------------------------------------------------

function agentBrandKey(brand) {
  return String(brand || "").trim().toLowerCase();
}

/**
 * List agents for a brand. Seeds the two built-in agents on first call for a
 * brand that has none, so every brand starts with usable agents.
 */
export async function listAgents(brand, { seedIfEmpty = true } = {}, deps = {}) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryContentAgents;
  const key = agentBrandKey(brand);

  const readMemory = () =>
    Array.from(memory.values())
      .filter((a) => a.brand.toLowerCase() === key)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  let agents;
  if (!client) {
    agents = readMemory();
  } else {
    const { data, error } = await client
      .from("content_agents")
      .select("*")
      .ilike("brand", key)
      .order("created_at", { ascending: true });
    if (error) throw error;
    agents = data || [];
  }

  if (agents.length === 0 && seedIfEmpty && key) {
    const seeded = [];
    for (const a of builtinAgents()) {
      seeded.push(await insertAgent(brand, a, deps));
    }
    return seeded;
  }
  return agents;
}

export async function getAgent(id, deps = {}) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryContentAgents;
  if (!client) {
    return memory.get(id) || null;
  }
  const { data, error } = await client.from("content_agents").select("*").eq("id", id);
  if (error) throw error;
  return data?.[0] || null;
}

export async function insertAgent(brand, agent, deps = {}) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryContentAgents;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const record = { id, brand, ...agent, created_at: now, updated_at: now };

  if (!client) {
    memory.set(id, record);
    return record;
  }
  const { data, error } = await client.from("content_agents").insert([record]).select();
  if (error) throw error;
  return data[0];
}

export async function updateAgent(id, updates, deps = {}) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryContentAgents;
  const withTs = { ...updates, updated_at: new Date().toISOString() };
  if (!client) {
    const mem = memory.get(id);
    if (mem) Object.assign(mem, withTs);
    return mem || null;
  }
  const { data, error } = await client
    .from("content_agents")
    .update(withTs)
    .eq("id", id)
    .select();
  if (error) throw error;
  return data?.[0] || null;
}

export async function deleteAgent(id, deps = {}) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryContentAgents;
  if (!client) {
    if (memory.has(id)) {
      memory.delete(id);
      return true;
    }
    return false;
  }
  const { data, error } = await client.from("content_agents").delete().eq("id", id).select();
  if (error) throw error;
  return !!(data && data.length > 0);
}
