// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/sam/samChatTools.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../http/appError.ts";
import { capToolOutput } from "./capOutput.ts";
import { toToolError, type ToolErrorView } from "./errors.ts";
import { markUntrusted } from "./untrusted.ts";
import { withProgressWait } from "./waiting.ts";
import type { ToolHandlerContext, ToolRegistration } from "./types.ts";

export type ToolOutcome =
  | {
      ok: true;
      output: unknown;
      summary: string;
      link: { path: string; label: string } | null;
      untrusted: string[];
      truncated: string | null;
    }
  | { ok: false; error: ToolErrorView };

function errorOutcome(error: unknown): ToolOutcome {
  return { ok: false, error: toToolError(error) };
}

export async function runTool(
  registration: ToolRegistration,
  context: ToolHandlerContext,
  rawInput: unknown,
  options?: { maxUsd?: number; timeoutMs?: number },
): Promise<ToolOutcome> {
  const execute = async (): Promise<ToolOutcome> => {
    const injected =
      rawInput !== null && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? {
            ...(rawInput as Record<string, unknown>),
            ...(options?.maxUsd !== undefined ? { maxUsd: options.maxUsd } : {}),
          }
        : rawInput;
    const parsed = registration.def.input.safeParse(injected);
    if (!parsed.success) return errorOutcome(parsed.error);

    const timeout = AbortSignal.timeout(options?.timeoutMs ?? 60_000);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    try {
      const output = await Promise.race([
        registration.def.handler({ ...context, signal }, parsed.data as never),
        new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
      const checked = registration.def.output.safeParse(output);
      if (!checked.success) {
        console.error("[tools] output invalid", { tool: registration.def.name });
        return errorOutcome(
          new AppError(500, "tool_output_invalid", "The tool returned data in an unexpected shape."),
        );
      }

      const marked = markUntrusted(checked.data, registration.untrustedPaths);
      const capped = capToolOutput(marked.output, 32_000);
      const input = parsed.data as Record<string, unknown>;
      const summary = registration.summarize(capped, input).slice(0, 300);
      const link = registration.link?.(capped, input) ?? null;
      const truncated =
        typeof capped === "object" &&
        capped !== null &&
        !Array.isArray(capped) &&
        typeof (capped as { truncated?: unknown }).truncated === "string"
          ? String((capped as { truncated: string }).truncated)
          : null;
      return { ok: true, output: capped, summary, link, untrusted: marked.untrusted, truncated };
    } catch (error) {
      return errorOutcome(error);
    }
  };

  if (registration.waitForProgress) {
    return withProgressWait(execute, registration.waitForProgress);
  }
  return execute();
}
