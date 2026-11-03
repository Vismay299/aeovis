// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityRuns.ts:190-208
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ZodType } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../http/errors.ts";
import { stableStringify } from "../cache/providerCache.ts";
import { PRICE_TABLE_VERSION } from "./version.ts";
import type { SpendFeature } from "../../shared/spend-features.ts";
import {
  priceQuoteSchema,
  quoteExceeds,
  formatUsd,
  type PriceQuote,
} from "../../shared/pricing.ts";

export type PricingContext = {
  brandKey: string;
  admin: SupabaseClient;
  env: Record<string, string | undefined>;
  now: Date;
};

export type PricedActionEstimateResult = {
  totalUsd: number;
  expectedUsd: number | null;
  units: Array<{ key: string; label: string; count: number }>;
  lines: Array<{ label: string; quantity: number; unitUsd: number; totalUsd: number }>;
  monthly: { interval: "daily" | "weekly" | "monthly"; runsPerMonth: number; totalUsd: number } | null;
  warnings: Array<{ code: string; message: string }>;
  blocked: { code: string; message: string; recovery?: string } | null;
};

export type PricedAction<I> = {
  key: string;
  feature: SpendFeature | (string & {});
  input: ZodType<I>;
  requireApproval: boolean;
  estimate(ctx: PricingContext, input: I): Promise<PricedActionEstimateResult>;
};

const ACTION_KEY_REGEX = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const registry = new Map<string, PricedAction<any>>();

function rootIsClosed(schema: unknown): boolean {
  return (
    typeof schema === "object" &&
    schema !== null &&
    (schema as { additionalProperties?: unknown }).additionalProperties === false
  );
}

export function definePricedAction<I>(a: PricedAction<I>): PricedAction<I> {
  if (!ACTION_KEY_REGEX.test(a.key)) {
    throw new AppError(500, "invalid_action_key", `Invalid priced action key: ${a.key}`);
  }
  if (registry.has(a.key)) {
    throw new AppError(500, "duplicate_price_action", `Duplicate priced action: ${a.key}`);
  }
  let jsonSchema: unknown;
  try {
    jsonSchema = z.toJSONSchema(a.input, { io: "input" });
  } catch {
    throw new AppError(500, "invalid_action_schema", "Priced action input schema is not representable as JSON Schema");
  }
  if (!rootIsClosed(jsonSchema)) {
    throw new AppError(500, "invalid_action_schema", "Priced action input schema must be strict (use z.strictObject)");
  }
  registry.set(a.key, a);
  return a;
}

export function getPricedAction(key: string): PricedAction<unknown> | null {
  return registry.get(key) ?? null;
}

/** Clear all registered priced actions. For unit testing only. */
export function clearPricedActionsForTesting(): void {
  registry.clear();
}

export async function quote<I>(
  key: string,
  ctx: PricingContext,
  rawInput: unknown,
): Promise<PriceQuote> {
  const action = getPricedAction(key);
  if (!action) {
    throw new AppError(404, "unknown_price_action", "This action cannot be priced.");
  }
  const input = action.input.parse(rawInput);
  const partial = (await action.estimate(ctx, input)) as PricedActionEstimateResult;
  const inputsHash = createHash("sha256")
    .update(stableStringify({ action: key, brandKey: ctx.brandKey, input }))
    .digest("hex");
  const fullQuote: PriceQuote = {
    ...partial,
    action: key,
    currency: "USD",
    priceVersion: PRICE_TABLE_VERSION,
    quotedAt: (ctx.now ?? new Date()).toISOString(),
    inputsHash,
  };
  return priceQuoteSchema.parse(fullQuote) as PriceQuote;
}

export async function requireApprovedPrice<I>(
  key: string,
  ctx: PricingContext,
  rawInput: unknown,
  maxUsd: number | undefined,
): Promise<{ quote: PriceQuote; approvedMaxUsd: number; source: "dialog" | "implicit" }> {
  const action = getPricedAction(key);
  if (!action) {
    throw new AppError(404, "unknown_price_action", "This action cannot be priced.");
  }
  // Validate input schema; if invalid, zod throws ZodError (which toErrorResponse converts to 400).
  action.input.parse(rawInput);

  const freshQuote = await quote(key, ctx, rawInput);
  if (freshQuote.blocked !== null) {
    throw new AppError(409, freshQuote.blocked.code, freshQuote.blocked.message, {
      recovery: freshQuote.blocked.recovery,
      details: { quote: freshQuote },
    });
  }

  if (maxUsd === undefined) {
    if (action.requireApproval) {
      throw new AppError(
        400,
        "approval_required",
        "Review and approve the price before running this.",
        { details: { quote: freshQuote } },
      );
    }
    return { quote: freshQuote, approvedMaxUsd: freshQuote.totalUsd, source: "implicit" };
  }

  if (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 1000) {
    throw new AppError(400, "invalid_request", "The approved maximum is invalid.");
  }

  if (quoteExceeds(freshQuote.totalUsd, maxUsd)) {
    throw new AppError(
      409,
      "price_changed",
      `This now costs up to ${formatUsd(freshQuote.totalUsd)}, more than the ${formatUsd(maxUsd)} you approved. Review the new price.`,
      {
        recovery: "Review the new price and approve it to continue.",
        details: { approvedMaxUsd: maxUsd, quote: freshQuote },
      },
    );
  }

  return { quote: freshQuote, approvedMaxUsd: maxUsd, source: "dialog" };
}

export async function recordApproval(
  admin: SupabaseClient,
  a: {
    brandKey: string;
    action: string;
    approvedMaxUsd: number;
    quote: PriceQuote;
    source: "dialog" | "implicit" | "schedule";
    subject?: { kind: string; id: string };
    approvedBy?: string;
  },
): Promise<string> {
  const { data, error } = await admin
    .from("price_approvals")
    .insert({
      brand_key: a.brandKey,
      action: a.action,
      approved_max_usd: a.approvedMaxUsd,
      quoted_usd: a.quote.totalUsd,
      source: a.source,
      quote: a.quote,
      price_version: a.quote.priceVersion,
      subject_kind: a.subject?.kind ?? null,
      subject_id: a.subject?.id ?? null,
      approved_by: a.approvedBy ?? null,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(error.message);
  }
  return data.id;
}
