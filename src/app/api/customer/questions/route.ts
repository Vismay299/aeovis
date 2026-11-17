// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityConfiguration.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../server/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
  type Workspace,
} from "../../../../server/workspace/requireWorkspace.ts";
import { getBrandAliases } from "../../../../shared/scoring/aliases.js";
import {
  questionsGetQuery,
  questionsPatchBody,
} from "../../../../server/questions/questions.contract.ts";
import { projectQuestionPatch } from "../../../../server/questions/applyQuestionPatch.ts";
import {
  listWorkspaceQuestions,
  saveQuestionPatch,
} from "../../../../server/questions/workspaceQuestions.ts";
import { getQuestionsState, type StateDeps } from "../../../../server/questions/state.ts";
import { captureServerEvent } from "../../../../shared/telemetry/server.ts";

export const dynamic = "force-dynamic";

export type QuestionsRouteDeps = RequireWorkspaceDeps &
  StateDeps & {
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

function parseQuery(request: Request): { brand_key?: string } {
  const raw: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
  const parsed = questionsGetQuery.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(400, "invalid_request", "Check the query and try again.", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export async function GET(
  request: Request,
  _ctx?: unknown,
  deps?: QuestionsRouteDeps
): Promise<Response> {
  try {
    const query = parseQuery(request);
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: query.brand_key },
      deps
    );

    const checkFlag = deps?.isFeatureEnabled ?? isFeatureEnabled;
    const enabled = await checkFlag("question_curation", workspace.brandKey);
    if (!enabled) {
      throw new AppError(404, "feature_unavailable", UNAVAILABLE_MESSAGE);
    }

    const state = await getQuestionsState(workspace.admin, workspace, deps);
    return json(state, 200);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  _ctx?: unknown,
  deps?: QuestionsRouteDeps
): Promise<Response> {
  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      throw new AppError(400, "invalid_request", "Malformed JSON request body.");
    }

    const parsed = questionsPatchBody.safeParse(rawBody);
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

    let rows: any[] = [];
    let events: any[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;

    if (body.patch) {
      const current = await listWorkspaceQuestions(workspace.admin, workspace.brandKey);
      const aliases =
        workspace.brand.aliases?.length
          ? workspace.brand.aliases
          : getBrandAliases(workspace.brand.display_name, workspace.brand.website);

      const patchResult = projectQuestionPatch(current, body.patch, {
        origin: body.addOrigin,
        aliases,
        sourceRef: body.addSourceRef,
      });

      rows = patchResult.rows;
      events = patchResult.events;
      created = patchResult.created;
      updated = patchResult.updated;
      skipped = patchResult.skipped;
    }

    await saveQuestionPatch(workspace.admin, {
      brandKey: workspace.brandKey,
      expectedRevision: body.expectedRevision,
      rows,
      events,
      settings: body.settings,
      actor: workspace.user.id,
    });

    const state = await getQuestionsState(workspace.admin, workspace, deps);
    try {
      void captureServerEvent({
        name: "questions:added",
        props: { origin: body.addOrigin, count: created },
        userId: workspace.user.id,
        brandKey: workspace.brandKey,
      }).catch(() => {});
    } catch {
      // Telemetry never changes the response.
    }
    return json(
      {
        ...state,
        created,
        updated,
        skipped,
      },
      200
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
