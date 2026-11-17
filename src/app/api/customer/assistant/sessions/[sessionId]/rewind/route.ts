import { AppError } from "../../../../../../../shared/http/appError.ts";
import { readJsonBody, toErrorResponse } from "../../../../../../../shared/http/errors.ts";
import {
  brandKeyFrom,
  json,
  requireAssistantWorkspace,
  sessionParam,
  type AssistantRouteDeps,
} from "../../../../../../../server/assistant/routeDeps.ts";
import {
  assistantBrandQuery,
  assistantRewindRequestSchema,
} from "../../../../../../../server/assistant/assistant.contract.ts";
import { loadMessages, toUIMessage } from "../../../../../../../server/assistant/messages.ts";
import { getSession } from "../../../../../../../server/assistant/sessions.ts";
import { requestCancel } from "../../../../../../../server/assistant/turns.ts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ sessionId: string }> | { sessionId: string } };

export type AssistantRewindRouteDeps = AssistantRouteDeps & {
  getSession?: typeof getSession;
  requestCancel?: typeof requestCancel;
  loadMessages?: typeof loadMessages;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const POLL_MS = 250;
const POLL_MAX_MS = 5_000;

function mapRewindError(error: { message?: unknown }): never {
  const message = String(error.message ?? "");
  if (message.includes("session_not_found")) {
    throw new AppError(404, "session_not_found", "This chat was archived or does not exist.");
  }
  if (message.includes("message_not_found")) {
    throw new AppError(404, "message_not_found", "This message does not exist in this chat.");
  }
  throw error;
}

export async function POST(request: Request, context: Context, deps?: AssistantRewindRouteDeps): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    const parsed = assistantRewindRequestSchema.safeParse(body);
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

    await (deps?.requestCancel ?? requestCancel)(workspace.admin, {
      sessionId,
      userId: workspace.user.id,
    });

    const now = deps?.now ?? Date.now;
    const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const startedAt = now();
    let streaming: { id: string } | null = null;
    for (;;) {
      const { data, error } = await workspace.admin
        .from("assistant_turns")
        .select("id")
        .eq("session_id", sessionId)
        .eq("status", "streaming")
        .maybeSingle();
      if (error) throw error;
      streaming = data as { id: string } | null;
      if (!streaming || now() - startedAt >= POLL_MAX_MS) break;
      await sleep(POLL_MS);
    }
    if (streaming) {
      const { error } = await workspace.admin
        .from("assistant_turns")
        .update({
          status: "stopped",
          stop_reason: "rewound",
          finished_at: new Date().toISOString(),
        })
        .eq("id", streaming.id);
      if (error) throw error;
    }

    const rewound = await workspace.admin.rpc("rewind_assistant_session", {
      p_session: sessionId,
      p_user: workspace.user.id,
      p_message_id: parsed.data.messageId,
    });
    if (rewound.error) mapRewindError(rewound.error);
    const rows = await (deps?.loadMessages ?? loadMessages)(workspace.admin, sessionId);
    return json({ removed: Number(rewound.data ?? 0), messages: rows.map(toUIMessage) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
