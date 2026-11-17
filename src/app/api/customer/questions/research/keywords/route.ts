import { AppError } from "../../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../../shared/http/errors.ts";
import { requireWorkspace, type Workspace } from "../../../../../../server/workspace/requireWorkspace.ts";
import { isFeatureEnabled } from "../../../../../../server/features/flags.ts";
import { aiQuestionFeatureGateError } from "../../../../../../server/questions/questions.contract.ts";
import {
  listResearchKeywords,
  type PromptResearchDeps,
} from "../../../../../../server/questions/promptResearch.ts";
import { questionsGetQuery } from "../../../../../../server/questions/questions.contract.ts";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

export type KeywordsRouteDeps = PromptResearchDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  listResearchKeywords?: typeof listResearchKeywords;
  env?: Record<string, string | undefined>;
};

export async function GET(
  request: Request,
  _ctx: unknown,
  deps?: KeywordsRouteDeps,
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const parsedQuery = questionsGetQuery.safeParse(Object.fromEntries(searchParams.entries()));
    if (!parsedQuery.success) {
      throw new AppError(400, "invalid_request", "Check the query and try again.", {
        cause: parsedQuery.error,
      });
    }
    const brandKey = parsedQuery.data.brand_key;

    const loadWorkspace = deps?.requireWorkspace ?? requireWorkspace;
    const ws: Workspace = await loadWorkspace(request, { brandKey }, deps as any);

    const gate = deps?.isFeatureEnabled ?? isFeatureEnabled;
    const curationOn = await gate("question_curation", ws.brandKey);
    const researchOn = await gate("prompt_research", ws.brandKey);
    if (!curationOn) {
      throw new AppError(
        404,
        "feature_unavailable",
        "This page is not available for your workspace yet.",
      );
    }
    if (!researchOn) {
      throw aiQuestionFeatureGateError(
        "prompt_research",
        ws.brandKey,
        deps?.env ?? (process.env as Record<string, string | undefined>),
      );
    }

    const listFn = deps?.listResearchKeywords ?? listResearchKeywords;
    const result = await listFn(ws.admin, ws.brandKey, deps);

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
