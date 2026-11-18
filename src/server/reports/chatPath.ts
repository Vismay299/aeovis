// The "Open the chat that wrote this" link on a report. Own code.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSession } from "../assistant/sessions.ts";

export type ReportChatPathDeps = { getSession?: typeof getSession };

/**
 * `/portal/assistant?s=<id>` when the writing session still exists, is not
 * archived and belongs to the caller; otherwise null. It goes through
 * `getSession`, which is the one place that knows an archived chat is gone, so
 * the link can never lead to a chat the assistant page refuses to open. The link
 * is a convenience: a lookup failure is "no link", never a failed report read.
 */
export async function reportChatPath(
  admin: SupabaseClient,
  input: { brandKey: string; userId: string; sessionId: string | null },
  deps?: ReportChatPathDeps,
): Promise<string | null> {
  if (!input.sessionId) return null;
  try {
    const session = await (deps?.getSession ?? getSession)(admin, {
      id: input.sessionId,
      brandKey: input.brandKey,
      userId: input.userId,
    });
    return session ? `/portal/assistant?s=${session.id}` : null;
  } catch {
    return null;
  }
}
