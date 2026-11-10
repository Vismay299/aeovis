import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { requireWorkspace, type Workspace } from "../../../../../lib/workspace/requireWorkspace.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { requireApprovedPrice } from "../../../../../lib/pricing/pricedActions.ts";
import {
  researchBody,
  researchQuestions,
  type PromptResearchDeps,
} from "../../../../../lib/questions/promptResearch.ts";
import "../../../../../lib/pricing/actions/index.ts";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export type ResearchRouteDeps = PromptResearchDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  requireApprovedPrice?: typeof requireApprovedPrice;
  researchQuestions?: typeof researchQuestions;
  env?: Record<string, string | undefined>;
  now?: () => Date;
};

export async function POST(
  request: Request,
  _ctx: unknown,
  deps?: ResearchRouteDeps,
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

    const parsed = researchBody.safeParse(rawBody);
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
    const researchOn = await gate("prompt_research", ws.brandKey);
    if (!curationOn || !researchOn) {
      throw new AppError(
        404,
        "feature_unavailable",
        "This page is not available for your workspace yet.",
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
      "questions.research.run",
      pricingCtx,
      { keyword: body.keyword },
      body.maxUsd,
    );

    const researchFn = deps?.researchQuestions ?? researchQuestions;
    const result = await researchFn(
      ws.admin,
      ws,
      { ...body, maxUsd: approval.approvedMaxUsd },
      deps,
    );

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
