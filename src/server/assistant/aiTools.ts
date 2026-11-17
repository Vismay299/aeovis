// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/sam/samChatTools.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { SkillSummary, LoadedSkill } from "../../assistant/skills/index.ts";
import type { ToolHandlerContext, ToolRegistration } from "../tools/types.ts";
import { runTool } from "../tools/run.ts";
import { toToolError } from "../tools/errors.ts";
import {
  requestApproval,
  toEnvelope,
  type ApprovalDeps,
  type AssistantToolResult,
} from "./approvals.ts";
import { trackAssistantEvent } from "./telemetry.ts";

export const PAID_TOOL_SENTENCE =
  " Paid: calling this shows the user a price card; it runs only after they approve.";

type ModelSchema = Parameters<typeof tool>[0]["inputSchema"];

/**
 * §6.2.8: the model must never choose a price ceiling. `maxUsd` (and each
 * registration's `modelOmit`) is absent from the schema the model sees while
 * staying on the MCP descriptor and the handler input.
 */
export function modelSchema(reg: ToolRegistration): ModelSchema {
  const schema = reg.def.input as unknown as {
    shape?: Record<string, unknown>;
    omit?: (mask: Record<string, true>) => unknown;
  };
  const shape = schema.shape ?? {};
  const mask: Record<string, true> = {};
  if (Object.prototype.hasOwnProperty.call(shape, "maxUsd")) mask.maxUsd = true;
  for (const key of reg.modelOmit ?? []) {
    if (Object.prototype.hasOwnProperty.call(shape, key)) mask[key] = true;
  }
  if (Object.keys(mask).length === 0 || typeof schema.omit !== "function") {
    return reg.def.input as unknown as ModelSchema;
  }
  return schema.omit(mask) as ModelSchema;
}

export function toolDescription(reg: ToolRegistration): string {
  if (reg.effect !== "paid" || reg.def.description.endsWith(PAID_TOOL_SENTENCE)) {
    return reg.def.description;
  }
  return reg.def.description + PAID_TOOL_SENTENCE;
}

function errorEnvelope(error: unknown): AssistantToolResult {
  const view = toToolError(error);
  return {
    status: "error",
    code: view.code,
    message: view.message,
    recovery: view.recovery,
    retryable: view.retryable,
  };
}

export type BuildAiToolSet = {
  regs: ToolRegistration[];
  ctx: ToolHandlerContext;
  skills: SkillSummary[];
  skillLoad: (name: string) => LoadedSkill | null;
  sessionId: string;
  turnId: string;
  onApproval: () => void;
  turnMemory: NonNullable<ToolHandlerContext["turnMemory"]>;
  approvalDeps?: ApprovalDeps;
};

function skillTool(i: BuildAiToolSet): unknown {
  const names = i.skills.map((skill) => skill.name);
  return tool({
    description:
      "Load a written workflow by name. Call this first when the user's request matches an available skill.",
    inputSchema: z.strictObject({ name: z.enum(names as [string, ...string[]]) }),
    execute: async (input) => {
      const startedAt = Date.now();
      try {
        const loaded = i.skillLoad(input.name);
        if (!loaded) {
          trackAssistantEvent("assistant:tool_call", {
            tool: "activate_skill",
            effect: "read",
            success: false,
            error_code: "skill_not_found",
            duration_ms: Math.max(0, Date.now() - startedAt),
            awaiting_approval: false,
          });
          return {
            status: "error" as const,
            code: "skill_not_found",
            message: "That workflow is not available in this chat.",
            recovery: "Ask the user which workflow they mean.",
            retryable: false,
          };
        }
        trackAssistantEvent("assistant:tool_call", {
          tool: "activate_skill",
          effect: "read",
          success: true,
          error_code: null,
          duration_ms: Math.max(0, Date.now() - startedAt),
          awaiting_approval: false,
        });
        trackAssistantEvent("assistant:skill_activate", {
          skill: loaded.name,
          version: loaded.version,
        });
        const envelope: AssistantToolResult = {
          status: "success",
          summary: "Loaded skill " + loaded.title + " v" + loaded.version + ".",
          data: { name: loaded.name, version: loaded.version, instructions: loaded.body },
          link: null,
          untrusted: [],
          truncated: null,
        };
        return envelope;
      } catch (error) {
        return errorEnvelope(error);
      }
    },
  });
}

/**
 * §6.2.8 AC-09/AC-10. Every tool call is wrapped so an exception becomes an
 * envelope the model can read; a paid call goes through `requestApproval`
 * before its handler is ever reached.
 */
export function buildAiToolSet(i: BuildAiToolSet): ToolSet {
  const ctx: ToolHandlerContext = { ...i.ctx, turnMemory: i.turnMemory };
  const set: Record<string, unknown> = {};

  for (const reg of i.regs) {
    set[reg.def.name] = tool({
      description: toolDescription(reg),
      inputSchema: modelSchema(reg),
      execute: async (rawInput, options) => {
        const startedAt = Date.now();
        let awaiting = false;
        let result: AssistantToolResult;
        try {
          const input =
            rawInput !== null && typeof rawInput === "object" && !Array.isArray(rawInput)
              ? (rawInput as Record<string, unknown>)
              : {};
          const callCtx: ToolHandlerContext = {
            ...ctx,
            ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
          };
          const decision = await reg.approval(callCtx, input);
          if (decision.kind === "none") {
            result = toEnvelope(await runTool(reg, callCtx, input));
          } else {
            result = await requestApproval(
              {
                reg,
                ctx: callCtx,
                input,
                decision,
                sessionId: i.sessionId,
                turnId: i.turnId,
                toolCallId: options?.toolCallId ?? reg.def.name,
              },
              i.approvalDeps,
            );
            if (result.status === "awaiting_approval") {
              awaiting = true;
              i.onApproval();
            }
          }
        } catch (error) {
          result = errorEnvelope(error);
        }
        trackAssistantEvent("assistant:tool_call", {
          tool: reg.def.name,
          effect: reg.effect,
          success: result.status === "success",
          error_code: result.status === "error" ? result.code : null,
          duration_ms: Math.max(0, Date.now() - startedAt),
          awaiting_approval: awaiting,
        });
        return result;
      },
    });
  }

  if (i.skills.length > 0) set.activate_skill = skillTool(i);
  return set as unknown as ToolSet;
}
