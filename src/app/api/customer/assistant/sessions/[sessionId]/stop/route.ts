import { AppError } from "../../../../../../../shared/http/appError.ts";
import { readOptionalJsonBody, toErrorResponse } from "../../../../../../../shared/http/errors.ts";
import {
  brandKeyFrom,
  json,
  requireAssistantWorkspace,
  sessionParam,
  type AssistantRouteDeps,
} from "../../../../../../../server/assistant/routeDeps.ts";
import { assistantBrandQuery, assistantStopRequestSchema } from "../../../../../../../server/assistant/assistant.contract.ts";
import { getSession } from "../../../../../../../server/assistant/sessions.ts";
import { requestCancel } from "../../../../../../../server/assistant/turns.ts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ sessionId: string }> | { sessionId: string } };

export type AssistantStopRouteDeps = AssistantRouteDeps & {
  getSession?: typeof getSession;
  requestCancel?: typeof requestCancel;
};

export async function POST(request: Request, context: Context, deps?: AssistantStopRouteDeps): Promise<Response> {
  try {
    const body = await readOptionalJsonBody(request);
    const parsed = assistantStopRequestSchema.safeParse(body);
    if (!parsed.success) return toErrorResponse(parsed.error);
    const workspace = await requireAssistantWorkspace(request, parsed.data.brand_key, deps);
    const sessionId = await sessionParam(context);
    const session = await (deps?.getSession ?? getSession)(workspace.admin, {
      id: sessionId,
      brandKey: workspace.brandKey,
      userId: workspace.user.id,
    });
    if (!session) {
      throw new AppError(404, "session_not_found", "This chat was archived or does not exist.");
    }
    const stopped = await (deps?.requestCancel ?? requestCancel)(workspace.admin, {
      sessionId,
      userId: workspace.user.id,
    });
    return json({ stopped });
  } catch (err) {
    return toErrorResponse(err);
  }
}
