import type { SupabaseClient } from "@supabase/supabase-js";
import type { UIMessage } from "ai";

export type MessageRole = "user" | "assistant";

export type StoredMessage = {
  sessionId: string;
  id: string;
  brandKey: string;
  seq: number;
  role: MessageRole;
  parts: unknown[];
  metadata: Record<string, unknown>;
  turnId: string | null;
  createdAt: string;
};

export type InsertMessage = {
  sessionId: string;
  id: string;
  brandKey: string;
  role: MessageRole;
  parts: unknown[];
  metadata?: Record<string, unknown>;
  turnId?: string | null;
  createdAt?: string;
};

type MessageRow = {
  session_id: string;
  id: string;
  brand_key: string;
  seq: number | string;
  role: MessageRole;
  parts: unknown[];
  metadata: Record<string, unknown> | null;
  turn_id: string | null;
  created_at: string;
};

function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    sessionId: row.session_id,
    id: row.id,
    brandKey: row.brand_key,
    seq: Number(row.seq),
    role: row.role,
    parts: Array.isArray(row.parts) ? row.parts : [],
    metadata: row.metadata ?? {},
    turnId: row.turn_id,
    createdAt: row.created_at,
  };
}

export async function loadMessages(admin: SupabaseClient, sessionId: string): Promise<StoredMessage[]> {
  const { data, error } = await admin
    .from("assistant_messages")
    .select("session_id,id,brand_key,seq,role,parts,metadata,turn_id,created_at")
    .eq("session_id", sessionId)
    .order("seq", { ascending: true });
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map((row) => toStoredMessage(row as MessageRow));
}

export async function insertMessage(admin: SupabaseClient, message: InsertMessage): Promise<StoredMessage> {
  const row: Record<string, unknown> = {
    session_id: message.sessionId,
    id: message.id,
    brand_key: message.brandKey,
    role: message.role,
    parts: message.parts,
    metadata: message.metadata ?? {},
    turn_id: message.turnId ?? null,
  };
  if (message.createdAt) row.created_at = message.createdAt;
  const { data, error } = await admin
    .from("assistant_messages")
    .insert(row)
    .select("session_id,id,brand_key,seq,role,parts,metadata,turn_id,created_at")
    .single();
  if (error) throw error;
  return toStoredMessage(data as MessageRow);
}

export function toUIMessage(row: StoredMessage): UIMessage {
  return {
    id: row.id,
    role: row.role,
    parts: row.parts as UIMessage["parts"],
    metadata: row.metadata,
  };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function isToolPart(part: unknown): part is Record<string, unknown> {
  if (!part || typeof part !== "object") return false;
  const type = (part as { type?: unknown }).type;
  return typeof type === "string" && (type === "dynamic-tool" || type.startsWith("tool-"));
}

/**
 * F22-AC-17: a message whose parts exceed 1 MB has older tool `data` replaced
 * with `{ omitted: true, reason: "size" }`, oldest part first, until it fits.
 * Parts are never reordered and no other field is touched.
 */
export function fitParts(parts: unknown[], maxBytes = 1_000_000): unknown[] {
  const fitted = JSON.parse(JSON.stringify(parts)) as unknown[];
  if (byteLength(fitted) <= maxBytes) return fitted;
  for (const part of fitted) {
    if (!isToolPart(part)) continue;
    const output = part.output;
    if (!output || typeof output !== "object" || Array.isArray(output)) continue;
    if (!Object.prototype.hasOwnProperty.call(output, "data")) continue;
    part.output = { ...(output as Record<string, unknown>), data: { omitted: true, reason: "size" } };
    if (byteLength(fitted) <= maxBytes) return fitted;
  }
  return fitted;
}
