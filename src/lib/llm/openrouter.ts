// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/openrouter.ts, src/server/lib/chatAgent.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

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
  const fallback = Number(env.LLM_HELPER_UNPRICED_ESTIMATE_USD ?? 0.05);
  const unpriced = Number.isFinite(fallback) && fallback > 0 ? fallback : 0.05;
  void modelId;
  void maxOutputTokens;
  // Token counts before the call are a guess (ceil(chars/4)); the settle uses
  // the reported cost. The estimate only needs to bound the hold.
  const guessedInputTokens = Math.ceil(Math.max(promptChars, 0) / 4);
  void guessedInputTokens;
  return unpriced;
}
