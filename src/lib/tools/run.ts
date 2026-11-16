// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/sam/samChatTools.ts
//   src/server/mcp/instrumentation.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../http/appError.ts";
import { captureServerError, captureServerEvent, isReportableErrorCode } from "../telemetry/server.ts";
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

/** Test seam: record the F26 calls without a PostHog client. */
export type ToolTelemetry = {
  captureServerEvent?: typeof captureServerEvent;
  captureServerError?: typeof captureServerError;
};

function errorOutcome(error: unknown): ToolOutcome {
  return { ok: false, error: toToolError(error) };
}

/**
 * Zod issue paths only — never values or messages — joined with `;` (F26 §6.2.8).
 * `data.rows.0.score` style, so an output mismatch is diagnosable without the output.
 */
export function zodIssuePaths(error: { issues: Array<{ path: PropertyKey[] }> }): string {
  return error.issues
    .map((issue) => (issue.path.length ? issue.path.map(String).join(".") : "<root>"))
    .join(";");
}

/** Telemetry is fire-and-forget: a throw or a rejection never reaches the tool result. */
function fireAndForget(call: () => void | Promise<void>): void {
  try {
    void Promise.resolve(call()).catch(() => {});
  } catch {
    /* swallowed: capture must never change the returned outcome */
  }
}

export async function runTool(
  registration: ToolRegistration,
  context: ToolHandlerContext,
  rawInput: unknown,
  options?: { maxUsd?: number; timeoutMs?: number; telemetry?: ToolTelemetry },
): Promise<ToolOutcome> {
  const startedAt = Date.now();
  let handlerError: unknown = null;
  let outputInvalid = false;

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
        outputInvalid = true;
        console.error("[tools] output invalid", { tool: registration.def.name });
        fireAndForget(() =>
          reportToolError(new Error("tool output invalid"), {
            tool: registration.def.name,
            error_code: "tool_output_invalid",
            issues: zodIssuePaths(checked.error).slice(0, 300),
          }),
        );
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
      handlerError = error;
      return errorOutcome(error);
    }
  };

  /** `captureServerError` with the tool's own identity, never a message or output. */
  async function reportToolError(
    error: unknown,
    props: { tool: string; error_code: string; issues?: string },
  ): Promise<void> {
    const report = options?.telemetry?.captureServerError ?? captureServerError;
    await report(error, props, context.userId);
  }

  const outcome = registration.waitForProgress
    ? await withProgressWait(execute, registration.waitForProgress)
    : await execute();

  // F26 §6.2.8: every source but `test` is measured. Errors are reported only
  // for reportable codes (409 price_changed and friends are user choices, not faults).
  if (context.source !== "test") {
    const capture = options?.telemetry?.captureServerEvent ?? captureServerEvent;
    fireAndForget(() =>
      capture({
        name: "tool:call",
        props: {
          tool: registration.def.name,
          source: context.source,
          success: outcome.ok,
          error_code: outcome.ok ? null : outcome.error.code,
          duration_ms: Math.max(0, Date.now() - startedAt),
          output_invalid: outputInvalid,
          truncated: outcome.ok && outcome.truncated !== null,
        },
        userId: context.userId,
        brandKey: context.brand.brandKey,
      }),
    );

    if (!outcome.ok && handlerError !== null && isReportableErrorCode(outcome.error.code)) {
      fireAndForget(() =>
        reportToolError(handlerError, {
          tool: registration.def.name,
          error_code: outcome.error.code,
        }),
      );
    }
  }

  return outcome;
}
