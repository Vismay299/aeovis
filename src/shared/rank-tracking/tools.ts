// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * F15 §6.2.15 — Tools for F22 in-app assistant.
 *
 * Tools:
 * - `list_rank_trackers`: free; output summaries
 * - `get_rank_tracker`: free; input { configId, compare? }, output { config, rows (<= 200, pinned first), run }
 * - `add_rank_tracking_keywords`: input { configId, keywords (1..100), maxUsd? }; same path as route
 * - `run_rank_check`: paid; input { configId, keywordIds?, maxUsd: z.number().positive().max(50) }
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../http/appError.ts";
import { createRankTrackingRepository } from "./repository.ts";
import { listTrackers, getTracker, addKeywords } from "./service.ts";
import { getLatestResults } from "./results.ts";
import { beginRankCheckRun } from "./runGuards.ts";
import { assertTrackedLocation } from "./market.ts";
import { requireApprovedPrice, type PricingContext } from "../pricing/pricedActions.ts";
import "../pricing/actions/index.ts";

export type RankTrackingToolBrand = {
  brandKey: string;
  website_host?: string;
  display_name?: string;
};

export type RankTrackingToolContext = {
  admin: SupabaseClient;
  brand: RankTrackingToolBrand;
  userId?: string | null;
  deps?: {
    repo?: ReturnType<typeof createRankTrackingRepository>;
    listTrackers?: typeof listTrackers;
    getTracker?: typeof getTracker;
    getLatestResults?: typeof getLatestResults;
    addKeywords?: typeof addKeywords;
    beginRankCheckRun?: typeof beginRankCheckRun;
    requireApprovedPrice?: typeof requireApprovedPrice;
    assertTrackedLocation?: typeof assertTrackedLocation;
  };
};

// 1. list_rank_trackers
export const listRankTrackersInput = z.strictObject({});

export const listRankTrackersOutput = z.looseObject({
  summaries: z.array(z.looseObject({})),
});

export const listRankTrackersTool = {
  name: "list_rank_trackers",
  description:
    "List this workspace's rank tracking domains with keyword counts, schedules, and latest check status. Free.",
  input: listRankTrackersInput,
  output: listRankTrackersOutput,
  handler: async (
    ctx: RankTrackingToolContext,
    rawInput?: unknown,
  ): Promise<z.infer<typeof listRankTrackersOutput>> => {
    listRankTrackersInput.parse(rawInput ?? {});
    const ws = { brandKey: ctx.brand.brandKey, userId: ctx.userId ?? null, admin: ctx.admin };
    const listFn = ctx.deps?.listTrackers ?? listTrackers;
    const summaries = await listFn(ws);
    return { summaries };
  },
};

// 2. get_rank_tracker
export const getRankTrackerInput = z.strictObject({
  configId: z.string().uuid(),
  compare: z.enum(["1d", "7d", "30d", "90d"]).optional(),
});

export const getRankTrackerOutput = z.looseObject({
  config: z.looseObject({}),
  rows: z.array(z.looseObject({})),
  run: z.looseObject({}).nullable(),
});

export const getRankTrackerTool = {
  name: "get_rank_tracker",
  description:
    "Get a tracked domain's settings, current rankings (up to 200 keywords, pinned first), and latest check status. Free.",
  input: getRankTrackerInput,
  output: getRankTrackerOutput,
  handler: async (
    ctx: RankTrackingToolContext,
    rawInput: unknown,
  ): Promise<z.infer<typeof getRankTrackerOutput>> => {
    const input = getRankTrackerInput.parse(rawInput);
    const ws = { brandKey: ctx.brand.brandKey, userId: ctx.userId ?? null, admin: ctx.admin };
    const trackerFn = ctx.deps?.getTracker ?? getTracker;
    const trackerRes = await trackerFn(ws, input.configId);
    const config = trackerRes?.tracker ?? trackerRes;

    const resultsFn = ctx.deps?.getLatestResults ?? getLatestResults;
    const results = await resultsFn(ws, input.configId, input.compare ?? "7d", {
      admin: ctx.admin,
      repo: ctx.deps?.repo,
    });

    const sortedRows = [...(results.rows ?? [])]
      .sort((a, b) => {
        if (!!a.pinned === !!b.pinned) return 0;
        return a.pinned ? -1 : 1;
      })
      .slice(0, 200);

    return {
      config,
      rows: sortedRows,
      run: results.run ?? null,
    };
  },
};

// 3. add_rank_tracking_keywords
export const addRankTrackingKeywordsInput = z.strictObject({
  configId: z.string().uuid(),
  keywords: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  matchCase: z.boolean().optional(),
  maxUsd: z.number().positive().max(1000).optional(),
});

export const addRankTrackingKeywordsOutput = z.looseObject({
  added: z.number().int(),
  addedIds: z.array(z.string()),
  skipped: z.number().int(),
  metricsFromCache: z.number().int(),
  approval: z.looseObject({}).nullable().optional(),
});

export const addRankTrackingKeywordsTool = {
  name: "add_rank_tracking_keywords",
  description:
    "Add keywords to a tracked domain. Optional maxUsd approves updated schedule pricing if required.",
  input: addRankTrackingKeywordsInput,
  output: addRankTrackingKeywordsOutput,
  handler: async (
    ctx: RankTrackingToolContext,
    rawInput: unknown,
  ): Promise<z.infer<typeof addRankTrackingKeywordsOutput>> => {
    const input = addRankTrackingKeywordsInput.parse(rawInput);
    const ws = { brandKey: ctx.brand.brandKey, userId: ctx.userId ?? null, admin: ctx.admin };
    const addFn = ctx.deps?.addKeywords ?? addKeywords;
    const result = await addFn(
      ws,
      input.configId,
      {
        keywords: input.keywords,
        matchCase: input.matchCase,
        maxUsd: input.maxUsd,
      },
      { repo: ctx.deps?.repo },
    );
    return result;
  },
};

// 4. run_rank_check
export const runRankCheckInput = z.strictObject({
  configId: z.string().uuid(),
  keywordIds: z.array(z.string().uuid()).min(1).max(1000).optional(),
  maxUsd: z.number().positive().max(50),
});

export const runRankCheckOutput = z.looseObject({
  runId: z.string(),
  jobId: z.string(),
  status: z.string(),
  pollAfterSeconds: z.number().int().optional(),
});

export const runRankCheckTool = {
  name: "run_rank_check",
  description:
    "Check Google positions now. Paid: call the price estimate for rank_tracking.check.run first and pass the approved maxUsd.",
  input: runRankCheckInput,
  output: runRankCheckOutput,
  handler: async (
    ctx: RankTrackingToolContext,
    rawInput: unknown,
  ): Promise<z.infer<typeof runRankCheckOutput>> => {
    const input = runRankCheckInput.parse(rawInput);
    const repo = ctx.deps?.repo ?? createRankTrackingRepository(ctx.admin);
    const config = await repo.getConfig(ctx.brand.brandKey, input.configId);
    if (!config) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
    if ((config as any).is_active === false) throw new AppError(409, "tracker_archived", "This domain was archived.");

    if ((config as any).location_name) {
      const assertLoc = ctx.deps?.assertTrackedLocation ?? assertTrackedLocation;
      await assertLoc((config as any).location_code, (config as any).location_name);
    }

    const keywords = await repo.listKeywords(ctx.brand.brandKey, input.configId);
    const chosen = input.keywordIds ? keywords.filter((k: any) => input.keywordIds!.includes(k.id)) : keywords;
    if (chosen.length === 0) throw new AppError(409, "no_keywords", "Add keywords before checking rankings.");

    const pricingCtx: PricingContext = {
      brandKey: ctx.brand.brandKey,
      admin: ctx.admin,
      env: process.env,
      now: new Date(),
    };
    const requireFn = ctx.deps?.requireApprovedPrice ?? requireApprovedPrice;
    const approved = await requireFn(
      "rank_tracking.check.run",
      pricingCtx,
      {
        configId: input.configId,
        keywordIds: input.keywordIds,
        method: "live",
      } as any,
      input.maxUsd,
    );

    const beginFn = ctx.deps?.beginRankCheckRun ?? beginRankCheckRun;
    const res = await beginFn(
      { brandKey: ctx.brand.brandKey, userId: ctx.userId ?? null },
      {
        configId: input.configId,
        trigger: "manual",
        keywordIds: input.keywordIds,
        approvedMaxUsd: approved.approvedMaxUsd,
      },
      { admin: ctx.admin, repo },
    );

    if (!res.ok) {
      throw new AppError(409, "rank_check_running", "A check is already running.", {
        details: { activeRunId: res.activeRunId },
      });
    }

    return {
      runId: res.runId,
      jobId: res.jobId,
      status: "queued",
      pollAfterSeconds: 3,
    };
  },
};

export const rankTrackingTools = [
  listRankTrackersTool,
  getRankTrackerTool,
  addRankTrackingKeywordsTool,
  runRankCheckTool,
];
