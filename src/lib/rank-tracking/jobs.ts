// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/rank-tracking/jobs
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { rankCheckPayloadSchema, runRankCheckJob, type RankCheckDeps } from "./checkJob.ts";

export const RANK_CHECK_KIND = "rank_tracking.check";

let boundDeps: RankCheckDeps | null = null;

export function setRankTrackingJobsDeps(deps: RankCheckDeps): void {
  boundDeps = deps;
}

export function registerRankTrackingJobs(): void {
  if (!getJobDefinition(RANK_CHECK_KIND)) {
    defineJob(
      RANK_CHECK_KIND,
      async (ctx: any) => {
        const parsed = rankCheckPayloadSchema.parse(ctx.payload);
        const typedCtx = { ...ctx, payload: parsed };
        const r = await runRankCheckJob(typedCtx, boundDeps ?? undefined);
        return { status: (r.status === "partial" ? "partial" : "completed") as "completed" | "partial", result: r.result };
      },
      { payloadSchema: rankCheckPayloadSchema, pollAfterSeconds: 5, deadlineSeconds: 7200, maxInvocations: 200 } as any,
    );
  }
}

registerRankTrackingJobs();
