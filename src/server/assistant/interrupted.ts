import type { SupabaseClient } from "@supabase/supabase-js";
import { fitParts, insertMessage } from "./messages.ts";
import { rebuildAssistantMessage } from "./streamStore.ts";
import { finishTurn } from "./turns.ts";

export const INTERRUPTED_NOTICE =
  "That reply was cut off before it finished. Everything above is saved. Ask again for a narrower piece (fewer keywords, competitors or pages), or tell me where to pick up.";

export type InterruptedTurnRow = {
  id: string;
  session_id: string;
  brand_key: string;
  status?: string;
};

export function interruptedNoticePart(): { type: "data-notice"; data: { code: "interrupted"; text: string } } {
  return { type: "data-notice", data: { code: "interrupted", text: INTERRUPTED_NOTICE } };
}

function isInterruptedNotice(part: unknown): boolean {
  return (
    part !== null &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "data-notice" &&
    (part as { data?: { code?: unknown } }).data?.code === "interrupted"
  );
}

function replyIdFor(turnId: string): string {
  return "a_" + turnId.replaceAll("-", "");
}

async function existingReply(
  admin: SupabaseClient,
  turn: InterruptedTurnRow,
): Promise<{ id: string; parts: unknown[] } | null> {
  const { data, error } = await admin
    .from("assistant_messages")
    .select("*")
    .eq("session_id", turn.session_id)
    .eq("turn_id", turn.id)
    .eq("role", "assistant")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { id: string; parts?: unknown[] };
  return { id: row.id, parts: Array.isArray(row.parts) ? row.parts : [] };
}

/**
 * AC-15: rebuild an interrupted turn's reply from its stored SSE frames, append
 * the exact notice once and point the turn at the message. Idempotent: a second
 * run neither inserts a second message nor appends a second notice. Never calls
 * a model.
 */
export async function rebuildInterruptedTurn(
  admin: SupabaseClient,
  turn: InterruptedTurnRow,
): Promise<boolean> {
  const { data, error } = await admin
    .from("assistant_stream_chunks")
    .select("seq,data")
    .eq("turn_id", turn.id)
    .order("seq", { ascending: true });
  if (error) throw error;
  const chunks = (Array.isArray(data) ? data : []).map((row) =>
    String((row as { data: string }).data),
  );
  const rebuilt = await rebuildAssistantMessage(chunks);
  const existing = await existingReply(admin, turn);
  const notice = interruptedNoticePart();

  let assistantMessageId: string;
  if (existing) {
    assistantMessageId = existing.id;
    if (!existing.parts.some(isInterruptedNotice)) {
      const parts = fitParts([...existing.parts, notice]);
      const updated = await admin
        .from("assistant_messages")
        .update({ parts })
        .eq("session_id", turn.session_id)
        .eq("id", existing.id);
      if (updated.error) throw updated.error;
    }
  } else {
    assistantMessageId = replyIdFor(turn.id);
    const parts = fitParts([...(rebuilt?.parts ?? []), notice]);
    try {
      await insertMessage(admin, {
        sessionId: turn.session_id,
        id: assistantMessageId,
        brandKey: turn.brand_key,
        role: "assistant",
        parts,
        metadata: {},
        turnId: turn.id,
      });
    } catch (err) {
      // A concurrent rebuild inserted the same id first: adopt that row rather
      // than failing the turn (the unique key is (session_id, id)).
      const raced = await existingReply(admin, turn);
      if (!raced) throw err;
      assistantMessageId = raced.id;
    }
  }

  const { error: linkError } = await admin
    .from("assistant_turns")
    .update({ assistant_message_id: assistantMessageId })
    .eq("id", turn.id);
  if (linkError) throw linkError;
  return true;
}

/**
 * A turn that `begin_assistant_turn` just marked interrupted keeps its reply
 * unbuilt and unlinked until the next turn or the maintenance job picks it up.
 * Bounded on purpose: the next turn repairs one, the job repairs up to 50.
 */
export async function rebuildInterruptedTurns(
  admin: SupabaseClient,
  options: { sessionId?: string; limit?: number } = {},
): Promise<number> {
  let query = admin
    .from("assistant_turns")
    .select("id,session_id,brand_key")
    .eq("status", "interrupted")
    .is("assistant_message_id", null)
    .eq("stop_reason", "interrupted");
  if (options.sessionId) query = query.eq("session_id", options.sessionId);
  const { data, error } = await query
    .order("started_at", { ascending: true })
    .limit(Math.max(1, Math.min(options.limit ?? 50, 50)));
  if (error) throw error;
  let rebuilt = 0;
  for (const turn of (Array.isArray(data) ? data : []) as InterruptedTurnRow[]) {
    if (await rebuildInterruptedTurn(admin, turn)) rebuilt += 1;
  }
  return rebuilt;
}

/** Marks a stale streaming turn interrupted, then rebuilds and notices its reply. */
export async function interruptStaleTurn(
  admin: SupabaseClient,
  turn: InterruptedTurnRow,
): Promise<boolean> {
  await finishTurn(admin, turn.id, {
    status: "interrupted",
    stopReason: "interrupted",
  });
  return await rebuildInterruptedTurn(admin, turn);
}
