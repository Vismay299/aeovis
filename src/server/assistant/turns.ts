import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../shared/http/appError.ts";

export type TurnStatus = "streaming" | "completed" | "stopped" | "error" | "interrupted";
export type FinishedTurnStatus = Exclude<TurnStatus, "streaming">;
export type TurnStopReason =
  | "finished"
  | "awaiting_approval"
  | "step_limit"
  | "turn_cap"
  | "deadline"
  | "user_stop"
  | "rewound"
  | "error"
  | "interrupted";

export type TurnStats = {
  steps?: number;
  toolCalls?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  costKnown?: boolean;
  model?: string | null;
  compacted?: boolean;
};

export type TurnOutcome = TurnStats & {
  status: FinishedTurnStatus;
  stopReason: TurnStopReason;
  assistantMessageId?: string | null;
  errorCode?: string | null;
};

function mapTurnRpcError(error: { message?: string } | null): never {
  const message = String(error?.message ?? "");
  if (message.includes("turn_in_progress")) {
    throw new AppError(
      409,
      "turn_in_progress",
      "The assistant is still answering. Wait for it to finish or press Stop.",
    );
  }
  if (message.includes("session_not_found")) {
    throw new AppError(404, "session_not_found", "This chat was archived or does not exist.");
  }
  throw error;
}

function statsPatch(stats: TurnStats): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (stats.steps !== undefined) patch.steps = stats.steps;
  if (stats.toolCalls !== undefined) patch.tool_calls = stats.toolCalls;
  if (stats.inputTokens !== undefined) patch.input_tokens = stats.inputTokens;
  if (stats.outputTokens !== undefined) patch.output_tokens = stats.outputTokens;
  if (stats.costUsd !== undefined) patch.cost_usd = stats.costUsd;
  if (stats.costKnown !== undefined) patch.cost_known = stats.costKnown;
  if (stats.model !== undefined) patch.model = stats.model;
  if (stats.compacted !== undefined) patch.compacted = stats.compacted;
  return patch;
}

/** Starts a turn atomically; a live streaming turn surfaces as 409. */
export async function beginTurn(
  admin: SupabaseClient,
  input: { sessionId: string; brandKey: string; userId: string },
): Promise<string> {
  const { data, error } = await admin.rpc("begin_assistant_turn", {
    p_session: input.sessionId,
    p_brand: input.brandKey,
    p_user: input.userId,
  });
  if (error) mapTurnRpcError(error);
  return String(data);
}

export async function heartbeat(admin: SupabaseClient, turnId: string, stats: TurnStats = {}): Promise<void> {
  const patch = { ...statsPatch(stats), heartbeat_at: new Date().toISOString() };
  const { error } = await admin.from("assistant_turns").update(patch).eq("id", turnId);
  if (error) throw error;
}

/** Sets cancel_requested_at on this user's streaming turn; false when none. */
export async function requestCancel(
  admin: SupabaseClient,
  input: { sessionId: string; userId: string },
): Promise<boolean> {
  const { data, error } = await admin
    .from("assistant_turns")
    .update({ cancel_requested_at: new Date().toISOString() })
    .eq("session_id", input.sessionId)
    .eq("user_id", input.userId)
    .eq("status", "streaming")
    .select("id");
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

export async function cancelRequested(admin: SupabaseClient, turnId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("assistant_turns")
    .select("cancel_requested_at")
    .eq("id", turnId)
    .maybeSingle();
  if (error) throw error;
  return Boolean((data as { cancel_requested_at?: string | null } | null)?.cancel_requested_at);
}

export async function finishTurn(admin: SupabaseClient, turnId: string, outcome: TurnOutcome): Promise<void> {
  const patch: Record<string, unknown> = {
    status: outcome.status,
    stop_reason: outcome.stopReason,
    finished_at: new Date().toISOString(),
    ...statsPatch(outcome),
  };
  if (outcome.assistantMessageId !== undefined) patch.assistant_message_id = outcome.assistantMessageId;
  if (outcome.errorCode !== undefined) patch.error_code = outcome.errorCode;
  const { error } = await admin.from("assistant_turns").update(patch).eq("id", turnId);
  if (error) throw error;
}

/**
 * Marks streaming turns whose heartbeat is older than the cutoff as
 * interrupted. Returns how many were changed. Interrupted turns are never
 * re-run automatically; the maintenance job rebuilds their partial reply.
 */
export async function markInterrupted(admin: SupabaseClient, olderThanSeconds: number): Promise<number> {
  const cutoff = new Date(Date.now() - Math.max(0, olderThanSeconds) * 1_000).toISOString();
  const { data, error } = await admin
    .from("assistant_turns")
    .update({
      status: "interrupted",
      stop_reason: "interrupted",
      finished_at: new Date().toISOString(),
    })
    .eq("status", "streaming")
    .lt("heartbeat_at", cutoff)
    .select("id");
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
}
