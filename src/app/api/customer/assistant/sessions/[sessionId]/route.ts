import { AppError } from "../../../../../../shared/http/appError.ts";
import { readJsonBody, toErrorResponse } from "../../../../../../shared/http/errors.ts";
import {
  assistantBrandQuery,
  assistantSessionPatchRequestSchema,
} from "../../../../../../server/assistant/assistant.contract.ts";
import { loadMessages, toUIMessage } from "../../../../../../server/assistant/messages.ts";
import {
  archiveSession,
  getSession,
  renameSession,
} from "../../../../../../server/assistant/sessions.ts";
import {
  brandKeyFrom,
  json,
  requireAssistantWorkspace,
  sessionParam,
  type AssistantRouteDeps,
} from "../../../../../../server/assistant/routeDeps.ts";
import { trackAssistantEvent } from "../../../../../../server/assistant/telemetry.ts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ sessionId: string }> | { sessionId: string } };

export type AssistantSessionRouteDeps = AssistantRouteDeps & {
  getSession?: typeof getSession;
  archiveSession?: typeof archiveSession;
  renameSession?: typeof renameSession;
  loadMessages?: typeof loadMessages;
};

export async function GET(request: Request, context: Context, deps?: AssistantSessionRouteDeps): Promise<Response> {
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
    const rows = await (deps?.loadMessages ?? loadMessages)(workspace.admin, sessionId);
    const { data, error } = await workspace.admin
      .from("assistant_turns")
      .select("id,started_at")
      .eq("session_id", sessionId)
      .eq("status", "streaming")
      .maybeSingle();
    if (error) throw error;
    const active = data as { id: string; started_at: string } | null;
    return json({
      session: {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        hasKickoff: session.kickoff !== null,
      },
      messages: rows.map(toUIMessage),
      activeTurn: active ? { id: active.id, startedAt: active.started_at } : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, context: Context, deps?: AssistantSessionRouteDeps): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    const parsed = assistantSessionPatchRequestSchema.safeParse(body);
    if (!parsed.success) return toErrorResponse(parsed.error);
    const workspace = await requireAssistantWorkspace(request, parsed.data.brand_key, deps);
    const sessionId = await sessionParam(context);
    const existing = await (deps?.getSession ?? getSession)(workspace.admin, {
      id: sessionId,
      brandKey: workspace.brandKey,
      userId: workspace.user.id,
    });
    if (!existing) {
      throw new AppError(404, "session_not_found", "This chat was archived or does not exist.");
    }

    let title = existing.title;
    if (parsed.data.title !== undefined) {
      const renamed = await (deps?.renameSession ?? renameSession)(workspace.admin, {
        id: sessionId,
        brandKey: workspace.brandKey,
        userId: workspace.user.id,
        title: parsed.data.title,
      });
      if (!renamed) {
        throw new AppError(404, "session_not_found", "This chat was archived or does not exist.");
      }
      title = renamed.title;
    }
    let archived = existing.archivedAt !== null;
    if (parsed.data.archived === true) {
      const didArchive = await (deps?.archiveSession ?? archiveSession)(workspace.admin, {
        id: sessionId,
        brandKey: workspace.brandKey,
        userId: workspace.user.id,
      });
      if (!didArchive) {
        throw new AppError(404, "session_not_found", "This chat was archived or does not exist.");
      }
      archived = true;
      trackAssistantEvent("assistant:session_archive", {});
    }
    return json({ id: sessionId, title, archived });
  } catch (err) {
    return toErrorResponse(err);
  }
}
