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

export async function listKnowledgeBlocks(brand, { activeOnly = false } = {}) {
  const key = brandKey(brand);
  const fromMemory = () =>
    Array.from(global.memoryKnowledgeBlocks.values())
      .filter((b) => b.brand.toLowerCase() === key && (!activeOnly || b.active))
      .sort((a, b) => a.sort_order - b.sort_order);

  if (!supabase) return fromMemory();
  try {
    let q = supabase
      .from("knowledge_blocks")
      .select("*")
      .ilike("brand", key)
      .order("sort_order", { ascending: true });
    if (activeOnly) q = q.eq("active", true);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.warn("[knowledge-db] list failed, checking memory:", err.message);
    return fromMemory();
  }
}

export async function insertKnowledgeBlock(brand, block) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const existing = await listKnowledgeBlocks(brand);
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

  if (!supabase) {
    global.memoryKnowledgeBlocks.set(id, record);
    return record;
  }
  try {
    const { data, error } = await supabase.from("knowledge_blocks").insert([record]).select();
    if (error) throw error;
    return data[0];
  } catch (err) {
    console.warn("[knowledge-db] insert failed, using memory:", err.message);
    global.memoryKnowledgeBlocks.set(id, record);
    return record;
  }
}

export async function updateKnowledgeBlock(id, updates) {
  const clean = { ...updates, updated_at: new Date().toISOString() };
  if (clean.content) clean.content = String(clean.content).slice(0, MAX_CONTENT_CHARS);
  const mem = global.memoryKnowledgeBlocks.get(id);
  if (mem) Object.assign(mem, clean);
  if (!supabase || global.memoryKnowledgeBlocks.has(id)) return mem || null;
  try {
    const { data, error } = await supabase
      .from("knowledge_blocks")
      .update(clean)
      .eq("id", id)
      .select();
    if (error) throw error;
    return data[0];
  } catch (err) {
    console.warn("[knowledge-db] update failed:", err.message);
    return mem || null;
  }
}

export async function deleteKnowledgeBlock(id) {
  if (global.memoryKnowledgeBlocks.has(id)) {
    global.memoryKnowledgeBlocks.delete(id);
    return true;
  }
  if (!supabase) return false;
  try {
    const { error } = await supabase.from("knowledge_blocks").delete().eq("id", id);
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn("[knowledge-db] delete failed:", err.message);
    return false;
  }
}

/** Persist a new drag order: array of block ids in the desired sequence. */
export async function reorderKnowledgeBlocks(brand, orderedIds) {
  const blocks = await listKnowledgeBlocks(brand);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  let i = 0;
  for (const id of orderedIds) {
    if (!byId.has(id)) continue;
    await updateKnowledgeBlock(id, { sort_order: i });
    i += 1;
  }
  return listKnowledgeBlocks(brand);
}
