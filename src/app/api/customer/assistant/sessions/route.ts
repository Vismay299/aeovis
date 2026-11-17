import { toErrorResponse } from "../../../../../shared/http/errors.ts";
import { readJsonBody } from "../../../../../shared/http/errors.ts";
import {
  assistantBrandQuery,
  assistantSessionCreateRequestSchema,
} from "../../../../../server/assistant/assistant.contract.ts";
import { createSession, listSessions } from "../../../../../server/assistant/sessions.ts";
import {
  brandKeyFrom,
  json,
  requireAssistantWorkspace,
  type AssistantRouteDeps,
} from "../../../../../server/assistant/routeDeps.ts";
import { trackAssistantEvent } from "../../../../../server/assistant/telemetry.ts";

export const dynamic = "force-dynamic";

export type AssistantSessionsRouteDeps = AssistantRouteDeps & {
  createSession?: typeof createSession;
  listSessions?: typeof listSessions;
};

export async function GET(request: Request, _ctx?: unknown, deps?: AssistantSessionsRouteDeps): Promise<Response> {
  try {
    const workspace = await requireAssistantWorkspace(request, brandKeyFrom(request, assistantBrandQuery), deps);
    const sessions = await (deps?.listSessions ?? listSessions)(workspace.admin, {
      brandKey: workspace.brandKey,
      userId: workspace.user.id,
      limit: 50,
    });
    return json({
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, _ctx?: unknown, deps?: AssistantSessionsRouteDeps): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    const parsed = assistantSessionCreateRequestSchema.safeParse(body);
    if (!parsed.success) {
      return toErrorResponse(parsed.error);
    }
    const workspace = await requireAssistantWorkspace(request, parsed.data.brand_key, deps);
    const session = await (deps?.createSession ?? createSession)(workspace.admin, {
      brandKey: workspace.brandKey,
      userId: workspace.user.id,
    });
    trackAssistantEvent("assistant:session_create", {});
    return json({ id: session.id, title: session.title }, 201);
  } catch (err) {
    return toErrorResponse(err);
  }
}
