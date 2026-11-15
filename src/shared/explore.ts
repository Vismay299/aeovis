// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/types/schemas/ai-search.ts:156-243
//   src/shared/prompt-explorer-labels.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";

export const EXPLORE_MAX_PROMPT_LENGTH = 500;
export const EXPLORE_MAX_HIGHLIGHT_BRAND_LENGTH = 100;

export const EXPLORE_MODELS = ["chatgpt", "gemini", "perplexity"] as const;
export type ExploreModel = (typeof EXPLORE_MODELS)[number];

export const exploreModelSchema = z.enum(EXPLORE_MODELS);

export function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ");
}

const MODEL_LABELS: Record<ExploreModel, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  perplexity: "Perplexity",
};

export function exploreModelLabel(model: ExploreModel): string {
  return MODEL_LABELS[model] ?? model;
}

const COUNTRY_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

export function countryLabel(code: string | null | undefined): string {
  if (!code) return "No country preference";
  try {
    return COUNTRY_NAMES.of(code) ?? code;
  } catch {
    return code;
  }
}

export function supportsWebSearchCountry(model: ExploreModel, country: string | null | undefined): boolean {
  if (!country) return true;
  // Gemini does not support country selection for search
  if (model === "gemini") return false;
  // ChatGPT and Perplexity support ISO 3166-1 alpha-2 codes
  return /^[A-Z]{2}$/.test(country);
}

export const exploreRunInputSchema = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(EXPLORE_MAX_PROMPT_LENGTH),
  models: z.preprocess(
    (val) => (Array.isArray(val) ? Array.from(new Set(val)) : val),
    z.array(exploreModelSchema).min(1).max(3),
  ),
  webSearch: z.boolean().default(true),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .default(null),
  highlightBrand: z.string().trim().min(1).max(EXPLORE_MAX_HIGHLIGHT_BRAND_LENGTH).nullable().default(null),
  fresh: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
});

export type ExploreRunInput = z.infer<typeof exploreRunInputSchema>;

export const exploreCitationSchema = z.object({
  url: z.string(),
  domain: z.string().nullable(),
  title: z.string().nullable(),
  matchedBrand: z.boolean(),
});
export type ExploreCitation = z.infer<typeof exploreCitationSchema>;

export const exploreSuccessResultSchema = z.object({
  status: z.literal("success"),
  model: exploreModelSchema,
  label: z.string(),
  route: z.enum(["dataforseo", "openrouter"]),
  modelName: z.string().nullable(),
  text: z.string(),
  truncated: z.boolean(),
  citations: z.array(exploreCitationSchema),
  fanOutQueries: z.array(z.string()),
  fanOutReported: z.boolean(),
  brandMentioned: z.boolean(),
  workspaceBrandMentioned: z.boolean(),
  outputTokens: z.number().int().nonnegative().nullable(),
  webSearch: z.boolean(),
  countryHint: z.string().nullable(),
  costUsd: z.number().nonnegative(),
  costState: z.enum(["measured", "estimated", "zero", "unknown"]),
  reusedFrom: z
    .object({
      observationId: z.string(),
      runId: z.string(),
      observedAt: z.string(),
    })
    .nullable(),
  observationId: z.string(),
  observedAt: z.string().nullable(),
});
export type ExploreSuccessResult = z.infer<typeof exploreSuccessResultSchema>;

export const exploreErrorResultSchema = z.object({
  status: z.literal("error"),
  model: exploreModelSchema,
  label: z.string(),
  errorCode: z.enum(["UPSTREAM_ERROR", "UNSUPPORTED_COUNTRY", "NOT_AVAILABLE", "COLLECTION_PAUSED"]),
  message: z.string(),
  costUsd: z.number().nonnegative(),
});
export type ExploreErrorResult = z.infer<typeof exploreErrorResultSchema>;

export const exploreModelResultSchema = z.discriminatedUnion("status", [
  exploreSuccessResultSchema,
  exploreErrorResultSchema,
]);
export type ExploreModelResult = z.infer<typeof exploreModelResultSchema>;
