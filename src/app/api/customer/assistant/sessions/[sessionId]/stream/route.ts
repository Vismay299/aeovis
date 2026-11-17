import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { AppError } from "../../../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../../../shared/http/errors.ts";
import { NO_STORE } from "../../../../../../../shared/http/errors.ts";
import {
  brandKeyFrom,
  requireAssistantWorkspace,
  sessionParam,
  type AssistantRouteDeps,
} from "../../../../../../../server/assistant/routeDeps.ts";
import { assistantBrandQuery } from "../../../../../../../server/assistant/assistant.contract.ts";
import { getSession } from "../../../../../../../server/assistant/sessions.ts";
import { replayTurnStream } from "../../../../../../../server/assistant/streamStore.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Context = { params: Promise<{ sessionId: string }> | { sessionId: string } };

export type AssistantStreamRouteDeps = AssistantRouteDeps & {
  getSession?: typeof getSession;
  replayTurnStream?: typeof replayTurnStream;
};

export async function GET(request: Request, context: Context, deps?: AssistantStreamRouteDeps): Promise<Response> {
  try {
    const workspace = await requireAssistantWorkspace(request, brandKeyFrom(request, assistantBrandQuery), deps);
    const sessionId = await sessionParam(context);
    const session = await (deps?.getSession ?? getSession)(workspace.admin, {
      id: sessionId,
      brandKey: workspace.brandKey,
      userId: workspace.user.id,
    });
    if (!session) {
      throw new AppError(404, "session_not_found", "This chat was archived or does not exist.");
    }
    // §6.5.7: no active streaming turn is a 204 even when finished chunks exist.
    const { data, error } = await workspace.admin
      .from("assistant_turns")
      .select("id")
      .eq("session_id", sessionId)
      .eq("status", "streaming")
      .maybeSingle();
    if (error) throw error;
    const active = data as { id: string } | null;
    if (!active) return new Response(null, { status: 204, headers: NO_STORE });
    return new Response((deps?.replayTurnStream ?? replayTurnStream)(workspace.admin, active.id), {
      status: 200,
      headers: UI_MESSAGE_STREAM_HEADERS,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
