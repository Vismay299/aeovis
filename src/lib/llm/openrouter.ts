// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/openrouter.ts, src/server/lib/chatAgent.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { isFreeModelId, lookupModelPrice } from "../llmPricing.js";

export type LlmEnv = Record<string, string | undefined>;

// The provider package re-exports only the model type; options ride through
// `createOpenRouter` + the per-model call, mirroring upstream's
// `usage: { include: true }` accounting shape.
export function buildModel(modelId: string, env: LlmEnv = process.env): LanguageModel {
  const apiKey = (env.LLM_API_KEY ?? "").trim();
  const baseURL = (env.LLM_BASE_URL ?? "").trim() || undefined;
  if (!apiKey) {
    throw new Error("LLM_API_KEY is not configured.");
  }
  const provider = createOpenRouter({ apiKey, baseURL });
  return provider(modelId, { usage: { include: true } }) as unknown as LanguageModel;
}

const openRouterUsageSchema = z.object({
  openrouter: z.object({ usage: z.object({ cost: z.number() }) }),
});

// Unknown is not zero (conventions §6.10): an absent cost settles at the
// estimate instead of fabricating a free call.
export function openRouterCostUsd(providerMetadata: unknown): number | null {
  const parsed = openRouterUsageSchema.safeParse(providerMetadata);
  if (!parsed.success) return null;
  return parsed.data.openrouter.usage.cost;
}

export function estimateLlmUsd(
  modelId: string,
  promptChars: number,
  maxOutputTokens: number,
  env: LlmEnv = process.env
): number {
  // Spec §6.2: table rates x (ceil(promptChars/3) input tokens + maxOutputTokens
  // output tokens), falling back to LLM_HELPER_UNPRICED_ESTIMATE_USD only for an
  // id the table has no rate for (priceable because the gateway reports cost).
  // A flat fallback for every id would under-reserve a long call on an expensive
  // model, and the cap check at reserve time is only as good as this number.
  if (isFreeModelId(modelId)) return 0;
  const price = lookupModelPrice(modelId, env as unknown as NodeJS.ProcessEnv);
  if (price) {
    const inputTokens = Math.ceil(Math.max(promptChars, 0) / 3);
    const outputTokens = Math.max(maxOutputTokens, 0);
    return (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;
  }
  const fallback = Number(env.LLM_HELPER_UNPRICED_ESTIMATE_USD ?? 0.05);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0.05;
}
