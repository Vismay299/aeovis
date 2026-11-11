// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/serverFunctions/keywords.ts, src/server/features/keywords/services/research/saved-keywords.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../lib/workspace/requireWorkspace.ts";
import {
  savedKeywordsGetQuery,
  savedKeywordsPostBody,
} from "../../../../../lib/keywords/keywords.contract.ts";
import {
  saveKeywords,
  getSavedKeywords,
} from "../../../../../lib/keywords/savedKeywords.ts";
import {
  createSavedKeywordsRepository,
  type SavedKeywordsRepository,
} from "../../../../../lib/keywords/repository.ts";
import { parseTerms } from "../../../../../shared/keyword-filtering.ts";
import { DEFAULT_LOCATION_CODE } from "../../../../../shared/keyword-locations.ts";

export const dynamic = "force-dynamic";

export type SavedKeywordsRouteDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  repo?: SavedKeywordsRepository;
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

export async function GET(
  request: Request,
  _ctx?: unknown,
  deps?: SavedKeywordsRouteDeps,
): Promise<Response> {
  try {
    const raw: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;

    const parsed = savedKeywordsGetQuery.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Check query fields and try again.", {
        cause: parsed.error,
      });
    }

    const query = parsed.data;
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: query.brand_key },
      deps,
    );

    const checkFlag = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await checkFlag("keyword_research", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", UNAVAILABLE_MESSAGE);
    }

    const repo = deps?.repo ?? createSavedKeywordsRepository(workspace.admin);

    const includeTerms = query.include ? parseTerms(query.include) : undefined;
    const excludeTerms = query.exclude ? parseTerms(query.exclude) : undefined;
    const tagIds = query.tags
      ? query.tags.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;
    const tagNames = query.tagNames
      ? query.tagNames.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;

    const result = await getSavedKeywords(repo, {
      brandKey: workspace.brandKey,
      search: query.q ?? null,
      includeTerms,
      excludeTerms,
      minVolume: query.minVol ?? null,
      maxVolume: query.maxVol ?? null,
      minCpc: query.minCpc ?? null,
      maxCpc: query.maxCpc ?? null,
      minDifficulty: query.minKd ?? null,
      maxDifficulty: query.maxKd ?? null,
      tagIds,
      tagNames,
      page: query.page,
      pageSize: query.size,
      sort: query.sort,
      order: query.order,
    });

    return json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  _ctx?: unknown,
  deps?: SavedKeywordsRouteDeps,
): Promise<Response> {
  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      throw new AppError(400, "invalid_json", "Invalid JSON request body.");
    }

    // F13-AC-07: The save route accepts no metrics from the client
    if (
      typeof rawBody === "object" &&
      rawBody !== null &&
      "metrics" in rawBody &&
      (rawBody as { metrics?: unknown }).metrics !== undefined
    ) {
      throw new AppError(400, "invalid_request", "Client metrics are not accepted.");
    }

    const parsed = savedKeywordsPostBody.safeParse(rawBody);
    if (!parsed.success) {
      throw new AppError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Check request fields and try again.",
        { cause: parsed.error },
      );
    }

    const body = parsed.data;
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: body.brand_key },
      deps,
    );

    const checkFlag = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await checkFlag("keyword_research", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", UNAVAILABLE_MESSAGE);
    }

    const repo = deps?.repo ?? createSavedKeywordsRepository(workspace.admin);

    const locationCode = body.locationCode ?? DEFAULT_LOCATION_CODE;
    const languageCode = body.languageCode ?? "en";

    const result = await saveKeywords(repo, {
      brandKey: workspace.brandKey,
      keywords: body.keywords,
      locationCode,
      languageCode,
      tags: body.tags,
      tagMode: body.tagMode,
      actorUserId: workspace.user?.id ?? null,
    });

    return json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
