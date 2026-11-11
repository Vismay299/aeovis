// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/serverFunctions/keywords.ts, src/server/features/keywords/services/research/saved-keywords.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../lib/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../../lib/workspace/requireWorkspace.ts";
import { savedKeywordsExportQuery } from "../../../../../../lib/keywords/keywords.contract.ts";
import { exportSavedKeywords } from "../../../../../../lib/keywords/savedKeywords.ts";
import {
  createSavedKeywordsRepository,
  type SavedKeywordsRepository,
} from "../../../../../../lib/keywords/repository.ts";
import { parseTerms } from "../../../../../../shared/keyword-filtering.ts";

export const dynamic = "force-dynamic";

export type SavedKeywordsExportRouteDeps = RequireWorkspaceDeps & {
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
  deps?: SavedKeywordsExportRouteDeps,
): Promise<Response> {
  try {
    const raw: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;

    const parsed = savedKeywordsExportQuery.safeParse(raw);
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

    const result = await exportSavedKeywords(repo, {
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
      sort: query.sort,
      order: query.order,
    });

    return json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
