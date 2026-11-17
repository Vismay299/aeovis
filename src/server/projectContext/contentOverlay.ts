/**
 * F07 §6.2.6 — the flagged Content Studio overlay. Own code.
 *
 * `resolveBrief` calls `withProjectMemory` after it has computed the brief it
 * returns and after any `upsert`, so the digest reaches every drafting step and
 * is never persisted onto `brand_briefs`.
 */

import { AppError } from "../../shared/http/appError.ts";
import { getSupabaseAdmin } from "../../shared/supabase/admin.js";
import { getProjectContextByKey, renderProjectContextMarkdown } from "./service.ts";

/** The digest is capped so one brief cannot blow a drafting prompt. */
export const PROJECT_MEMORY_BRIEF_MAX_CHARS = 12_000;

/**
 * The brief plus the memory digest. Returns a NEW object: `resolveBrief`'s
 * callers hold the value they persisted, and mutating it would write memory into
 * the brand brief on the next save.
 */
export function withProjectMemory(
  brief: Record<string, unknown>,
  markdown: string,
): Record<string, unknown> {
  return { ...brief, project_memory: markdown.slice(0, PROJECT_MEMORY_BRIEF_MAX_CHARS) };
}

/**
 * The default markdown source for `resolveBrief`: the workspace's memory, read
 * with the service client. `resolveBrief` receives a brand key, not a brand row,
 * which is what `getProjectContextByKey` exists for.
 */
export async function defaultProjectMemoryMarkdown(brandKey: string): Promise<string> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new AppError(503, "storage_unavailable", "Workspace storage is unavailable.");
  }
  return renderProjectContextMarkdown(await getProjectContextByKey(admin, brandKey));
}
