import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../shared/http/appError.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";

export type KickoffBuilder = (i: {
  admin: SupabaseClient;
  ws: Workspace;
  kickoff: Record<string, unknown>;
}) => Promise<{ text: string; label: string }>;

export type KickoffInput = {
  admin: SupabaseClient;
  ws: Workspace;
  kickoff: Record<string, unknown>;
};

const KIND_PATTERN = /^[a-z][a-z0-9_]*$/;
const builders = new Map<string, KickoffBuilder>();

/**
 * Feature registrations live in `kickoffKinds.ts` and are imported for their
 * side effect by `turn.ts`; this module never imports them, so there is no
 * cycle. Re-registering the same kind is a deployment bug, not an update path.
 */
export function registerKickoff(kind: string, build: KickoffBuilder): void {
  if (!KIND_PATTERN.test(kind)) {
    throw new AppError(500, "invalid_kickoff_kind", "A kickoff kind must be lowercase snake case.");
  }
  if (builders.has(kind)) {
    throw new AppError(500, "duplicate_kickoff_kind", "This kickoff kind is already registered.");
  }
  builders.set(kind, build);
}

export async function buildKickoff(i: KickoffInput): Promise<{ text: string; label: string }> {
  const kind = typeof i.kickoff.kind === "string" ? i.kickoff.kind : "";
  const build = builders.get(kind);
  if (!build) {
    throw new AppError(409, "no_kickoff", "There is nothing to start in this chat.");
  }
  return await build(i);
}

/** Test seam only: the production registry is populated by side-effect imports. */
export function clearKickoffsForTesting(): void {
  builders.clear();
}
