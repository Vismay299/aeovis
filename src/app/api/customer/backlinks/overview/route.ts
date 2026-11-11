import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../lib/workspace/requireWorkspace.ts";
import { requireApprovedPrice } from "../../../../../lib/pricing/pricedActions.ts";
import {
  backlinksBrandQuery,
  backlinksOverviewRequestBody,
} from "../../../../../lib/backlinks/backlinks.contract.ts";
import {
  profileOverview,
  type BacklinksServiceDeps,
} from "../../../../../lib/backlinks/backlinksService.ts";
import { createBacklinksClient } from "../../../../../lib/providers/dataforseo/backlinks.ts";
import { normalizeBacklinksTarget } from "../../../../../lib/providers/dataforseo/backlinksTarget.ts";
import {
  appendResearch,
  declaredCompetitors,
} from "../../../../../lib/projectContext/service.ts";
import {
  backlinksResearchKey,
  formatBacklinksResearchSummary,
} from "../../../../../lib/backlinks/researchLog.ts";
import { toResearchError } from "../../../../../lib/research/providerErrors.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type BacklinksOverviewRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  requireApprovedPrice?: typeof requireApprovedPrice;
  profileOverview?: typeof profileOverview;
  declaredCompetitors?: typeof declaredCompetitors;
  appendResearch?: typeof appendResearch;
  createBacklinksClient?: typeof createBacklinksClient;
  serviceDeps?: Partial<BacklinksServiceDeps>;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function queryBrandKey(request: Request): string | undefined {
  const raw: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
  const parsed = backlinksBrandQuery.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(400, "invalid_request", "Check the query and try again.");
  }
  return parsed.data.brand_key;
}

export async function POST(
  request: Request,
  _ctx?: unknown,
  deps?: BacklinksOverviewRouteDeps,
): Promise<Response> {
  try {
    let bodyRaw: unknown;
    try {
      bodyRaw = await request.json();
    } catch {
      throw new AppError(400, "invalid_request", "The request body must be JSON.");
    }

    const parsed = backlinksOverviewRequestBody.safeParse(bodyRaw);
    if (!parsed.success) {
      throw new AppError(
        400,
        "invalid_request",
        "Check the highlighted fields and try again.",
      );
    }
    const body = parsed.data;

    const brandKey = queryBrandKey(request);
    const workspace = await requireWorkspace(request, { brandKey }, deps);

    const checkFlag = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await checkFlag("backlinks", workspace.brandKey))) {
      throw new AppError(
        404,
        "feature_unavailable",
        "This page is not available for your workspace yet.",
      );
    }

    const target = normalizeBacklinksTarget(body.target, { scope: body.scope });

    if (!body.cacheOnly) {
      const approveFn = deps?.requireApprovedPrice ?? requireApprovedPrice;
      await approveFn(
        "backlinks.lookup.run",
        {
          brandKey: workspace.brandKey,
          admin: workspace.admin,
          env: process.env,
          now: new Date(),
        },
        {
          target: body.target,
          scope: body.scope,
          tab: body.tab ?? "backlinks",
          pageSize: body.pageSize ?? 50,
        },
        body.maxUsd,
      );
    }

    const client = (deps?.createBacklinksClient ?? createBacklinksClient)();
    const serviceDeps: BacklinksServiceDeps = {
      client,
      brandKey: workspace.brandKey,
      requestId: body.requestId,
      maxUsd: body.maxUsd,
      cacheOnly: body.cacheOnly,
      ...deps?.serviceDeps,
    };

    let result;
    try {
      const profileOverviewFn = deps?.profileOverview ?? profileOverview;
      result = await profileOverviewFn(
        {
          target: body.target,
          scope: body.scope,
        },
        serviceDeps,
      );
    } catch (err) {
      throw toResearchError(err, {
        unavailableCode: "backlinks_unavailable",
        unavailableMessage: "Backlink data is unavailable right now. Please retry.",
      });
    }

    if (!result) {
      return json({
        status: "not_cached",
        target: target.apiTarget,
        displayTarget: target.displayTarget,
        scope: target.scope,
      });
    }

    const ownHost = (workspace.brand?.website_host ?? "")
      .toLowerCase()
      .replace(/^www\./, "");
    const targetHost = (
      target.scope === "exact_url"
        ? new URL(target.apiTarget).hostname
        : target.apiTarget
    )
      .toLowerCase()
      .replace(/^www\./, "");
    const isOwnSite = targetHost === ownHost;

    let isDeclaredCompetitor = false;
    try {
      const declaredFn = deps?.declaredCompetitors ?? declaredCompetitors;
      const comps = await declaredFn(workspace.admin, workspace.brandKey);
      isDeclaredCompetitor = comps.some(
        (c) => c.domain.toLowerCase().replace(/^www\./, "") === targetHost,
      );
    } catch {
      // If competitor lookup fails, default to false
    }

    if (!result.cached) {
      const appendFn = deps?.appendResearch ?? appendResearch;
      const researchKey = backlinksResearchKey({
        apiTarget: target.apiTarget,
        scope: target.scope,
        path: target.path,
      });
      try {
        await appendFn(workspace.admin, {
          brandKey: workspace.brandKey,
          kind: "backlinks.research",
          researchKey,
          summary: formatBacklinksResearchSummary({
            display: target.displayTarget,
            backlinks: result.overview.summary.backlinks,
            referringDomains: result.overview.summary.referringDomains,
          }),
          author: "user",
          actorUserId: workspace.user.id,
        });
      } catch (err) {
        console.error("appendResearch failed:", err);
      }
    }

    return json({
      status: "ok",
      target: result.overview.target,
      displayTarget: result.overview.displayTarget,
      scope: result.overview.scope,
      summary: result.overview.summary,
      trends: result.overview.trends,
      newLostTrends: result.overview.newLostTrends,
      tracked: null,
      isOwnSite,
      isDeclaredCompetitor,
      cached: result.cached,
      fetchedAt: result.fetchedAt,
      provenance: { gateway: "dataforseo" },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
