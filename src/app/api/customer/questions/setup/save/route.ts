import { AppError } from "../../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../../lib/http/errors.ts";
import { requireWorkspace, type Workspace } from "../../../../../../lib/workspace/requireWorkspace.ts";
import { isFeatureEnabled } from "../../../../../../lib/features/flags.ts";
import { aiQuestionFeatureGateError } from "../../../../../../lib/questions/questions.contract.ts";
import { captureServerEvent } from "../../../../../../lib/telemetry/server.ts";
import {
  saveSetupBodySchema,
  saveSetupReview,
  type SaveSetupDeps,
} from "../../../../../../lib/questions/setup/save.ts";

export const maxDuration = 90;
export const dynamic = "force-dynamic";

export type SetupSaveRouteDeps = SaveSetupDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  saveSetupReview?: typeof saveSetupReview;
  env?: Record<string, string | undefined>;
};

export async function POST(
  request: Request,
  _ctx: unknown,
  deps?: SetupSaveRouteDeps,
): Promise<Response> {
  try {
    let rawBody: unknown = {};
    const text = await request.text();
    if (text.trim()) {
      try {
        rawBody = JSON.parse(text);
      } catch {
        throw new AppError(400, "invalid_json", "The request body must be JSON.");
      }
    }

    const parsed = saveSetupBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Invalid request body.", {
        details: { issues: parsed.error.issues },
      });
    }
    const body = parsed.data;

    const loadWorkspace = deps?.requireWorkspace ?? requireWorkspace;
    const ws: Workspace = await loadWorkspace(request, { brandKey: body.brand_key }, deps as any);

    const gate = deps?.isFeatureEnabled ?? isFeatureEnabled;
    const curationOn = await gate("question_curation", ws.brandKey);
    const setupOn = await gate("question_setup", ws.brandKey);
    if (!curationOn) {
      throw new AppError(
        404,
        "feature_unavailable",
        "This page is not available for your workspace yet.",
      );
    }
    if (!setupOn) {
      throw aiQuestionFeatureGateError(
        "question_setup",
        ws.brandKey,
        deps?.env ?? (process.env as Record<string, string | undefined>),
      );
    }

    const saveFn = deps?.saveSetupReview ?? saveSetupReview;
    const result = await saveFn(ws.admin, ws, body, deps);

    try {
      void captureServerEvent({
        name: "questions:setup_saved",
        props: {
          questions: result.saved.questionsAdded,
          competitors: result.saved.competitorsSaved,
          // Only a panel that was actually approved; `approveError` means it was not.
          approved: result.panel !== null,
        },
        userId: ws.user.id,
        brandKey: ws.brandKey,
      }).catch(() => {});
    } catch {
      // Telemetry never changes the response.
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
