import { z } from "zod";
import { AppError } from "../../../../../../../shared/http/appError.ts";
import { readJsonBody, toErrorResponse } from "../../../../../../../shared/http/errors.ts";
import {
  brandKeyFrom,
  requireAssistantWorkspace,
  sessionParam,
  type AssistantRouteDeps,
} from "../../../../../../../server/assistant/routeDeps.ts";
import { assistantBrandQuery } from "../../../../../../../server/assistant/assistant.contract.ts";
import { runAssistantTurn } from "../../../../../../../server/assistant/turn.ts";
import type { TurnDeps } from "../../../../../../../server/assistant/turn.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> | { sessionId: string } };

export type AssistantChatRouteDeps = AssistantRouteDeps & {
  runAssistantTurn?: typeof runAssistantTurn;
  turnDeps?: TurnDeps;
};

export const assistantChatBodySchema = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  message: z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    role: z.literal("user"),
    parts: z
      .array(z.strictObject({ type: z.literal("text"), text: z.string().max(8000) }))
      .length(1),
    metadata: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("chat"),
        source: z.enum(["composer", "suggestion", "edit", "retry"]),
      }),
      z.strictObject({ kind: z.literal("approval"), approvalId: z.uuid() }),
      z.strictObject({ kind: z.literal("kickoff") }),
    ]),
  }),
});

export async function POST(request: Request, context: Context, deps?: AssistantChatRouteDeps): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    const parsed = assistantChatBodySchema.safeParse(body);
    if (!parsed.success) return toErrorResponse(parsed.error);
    const input = parsed.data;
    if (input.message.metadata.kind === "chat" && input.message.parts[0].text.trim().length < 1) {
      throw new AppError(400, "invalid_request", "Type a message before sending.");
    }
    const workspace = await requireAssistantWorkspace(request, input.brand_key, deps);
    const sessionId = await sessionParam(context);
    const turn = await (deps?.runAssistantTurn ?? runAssistantTurn)(
      { ws: workspace, sessionId, message: input.message },
      deps?.turnDeps,
    );
    return turn;
  } catch (err) {
    return toErrorResponse(err);
  }
}
