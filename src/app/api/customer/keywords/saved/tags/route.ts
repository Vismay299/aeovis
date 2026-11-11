// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/services/research/saved-keywords.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../lib/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../../lib/workspace/requireWorkspace.ts";
import { savedKeywordsTagsBody } from "../../../../../../lib/keywords/keywords.contract.ts";
import { updateSavedKeywordTags } from "../../../../../../lib/keywords/savedKeywords.ts";
import {
  createSavedKeywordsRepository,
  type SavedKeywordsRepository,
} from "../../../../../../lib/keywords/repository.ts";

export const dynamic = "force-dynamic";

export type SavedKeywordsTagsRouteDeps = RequireWorkspaceDeps & {
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

export async function POST(
  request: Request,
  _ctx?: unknown,
  deps?: SavedKeywordsTagsRouteDeps,
): Promise<Response> {
  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      throw new AppError(400, "invalid_json", "Invalid JSON request body.");
    }

    const parsed = savedKeywordsTagsBody.safeParse(rawBody);
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

    const result = await updateSavedKeywordTags(repo, {
      brandKey: workspace.brandKey,
      savedKeywordIds: body.savedKeywordIds,
      addTags: body.addTags,
      removeTagIds: body.removeTagIds,
    });

    return json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
