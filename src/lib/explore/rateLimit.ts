import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../http/errors.ts";

export type RateLimitDeps = {
  findActiveRun?: (brandKey: string, userId: string) => Promise<{ id: string } | null>;
  listUserRunsInWindow?: (userId: string, sinceIso: string) => Promise<Array<{ id: string; created_at: string }>>;
  countWorkspaceRunsSince?: (brandKey: string, sinceIso: string) => Promise<number>;
};

export async function checkExploreRateLimits(
  client: SupabaseClient,
  params: {
    brandKey: string;
    userId: string;
    now?: Date;
    env?: Record<string, string | undefined>;
  },
  deps?: RateLimitDeps,
): Promise<void> {
  const now = params.now ?? new Date();
  const env = params.env ?? process.env;

  const maxUserHour = Number(env.EXPLORE_MAX_RUNS_PER_USER_HOUR || 10);
  const maxWorkspaceDay = Number(env.EXPLORE_MAX_RUNS_PER_WORKSPACE_DAY || 30);

  // 1. Check if user already has an active run
  let activeRun: { id: string } | null = null;
  if (deps?.findActiveRun) {
    activeRun = await deps.findActiveRun(params.brandKey, params.userId);
  } else if (client && typeof client.from === "function") {
    const { data } = await client
      .from("explore_runs")
      .select("id")
      .eq("brand_key", params.brandKey)
      .eq("created_by", params.userId)
      .in("status", ["queued", "running"])
      .limit(1)
      .maybeSingle();
    activeRun = data ?? null;
  }

  if (activeRun) {
    throw new AppError(
      409,
      "explore_already_running",
      "Your previous question is still being answered.",
      { details: { activeRunId: activeRun.id } },
    );
  }

  // 2. Check user rolling hour limit
  const hourAgo = new Date(now.getTime() - 3600_000);
  let userRuns: Array<{ id: string; created_at: string }> = [];

  if (deps?.listUserRunsInWindow) {
    userRuns = await deps.listUserRunsInWindow(params.userId, hourAgo.toISOString());
  } else if (client && typeof client.from === "function") {
    const { data } = await client
      .from("explore_runs")
      .select("id, created_at")
      .eq("created_by", params.userId)
      .gt("created_at", hourAgo.toISOString())
      .order("created_at", { ascending: true });
    userRuns = (data as any) ?? [];
  }

  if (userRuns.length >= maxUserHour) {
    const oldest = new Date(userRuns[0].created_at);
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest.getTime() + 3600_000 - now.getTime()) / 1000));
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));

    throw new AppError(
      429,
      "explore_rate_limited",
      `You have asked a lot of questions recently. Try again in ${minutes} minutes.`,
      {
        recovery: "Wait, then ask again.",
        details: { retryAfterSeconds },
      },
    );
  }

  // 3. Check workspace daily limit (since UTC midnight)
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let workspaceCount = 0;

  if (deps?.countWorkspaceRunsSince) {
    workspaceCount = await deps.countWorkspaceRunsSince(params.brandKey, utcMidnight.toISOString());
  } else if (client && typeof client.from === "function") {
    const { count } = await client
      .from("explore_runs")
      .select("id", { count: "exact", head: true })
      .eq("brand_key", params.brandKey)
      .gte("created_at", utcMidnight.toISOString());
    workspaceCount = count ?? 0;
  }

  if (workspaceCount >= maxWorkspaceDay) {
    const tomorrowUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const retryAfterSeconds = Math.max(1, Math.ceil((tomorrowUtc.getTime() - now.getTime()) / 1000));

    throw new AppError(
      429,
      "explore_rate_limited",
      `This workspace has reached today's limit of ${maxWorkspaceDay} questions. Try again tomorrow.`,
      {
        recovery: "Wait, then ask again.",
        details: { retryAfterSeconds },
      },
    );
  }
}
