import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../shared/http/appError.ts";
import { formatUsd, priceQuoteSchema } from "../../shared/pricing.ts";
import type { PriceQuote } from "../../shared/pricing.ts";
import {
  quote as defaultQuote,
  recordApproval as defaultRecordApproval,
  requireApprovedPrice as defaultRequireApprovedPrice,
} from "../../shared/pricing/pricedActions.ts";
import { stableStringify } from "../cache/providerCache.ts";
import type { FeatureFlagDeps } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";
import { availableTools as defaultAvailableTools } from "../tools/registry.ts";
import { getTool } from "../tools/registry.ts";
import { runTool as defaultRunTool } from "../tools/run.ts";
import type { ToolOutcome } from "../tools/run.ts";
import { capToolOutput } from "../tools/capOutput.ts";
import type { ApprovalDecision, ToolHandlerContext, ToolRegistration } from "../tools/types.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import { readAssistantConfig } from "./config.ts";
import { trackAssistantEvent } from "./telemetry.ts";

export type AssistantToolResult =
  | {
      status: "success";
      summary: string;
      data: unknown;
      link: { path: string; label: string } | null;
      untrusted: string[];
      truncated: string | null;
    }
  | {
      status: "awaiting_approval";
      approvalId: string;
      kind: "price" | "confirm";
      label: string;
      quote: PriceQuote | null;
      expiresAt: string;
      summary: string;
    }
  | {
      status: "error";
      code: string;
      message: string;
      recovery: string | null;
      retryable: boolean;
      quote?: PriceQuote;
    };

export type ApprovalView = {
  id: string;
  toolName: string;
  label: string;
  kind: "price" | "confirm";
  status: string;
  quote: PriceQuote | null;
  approvedMaxUsd: number | null;
  expiresAt: string;
  decidedAt: string | null;
  result: AssistantToolResult | null;
  errorCode: string | null;
};

type ApprovalRow = {
  id: string;
  session_id: string;
  turn_id: string | null;
  brand_key: string;
  user_id: string;
  tool_name: string;
  tool_call_id: string;
  kind: "price" | "confirm";
  priced_action: string | null;
  input: Record<string, unknown>;
  input_sha256: string;
  quote_input: unknown;
  quote: unknown;
  quoted_usd: number | string | null;
  approved_max_usd: number | string | null;
  label: string;
  status: string;
  result: unknown;
  error_code: string | null;
  decided_at: string | null;
  finished_at: string | null;
  expires_at: string;
  created_at: string;
};

export type ApprovalDeps = {
  quote?: typeof defaultQuote;
  requireApprovedPrice?: typeof defaultRequireApprovedPrice;
  recordApproval?: typeof defaultRecordApproval;
  runTool?: typeof defaultRunTool;
  availableTools?: typeof defaultAvailableTools;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  isFeatureEnabled?: (
    name: FeatureName,
    brandKey?: string,
    deps?: FeatureFlagDeps,
  ) => Promise<boolean>;
};

function numberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function quoteOrNull(value: unknown): PriceQuote | null {
  const parsed = priceQuoteSchema.safeParse(value);
  return parsed.success ? (parsed.data as PriceQuote) : null;
}

export function approvalViewFromRow(row: ApprovalRow): ApprovalView {
  return {
    id: row.id,
    toolName: row.tool_name,
    label: row.label,
    kind: row.kind,
    status: row.status,
    quote: quoteOrNull(row.quote),
    approvedMaxUsd: numberOrNull(row.approved_max_usd),
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    result: (row.result as AssistantToolResult | null) ?? null,
    errorCode: row.error_code,
  };
}

export function approvalSummary(label: string, quote: PriceQuote | null): string {
  return (
    "Waiting for the user to approve " +
    label +
    (quote ? " (up to " + formatUsd(quote.totalUsd) + ")" : "") +
    ". Do not call this tool again for it. The reply pauses here; you will get a message with the outcome."
  );
}

export function toEnvelope(outcome: ToolOutcome): AssistantToolResult {
  if (outcome.ok) {
    return {
      status: "success",
      summary: outcome.summary,
      data: outcome.output,
      link: outcome.link,
      untrusted: outcome.untrusted,
      truncated: outcome.truncated,
    };
  }
  const quote = outcome.error.details?.quote;
  const parsed = priceQuoteSchema.safeParse(quote);
  return {
    status: "error",
    code: outcome.error.code,
    message: outcome.error.message,
    recovery: outcome.error.recovery,
    retryable: outcome.error.retryable,
    ...(parsed.success ? { quote: parsed.data as PriceQuote } : {}),
  };
}

function awaitingEnvelope(row: ApprovalRow): AssistantToolResult {
  const quote = quoteOrNull(row.quote);
  return {
    status: "awaiting_approval",
    approvalId: row.id,
    kind: row.kind,
    label: row.label,
    quote,
    expiresAt: row.expires_at,
    summary: approvalSummary(row.label, quote),
  };
}

function isDuplicate(error: { code?: unknown; message?: unknown } | null): boolean {
  if (!error) return false;
  return error.code === "23505" || /duplicate key|unique constraint/i.test(String(error.message ?? ""));
}

export type RequestApprovalInput = {
  reg: ToolRegistration;
  ctx: ToolHandlerContext;
  input: Record<string, unknown>;
  decision: Exclude<ApprovalDecision, { kind: "none" }>;
  sessionId: string;
  turnId: string;
  toolCallId: string;
};

/**
 * §6.2.4. A paid or external call never runs here unless its quote is exactly
 * zero; otherwise the row is the approval, and the reply pauses.
 */
export async function requestApproval(
  i: RequestApprovalInput,
  deps: ApprovalDeps = {},
): Promise<AssistantToolResult> {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const runToolFn = deps.runTool ?? defaultRunTool;
  const priceQuote = deps.quote ?? defaultQuote;
  const ctx = { ...i.ctx, admin: i.ctx.admin };

  let quote: PriceQuote | null = null;
  if (i.decision.kind === "price") {
    quote = await priceQuote(
      i.decision.action,
      { brandKey: ctx.brand.brandKey, admin: ctx.admin, env, now: now() },
      i.decision.quoteInput,
    );
    if (quote.blocked) {
      return {
        status: "error",
        code: quote.blocked.code,
        message: quote.blocked.message,
        recovery: quote.blocked.recovery ?? null,
        retryable: false,
        quote,
      };
    }
    if (quote.totalUsd === 0) {
      const outcome = await runToolFn(i.reg, ctx, i.input, { maxUsd: 0.01 });
      return toEnvelope(outcome);
    }
  }

  const quoteInput = i.decision.kind === "price" ? i.decision.quoteInput : null;
  const pricedAction = i.decision.kind === "price" ? i.decision.action : null;
  const ttl = readAssistantConfig(env).approvalTtlSeconds;
  const row = {
    session_id: i.sessionId,
    turn_id: i.turnId,
    brand_key: ctx.brand.brandKey,
    user_id: ctx.userId,
    tool_name: i.reg.def.name,
    tool_call_id: i.toolCallId,
    kind: i.decision.kind,
    priced_action: pricedAction,
    input: i.input,
    input_sha256: createHash("sha256").update(stableStringify(i.input)).digest("hex"),
    quote_input: quoteInput,
    quote,
    quoted_usd: quote ? quote.totalUsd : null,
    label: i.decision.label.slice(0, 200),
    expires_at: new Date(now().getTime() + ttl * 1_000).toISOString(),
  };

  const inserted = await ctx.admin.from("assistant_approvals").insert(row).select("*").single();
  if (inserted.error) {
    if (isDuplicate(inserted.error)) {
      const existing = await ctx.admin
        .from("assistant_approvals")
        .select("*")
        .eq("session_id", i.sessionId)
        .eq("tool_call_id", i.toolCallId)
        .maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data) return awaitingEnvelope(existing.data as ApprovalRow);
    }
    throw inserted.error;
  }
  const saved = inserted.data as ApprovalRow;
  trackAssistantEvent("assistant:approval", {
    tool: i.reg.def.name,
    kind: i.decision.kind,
    decision: "requested",
    quoted_usd: quote ? quote.totalUsd : 0,
    approved_max_usd: null,
    outcome: "pending",
    error_code: null,
  });
  return awaitingEnvelope(saved);
}

export async function getApprovalView(
  admin: SupabaseClient,
  i: { approvalId: string; brandKey: string; userId: string },
): Promise<ApprovalView> {
  const { data, error } = await admin
    .from("assistant_approvals")
    .select("*")
    .eq("id", i.approvalId)
    .eq("brand_key", i.brandKey)
    .eq("user_id", i.userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new AppError(404, "approval_not_found", "This approval does not exist.");
  return approvalViewFromRow(data as ApprovalRow);
}

function mapClaimError(error: { message?: unknown }): never {
  const message = String(error.message ?? "");
  if (message.includes("approval_not_found")) {
    throw new AppError(404, "approval_not_found", "This approval does not exist.");
  }
  if (message.includes("approval_expired")) {
    throw new AppError(
      410,
      "approval_expired",
      "This approval expired. Ask the assistant again for a fresh price.",
    );
  }
  if (message.includes("approval_not_pending")) {
    throw new AppError(409, "approval_not_pending", "This approval was already decided.");
  }
  throw error;
}

export type DecideApprovalInput = {
  ws: Workspace;
  approvalId: string;
  decision: "approve" | "decline";
  maxUsd?: number;
};

/** §6.2.4 decideApproval: scoped read, re-quote, atomic claim, run once. */
export async function decideApproval(
  i: DecideApprovalInput,
  deps: ApprovalDeps = {},
): Promise<ApprovalView> {
  const admin = i.ws.admin;
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const runToolFn = deps.runTool ?? defaultRunTool;

  const loaded = await admin
    .from("assistant_approvals")
    .select("*")
    .eq("id", i.approvalId)
    .eq("brand_key", i.ws.brandKey)
    .eq("user_id", i.ws.user.id)
    .maybeSingle();
  if (loaded.error) throw loaded.error;
  if (!loaded.data) throw new AppError(404, "approval_not_found", "This approval does not exist.");
  const row = loaded.data as ApprovalRow;

  if (i.decision === "decline") {
    const at = now().toISOString();
    const declined = await admin
      .from("assistant_approvals")
      .update({ status: "declined", decided_at: at, finished_at: at })
      .eq("id", row.id)
      .eq("status", "pending")
      .gt("expires_at", at)
      .select("*");
    if (declined.error) throw declined.error;
    if (!Array.isArray(declined.data) || declined.data.length === 0) {
      const expired = row.status === "expired" || (row.status === "pending" && row.expires_at <= at);
      if (expired) {
        if (row.status === "pending") {
          await admin.from("assistant_approvals").update({ status: "expired" }).eq("id", row.id);
        }
        throw new AppError(
          410,
          "approval_expired",
          "This approval expired. Ask the assistant again for a fresh price.",
        );
      }
      throw new AppError(409, "approval_not_pending", "This approval was already decided.");
    }
    trackAssistantEvent("assistant:approval", {
      tool: row.tool_name,
      kind: row.kind,
      decision: "decline",
      quoted_usd: quoteOrNull(row.quote)?.totalUsd ?? 0,
      approved_max_usd: null,
      outcome: "declined",
      error_code: null,
    });
    return approvalViewFromRow({ ...row, status: "declined", decided_at: at, finished_at: at });
  }

  const reg = getTool(row.tool_name);
  if (!reg) {
    throw new AppError(409, "tool_unavailable", "This action is no longer available for your workspace.");
  }
  const tools = await (deps.availableTools ?? defaultAvailableTools)(
    { brandKey: i.ws.brandKey, role: i.ws.role },
    deps.isFeatureEnabled ? { isFeatureEnabled: deps.isFeatureEnabled } : {},
  );
  if (!tools.some((candidate) => candidate.def.name === row.tool_name)) {
    throw new AppError(409, "tool_unavailable", "This action is no longer available for your workspace.");
  }

  const hash = createHash("sha256").update(stableStringify(row.input)).digest("hex");
  if (hash !== row.input_sha256) {
    throw new AppError(500, "approval_corrupt", "This approval cannot be run. Ask the assistant again.");
  }

  let approvedMaxUsd: number | null = null;
  let freshQuote: PriceQuote | null = quoteOrNull(row.quote);
  if (row.kind === "price") {
    if (i.maxUsd === undefined) {
      throw new AppError(400, "approval_required", "Review and approve the price before running this.");
    }
    if (!row.priced_action) {
      throw new AppError(500, "approval_corrupt", "This approval cannot be run. Ask the assistant again.");
    }
    try {
      const approved = await (deps.requireApprovedPrice ?? defaultRequireApprovedPrice)(
        row.priced_action,
        { brandKey: i.ws.brandKey, admin, env, now: now() },
        row.quote_input,
        i.maxUsd,
      );
      approvedMaxUsd = approved.approvedMaxUsd;
      freshQuote = approved.quote;
    } catch (err) {
      if (err instanceof AppError && err.code === "price_changed") {
        const changed = priceQuoteSchema.safeParse(err.details?.quote);
        if (changed.success) {
          const fresh = changed.data as PriceQuote;
          await admin
            .from("assistant_approvals")
            .update({ quote: fresh, quoted_usd: fresh.totalUsd })
            .eq("id", row.id);
        }
      }
      throw err;
    }
  }

  const claimed = await admin.rpc("claim_assistant_approval", {
    p_id: row.id,
    p_user: i.ws.user.id,
    p_brand: i.ws.brandKey,
    p_max: approvedMaxUsd,
  });
  if (claimed.error) mapClaimError(claimed.error);
  const claimedRow = (claimed.data as ApprovalRow | null) ?? { ...row, status: "running" };

  if (row.kind === "price" && freshQuote && row.priced_action && approvedMaxUsd !== null) {
    try {
      await (deps.recordApproval ?? defaultRecordApproval)(admin, {
        brandKey: i.ws.brandKey,
        action: row.priced_action,
        approvedMaxUsd,
        quote: freshQuote,
        source: "dialog",
        subject: { kind: "assistant_approval", id: row.id },
        approvedBy: i.ws.user.id,
      });
    } catch {
      console.error("[pricing] approval record failed", { approvalId: row.id });
    }
  }

  const ctx: ToolHandlerContext = {
    admin,
    brand: i.ws.brand,
    userId: i.ws.user.id,
    user: i.ws.user,
    role: i.ws.role,
    requestId: "approval:" + row.id,
    sessionId: row.session_id,
    source: "approval",
  };
  const outcome = await runToolFn(reg, ctx, row.input, {
    maxUsd: approvedMaxUsd ?? undefined,
    timeoutMs: 120_000,
  });
  const envelope = capToolOutput(toEnvelope(outcome), 100_000) as AssistantToolResult;
  const status = outcome.ok ? "executed" : "failed";
  const errorCode = outcome.ok ? null : outcome.error.code;
  const finishedAt = now().toISOString();
  const stored = await admin
    .from("assistant_approvals")
    .update({ status, result: envelope, error_code: errorCode, finished_at: finishedAt })
    .eq("id", row.id)
    .select("*")
    .single();
  if (stored.error) throw stored.error;
  trackAssistantEvent("assistant:approval", {
    tool: row.tool_name,
    kind: row.kind,
    decision: "approve",
    quoted_usd: freshQuote?.totalUsd ?? 0,
    approved_max_usd: approvedMaxUsd,
    outcome: status,
    error_code: errorCode,
  });
  return approvalViewFromRow({
    ...(stored.data as ApprovalRow),
    ...claimedRow,
    status,
    result: envelope,
    error_code: errorCode,
    finished_at: finishedAt,
  });
}
