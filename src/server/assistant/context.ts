import type { SupabaseClient } from "@supabase/supabase-js";
import { convertToModelMessages } from "ai";
import type { ModelMessage, UIMessage } from "ai";
import type { StoredMessage } from "./messages.ts";

export type ExpandDeps = { admin: SupabaseClient };

type ApprovalRow = {
  id: string;
  session_id: string;
  label: string;
  status: string;
  result: unknown;
};

function textOf(parts: unknown[]): string {
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const type = (part as { type?: unknown }).type;
    const text = (part as { text?: unknown }).text;
    if (type === "text" && typeof text === "string") return text;
  }
  return "";
}

const CONTINUE =
  "Continue from here; do not call the same tool for the same request again unless the user asks.";

function approvalContinuation(row: ApprovalRow): string | null {
  const head = "The user ";
  if (row.status === "executed" || row.status === "failed") {
    const result = JSON.stringify(row.result ?? null);
    return (
      head +
      "approved " +
      row.label +
      " (approval " +
      row.id +
      "). Result as JSON: " +
      result +
      ". " +
      CONTINUE
    );
  }
  if (row.status === "declined") {
    return head + "declined " + row.label + " (approval " + row.id + "). It did not run. " + CONTINUE;
  }
  // SPEC GAPS G5: §6.2.4 defines approved/declined wording only; the expired
  // variant follows the same shape so an expired card still continues the chat.
  if (row.status === "expired") {
    return (
      head +
      "did not approve " +
      row.label +
      " (approval " +
      row.id +
      "); the approval expired. It did not run. " +
      CONTINUE
    );
  }
  return null;
}

/**
 * §6.2.8 expandUserMessage: the model never reads a client-supplied
 * continuation. An approval message is rebuilt from the stored approval row.
 */
export async function expandUserMessage(row: StoredMessage, deps: ExpandDeps): Promise<string> {
  const kind = row.metadata?.kind;
  if (kind === "approval") {
    const approvalId = String(row.metadata.approvalId ?? "");
    const { data, error } = await deps.admin
      .from("assistant_approvals")
      .select("id,session_id,label,status,result")
      .eq("id", approvalId)
      .eq("session_id", row.sessionId)
      .maybeSingle();
    if (error) throw error;
    const approval = data as ApprovalRow | null;
    const text = approval ? approvalContinuation(approval) : null;
    return text ?? "The approval " + approvalId + " could not be found; ask the user what they want to do.";
  }
  if (kind === "kickoff") {
    const text = row.metadata?.text;
    return typeof text === "string" ? text : "";
  }
  return textOf(row.parts);
}

export type BuildModelInput = {
  system: string;
  uiMessages: UIMessage[];
  convertToModelMessages?: typeof convertToModelMessages;
};

export type ModelInput = { system: string; messages: ModelMessage[]; estimatedTokens: number };

function withoutDataParts(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.filter((part) => {
      const type = (part as { type?: unknown }).type;
      return typeof type !== "string" || !type.startsWith("data-");
    }),
  }));
}

/** §6.2.8: data-* parts are UI state, not model input. */
export async function buildModelInput(i: BuildModelInput): Promise<ModelInput> {
  const uiMessages = withoutDataParts(i.uiMessages);
  const convert = i.convertToModelMessages ?? convertToModelMessages;
  const messages = await convert(uiMessages);
  const estimatedTokens = Math.ceil(
    (i.system.length + JSON.stringify(uiMessages).length) / 4,
  );
  return { system: i.system, messages, estimatedTokens };
}
