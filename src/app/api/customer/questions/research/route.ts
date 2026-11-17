import { AppError } from "../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../shared/http/errors.ts";
import { requireWorkspace, type Workspace } from "../../../../../server/workspace/requireWorkspace.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";
import { aiQuestionFeatureGateError } from "../../../../../server/questions/questions.contract.ts";
import { requireApprovedPrice } from "../../../../../shared/pricing/pricedActions.ts";
import {
  researchBody,
  researchQuestions,
  type PromptResearchDeps,
} from "../../../../../server/questions/promptResearch.ts";
import { cached } from "../../../../../server/cache/providerCache.ts";
import { captureServerEvent } from "../../../../../shared/telemetry/server.ts";
import "../../../../../shared/pricing/actions/index.ts";

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
    // F26 §6.2.7 `questions:researched { results, cached }`: the service does not
    // return its cache outcome, so count the two `cached()` reads it makes and
    // call the lookup cached only when both hit (no provider call happened).
    const cacheReads = { calls: 0, hits: 0 };
    const baseCached = deps?.cached ?? cached;
    const countedCached = (async (
      input: Parameters<typeof cached>[0],
      fetcher: () => Promise<unknown>,
      cacheDeps?: Parameters<typeof cached>[2],
    ) => {
      const outcome = await baseCached(input, fetcher, cacheDeps);
      cacheReads.calls += 1;
      if (outcome.hit) cacheReads.hits += 1;
      return outcome;
    }) as unknown as typeof cached;
    const result = await researchFn(
      ws.admin,
      ws,
      { ...body, maxUsd: approval.approvedMaxUsd },
      { ...deps, cached: countedCached },
    );

    try {
      void captureServerEvent({
        name: "questions:researched",
        props: {
          results: result.questions.length,
          cached: cacheReads.calls > 0 && cacheReads.hits === cacheReads.calls,
        },
        userId: ws.user.id,
        brandKey: ws.brandKey,
      }).catch(() => {});
    } catch {
      // Telemetry never changes the response.
    }

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
