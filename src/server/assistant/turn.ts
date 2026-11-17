// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/sam/SamChatAgent.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createUIMessageStream, createUIMessageStreamResponse, stepCountIs, streamText } from "ai";
import type { LanguageModel, ModelMessage, StepResult, ToolSet, UIMessage } from "ai";
import { AppError } from "../../shared/http/appError.ts";
import { formatUsd } from "../../shared/pricing.ts";
import { metered } from "../../shared/spend/index.ts";
import type { SpendDeps } from "../../shared/spend/index.ts";
import { openRouterCostUsd, buildModel } from "../llm/openrouter.ts";
import { llmText } from "../llm/index.ts";
import { resolveCost } from "../../shared/llmPricing.js";
import { LOCATION_OPTIONS, workspaceMarket } from "../../shared/keyword-locations.ts";
import { isFeatureEnabled } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";
import { availableTools } from "../tools/registry.ts";
import { loadSkill, listSkills } from "../../assistant/skills/index.ts";
import type { LoadedSkill, SkillSummary } from "../../assistant/skills/index.ts";
import { getProjectContext, renderProjectContextMarkdown } from "../projectContext/service.ts";
import { keepAlive as defaultKeepAlive } from "../keepAlive.js";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import { buildAiToolSet } from "./aiTools.ts";
import type { ApprovalDeps } from "./approvals.ts";
import { assertInputFits, compactSession, shouldCompact } from "./compaction.ts";
import { assistantConfigured, readAssistantConfig } from "./config.ts";
import type { AssistantConfig } from "./config.ts";
import { buildModelInput, expandUserMessage } from "./context.ts";
import { persistSseStream } from "./streamStore.ts";
import { buildKickoff } from "./kickoff.ts";
import "./kickoffKinds.ts";
import { getSession, setTitleIfNew } from "./sessions.ts";
import { consumeKickoff } from "./sessions.ts";
import { insertMessage, fitParts, loadMessages, toUIMessage } from "./messages.ts";
import type { InsertMessage, StoredMessage } from "./messages.ts";
import { rebuildInterruptedTurns } from "./interrupted.ts";
import { assertTurnRate } from "./rateLimit.ts";
import { trackAssistantEvent } from "./telemetry.ts";
import { beginTurn, cancelRequested, finishTurn, heartbeat } from "./turns.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { toToolError } from "../tools/errors.ts";

export const STEP_LIMIT_NOTICE = (n: number) =>
  "I stopped after " + n + " steps. Ask me to continue if you want me to go on.";
export const TURN_CAP_NOTICE = (cap: number) =>
  "I stopped because this reply reached its spending limit of " +
  formatUsd(cap) +
  ". Ask me to continue if you want me to go on.";
export const DEADLINE_NOTICE =
  "I stopped because this reply was taking too long. Ask me to continue, or ask for a narrower piece.";
export const COMPACTED_NOTICE =
  "Earlier messages were summarised so the assistant stays fast. They are still shown here.";
export const GATEWAY_ERROR_TEXT =
  "The assistant could not reach its language model. Try again in a moment.";

/**
 * AC-17: every assistant reply is fitted before insert, so a reply over the
 * 1 MB `assistant_messages.parts` CHECK cannot be silently lost.
 */
export async function storeAssistantReply(
  admin: SupabaseClient,
  message: InsertMessage,
): Promise<StoredMessage> {
  return await insertMessage(admin, { ...message, parts: fitParts(message.parts) });
}

export type TurnMessageMetadata =
  | { kind: "chat"; source: "composer" | "suggestion" | "edit" | "retry" }
  | { kind: "approval"; approvalId: string }
  | { kind: "kickoff" };

export type TurnMessage = {
  id: string;
  role: "user";
  parts: Array<{ type: "text"; text: string }>;
  metadata: TurnMessageMetadata;
};

export type TurnInput = { ws: Workspace; sessionId: string; message: TurnMessage };

export type TurnDeps = {
  admin?: SupabaseClient;
  model?: LanguageModel;
  env?: Record<string, string | undefined>;
  spend?: SpendDeps;
  metered?: typeof metered;
  llmText?: typeof llmText;
  isFeatureEnabled?: (name: FeatureName, brandKey?: string) => Promise<boolean>;
  availableTools?: typeof availableTools;
  listSkills?: typeof listSkills;
  loadSkill?: typeof loadSkill;
  approvalDeps?: ApprovalDeps;
  now?: () => number;
  heartbeatMs?: number;
  cancelPollMs?: number;
  deadlineMs?: number;
  projectContext?: typeof getProjectContext;
  renderProjectContext?: typeof renderProjectContextMarkdown;
  keepAlive?: typeof defaultKeepAlive;
  createStream?: typeof createUIMessageStream;
  createResponse?: typeof createUIMessageStreamResponse;
  streamText?: typeof streamText;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function noticeFor(reason: string, cfg: AssistantConfig): { code: string; text: string } | null {
  if (reason === "step_limit") {
    return { code: "step_limit", text: STEP_LIMIT_NOTICE(cfg.maxSteps) };
  }
  if (reason === "turn_cap") return { code: "turn_cap", text: TURN_CAP_NOTICE(cfg.turnMaxUsd) };
  if (reason === "deadline") return { code: "deadline", text: DEADLINE_NOTICE };
  return null;
}

function safeErrorMessage(error: unknown): string {
  const view = toToolError(error);
  return view.code === "internal_error" ? GATEWAY_ERROR_TEXT : view.message;
}

function errorCodeOf(error: unknown): string {
  const view = toToolError(error);
  return view.code === "internal_error" ? "llm_failed" : view.code;
}

async function deleteMessage(admin: SupabaseClient, sessionId: string, id: string): Promise<void> {
  const { error } = await admin
    .from("assistant_messages")
    .delete()
    .eq("session_id", sessionId)
    .eq("id", id);
  if (error) throw error;
}

async function storedMessageFor(
  i: TurnInput,
  admin: SupabaseClient,
  cfg: AssistantConfig,
): Promise<{
  parts: Array<{ type: "text"; text: string }>;
  metadata: Record<string, unknown>;
  titleText: string | null;
}> {
  const message = i.message;
  if (message.metadata.kind === "approval") {
    const approvalId = message.metadata.approvalId;
    const { data, error } = await admin
      .from("assistant_approvals")
      .select("id,session_id,label,status")
      .eq("id", approvalId)
      .eq("session_id", i.sessionId)
      .maybeSingle();
    if (error) throw error;
    const row = data as { label?: string; status?: string } | null;
    const status = row?.status ?? "";
    if (!row || (status !== "executed" && status !== "failed" && status !== "declined" && status !== "expired")) {
      throw new AppError(409, "approval_pending", "Approve or decline the card first.");
    }
    const label = String(row.label ?? "the action");
    const prefix =
      status === "declined" ? "Declined: " : status === "expired" ? "Expired: " : "Approved: ";
    return {
      parts: [{ type: "text", text: prefix + label }],
      metadata: { kind: "approval", approvalId },
      titleText: null,
    };
  }
  if (message.metadata.kind === "kickoff") {
    const kickoff = await consumeKickoff(admin, i.sessionId);
    if (!kickoff) {
      throw new AppError(409, "no_kickoff", "There is nothing to start in this chat.");
    }
    const built = await buildKickoff({ admin, ws: i.ws, kickoff });
    return {
      parts: [{ type: "text", text: built.label }],
      metadata: { kind: "kickoff", text: built.text.slice(0, 8_000) },
      titleText: null,
    };
  }
  const text = message.parts[0]?.text ?? "";
  return {
    parts: [{ type: "text", text }],
    metadata: { kind: "chat", source: message.metadata.source },
    titleText: text,
  };
}

export async function runAssistantTurn(i: TurnInput, deps: TurnDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const admin = deps.admin ?? i.ws.admin;

  const session = await getSession(admin, {
    id: i.sessionId,
    brandKey: i.ws.brandKey,
    userId: i.ws.user.id,
  });
  if (!session) {
    throw new AppError(404, "session_not_found", "This chat was archived or does not exist.");
  }

  const cfg = readAssistantConfig(env);
  if (!assistantConfigured(env).ok) {
    throw new AppError(
      503,
      "assistant_not_configured",
      "The assistant is not set up on this deployment yet.",
    );
  }

  const flag = deps.isFeatureEnabled ?? isFeatureEnabled;
  await assertTurnRate(admin, { userId: i.ws.user.id, brandKey: i.ws.brandKey }, cfg, {
    now: () => new Date(now()),
  });

  const duplicate = await admin
    .from("assistant_messages")
    .select("id")
    .eq("session_id", i.sessionId)
    .eq("id", i.message.id)
    .maybeSingle();
  if (duplicate.error) throw duplicate.error;
  if (duplicate.data) {
    throw new AppError(409, "duplicate_message", "This message was already sent.");
  }

  const built = await storedMessageFor(i, admin, cfg);
  const turnId = await beginTurn(admin, {
    sessionId: i.sessionId,
    brandKey: i.ws.brandKey,
    userId: i.ws.user.id,
  });
  // AC-15: beginTurn marks a stale streaming turn interrupted; that reply is
  // rebuilt and noticed here, before the new turn's own reply is stored. A
  // rebuild failure must not take the new turn down.
  await rebuildInterruptedTurns(admin, { sessionId: i.sessionId, limit: 1 }).catch(() => 0);

  let userMessageId: string | null = i.message.id;
  try {
    await insertMessage(admin, {
      sessionId: i.sessionId,
      id: i.message.id,
      brandKey: i.ws.brandKey,
      role: "user",
      parts: built.parts,
      metadata: built.metadata,
      turnId,
    });
    if (built.titleText !== null) await setTitleIfNew(admin, i.sessionId, built.titleText);
  } catch (error) {
    userMessageId = null;
    await finishTurn(admin, turnId, {
      status: "error",
      stopReason: "error",
      errorCode: "message_insert_failed",
    }).catch(() => {});
    throw error;
  }

  // Every failure between beginTurn and the first streamText call must finish
  // the turn row and drop the user message. Otherwise the row stays `streaming`
  // with no heartbeat and the user's next send is a 409 `turn_in_progress`
  // until the 90 s staleness cutoff.
  const abandonTurn = async (error: unknown, compactedNow = false): Promise<never> => {
    if (userMessageId) await deleteMessage(admin, i.sessionId, userMessageId).catch(() => {});
    const view = toToolError(error);
    await finishTurn(admin, turnId, {
      status: "error",
      stopReason: "error",
      errorCode: view.code === "internal_error" ? "turn_setup_failed" : view.code,
      compacted: compactedNow,
    }).catch(() => {});
    throw error;
  };

  const regs = await (deps.availableTools ?? availableTools)(
    { brandKey: i.ws.brandKey, role: i.ws.role },
    deps.isFeatureEnabled ? { isFeatureEnabled: deps.isFeatureEnabled as never } : {},
  ).catch(abandonTurn);
  const toolNames = new Set(regs.map((reg) => reg.def.name));
  const skillsEnabled = await flag("assistant_skills", i.ws.brandKey).catch(abandonTurn);
  const skills: SkillSummary[] = (deps.listSkills ?? listSkills)({
    availableTools: toolNames,
    enabled: skillsEnabled,
  });
  const skillLoad = (name: string): LoadedSkill | null =>
    (deps.loadSkill ?? loadSkill)(name, { availableTools: toolNames, enabled: skillsEnabled });

  let memoryMarkdown: string | null = null;
  if (await flag("project_memory", i.ws.brandKey).catch(abandonTurn)) {
    try {
      const context = await (deps.projectContext ?? getProjectContext)(admin, i.ws.brand);
      memoryMarkdown = (deps.renderProjectContext ?? renderProjectContextMarkdown)(context);
    } catch {
      memoryMarkdown = null;
    }
  }
  const marketCodes = workspaceMarket(i.ws.brand);
  const country =
    LOCATION_OPTIONS.find((option) => option.code === marketCodes.locationCode)?.label ?? "United States";
  const market = { country, language: marketCodes.languageCode };
  const today = new Date(now()).toISOString().slice(0, 10);

  let summary = session.summary;
  let compactedThroughSeq = session.compactedThroughSeq ?? 0;
  let compacted = false;
  let uiMessages: UIMessage[] = [];
  let modelInput = { system: "", messages: [] as ModelMessage[], estimatedTokens: 0 };

  const rebuild = async (): Promise<void> => {
    const rows = (await loadMessages(admin, i.sessionId)).filter(
      (row) => row.seq > compactedThroughSeq,
    );
    const last = rows[rows.length - 1];
    if (last && last.role === "user") {
      const expanded = await expandUserMessage(last, { admin });
      const textIndex = last.parts.findIndex(
        (part) =>
          part !== null &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text",
      );
      const parts = last.parts.map((part, index) =>
        index === textIndex ? { ...(part as Record<string, unknown>), text: expanded } : part,
      );
      rows[rows.length - 1] = { ...last, parts };
    }
    uiMessages = rows.map(toUIMessage);
    const system = buildSystemPrompt({
      brand: i.ws.brand,
      today,
      market,
      skills,
      memoryMarkdown,
      summary,
    });
    modelInput = await buildModelInput({ system, uiMessages });
  };

  await rebuild().catch(abandonTurn);
  if (shouldCompact(modelInput.estimatedTokens, cfg)) {
    try {
      const compactResult = await compactSession(
        {
          admin,
          brandKey: i.ws.brandKey,
          sessionId: i.sessionId,
          messages: await loadMessages(admin, i.sessionId),
        },
        { llmText: deps.llmText },
      );
      if (compactResult.throughSeq > 0) {
        summary = compactResult.summary;
        compactedThroughSeq = compactResult.throughSeq;
        compacted = true;
        await rebuild();
      }
    } catch {
      // A refusal or a failed summariser skips compaction and continues uncompacted.
    }
  }
  try {
    assertInputFits(modelInput.estimatedTokens, cfg);
  } catch (error) {
    await abandonTurn(error, compacted);
  }

  const ready = deferred<Response>();
  const stats = {
    steps: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    runningUsd: 0,
    unknownSteps: 0,
    toolCallsRun: 0,
  };
  let approvalWaiting = false;
  let overCap = false;
  let stopReason: string | null = null;
  let turnError: string | null = null;
  let assistantMessageId: string | null = null;

  const streamTurn = async (): Promise<{
    value: null;
    actualUsd: number | null;
    provider: string;
    endpoint: string;
    billed: boolean;
  }> => {
    const completion = deferred<void>();
    const controller = new AbortController();
    let abortCause: "deadline" | "user_stop" | null = null;
    const completion$ = completion;

    const abort = (cause: "deadline" | "user_stop") => {
      if (controller.signal.aborted) return;
      abortCause = cause;
      controller.abort(cause);
    };

    const heartbeatTimer = setInterval(() => {
      void heartbeat(admin, turnId, {
        steps: stats.steps,
        toolCalls: stats.toolCalls,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        costUsd: stats.unknownSteps > 0 || stats.steps === 0 ? null : stats.runningUsd,
        costKnown: stats.steps > 0 && stats.unknownSteps === 0,
        model: cfg.model,
        compacted,
      }).catch(() => {});
    }, deps.heartbeatMs ?? 15_000);
    heartbeatTimer.unref?.();

    const cancelTimer = setInterval(() => {
      void cancelRequested(admin, turnId)
        .then((requested) => {
          if (requested) abort("user_stop");
        })
        .catch(() => {});
    }, deps.cancelPollMs ?? 1_000);
    cancelTimer.unref?.();

    const deadlineTimer = setTimeout(() => abort("deadline"), deps.deadlineMs ?? cfg.deadlineMs);
    deadlineTimer.unref?.();

    const clearTimers = () => {
      clearInterval(heartbeatTimer);
      clearInterval(cancelTimer);
      clearTimeout(deadlineTimer);
    };

    const onStepFinish = (step: StepResult<ToolSet>) => {
      const reported = openRouterCostUsd(step.providerMetadata);
      let cost: number | null = reported;
      if (cost === null) {
        try {
          const resolved = resolveCost({
            model: cfg.model,
            provider: "openrouter",
            usage: {
              prompt_tokens: step.usage?.inputTokens,
              completion_tokens: step.usage?.outputTokens,
            },
            env,
          });
          cost = resolved.cost;
        } catch {
          cost = null;
        }
      }
      if (cost === null) stats.unknownSteps += 1;
      else stats.runningUsd += cost;
      stats.steps += 1;
      stats.toolCallsRun += step.toolCalls.length;
      stats.toolCalls = stats.toolCallsRun;
      stats.inputTokens += step.usage?.inputTokens ?? 0;
      stats.outputTokens += step.usage?.outputTokens ?? 0;
      if (stats.runningUsd >= 0.9 * cfg.turnMaxUsd) overCap = true;
      for (const result of step.toolResults) {
        const output = (result as { output?: unknown }).output;
        if (
          output &&
          typeof output === "object" &&
          (output as { status?: unknown }).status === "awaiting_approval"
        ) {
          approvalWaiting = true;
        }
      }
    };

    const streamTextFn = deps.streamText ?? streamText;
    const createStream = deps.createStream ?? createUIMessageStream;
    const createResponse = deps.createResponse ?? createUIMessageStreamResponse;

    const handleError = (error: unknown): string => {
      const code = errorCodeOf(error);
      if (code !== "llm_failed") turnError = code;
      else turnError = "llm_failed";
      return safeErrorMessage(error);
    };

    const execute = async ({ writer: rawWriter }: { writer: unknown }) => {
      const writer = rawWriter as {
        write: (chunk: unknown) => void;
        merge: (stream: unknown) => void;
      };
      try {
        if (compacted) {
          writer.write({ type: "data-notice", data: { code: "compacted", text: COMPACTED_NOTICE } });
        }
        const result = streamTextFn({
          model: deps.model ?? buildModel(cfg.model, env),
          system: modelInput.system,
          messages: modelInput.messages,
          tools: buildAiToolSet({
            regs,
            ctx: {
              admin,
              brand: i.ws.brand,
              userId: i.ws.user.id,
              user: i.ws.user,
              role: i.ws.role,
              requestId: "turn:" + turnId,
              sessionId: i.sessionId,
              source: "assistant",
            },
            skills,
            skillLoad,
            sessionId: i.sessionId,
            turnId,
            onApproval: () => {
              approvalWaiting = true;
            },
            turnMemory: {},
            approvalDeps: deps.approvalDeps,
          }),
          stopWhen: [
            stepCountIs(cfg.maxSteps),
            () => approvalWaiting,
            () => overCap,
            () => controller.signal.aborted,
          ],
          maxOutputTokens: cfg.maxOutputTokens,
          maxRetries: 0,
          abortSignal: controller.signal,
          onStepFinish,
          onError: (error: unknown) => {
            handleError(error);
          },
        });

        writer.merge(
          result.toUIMessageStream({
            sendFinish: false,
            sendReasoning: false,
            onError: handleError,
            messageMetadata: ({ part }: { part: { type: string } }) =>
              part.type === "finish"
                ? {
                    turnId,
                    costUsd: stats.unknownSteps > 0 || stats.steps === 0 ? null : stats.runningUsd,
                    costKnown: stats.steps > 0 && stats.unknownSteps === 0,
                    model: cfg.model,
                  }
                : { turnId },
          }),
        );
        await result.consumeStream();
      } catch (error) {
        handleError(error);
      } finally {
        if (turnError) stopReason = "error";
        else if (abortCause === "deadline") stopReason = "deadline";
        else if (abortCause === "user_stop") stopReason = "user_stop";
        else if (approvalWaiting) stopReason = "awaiting_approval";
        else if (overCap) stopReason = "turn_cap";
        else if (stats.steps >= cfg.maxSteps) stopReason = "step_limit";
        else stopReason = "finished";

        const notice = noticeFor(stopReason, cfg);
        if (notice) {
          try {
            writer.write({ type: "data-notice", data: notice });
          } catch {
            // The client closed; the turn is still finished and metered below.
          }
        }
        try {
          writer.write({
            type: "finish",
            messageMetadata: {
              turnId,
              costUsd: stats.unknownSteps > 0 || stats.steps === 0 ? null : stats.runningUsd,
              costKnown: stats.steps > 0 && stats.unknownSteps === 0,
              model: cfg.model,
            },
          });
        } catch {
          // Same as above.
        }
        clearTimers();
        completion$.resolve();
      }
    };

    const messageSaved = deferred<void>();
    const stream = createStream({
      originalMessages: uiMessages,
      generateId: () => "a_" + randomUUID().replaceAll("-", ""),
      execute: execute as never,
      onError: handleError,
      onFinish: async ({ responseMessage }: { responseMessage: UIMessage }) => {
        try {
          if (responseMessage && responseMessage.parts.length > 0) {
            assistantMessageId = responseMessage.id;
            await storeAssistantReply(admin, {
              sessionId: i.sessionId,
              id: responseMessage.id,
              brandKey: i.ws.brandKey,
              role: "assistant",
              parts: responseMessage.parts as unknown[],
              metadata: (responseMessage.metadata ?? {}) as Record<string, unknown>,
              turnId,
            });
          }
        } catch {
          // A failed insert must not take the stream down; the turn still settles.
        } finally {
          messageSaved.resolve();
        }
      },
    });
    const response = createResponse({
      stream,
      consumeSseStream: ({ stream: sse }: { stream: ReadableStream<string> }) =>
        persistSseStream(admin, { turnId, brandKey: i.ws.brandKey }, sse).catch(() => {}),
    });
    ready.resolve(response);
    await completion.promise;
    await messageSaved.promise;
    return {
      value: null,
      actualUsd: stats.unknownSteps > 0 || stats.steps === 0 ? null : stats.runningUsd,
      provider: "openrouter",
      endpoint: "chat:" + cfg.model,
      billed: stats.steps > 0,
    };
  };

  const work = (deps.metered ?? metered)(
    {
      brandKey: i.ws.brandKey,
      feature: "assistant.turn",
      estimateUsd: cfg.turnMaxUsd,
      maxUsd: cfg.turnMaxUsd,
      idempotencyKey: "assistant.turn:" + turnId,
      ttlSeconds: 900,
    },
    streamTurn,
    deps.spend,
  );

  const statusFor = (reason: string | null): "completed" | "stopped" | "error" =>
    reason === "user_stop" ? "stopped" : reason === "error" ? "error" : "completed";

  const settleTurn = async () => {
    const reason = stopReason ?? "finished";
    const status = statusFor(reason);
    const costKnown = stats.steps > 0 && stats.unknownSteps === 0;
    await finishTurn(admin, turnId, {
      status,
      stopReason: reason as never,
      steps: stats.steps,
      toolCalls: stats.toolCalls,
      inputTokens: stats.steps > 0 ? stats.inputTokens : null,
      outputTokens: stats.steps > 0 ? stats.outputTokens : null,
      costUsd: costKnown ? stats.runningUsd : null,
      costKnown,
      model: cfg.model,
      compacted,
      assistantMessageId,
      errorCode: turnError,
    });
    trackAssistantEvent("assistant:turn", {
      status,
      stop_reason: reason,
      steps: stats.steps,
      tool_calls: stats.toolCalls,
      cost_usd: costKnown ? Number(stats.runningUsd.toFixed(6)) : null,
      cost_known: costKnown,
      model: cfg.model,
      compacted,
      error_code: turnError,
    });
  };

  work.then(
    async () => {
      try {
        await settleTurn();
      } catch {
        // finishTurn failure is logged by the repository; the response is already out.
      }
    },
    async (error) => {
      if (stopReason === null) stopReason = "error";
      if (turnError === null) turnError = errorCodeOf(error);
      try {
        await settleTurn();
      } catch {
        // As above.
      }
      if (userMessageId) await deleteMessage(admin, i.sessionId, userMessageId).catch(() => {});
      ready.reject(error);
    },
  );

  void (deps.keepAlive ?? defaultKeepAlive)(work, { label: "assistant-turn" });
  return await ready.promise;
}

export type { AssistantConfig };
