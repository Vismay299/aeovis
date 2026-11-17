// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/services/research/saved-keywords.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../server/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../../server/workspace/requireWorkspace.ts";
import {
  tagPatchBody,
  tagDeleteQuery,
} from "../../../../../../server/keywords/keywords.contract.ts";
import {
  updateSavedKeywordTag,
  deleteSavedKeywordTag,
} from "../../../../../../server/keywords/savedKeywords.ts";
import {
  createSavedKeywordsRepository,
  type SavedKeywordsRepository,
} from "../../../../../../server/keywords/repository.ts";

export const dynamic = "force-dynamic";

export type TagItemRouteDeps = RequireWorkspaceDeps & {
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

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ tagId: string }> | { tagId: string } },
  deps?: TagItemRouteDeps,
): Promise<Response> {
  try {
    const params = await ctx.params;
    const tagId = params.tagId;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      throw new AppError(400, "invalid_json", "Invalid JSON request body.");
    }

    const parsed = tagPatchBody.safeParse(rawBody);
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

    const result = await updateSavedKeywordTag(repo, {
      brandKey: workspace.brandKey,
      tagId,
      name: body.name,
      color: body.color,
    });

    return json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ tagId: string }> | { tagId: string } },
  deps?: TagItemRouteDeps,
): Promise<Response> {
  try {
    const params = await ctx.params;
    const tagId = params.tagId;

    const raw: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;

    const parsed = tagDeleteQuery.safeParse(raw);
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

    const result = await deleteSavedKeywordTag(repo, {
      brandKey: workspace.brandKey,
      tagId,
    });

    return json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
