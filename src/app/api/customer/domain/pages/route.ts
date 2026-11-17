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
  resolveLabsMarket,
  workspaceMarket,
} from "../../../../../shared/keyword-locations.ts";
import {
  domainBrandQuery,
  domainPagesRequestBody,
} from "../../../../../server/domain/domain.contract.ts";
import {
  getPagesPage,
  type DomainServiceDeps,
} from "../../../../../server/domain/domainService.ts";
import { createLabsClient } from "../../../../../shared/providers/dataforseo/labs.ts";
import { toResearchError } from "../../../../../server/research/providerErrors.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type DomainPagesRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  requireApprovedPrice?: typeof requireApprovedPrice;
  getPagesPage?: typeof getPagesPage;
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
  deps?: DomainPagesRouteDeps,
): Promise<Response> {
  try {
    let bodyRaw: unknown;
    try {
      bodyRaw = await request.json();
    } catch {
      throw new AppError(400, "invalid_request", "The request body must be JSON.");
    }

    const parsed = domainPagesRequestBody.safeParse(bodyRaw);
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

    if (!body.cacheOnly) {
      const approveFn = deps?.requireApprovedPrice ?? requireApprovedPrice;
      await approveFn(
        "domain.pages.page",
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
          pageSize: body.pageSize,
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

    let result;
    try {
      const getPagesPageFn = deps?.getPagesPage ?? getPagesPage;
      result = await getPagesPageFn(
        {
          domain: body.domain,
          scope: body.scope,
          locationCode: market.locationCode,
          languageCode: market.languageCode,
          page: body.page,
          pageSize: body.pageSize,
          sortMode: body.sortMode,
          sortOrder: body.sortOrder,
          filters: body.filters,
          search: body.search,
        },
        serviceDeps,
      );
    } catch (err) {
      throw toResearchError(err, {
        unavailableCode: "domain_unavailable",
        unavailableMessage: "Domain data is unavailable right now. Please retry.",
      });
    }

    if (!result) {
      return json({
        status: "not_cached",
        domain: target.hostname,
        page: body.page,
        pageSize: body.pageSize,
      });
    }

    return json({
      status: "ok",
      domain: target.hostname,
      page: result.page,
      pageSize: result.pageSize,
      totalCount: result.totalCount,
      hasMore: result.hasMore,
      pages: result.pages,
      cached: result.cached,
      fetchedAt: result.fetchedAt,
      provenance: result.provenance,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
