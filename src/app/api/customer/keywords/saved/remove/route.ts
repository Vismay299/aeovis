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
import { savedKeywordsRemoveBody } from "../../../../../../server/keywords/keywords.contract.ts";
import { removeSavedKeywords } from "../../../../../../server/keywords/savedKeywords.ts";
import {
  createSavedKeywordsRepository,
  type SavedKeywordsRepository,
} from "../../../../../../server/keywords/repository.ts";

export const dynamic = "force-dynamic";

export type RemoveSavedKeywordsRouteDeps = RequireWorkspaceDeps & {
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
  deps?: RemoveSavedKeywordsRouteDeps,
): Promise<Response> {
  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      throw new AppError(400, "invalid_json", "Invalid JSON request body.");
    }

    const parsed = savedKeywordsRemoveBody.safeParse(rawBody);
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

    const result = await removeSavedKeywords(repo, {
      brandKey: workspace.brandKey,
      savedKeywordIds: body.savedKeywordIds,
    });

    return json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
