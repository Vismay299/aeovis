import crypto from "crypto";
import { supabase } from "../db.js";
import { builtinAgents } from "../content/agents/model.js";

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
  return deps && Object.prototype.hasOwnProperty.call(deps, "client") ? deps.client : supabase;
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

const STALE_CONTENT_JOB_MS = 20 * 60 * 1000;

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

/** Pending/stuck jobs for the cron resume path (mirrors scan worker route). */
export async function listResumableContentJobs(limit = 5) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from("content_jobs")
      .select("*")
      .in("status", CONTENT_JOB_RUNNING)
      .limit(limit * 3);
    if (error) throw error;
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    return (data || [])
      .filter((job) => {
        if (job.status === "pending") return true;
        return new Date(job.created_at).getTime() < fiveMinutesAgo;
      })
      .slice(0, limit);
  } catch (err) {
    console.warn("[content-db] listResumableContentJobs failed:", err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// content_items
// ---------------------------------------------------------------------------

export async function insertContentItem(item) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const record = {
    id,
    job_id: item.job_id || null,
    brand: item.brand,
    playbook: item.playbook,
    title: item.title || null,
    body_md: item.body_md || "",
    research_pack: item.research_pack || null,
    benchmark_notes: item.benchmark_notes || null,
    rubric: item.rubric || null,
    revision: item.revision || 0,
    revisions: item.revisions || [],
    target_queries: item.target_queries || [],
    agent_id: item.agent_id || null,
    agent_snapshot: item.agent_snapshot || null,
    status: item.status || "draft",
    created_at: now,
    updated_at: now,
  };

  if (!supabase) {
    global.memoryContentItems.set(id, record);
    return record;
  }

  try {
    const { data, error } = await supabase.from("content_items").insert([record]).select();
    if (error) throw error;
    return data[0];
  } catch (err) {
    console.warn("[content-db] insert content_item failed, using memory:", err.message);
    global.memoryContentItems.set(id, record);
    return record;
  }
}

export async function updateContentItem(id, updates, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;
  const withTimestamp = { ...updates, updated_at: new Date().toISOString() };

  if (!hasDb) {
    const memItem = global.memoryContentItems.get(id);
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
    return global.memoryContentItems.get(id) || null;
  }

  const { data, error } = await client
    .from("content_items")
    .select("*")
    .eq("id", id);
  if (error) throw error;
  return data[0] || null;
}

export async function listContentItems(brand) {
  if (!supabase) {
    const list = Array.from(global.memoryContentItems.values());
    const filtered = brand
      ? list.filter((i) => i.brand.toLowerCase() === brand.toLowerCase())
      : list;
    return filtered.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  }
  try {
    let query = supabase
      .from("content_items")
      .select("*")
      .order("updated_at", { ascending: false });
    if (brand) query = query.ilike("brand", brand);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.warn("[content-db] list content_items failed, checking memory:", err.message);
    const list = Array.from(global.memoryContentItems.values());
    return brand
      ? list.filter((i) => i.brand.toLowerCase() === brand.toLowerCase())
      : list;
  }
}

// ---------------------------------------------------------------------------
// content_feedback
// ---------------------------------------------------------------------------

export async function insertContentFeedback({ item_id, brand, verdict, comment }) {
  const id = crypto.randomUUID();
  const record = {
    id,
    item_id,
    brand,
    verdict,
    comment: comment || null,
    created_at: new Date().toISOString(),
  };

  if (!supabase) {
    global.memoryContentFeedback.set(id, record);
    return record;
  }

  try {
    const { data, error } = await supabase
      .from("content_feedback")
      .insert([record])
      .select();
    if (error) throw error;
    return data[0];
  } catch (err) {
    console.warn("[content-db] insert content_feedback failed, using memory:", err.message);
    global.memoryContentFeedback.set(id, record);
    return record;
  }
}

// ---------------------------------------------------------------------------
// brand_briefs
// ---------------------------------------------------------------------------

function briefKey(brand) {
  return String(brand || "").trim().toLowerCase();
}

export async function getBrandBrief(brand) {
  const key = briefKey(brand);
  if (!supabase) {
    return global.memoryBrandBriefs.get(key) || null;
  }
  try {
    const { data, error } = await supabase
      .from("brand_briefs")
      .select("*")
      .ilike("brand", key)
      .limit(1);
    if (error) throw error;
    return data?.[0] || global.memoryBrandBriefs.get(key) || null;
  } catch (err) {
    console.warn("[content-db] get brand_brief failed, checking memory:", err.message);
    return global.memoryBrandBriefs.get(key) || null;
  }
}

export async function upsertBrandBrief(brand, brief) {
  const key = briefKey(brand);
  const now = new Date().toISOString();

  if (!supabase) {
    const existing = global.memoryBrandBriefs.get(key);
    const record = existing
      ? { ...existing, brief, updated_at: now }
      : { id: crypto.randomUUID(), brand, brief, created_at: now, updated_at: now };
    global.memoryBrandBriefs.set(key, record);
    return record;
  }

  try {
    const existing = await getBrandBrief(brand);
    if (existing?.id && !global.memoryBrandBriefs.has(key)) {
      const { data, error } = await supabase
        .from("brand_briefs")
        .update({ brief, updated_at: now })
        .eq("id", existing.id)
        .select();
      if (error) throw error;
      return data[0];
    }
    const { data, error } = await supabase
      .from("brand_briefs")
      .insert([{ brand, brief, created_at: now, updated_at: now }])
      .select();
    if (error) throw error;
    return data[0];
  } catch (err) {
    console.warn("[content-db] upsert brand_brief failed, using memory:", err.message);
    const record = { id: crypto.randomUUID(), brand, brief, created_at: now, updated_at: now };
    global.memoryBrandBriefs.set(key, record);
    return record;
  }
}

// ---------------------------------------------------------------------------
// content_lessons
// ---------------------------------------------------------------------------

export async function listLessons(brand, playbook, { activeOnly = true } = {}) {
  const key = briefKey(brand);
  if (!supabase) {
    return Array.from(global.memoryContentLessons.values()).filter(
      (l) =>
        l.brand.toLowerCase() === key &&
        (!playbook || l.playbook === playbook) &&
        (!activeOnly || l.active)
    );
  }
  try {
    let query = supabase
      .from("content_lessons")
      .select("*")
      .ilike("brand", key)
      .order("created_at", { ascending: false });
    if (playbook) query = query.eq("playbook", playbook);
    if (activeOnly) query = query.eq("active", true);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.warn("[content-db] list content_lessons failed, checking memory:", err.message);
    return Array.from(global.memoryContentLessons.values()).filter(
      (l) =>
        l.brand.toLowerCase() === key &&
        (!playbook || l.playbook === playbook) &&
        (!activeOnly || l.active)
    );
  }
}

export async function insertLessons(brand, playbook, lessons, sourceFeedbackId) {
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

  if (!supabase) {
    records.forEach((r) => global.memoryContentLessons.set(r.id, r));
    return records;
  }

  try {
    const { data, error } = await supabase
      .from("content_lessons")
      .insert(records)
      .select();
    if (error) throw error;
    return data;
  } catch (err) {
    console.warn("[content-db] insert content_lessons failed, using memory:", err.message);
    records.forEach((r) => global.memoryContentLessons.set(r.id, r));
    return records;
  }
}

export async function setLessonActive(id, active) {
  const memLesson = global.memoryContentLessons.get(id);
  if (memLesson) memLesson.active = active;

  if (!supabase || global.memoryContentLessons.has(id)) {
    return memLesson || null;
  }

  try {
    const { data, error } = await supabase
      .from("content_lessons")
      .update({ active })
      .eq("id", id)
      .select();
    if (error) throw error;
    return data[0];
  } catch (err) {
    console.warn("[content-db] setLessonActive failed:", err.message);
    return memLesson || null;
  }
}

/** Deactivate a lesson by exact text match (learn step `supersedes`). */
export async function deactivateLessonByText(brand, playbook, lessonText) {
  const target = String(lessonText || "").trim();
  if (!target) return;
  const all = await listLessons(brand, playbook, { activeOnly: true });
  const match = all.find((l) => l.lesson.trim() === target);
  if (match) await setLessonActive(match.id, false);
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
export async function listAgents(brand, { seedIfEmpty = true } = {}) {
  const key = agentBrandKey(brand);

  const readMemory = () =>
    Array.from(global.memoryContentAgents.values())
      .filter((a) => a.brand.toLowerCase() === key)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  let agents;
  if (!supabase) {
    agents = readMemory();
  } else {
    try {
      const { data, error } = await supabase
        .from("content_agents")
        .select("*")
        .ilike("brand", key)
        .order("created_at", { ascending: true });
      if (error) throw error;
      agents = data || [];
    } catch (err) {
      console.warn("[content-db] listAgents failed, checking memory:", err.message);
      agents = readMemory();
    }
  }

  if (agents.length === 0 && seedIfEmpty && key) {
    const seeded = [];
    for (const a of builtinAgents()) {
      seeded.push(await insertAgent(brand, a));
    }
    return seeded;
  }
  return agents;
}

export async function getAgent(id) {
  if (!supabase || global.memoryContentAgents.has(id)) {
    return global.memoryContentAgents.get(id) || null;
  }
  try {
    const { data, error } = await supabase.from("content_agents").select("*").eq("id", id);
    if (error) throw error;
    return data?.[0] || null;
  } catch (err) {
    console.warn("[content-db] getAgent failed, checking memory:", err.message);
    return global.memoryContentAgents.get(id) || null;
  }
}

export async function insertAgent(brand, agent) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const record = { id, brand, ...agent, created_at: now, updated_at: now };

  if (!supabase) {
    global.memoryContentAgents.set(id, record);
    return record;
  }
  try {
    const { data, error } = await supabase.from("content_agents").insert([record]).select();
    if (error) throw error;
    return data[0];
  } catch (err) {
    console.warn("[content-db] insertAgent failed, using memory:", err.message);
    global.memoryContentAgents.set(id, record);
    return record;
  }
}

export async function updateAgent(id, updates) {
  const withTs = { ...updates, updated_at: new Date().toISOString() };
  const mem = global.memoryContentAgents.get(id);
  if (mem) Object.assign(mem, withTs);
  if (!supabase || global.memoryContentAgents.has(id)) return mem || null;
  try {
    const { data, error } = await supabase
      .from("content_agents")
      .update(withTs)
      .eq("id", id)
      .select();
    if (error) throw error;
    return data[0];
  } catch (err) {
    console.warn("[content-db] updateAgent failed:", err.message);
    return mem || null;
  }
}

export async function deleteAgent(id) {
  if (global.memoryContentAgents.has(id)) {
    global.memoryContentAgents.delete(id);
    return true;
  }
  if (!supabase) return false;
  try {
    const { error } = await supabase.from("content_agents").delete().eq("id", id);
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn("[content-db] deleteAgent failed:", err.message);
    return false;
  }
}
