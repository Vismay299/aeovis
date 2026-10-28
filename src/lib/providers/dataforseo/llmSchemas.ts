// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseoLlmSchemas.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";

const monthlyVolumeSchema = z.looseObject({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  search_volume: z.number().nullable().optional(),
});

const mentionSourceSchema = z.looseObject({
  url: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
});

const brandEntitySchema = z.looseObject({
  title: z.string().nullable().optional(),
});

export const llmMentionItemSchema = z.looseObject({
  question: z.string().nullable().optional(),
  answer: z.string().nullable().optional(),
  sources: z.array(mentionSourceSchema).nullable().optional(),
  search_results: z.array(mentionSourceSchema).nullable().optional(),
  ai_search_volume: z.number().nullable().optional(),
  monthly_searches: z.array(monthlyVolumeSchema).nullable().optional(),
  first_response_at: z.string().nullable().optional(),
  last_response_at: z.string().nullable().optional(),
  brand_entities: z.array(brandEntitySchema).nullable().optional(),
});
export type LlmMentionItem = z.infer<typeof llmMentionItemSchema>;

const groupElementSchema = z.looseObject({
  type: z.string().nullable().optional(),
  key: z.string().nullable().optional(),
  mentions: z.number().nullable().optional(),
  ai_search_volume: z.number().nullable().optional(),
  impressions: z.number().nullable().optional(),
});

export const llmAggregatedTotalSchema = z.looseObject({
  platform: z.array(groupElementSchema).nullable().optional(),
});
export type LlmAggregatedTotal = z.infer<typeof llmAggregatedTotalSchema>;

export const llmTopPagesItemSchema = z.looseObject({
  key: z.string().nullable().optional(),
  platform: z.array(groupElementSchema).nullable().optional(),
});
export type LlmTopPagesItem = z.infer<typeof llmTopPagesItemSchema>;

export const llmCrossAggregatedItemSchema = z.looseObject({
  key: z.string().nullable().optional(),
  platform: z.array(groupElementSchema).nullable().optional(),
});
export type LlmCrossAggregatedItem = z.infer<typeof llmCrossAggregatedItemSchema>;

const responseAnnotationSchema = z.looseObject({
  type: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
});

const responseSectionSchema = z.looseObject({
  type: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  annotations: z.array(responseAnnotationSchema).nullable().optional(),
});

const responseItemSchema = z.looseObject({
  type: z.string().nullable().optional(),
  sections: z.array(responseSectionSchema).nullable().optional(),
});

export const llmResponseResultSchema = z.looseObject({
  model_name: z.string().nullable().optional(),
  output_tokens: z.number().nullable().optional(),
  web_search: z.boolean().nullable().optional(),
  items: z.array(responseItemSchema).nullable().optional(),
  fan_out_queries: z.array(z.string()).nullable().optional(),
});
export type LlmResponseResult = z.infer<typeof llmResponseResultSchema>;