import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * F12 §6.2 — link collected answers to stable workspace question ids.
 *
 * Read-only phase: everything happens inside the `link_question_answers`
 * service-role RPC against stored rows. No provider calls, no answer text.
 * The only log line this module may emit is the lazy-link failure below,
 * which carries the workspace key and never question or answer text.
 */

export type LinkLinkedBy = "backfill" | "periodic" | "read";

export type LinkQuestionAnswersOptions = {
  limit?: number;
  importMissing?: boolean;
  linkedBy?: LinkLinkedBy;
};

export type LinkQuestionAnswersResult = {
  scan: number;
  explore: number;
  legacy: number;
  imported: number;
  unmatched: number;
};

const LINK_DEFAULT_LIMIT = 2000;
const LINK_READ_LIMIT = 500;

export async function linkQuestionAnswers(
  admin: SupabaseClient,
  brandKey: string,
  options: LinkQuestionAnswersOptions = {},
): Promise<LinkQuestionAnswersResult> {
  const { data, error } = await admin.rpc("link_question_answers", {
    p_brand: brandKey,
    p_limit: options.limit ?? LINK_DEFAULT_LIMIT,
    p_import_missing: options.importMissing ?? false,
    p_linked_by: options.linkedBy ?? "periodic",
  });
  if (error) throw error;
  const result = (data ?? {}) as Record<string, unknown>;
  return {
    scan: Number(result.scan ?? 0),
    explore: Number(result.explore ?? 0),
    legacy: Number(result.legacy ?? 0),
    imported: Number(result.imported ?? 0),
    unmatched: Number(result.unmatched ?? 0),
  };
}

/**
 * Best-effort link before a history read, bounded to 500 rows. A failing
 * lazy link must never fail the read: swallow every error, log only the
 * workspace key, return null.
 */
export async function linkBeforeRead(
  admin: SupabaseClient,
  brandKey: string,
): Promise<null> {
  try {
    await linkQuestionAnswers(admin, brandKey, { limit: LINK_READ_LIMIT, linkedBy: "read" });
  } catch {
    console.error(`[question-history] lazy link failed ${brandKey}`);
  }
  return null;
}
