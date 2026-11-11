import { z } from "zod";
import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { requireWorkspace, type Workspace } from "../../../../../lib/workspace/requireWorkspace.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { aiQuestionFeatureGateError } from "../../../../../lib/questions/questions.contract.ts";
import { requireApprovedPrice, recordApproval } from "../../../../../lib/pricing/pricedActions.ts";
import { enqueueJob } from "../../../../../lib/jobs/enqueue.ts";
import {
  readQuestionSettings,
} from "../../../../../lib/questions/workspaceQuestions.ts";
import { normalizeCompetitorDomain } from "../../../../../lib/questions/setup/research.ts";
import type { SetupPayload } from "../../../../../lib/questions/setup/schemas.ts";
import "../../../../../lib/pricing/actions/index.ts";
import "../../../../../lib/questions/jobs.ts";

export const maxDuration = 90;
export const dynamic = "force-dynamic";

export const setupRouteBodySchema = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  maxUsd: z.number().positive().max(1000).optional(),
});

export type SetupRouteDeps = {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  requireApprovedPrice?: typeof requireApprovedPrice;
  enqueueJob?: typeof enqueueJob;
  recordApproval?: typeof recordApproval;
  readQuestionSettings?: typeof readQuestionSettings;
  saveSetupJob?: (admin: Workspace["admin"], brandKey: string, jobId: string, userId: string) => Promise<void>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
};

export async function POST(
  request: Request,
  _ctx: unknown,
  deps?: SetupRouteDeps,
): Promise<Response> {
  try {
    let rawBody: unknown = {};
    const text = await request.text();
    if (text.trim()) {
      try {
        rawBody = JSON.parse(text);
      } catch {
        throw new AppError(400, "invalid_json", "The request body must be JSON.");
      }
    }

    const parsed = setupRouteBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Invalid request body.", {
        details: { issues: parsed.error.issues },
      });
    }
    const body = parsed.data;

    const loadWorkspace = deps?.requireWorkspace ?? requireWorkspace;
    const ws: Workspace = await loadWorkspace(request, { brandKey: body.brand_key }, deps as any);

    const gate = deps?.isFeatureEnabled ?? isFeatureEnabled;
    const curationOn = await gate("question_curation", ws.brandKey);
    const setupOn = await gate("question_setup", ws.brandKey);
    if (!curationOn) {
      throw new AppError(
        404,
        "feature_unavailable",
        "This page is not available for your workspace yet.",
      );
    }
    if (!setupOn) {
      throw aiQuestionFeatureGateError(
        "question_setup",
        ws.brandKey,
        deps?.env ?? (process.env as Record<string, string | undefined>),
      );
    }

    const pricingCtx = {
      brandKey: ws.brandKey,
      admin: ws.admin,
      env: deps?.env ?? (process.env as Record<string, string | undefined>),
      now: deps?.now ? deps.now() : new Date(),
    };

    const approvePrice = deps?.requireApprovedPrice ?? requireApprovedPrice;
    const approval = await approvePrice(
      "questions.setup.run",
      pricingCtx,
      {},
      body.maxUsd,
    );

    const readSettings = deps?.readQuestionSettings ?? readQuestionSettings;
    const settings = await readSettings(ws.admin, ws.brandKey);

    const ownHost =
      normalizeCompetitorDomain(ws.brand.website_host || ws.brand.website) || "localhost";

    const jobPayload: SetupPayload = {
      brandKey: ws.brandKey,
      approvedMaxUsd: approval.approvedMaxUsd,
      requestedBy: ws.user.id,
      website: ws.brand.website,
      ownHost,
      displayName: ws.brand.display_name,
      market: {
        country: settings.country,
        language: settings.language,
      },
    };

    const enqueue = deps?.enqueueJob ?? enqueueJob;
    const { jobId } = await enqueue(
      "questions.setup",
      jobPayload,
      {
        brandKey: ws.brandKey,
        singleActiveKey: `questions.setup:${ws.brandKey}`,
        trigger: "manual",
        createdBy: ws.user.id,
      },
      deps as any,
    );

    const record = deps?.recordApproval ?? recordApproval;
    await record(ws.admin, {
      brandKey: ws.brandKey,
      action: "questions.setup.run",
      approvedMaxUsd: approval.approvedMaxUsd,
      quote: approval.quote,
      source: approval.source,
      subject: { kind: "job", id: jobId },
      approvedBy: ws.user.id,
    });

    const saveJob = deps?.saveSetupJob ?? (async (admin, brandKey, setupJobId, userId) => {
      const { error } = await admin.from("workspace_question_settings").upsert(
        {
          brand_key: brandKey,
          setup_job_id: setupJobId,
          updated_by: userId,
          updated_at: (deps?.now ? deps.now() : new Date()).toISOString(),
        },
        { onConflict: "brand_key" },
      );
      if (error) {
        throw new AppError(503, "questions_unavailable", "Setup status could not be saved.", {
          cause: error,
        });
      }
    });
    await saveJob(ws.admin, ws.brandKey, jobId, ws.user.id);

    return new Response(
      JSON.stringify({
        jobId,
        status: "queued",
        pollAfterSeconds: 3,
      }),
      {
        status: 202,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
