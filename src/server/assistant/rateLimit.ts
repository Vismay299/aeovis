import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../shared/http/appError.ts";
import type { AssistantConfig } from "./config.ts";

export const RATE_LIMIT_MESSAGE = "You have sent a lot of messages. Try again in a few minutes.";
export const RATE_LIMIT_RECOVERY = "Wait a few minutes, or start fewer parallel chats.";

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function countSince(
  admin: SupabaseClient,
  column: "user_id" | "brand_key",
  value: string,
  since: Date,
): Promise<number> {
  // A head count, not a row read: a plain select is cut at PostgREST `max_rows`
  // (1,000), which would make any limit above that unreachable.
  const { count, error } = await admin
    .from("assistant_turns")
    .select("id", { count: "exact", head: true })
    .eq(column, value)
    .gte("started_at", since.toISOString());
  if (error) throw error;
  return count ?? 0;
}

/** §6.2.8 AC-21: a rolling hour per user and a UTC day per workspace. */
export async function assertTurnRate(
  admin: SupabaseClient,
  i: { userId: string; brandKey: string },
  cfg: Pick<AssistantConfig, "perUserHour" | "perWorkspaceDay">,
  deps: { now?: () => Date } = {},
): Promise<void> {
  const now = deps.now ? deps.now() : new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60_000);
  const perUser = await countSince(admin, "user_id", i.userId, hourAgo);
  const perBrand = await countSince(admin, "brand_key", i.brandKey, utcMidnight(now));
  if (perUser >= cfg.perUserHour || perBrand >= cfg.perWorkspaceDay) {
    throw new AppError(429, "assistant_rate_limited", RATE_LIMIT_MESSAGE, {
      recovery: RATE_LIMIT_RECOVERY,
    });
  }
}
