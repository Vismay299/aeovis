import { AppError } from "../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../server/workspace/requireWorkspace.ts";
import { requireApprovedPrice } from "../../../../../shared/pricing/pricedActions.ts";
import {
  backlinksBrandQuery,
  referringDomainsRequestBody,
} from "../../../../../server/backlinks/backlinks.contract.ts";
import {
  profileReferringDomainsPage,
  type BacklinksServiceDeps,
} from "../../../../../server/backlinks/backlinksService.ts";
import { createBacklinksClient } from "../../../../../shared/providers/dataforseo/backlinks.ts";
import { normalizeBacklinksTarget } from "../../../../../shared/providers/dataforseo/backlinksTarget.ts";
import { toResearchError } from "../../../../../server/research/providerErrors.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type ReferringDomainsRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  requireApprovedPrice?: typeof requireApprovedPrice;
  profileReferringDomainsPage?: typeof profileReferringDomainsPage;
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
  deps?: ReferringDomainsRouteDeps,
): Promise<Response> {
  try {
    let bodyRaw: unknown;
    try {
      bodyRaw = await request.json();
    } catch {
      throw new AppError(400, "invalid_request", "The request body must be JSON.");
    }

    const parsed = referringDomainsRequestBody.safeParse(bodyRaw);
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
    if (target.scope === "subfolder") {
      throw new AppError(
        400,
        "subfolder_not_supported",
        "Referring domains can't be broken down for a subfolder — use the Backlinks tab, or switch to Domain or Subdomains scope.",
      );
    }

    if (!body.cacheOnly) {
      const approveFn = deps?.requireApprovedPrice ?? requireApprovedPrice;
      await approveFn(
        "backlinks.page",
        {
          brandKey: workspace.brandKey,
          admin: workspace.admin,
          env: process.env,
          now: new Date(),
        },
        { tab: "domains", pageSize: body.pageSize },
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
      const profileReferringDomainsPageFn =
        deps?.profileReferringDomainsPage ?? profileReferringDomainsPage;
      result = await profileReferringDomainsPageFn(
        {
          target: body.target,
          scope: body.scope,
          page: body.page,
          pageSize: body.pageSize,
          sortField: body.sortField,
          sortOrder: body.sortOrder,
          filters: body.filters,
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

    return json({
      status: "ok",
      rows: result.rows,
      totalCount: result.totalCount,
      hasMore: result.hasMore,
      page: result.page,
      pageSize: result.pageSize,
      cached: result.cached,
      fetchedAt: result.fetchedAt,
      provenance: result.provenance,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
