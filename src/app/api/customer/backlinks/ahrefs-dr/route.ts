// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/serverFunctions/ahrefs.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../server/workspace/requireWorkspace.ts";
import {
  backlinksBrandQuery,
  ahrefsDomainRatingsRequestBody,
} from "../../../../../server/backlinks/backlinks.contract.ts";
import {
  getAhrefsDomainRatings,
  type AhrefsDomainRatingDeps,
} from "../../../../../server/backlinks/ahrefsDomainRating.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export type AhrefsDomainRatingsRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  getAhrefsDomainRatings?: typeof getAhrefsDomainRatings;
  serviceDeps?: AhrefsDomainRatingDeps;
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
  deps?: AhrefsDomainRatingsRouteDeps,
): Promise<Response> {
  try {
    let bodyRaw: unknown;
    try {
      bodyRaw = await request.json();
    } catch {
      throw new AppError(400, "invalid_request", "The request body must be JSON.");
    }

    const parsed = ahrefsDomainRatingsRequestBody.safeParse(bodyRaw);
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
    if (!(await checkFlag("backlinks_ahrefs_dr", workspace.brandKey))) {
      throw new AppError(
        404,
        "feature_unavailable",
        "This page is not available for your workspace yet.",
      );
    }

    const getRatings = deps?.getAhrefsDomainRatings ?? getAhrefsDomainRatings;
    const ratings = await getRatings(body.domains, deps?.serviceDeps);

    const failed = Object.values(ratings).filter((dr) => dr === null).length;
    console.info("[backlinks] ahrefs", {
      count: body.domains.length,
      failed,
    });

    return json({ ratings });
  } catch (err) {
    return toErrorResponse(err);
  }
}
