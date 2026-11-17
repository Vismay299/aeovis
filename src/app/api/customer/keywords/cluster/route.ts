// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/services/research/refresh-metrics.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../server/workspace/requireWorkspace.ts";
import { clusterBody } from "../../../../../server/keywords/keywords.contract.ts";
import {
  requireApprovedPrice,
  recordApproval,
  type PricingContext,
} from "../../../../../shared/pricing/pricedActions.ts";
import "../../../../../shared/pricing/actions/index.ts";
import { enqueueJob } from "../../../../../server/jobs/enqueue.ts";
import { KEYWORDS_CLUSTER_KIND } from "../../../../../server/keywords/jobs.ts";

export const dynamic = "force-dynamic";

export type ClusterRouteDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  requireApprovedPrice?: typeof requireApprovedPrice;
  recordApproval?: typeof recordApproval;
  enqueueJob?: typeof enqueueJob;
};

const UNAVAILABLE_MESSAGE = "This page is not available for your workspace yet.";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function POST(
  request: Request,
  _ctx?: unknown,
  deps?: ClusterRouteDeps,
): Promise<Response> {
  try {
    let rawBody: unknown = {};
    const text = await request.text();
    if (text.trim().length > 0) {
      try {
        rawBody = JSON.parse(text);
      } catch {
        throw new AppError(400, "invalid_json", "Invalid JSON request body.");
      }
    }

    const parsed = clusterBody.safeParse(rawBody);
    if (!parsed.success) {
      throw new AppError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Check request fields and try again.",
        { cause: parsed.error },
      );
    }

    const body = parsed.data;
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: body.brand_key },
      deps,
    );

    const checkFlag = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await checkFlag("keyword_clustering", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", UNAVAILABLE_MESSAGE);
    }

    const pricingCtx: PricingContext = {
      brandKey: workspace.brandKey,
      admin: workspace.admin,
      env: process.env,
      now: new Date(),
    };

    const priceApprovalFn = deps?.requireApprovedPrice ?? requireApprovedPrice;
    const approval = await priceApprovalFn(
      "keywords.clustering.run",
      pricingCtx,
      { savedKeywordIds: body.savedKeywordIds },
      body.maxUsd,
    );

    const enqueue = deps?.enqueueJob ?? enqueueJob;
    const { jobId } = await enqueue(
      KEYWORDS_CLUSTER_KIND,
      {
        savedKeywordIds: body.savedKeywordIds,
        approvedMaxUsd: approval.approvedMaxUsd,
        requestedBy: workspace.user.id,
      },
      {
        brandKey: workspace.brandKey,
        singleActiveKey: `keywords.cluster:${workspace.brandKey}`,
        trigger: "manual",
        createdBy: workspace.user.id,
      },
    );

    const record = deps?.recordApproval ?? recordApproval;
    await record(workspace.admin, {
      brandKey: workspace.brandKey,
      action: "keywords.clustering.run",
      approvedMaxUsd: approval.approvedMaxUsd,
      quote: approval.quote,
      source: approval.source,
      subject: { kind: "job", id: jobId },
      approvedBy: workspace.user.id,
    });

    return json({ jobId, status: "queued", pollAfterSeconds: 3 }, 202);
  } catch (err) {
    return toErrorResponse(err);
  }
}