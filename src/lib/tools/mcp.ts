// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/output-schemas.ts
//   src/server/mcp/server.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { AppError } from "../http/appError.ts";
import { toToolError } from "./errors.ts";
import { toCallToolResult } from "./format.ts";
import { runTool, type ToolOutcome } from "./run.ts";
import { TOOL_REGISTRY } from "./registry.ts";
import type { ToolHandlerContext, ToolRegistration } from "./types.ts";

export function toMcpToolDescriptors(
  registrations: readonly ToolRegistration[] = TOOL_REGISTRY,
): Array<{
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  outputSchema: object;
  annotations: ToolRegistration["annotations"];
}> {
  return registrations.map((registration) => ({
    name: registration.def.name,
    title: registration.def.title ?? registration.def.name,
    description: registration.def.description,
    inputSchema: z.toJSONSchema(registration.def.input, { io: "input" }) as object,
    outputSchema: z.toJSONSchema(registration.def.output, { io: "output" }) as object,
    annotations: registration.annotations,
  }));
}

export async function callToolForMcp(
  registration: ToolRegistration,
  context: ToolHandlerContext,
  rawInput: unknown,
  base: { baseUrl: string },
): Promise<ReturnType<typeof toCallToolResult>> {
  if (registration.effect === "paid") {
    const maxUsd =
      typeof rawInput === "object" && rawInput !== null
        ? (rawInput as Record<string, unknown>).maxUsd
        : undefined;

    if (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || maxUsd <= 0) {
      const outcome: ToolOutcome = {
        ok: false,
        error: toToolError(
          new AppError(400, "approval_required", "Pass the approved maxUsd before running this tool."),
        ),
      };

      return toCallToolResult(registration, outcome, {
        ...base,
        brandKey: context.brand.brandKey,
      });
    }
  }

  const outcome = await runTool(registration, context, rawInput);

  return toCallToolResult(registration, outcome, {
    ...base,
    brandKey: context.brand.brandKey,
  });
}
