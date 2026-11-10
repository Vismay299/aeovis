// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/serverFunctions/serp-locations.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../lib/workspace/requireWorkspace.ts";
import { serpRequestBody } from "../../../../../lib/keywords/keywords.contract.ts";
import {
  runSerpRequest,
  type RunSerpDeps,
} from "../../../../../lib/keywords/serp.ts";
import "../../../../../lib/pricing/actions/index.ts";
import { CacheOnlyMiss } from "../../../../../lib/research/cache.ts";
import { toResearchError } from "../../../../../lib/research/providerErrors.ts";

export const dynamic = "force-dynamic";

export type SerpRouteDeps = RequireWorkspaceDeps &
  RunSerpDeps & {
    requireWorkspace?: typeof requireWorkspace;
    isFeatureEnabled?: typeof isFeatureEnabled;
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
  deps?: SerpRouteDeps,
): Promise<Response> {
  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      throw new AppError(400, "invalid_json", "Invalid JSON request body.");
    }

    const parsed = serpRequestBody.safeParse(rawBody);
    if (!parsed.success) {
      throw new AppError(
        400,
        "invalid_request",
        "Check request fields and try again.",
        { cause: parsed.error },
      );
    }

    const input = parsed.data;
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: input.brand_key },
      deps,
    );

    const checkFlag = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await checkFlag("keyword_research", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", UNAVAILABLE_MESSAGE);
    }

    try {
      const outcome = await runSerpRequest(
        workspace,
        {
          keyword: input.keyword,
          locationCode: input.locationCode,
          languageCode: input.languageCode,
          locationName: input.locationName,
          depth: input.depth,
          maxUsd: input.maxUsd,
          requestId: input.requestId ?? crypto.randomUUID(),
          cacheOnly: input.cacheOnly,
        },
        deps,
      );

      return json(outcome);
    } catch (err) {
      if (err instanceof CacheOnlyMiss) {
        return json({ notCached: true, cached: false });
      }
      throw err;
    }
  } catch (err) {
    const mapped = toResearchError(err, {
      unavailableCode: "serp_unavailable",
      unavailableMessage:
        "SERP analysis is temporarily unavailable. Try again shortly.",
    });
    return toErrorResponse(mapped);
  }
}
