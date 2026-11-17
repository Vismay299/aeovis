import { createRankTrackingRepository } from "../../../shared/rank-tracking/repository.ts";
import {
  addRankTrackingKeywordsTool,
  getRankTrackerTool,
  listRankTrackersTool,
  runRankCheckTool,
} from "../../../shared/rank-tracking/tools.ts";
import { defineRegistration, type ToolRegistration } from "../types.ts";
import {
  actionQuoteInput,
  paidAnnotations,
  readAnnotations,
} from "./quote.ts";

type ToolInput = Record<string, unknown>;

function trackerPath(configId: unknown) {
  return "/portal/rank-tracking/" + String(configId ?? "");
}

async function addKeywordsApproval(_ctx: unknown, input: ToolInput) {
  const ctx = _ctx as {
    admin?: { from?: unknown };
    brand?: { brandKey?: string };
  };
  const configId = String(input.configId ?? "");
  const keywords = Array.isArray(input.keywords) ? input.keywords : [];

  let config: Awaited<
    ReturnType<ReturnType<typeof createRankTrackingRepository>["getConfig"]>
  > | null = null;
  if (ctx?.admin?.from && ctx?.brand?.brandKey && configId) {
    try {
      config = await createRankTrackingRepository(
        ctx.admin as never,
      ).getConfig(ctx.brand.brandKey, configId);
    } catch {
      config = null;
    }
  }

  if (config?.schedule_interval === "manual") return { kind: "none" as const };

  return {
    kind: "price" as const,
    action: "rank_tracking.config.save",
    quoteInput: actionQuoteInput("rank_tracking.config.save", input, {
      configId,
      addKeywords: keywords,
      devices: config?.devices ?? "mobile",
      serpDepth: config?.serp_depth ?? 40,
      scheduleInterval: config?.schedule_interval ?? "weekly",
    }),
    label:
      "Add " +
      keywords.length +
      " keywords to " +
      String(config?.domain ?? "the tracker"),
  };
}

function lastCheck(output: any): string {
  const value =
    output?.run?.completed_at ??
    output?.run?.started_at ??
    output?.config?.last_checked_at ??
    null;
  return value ? String(value).slice(0, 10) : "no check yet";
}

export const registrations: ToolRegistration[] = [
  defineRegistration({
    def: listRankTrackersTool as never,
    area: "rank_tracking",
    feature: "rank_tracking",
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: readAnnotations(),
    summarize: (output: any) =>
      (output?.summaries?.length ?? 0) + " rank trackers.",
    link: () => ({ path: "/portal/rank-tracking", label: "Rank tracking" }),
    example: {
      input: {},
      output: { summaries: [] },
    },
  }),
  defineRegistration({
    def: getRankTrackerTool as never,
    area: "rank_tracking",
    feature: "rank_tracking",
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: readAnnotations(),
    summarize: (output: any) =>
      (output?.rows?.length ?? 0) +
      " tracked keywords; last check " +
      lastCheck(output) +
      ".",
    link: (_output, input) => ({
      path: trackerPath(input.configId),
      label: "Rank tracker",
    }),
    example: {
      input: { configId: "0b9c2d4e-6f70-4a81-9b2c-3d4e5f607182" },
      output: { config: {}, rows: [], run: null },
    },
  }),
  defineRegistration({
    def: addRankTrackingKeywordsTool as never,
    area: "rank_tracking",
    feature: "rank_tracking",
    effect: "paid",
    approval: addKeywordsApproval,
    annotations: paidAnnotations(),
    summarize: (output: any) =>
      "Added " + (output?.added ?? 0) + " keywords to the tracker.",
    link: (_output, input) => ({
      path: trackerPath(input.configId),
      label: "Rank tracker",
    }),
    example: {
      input: {
        configId: "0b9c2d4e-6f70-4a81-9b2c-3d4e5f607182",
        keywords: ["example keyword"],
        maxUsd: 0.5,
      },
      output: { added: 1, addedIds: ["keyword-id"], skipped: 0, metricsFromCache: 0 },
    },
  }),
  defineRegistration({
    def: runRankCheckTool as never,
    area: "rank_tracking",
    feature: "rank_tracking",
    effect: "paid",
    approval: (_ctx, input) => ({
      kind: "price",
      action: "rank_tracking.check.run",
      quoteInput: actionQuoteInput("rank_tracking.check.run", input, {
        method: "live",
      }),
      label: "Run a rank check",
    }),
    annotations: paidAnnotations(),
    summarize: () => "Rank check started.",
    link: (_output, input) => ({
      path: trackerPath(input.configId),
      label: "Rank tracker",
    }),
    example: {
      input: {
        configId: "0b9c2d4e-6f70-4a81-9b2c-3d4e5f607182",
        maxUsd: 0.5,
      },
      output: {
        runId: "run-example",
        jobId: "job-example",
        status: "queued",
        pollAfterSeconds: 3,
      },
    },
  }),
];
