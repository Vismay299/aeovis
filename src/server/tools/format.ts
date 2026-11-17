// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/formatters.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { buildAppUrl } from "./links.ts";
import type { ToolOutcome } from "./run.ts";
import type { ToolRegistration } from "./types.ts";

export const MCP_TEXT_CHAR_BUDGET = 40_000;
const TRUNCATION_NOTICE =
  "[Text truncated at 40,000 characters; this is partial text output. The structuredContent payload is unchanged. Narrow the request to see the rest.]";

export function truncatePreview(value: string, max = 300): string {
  if (value.length <= max) return value;
  if (max <= 0) return "";
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

export function toCallToolResult(
  registration: ToolRegistration,
  outcome: ToolOutcome,
  base: { baseUrl: string; brandKey: string },
): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: true;
  _meta?: Record<string, unknown>;
} {
  const meta = {
    url: outcome.ok && outcome.link ? buildAppUrl(base.baseUrl, outcome.link.path) : base.baseUrl,
    workspace: base.brandKey,
  };
  if (!outcome.ok) {
    const error = outcome.error;
    const text = error.message + (error.recovery ? " " + error.recovery : "");
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        status: "error",
        code: error.code,
        message: error.message,
        recovery: error.recovery,
        meta,
      },
      isError: true,
      _meta: meta,
    };
  }

  const linkText = outcome.link ? "\n" + buildAppUrl(base.baseUrl, outcome.link.path) : "";
  const fullText = outcome.summary + linkText + "\n" + JSON.stringify(outcome.output);
  const text =
    fullText.length <= MCP_TEXT_CHAR_BUDGET
      ? fullText
      : fullText.slice(0, MCP_TEXT_CHAR_BUDGET - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      ...(typeof outcome.output === "object" && outcome.output !== null && !Array.isArray(outcome.output)
        ? (outcome.output as Record<string, unknown>)
        : { data: outcome.output }),
      meta,
    },
    _meta: meta,
  };
}
