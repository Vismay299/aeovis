import type { SupabaseClient } from "@supabase/supabase-js";
import type { z, ZodType } from "zod";
import type { FeatureName } from "../features/names.ts";
import type { CustomerBrand } from "../workspace/requireWorkspace.ts";

export type ToolHandlerContext = {
  admin: SupabaseClient;
  brand: CustomerBrand;
  userId: string;
  user: { id: string; email: string };
  role: "owner" | "member";
  requestId: string;
  sessionId?: string;
  source: "assistant" | "approval" | "mcp" | "test";
  signal?: AbortSignal;
  /** Per-turn scratch state, populated by the assistant runtime. Never module-global. */
  turnMemory?: TurnMemory;
};

/**
 * URLs the current assistant turn has already mapped, keyed by normalised host.
 * `read_pages` may read those competitor URLs; P4 creates one object per turn.
 */
export type TurnMemory = {
  mappedUrls?: Record<string, readonly string[]>;
};

export type ToolDefinition<I extends ZodType = ZodType, O extends ZodType = ZodType> = {
  name: string;
  title?: string;
  description: string;
  input: I;
  output: O;
  handler: (ctx: ToolHandlerContext, input: z.output<I>) => Promise<z.input<O>>;
};

export type ToolArea =
  | "memory"
  | "questions"
  | "visibility"
  | "keywords"
  | "domain"
  | "rank_tracking"
  | "backlinks"
  | "local"
  | "audit"
  | "indexnow"
  | "analytics"
  | "search_console"
  | "site"
  | "content"
  | "pricing"
  | "reports";
export type ToolEffect = "read" | "write" | "external" | "paid";

export type ApprovalDecision =
  | { kind: "none" }
  | { kind: "confirm"; label: string }
  | { kind: "price"; action: string; quoteInput: unknown; label: string };

export type ToolRegistration = {
  def: ToolDefinition;
  area: ToolArea;
  feature: FeatureName | null;
  ownerOnly?: boolean;
  effect: ToolEffect;
  approval: (ctx: ToolHandlerContext, input: Record<string, unknown>) => ApprovalDecision | Promise<ApprovalDecision>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
    idempotentHint: boolean;
  };
  summarize: (output: unknown, input: Record<string, unknown>) => string;
  link?: (output: unknown, input: Record<string, unknown>) => { path: string; label: string } | null;
  untrustedPaths?: readonly string[];
  waitForProgress?: {
    statusPath: string;
    runningValues: readonly string[];
    progressPath: string;
    budgetMs: number;
  };
  modelOmit?: readonly string[];
  example: { input: Record<string, unknown>; output: unknown };
};

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;

export function defineRegistration<T extends ToolRegistration>(registration: T): T {
  if (!TOOL_NAME_RE.test(registration.def.name)) {
    throw new Error("Invalid tool name");
  }
  if (process.env.NODE_TEST_CONTEXT) {
    registration.def.input.parse(registration.example.input);
    registration.def.output.parse(registration.example.output);
  }
  return registration;
}
