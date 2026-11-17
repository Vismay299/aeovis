// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/services/research/refresh-metrics.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { enqueueSystemJob } from "../jobs/enqueue.ts";
import { DB_STEP, LONG_PAID_STEP } from "../jobs/stepConfigs.ts";
import { AppError } from "../../shared/http/errors.ts";
import { getSupabaseAdmin } from "../../shared/supabase/admin.js";
import {
  refreshMetricsPayloadSchema,
  runRefreshMetricsJob,
  type RefreshMetricsDeps,
} from "./refreshMetrics.ts";
import {
  clusterOutputSchema as _clusterOutputSchema,
  runClusterJob,
  type ClusterJobDeps,
} from "./clustering.ts";
import { z } from "zod";

export const KEYWORDS_REFRESH_METRICS_KIND = "keywords.refresh_metrics";
export const KEYWORDS_METRICS_RETENTION_KIND = "keywords.metrics_retention";
export const KEYWORDS_CLUSTER_KIND = "keywords.cluster";

export const clusterPayloadSchema = z.strictObject({
  savedKeywordIds: z.array(z.string().uuid()).min(10).max(500),
  approvedMaxUsd: z.number().positive(),
  requestedBy: z.string().uuid(),
});

const RETENTION_DAYS = 400;
const DAY_MS = 86_400_000;
const PRUNE_LIMIT = 5_000;

export type KeywordRetentionDeps = {
  admin?: any;
  now?: () => Date;
};

let boundRetentionAdmin: any = null;
let boundRefreshDeps: RefreshMetricsDeps | null = null;
let boundClusterDeps: ClusterJobDeps | null = null;

export function setKeywordJobsDeps(deps: {
  retention?: KeywordRetentionDeps;
  refresh?: RefreshMetricsDeps;
  cluster?: ClusterJobDeps;
}): void {
  if (deps.retention?.admin) boundRetentionAdmin = deps.retention.admin;
  if (deps.refresh) boundRefreshDeps = deps.refresh;
  if (deps.cluster) boundClusterDeps = deps.cluster;
}

export function registerKeywordJobs(): void {
  // 1. keywords.refresh_metrics
  if (!getJobDefinition(KEYWORDS_REFRESH_METRICS_KIND)) {
    defineJob(
      KEYWORDS_REFRESH_METRICS_KIND,
      async (ctx) => {
        const parsed = refreshMetricsPayloadSchema.parse(ctx.payload);
        const typedCtx = {
          ...ctx,
          payload: parsed,
        };
        return await runRefreshMetricsJob(typedCtx, boundRefreshDeps ?? undefined);
      },
      {
        deadlineSeconds: 3600,
        maxInvocations: 10,
      },
    );
  }

  // 2. keywords.metrics_retention job
  if (!getJobDefinition(KEYWORDS_METRICS_RETENTION_KIND)) {
    defineJob(
      KEYWORDS_METRICS_RETENTION_KIND,
      async (ctx) => {
        const admin =
          boundRetentionAdmin ??
          (typeof getSupabaseAdmin === "function" ? getSupabaseAdmin() : null);
        if (!admin) {
          throw new AppError(503, "storage_unavailable", "Supabase admin client unavailable.");
        }

        const now = new Date();
        const before = new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString();

        const pruned = await ctx.step.do<number>("prune", DB_STEP, async () => {
          const { data, error } = await admin.rpc("prune_keyword_metrics", {
            p_before: before,
            p_limit: PRUNE_LIMIT,
          });
          if (error) throw error;
          const count = Number(data);
          return Number.isFinite(count) ? count : 0;
        });

        console.log(`[keywords.retention] pruned=${pruned}`);
        return { result: { pruned } };
      },
      {
        deadlineSeconds: 3600,
        maxInvocations: 5,
      },
    );
  }

  // 3. keywords.cluster
  if (!getJobDefinition(KEYWORDS_CLUSTER_KIND)) {
    defineJob(
      KEYWORDS_CLUSTER_KIND,
      async (ctx) => {
        const parsed = clusterPayloadSchema.parse(ctx.payload);
        const typedCtx = {
          ...ctx,
          payload: parsed,
        };
        const result = await runClusterJob(typedCtx as any, boundClusterDeps ?? undefined);
        return result as any;
      },
      {
        deadlineSeconds: 600,
        maxInvocations: 5,
        pollAfterSeconds: 3,
      },
    );
  }

  // 4. keywords.metrics_retention periodic
  if (!listPeriodics().some((p) => p.name === KEYWORDS_METRICS_RETENTION_KIND)) {
    definePeriodic({
      name: KEYWORDS_METRICS_RETENTION_KIND,
      everySeconds: 86400,
      run: async (now: Date) => {
        const day = now.toISOString().slice(0, 10);
        try {
          await enqueueSystemJob(
            KEYWORDS_METRICS_RETENTION_KIND,
            {},
            {
              dedupeKey: `${KEYWORDS_METRICS_RETENTION_KIND}:${day}`,
            },
          );
        } catch (err: unknown) {
          if (err instanceof AppError && err.code === "job_already_running") return;
          throw err;
        }
      },
    });
  }
}

registerKeywordJobs();
