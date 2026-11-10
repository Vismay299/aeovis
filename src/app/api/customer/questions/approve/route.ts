// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityConfiguration.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../lib/workspace/requireWorkspace.ts";
import { questionsApproveBody } from "../../../../../lib/questions/questions.contract.ts";
import { approveQuestionPanel, type ApproveQuestionPanelDeps } from "../../../../../lib/questions/panel.ts";
import { getQuestionsState, type StateDeps } from "../../../../../lib/questions/state.ts";

export const dynamic = "force-dynamic";

export type QuestionsApproveRouteDeps = RequireWorkspaceDeps &
  StateDeps &
  ApproveQuestionPanelDeps & {
    isFeatureEnabled?: typeof isFeatureEnabled;
    requireWorkspace?: typeof requireWorkspace;
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
  deps?: QuestionsApproveRouteDeps
): Promise<Response> {
  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      throw new AppError(400, "invalid_request", "Malformed JSON request body.");
    }

    const parsed = questionsApproveBody.safeParse(rawBody);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Check the request body and try again.", {
        cause: parsed.error,
      });
    }
    const body = parsed.data;

    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: body.brand_key },
      deps
    );

    const checkFlag = deps?.isFeatureEnabled ?? isFeatureEnabled;
    const enabled = await checkFlag("question_curation", workspace.brandKey);
    if (!enabled) {
      throw new AppError(404, "feature_unavailable", UNAVAILABLE_MESSAGE);
    }

    const panel = await approveQuestionPanel(
      workspace.admin,
      workspace,
      body.expectedRevision,
      deps
    );

    const state = await getQuestionsState(workspace.admin, workspace, deps);
    return json({ panel, state }, 201);
  } catch (error) {
    return toErrorResponse(error);
  }
}
