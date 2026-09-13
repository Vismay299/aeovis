import crypto from "crypto";
import { supabase } from "../db.js";

/**
 * Knowledge blocks — the stackable context layer. Brand-wide; every agent
 * inherits the active blocks in sort order (drag order = precedence).
 * Mirrors the other content DB helpers: Supabase + memory fallback.
 */

global.memoryKnowledgeBlocks = global.memoryKnowledgeBlocks || new Map();

export const KNOWLEDGE_TYPES = ["url", "snippet", "banned_claims", "glossary"];

const MAX_CONTENT_CHARS = 12000;

function brandKey(brand) {
  return String(brand || "").trim().toLowerCase();
}

function resolveClient(deps) {
  if (deps && Object.prototype.hasOwnProperty.call(deps, "client")) return deps.client;
  if (deps && Object.prototype.hasOwnProperty.call(deps, "supabase")) return deps.supabase;
  return supabase;
}

export async function listKnowledgeBlocks(brand, { activeOnly = false } = {}, deps = {}) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryKnowledgeBlocks;
  const key = brandKey(brand);
  const fromMemory = () =>
    Array.from(memory.values())
      .filter((b) => b.brand.toLowerCase() === key && (!activeOnly || b.active))
      .sort((a, b) => a.sort_order - b.sort_order);

  if (!client) return fromMemory();
  let q = client
    .from("knowledge_blocks")
    .select("*")
    .ilike("brand", key)
    .order("sort_order", { ascending: true });
  if (activeOnly) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function insertKnowledgeBlock(brand, block, deps = {}) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryKnowledgeBlocks;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const existing = await listKnowledgeBlocks(brand, {}, deps);
  const record = {
    id,
    brand,
    type: KNOWLEDGE_TYPES.includes(block.type) ? block.type : "snippet",
    title: String(block.title || "").trim().slice(0, 120) || "Untitled",
    content: String(block.content || "").trim().slice(0, MAX_CONTENT_CHARS),
    source_url: block.source_url ? String(block.source_url).trim().slice(0, 500) : null,
    active: block.active !== false,
    sort_order: existing.length,
    created_at: now,
    updated_at: now,
  };

  if (!client) {
    memory.set(id, record);
    return record;
  }
  const { data, error } = await client.from("knowledge_blocks").insert([record]).select();
  if (error) throw error;
  return data[0];
}

export async function updateKnowledgeBlock(id, updates, deps = {}) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryKnowledgeBlocks;
  const clean = { ...updates, updated_at: new Date().toISOString() };
  if (clean.content) clean.content = String(clean.content).slice(0, MAX_CONTENT_CHARS);
  if (!client) {
    const mem = memory.get(id);
    if (mem) Object.assign(mem, clean);
    return mem || null;
  }
  const { data, error } = await client
    .from("knowledge_blocks")
    .update(clean)
    .eq("id", id)
    .select();
  if (error) throw error;
  return data?.[0] || null;
}

export async function deleteKnowledgeBlock(id, deps = {}) {
  const client = resolveClient(deps);
  const memory = deps?.memory || global.memoryKnowledgeBlocks;
  if (!client) {
    if (memory.has(id)) {
      memory.delete(id);
      return true;
    }
    return false;
  }
  const { data, error } = await client.from("knowledge_blocks").delete().eq("id", id).select();
  if (error) throw error;
  return !!(data && data.length > 0);
}

/** Persist a new drag order: array of block ids in the desired sequence. */
export async function reorderKnowledgeBlocks(brand, orderedIds, deps = {}) {
  const blocks = await listKnowledgeBlocks(brand, {}, deps);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  let i = 0;
  for (const id of orderedIds) {
    if (!byId.has(id)) continue;
    await updateKnowledgeBlock(id, { sort_order: i }, deps);
    i += 1;
  }
  return listKnowledgeBlocks(brand, {}, deps);
}
