// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/types/schemas/projectWebsite.ts:1-58, src/types/schemas/aiPromptSuggestions.ts:1-34
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";

export const MAX_SUGGESTED_KEYWORDS = 15;

export const researchKeywordSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^\S+(?:\s+\S+){0,4}$/, "Keywords must contain five words or fewer.");

export const suggestedTopicSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^\S+(?:\s+\S+){0,4}$/, "Topic names must contain five words or fewer."),
  questions: z.array(z.string().trim().min(2).max(1500)).length(5),
});

export function draftOutputSchema(missing: { overview: boolean; competitors: boolean }) {
  const shape: Record<string, z.ZodTypeAny> = {
    topics: z.array(suggestedTopicSchema).length(5),
    suggestedKeywords: z.array(z.string().trim()).max(MAX_SUGGESTED_KEYWORDS),
    persona: z.string().trim().min(1).max(200),
  };

  if (missing.overview) {
    shape.overview = z.string().trim().min(1).max(3500);
  }

  if (missing.competitors) {
    shape.searchQueries = z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .max(2);
  }

  return z.strictObject(shape);
}

export const pickOutputSchema = z.strictObject({
  domains: z.array(z.string().trim().min(1).max(255)).max(5),
});

export const verifyOutputSchema = z.strictObject({
  competitors: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(120),
        domain: z.string().trim().min(1).max(255),
        notes: z.string().trim().min(1).max(500),
        sourceUrl: z.string().trim().min(1),
      }),
    )
    .max(5),
});

export const setupCandidateSchema = z.strictObject({
  id: z.string().regex(/^c\d{1,3}$/),
  text: z.string().min(2).max(1500),
  topic: z.string().min(1).max(120),
  origin: z.enum(["ai_setup", "promptgen"]),
  branded: z.boolean(),
  eliciting: z.boolean(),
  selected: z.boolean(),
  existing: z
    .strictObject({
      questionId: z.string(),
      status: z.enum(["active", "paused", "archived"]),
    })
    .nullable(),
});

export const setupReviewSchema = z.strictObject({
  version: z.literal(1),
  overview: z.strictObject({
    text: z.string(),
    preserved: z.boolean(),
  }),
  persona: z.string().min(1).max(500),
  competitors: z.strictObject({
    preserved: z.boolean(),
    items: z.array(
      z.strictObject({
        name: z.string().min(1).max(120),
        domain: z.string().min(1).max(255),
        notes: z.string().max(500),
        sourceUrl: z.string().nullable(),
      }),
    ),
  }),
  candidates: z.array(setupCandidateSchema),
  topics: z.array(z.string()),
  suggestedKeywords: z.array(z.string()),
  warnings: z.array(
    z.strictObject({
      code: z.string(),
      message: z.string(),
    }),
  ),
});

export type SetupReview = z.infer<typeof setupReviewSchema>;
export type SetupCandidate = z.infer<typeof setupCandidateSchema>;

export const setupPayloadSchema = z.strictObject({
  brandKey: z.string().min(1).max(200),
  approvedMaxUsd: z.number().positive().max(1000),
  requestedBy: z.string().uuid(),
  website: z.string().min(1).max(2048),
  ownHost: z.string().min(1).max(255),
  displayName: z.string().min(1).max(200),
  market: z.strictObject({
    country: z.string().min(2).max(10),
    language: z.string().min(2).max(10),
  }),
});

export type SetupPayload = z.infer<typeof setupPayloadSchema>;
