// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/sam/SamSessionRepository.ts
//   src/server/features/sam/SamChatAgent.ts
//   src/db/pg/sam.schema.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";

export type AssistantSession = {
  id: string;
  brandKey: string;
  userId: string;
  title: string;
  summary: string | null;
  compactedThroughSeq: number | null;
  kickoff: Record<string, unknown> | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type SessionRow = {
  id: string;
  brand_key: string;
  user_id: string;
  title: string;
  summary: string | null;
  compacted_through_seq: number | string | null;
  kickoff: Record<string, unknown> | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

function toSession(row: SessionRow): AssistantSession {
  return {
    id: row.id,
    brandKey: row.brand_key,
    userId: row.user_id,
    title: row.title,
    summary: row.summary,
    compactedThroughSeq:
      row.compacted_through_seq === null || row.compacted_through_seq === undefined
        ? null
        : Number(row.compacted_through_seq),
    kickoff: row.kickoff ?? null,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Title rule ported from SamChatAgent.ts:86-91: whitespace-collapsed, empty
 * becomes "New chat", and text over 60 characters is cut to 57 plus U+2026.
 */
export function deriveTitle(text: string): string {
  const trimmed = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!trimmed) return "New chat";
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}

export async function createSession(
  admin: SupabaseClient,
  input: { brandKey: string; userId: string; kickoff?: Record<string, unknown> | null },
): Promise<AssistantSession> {
  const row: Record<string, unknown> = { brand_key: input.brandKey, user_id: input.userId };
  if (input.kickoff) row.kickoff = input.kickoff;
  const { data, error } = await admin.from("assistant_sessions").insert(row).select("*").single();
  if (error) throw error;
  return toSession(data as SessionRow);
}

export async function listSessions(
  admin: SupabaseClient,
  input: { brandKey: string; userId: string; limit?: number },
): Promise<AssistantSession[]> {
  const { data, error } = await admin
    .from("assistant_sessions")
    .select("*")
    .eq("brand_key", input.brandKey)
    .eq("user_id", input.userId)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(input.limit ?? 50);
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map((row) => toSession(row as SessionRow));
}

export async function getSession(
  admin: SupabaseClient,
  input: { id: string; brandKey: string; userId: string },
): Promise<AssistantSession | null> {
  const { data, error } = await admin
    .from("assistant_sessions")
    .select("*")
    .eq("id", input.id)
    .eq("brand_key", input.brandKey)
    .eq("user_id", input.userId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw error;
  return data ? toSession(data as SessionRow) : null;
}

export async function archiveSession(
  admin: SupabaseClient,
  input: { id: string; brandKey: string; userId: string },
): Promise<boolean> {
  const { data, error } = await admin
    .from("assistant_sessions")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", input.id)
    .eq("brand_key", input.brandKey)
    .eq("user_id", input.userId)
    .is("archived_at", null)
    .select("id");
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

export async function renameSession(
  admin: SupabaseClient,
  input: { id: string; brandKey: string; userId: string; title: string },
): Promise<AssistantSession | null> {
  const { data, error } = await admin
    .from("assistant_sessions")
    .update({ title: input.title })
    .eq("id", input.id)
    .eq("brand_key", input.brandKey)
    .eq("user_id", input.userId)
    .is("archived_at", null)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data ? toSession(data as SessionRow) : null;
}

/** Only the default title is replaced, so a user's rename is never overwritten. */
export async function setTitleIfNew(admin: SupabaseClient, id: string, firstText: string): Promise<boolean> {
  const title = deriveTitle(firstText);
  if (title === "New chat") return false;
  const { data, error } = await admin
    .from("assistant_sessions")
    .update({ title })
    .eq("id", id)
    .eq("title", "New chat")
    .select("id");
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

/**
 * Returns the kickoff object and clears it. The clear is a compare-and-swap on
 * the value just read, so two concurrent consumers cannot both receive it:
 * the loser's update matches no row and retries into a null read.
 */
export async function consumeKickoff(
  admin: SupabaseClient,
  id: string,
): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await admin.from("assistant_sessions").select("id,kickoff").eq("id", id).maybeSingle();
    if (error) throw error;
    const kickoff = (data as { kickoff?: Record<string, unknown> | null } | null)?.kickoff ?? null;
    if (!kickoff) return null;
    const { data: cleared, error: clearError } = await admin
      .from("assistant_sessions")
      .update({ kickoff: null })
      .eq("id", id)
      // PostgREST cannot cast an object interpolated into the URL (it encodes
      // as "[object Object]"); send the JSON text instead so the jsonb
      // comparison matches. See the regression test in sessions.test.ts.
      .filter("kickoff", "eq", JSON.stringify(kickoff))
      .select("id");
    if (clearError) throw clearError;
    if (Array.isArray(cleared) && cleared.length > 0) return kickoff;
  }
  return null;
}
