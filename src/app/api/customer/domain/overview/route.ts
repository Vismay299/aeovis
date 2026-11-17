import { AppError } from "../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../server/workspace/requireWorkspace.ts";
import { requireApprovedPrice } from "../../../../../shared/pricing/pricedActions.ts";
import { parseResearchTargetOrThrow } from "../../../../../server/research/target.ts";
import {
  isLabsLocationCode,
  LABS_LOCATION_OPTIONS,
  LOCATIONS,
  resolveLabsMarket,
  workspaceMarket,
} from "../../../../../shared/keyword-locations.ts";
import {
  domainBrandQuery,
  domainOverviewRequestBody,
} from "../../../../../server/domain/domain.contract.ts";
import {
  getOverview,
  type DomainServiceDeps,
} from "../../../../../server/domain/domainService.ts";
import { createLabsClient } from "../../../../../shared/providers/dataforseo/labs.ts";
import {
  appendResearch,
  declaredCompetitors,
} from "../../../../../server/projectContext/service.ts";
import {
  domainResearchKey,
  formatOverviewResearchSummary,
} from "../../../../../server/domain/researchLog.ts";
import { toResearchError } from "../../../../../server/research/providerErrors.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type DomainOverviewRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  requireApprovedPrice?: typeof requireApprovedPrice;
  getOverview?: typeof getOverview;
  declaredCompetitors?: typeof declaredCompetitors;
  appendResearch?: typeof appendResearch;
  createLabsClient?: typeof createLabsClient;
  serviceDeps?: Partial<DomainServiceDeps>;
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
  const parsed = domainBrandQuery.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(400, "invalid_request", "Check the query and try again.");
  }
  return parsed.data.brand_key;
}

export async function POST(
  request: Request,
  _ctx?: unknown,
  deps?: DomainOverviewRouteDeps,
): Promise<Response> {
  try {
    let bodyRaw: unknown;
    try {
      bodyRaw = await request.json();
    } catch {
      throw new AppError(400, "invalid_request", "The request body must be JSON.");
    }

    const parsed = domainOverviewRequestBody.safeParse(bodyRaw);
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
    if (!(await checkFlag("domain_research", workspace.brandKey))) {
      throw new AppError(
        404,
        "feature_unavailable",
        "This page is not available for your workspace yet.",
      );
    }

    const target = parseResearchTargetOrThrow(body.domain, body.scope);

    if (body.locationCode !== undefined && !isLabsLocationCode(body.locationCode)) {
      throw new AppError(
        400,
        "invalid_location",
        "Domain research is not available for this country.",
      );
    }

    const market = resolveLabsMarket(
      { locationCode: body.locationCode, languageCode: body.languageCode },
      workspaceMarket(workspace.brand),
    );
    const country =
      LABS_LOCATION_OPTIONS.find((l) => l.code === market.locationCode)?.label ??
      LOCATIONS[market.locationCode] ??
      `Location ${market.locationCode}`;

    if (!body.cacheOnly) {
      const approveFn = deps?.requireApprovedPrice ?? requireApprovedPrice;
      await approveFn(
        "domain.lookup.run",
        {
          brandKey: workspace.brandKey,
          admin: workspace.admin,
          env: process.env,
          now: new Date(),
        },
        {
          domain: target.display,
          scope: target.scope,
          locationCode: market.locationCode,
          languageCode: market.languageCode,
          tab: "keywords",
          pageSize: 50,
        },
        body.maxUsd,
      );
    }

    const labs = (deps?.createLabsClient ?? createLabsClient)();
    const serviceDeps: DomainServiceDeps = {
      labs,
      brandKey: workspace.brandKey,
      requestId: body.requestId,
      maxUsd: body.maxUsd,
      cacheOnly: body.cacheOnly,
      ...deps?.serviceDeps,
    };

    let overview;
    try {
      const getOverviewFn = deps?.getOverview ?? getOverview;
      overview = await getOverviewFn(
        {
          domain: body.domain,
          scope: body.scope,
          locationCode: market.locationCode,
          languageCode: market.languageCode,
        },
        serviceDeps,
      );
    } catch (err) {
      throw toResearchError(err, {
        unavailableCode: "domain_unavailable",
        unavailableMessage: "Domain data is unavailable right now. Please retry.",
      });
    }

    if (!overview) {
      return json({
        status: "not_cached",
        domain: target.hostname,
        displayTarget: target.display,
        scope: target.scope,
        market: {
          locationCode: market.locationCode,
          languageCode: market.languageCode,
          country,
        },
      });
    }

    const ownHost = (workspace.brand?.website_host ?? "")
      .toLowerCase()
      .replace(/^www\./, "");
    const isOwnSite = target.hostname === ownHost;

    let isDeclaredCompetitor = false;
    try {
      const declaredFn = deps?.declaredCompetitors ?? declaredCompetitors;
      const comps = await declaredFn(workspace.admin, workspace.brandKey);
      isDeclaredCompetitor = comps.some(
        (c) => c.domain.toLowerCase() === target.hostname.toLowerCase(),
      );
    } catch {
      // If competitor lookup fails, default to false
    }

    if (!overview.cached) {
      const appendFn = deps?.appendResearch ?? appendResearch;
      const researchKey = domainResearchKey({
        hostname: target.hostname,
        scope: target.scope,
        path: target.path,
        locationCode: market.locationCode,
        languageCode: market.languageCode,
      });
      try {
        await appendFn(workspace.admin, {
          brandKey: workspace.brandKey,
          kind: "domain.research",
          researchKey,
          summary: formatOverviewResearchSummary({
            display: target.display,
            locationCode: market.locationCode,
            organicKeywords: overview.organicKeywords,
            organicTraffic: overview.organicTraffic,
            hasData: overview.hasData,
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
      domain: target.hostname,
      displayTarget: target.display,
      scope: target.scope,
      organicTraffic: overview.organicTraffic,
      organicKeywords: overview.organicKeywords,
      hasData: overview.hasData,
      market: {
        locationCode: market.locationCode,
        languageCode: market.languageCode,
        country,
      },
      isOwnSite,
      isDeclaredCompetitor,
      cached: overview.cached,
      fetchedAt: overview.fetchedAt,
      provenance: overview.provenance,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
