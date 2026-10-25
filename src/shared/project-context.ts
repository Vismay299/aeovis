// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/types/schemas/projectContext.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";

export const PROJECT_CONTEXT_SECTION_KEYS = [
  "business_overview",
  "current_goal",
  "positioning",
  "writing_preferences",
] as const;

export type ProjectContextSectionKey = (typeof PROJECT_CONTEXT_SECTION_KEYS)[number];

export const PROJECT_CONTEXT_SECTION_LABELS: Record<ProjectContextSectionKey, string> = {
  business_overview: "Business overview",
  current_goal: "Current goal",
  positioning: "Positioning",
  writing_preferences: "Writing preferences",
};

export const PROJECT_CONTEXT_SECTION_HINTS: Record<ProjectContextSectionKey, string> = {
  business_overview: "What you sell, who buys it, and where.",
  current_goal: "What you're pushing for right now, and by when.",
  positioning: "Why someone picks you over the alternatives.",
  writing_preferences: "Voice, words to avoid, topics that are off-limits.",
};

export const PROJECT_CONTEXT_SECTION_PLACEHOLDERS: Record<ProjectContextSectionKey, string> = {
  business_overview:
    "e.g. Oversized and heavyweight T-shirts with anime graphics, sold online across India. Buyers are 18–30 and shop on their phones.",
  current_goal: "e.g. Be named in AI answers for 'oversized tees India' by March.",
  positioning:
    "e.g. Heavier fabric than fast-fashion brands, original artwork instead of licensed prints.",
  writing_preferences:
    "e.g. Casual and direct. Never say 'premium quality'. Don't compare prices with named competitors.",
};

export const PROSE_MAX_CHARS = 4000;
export const CUSTOM_SECTION_KEY_PREFIX = "custom:";
export const KEY_PAGE_ROLES = ["hub", "spoke", "money", "other"] as const;
export type KeyPageRole = (typeof KEY_PAGE_ROLES)[number];

export const KEY_PAGE_ROLE_LABELS: Record<KeyPageRole, string> = {
  hub: "Hub page",
  spoke: "Supporting page",
  money: "Money page",
  other: "Other",
};

export const CONTEXT_AUTHORS = ["user", "assistant", "system"] as const;
export type ContextAuthor = (typeof CONTEXT_AUTHORS)[number];

export const MAX_CUSTOM_SECTIONS = 20;
export const MAX_COMPETITORS = 100;
export const MAX_KEY_PAGES = 100;
export const RESEARCH_LOG_RETENTION_DAYS = 90;
export const RESEARCH_LOG_LIMIT = 20;

const projectContextSectionKeySchema = z.enum(PROJECT_CONTEXT_SECTION_KEYS);
const keyPageRoleSchema = z.enum(KEY_PAGE_ROLES);
const contextAuthorSchema = z.enum(CONTEXT_AUTHORS);

export const customSectionSlugSchema = z
  .string()
  .trim()
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a lowercase slug like 'launch-plan'");

const competitorInputSchema = z.object({
  domain: z.string().trim().min(1).max(255),
  name: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
});

const keyPageInputSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  role: keyPageRoleSchema.optional(),
  topic: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(500).optional(),
});

const researchKindSchema = z
  .string()
  .refine(
    (kind) => kind === "note" || /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(kind),
    "Use 'note' or a dotted spend-feature name.",
  );

export const projectContextUpdateSchema = z.union([
  z.strictObject({ section: projectContextSectionKeySchema, content: z.string() }),
  z.strictObject({
    customSection: customSectionSlugSchema,
    title: z.string().trim().min(1).max(120).optional(),
    content: z.string(),
  }),
  z.strictObject({ deleteCustomSection: customSectionSlugSchema }),
  z.strictObject({ addCompetitors: z.array(competitorInputSchema).min(1).max(100) }),
  z.strictObject({ removeCompetitors: z.array(z.string().trim().min(1)).min(1).max(100) }),
  z.strictObject({ addKeyPages: z.array(keyPageInputSchema).min(1).max(100) }),
  z.strictObject({ removeKeyPages: z.array(z.string().trim().min(1)).min(1).max(100) }),
  z.strictObject({ removeResearchLog: z.array(z.string().min(1)).min(1).max(100) }),
  z.strictObject({
    appendResearchLog: z.object({
      summary: z.string().trim().min(1).max(1000),
      kind: researchKindSchema.optional(),
      researchKey: z.string().trim().min(1).max(300).optional(),
    }),
  }),
]);

export type ProjectContextUpdate = z.infer<typeof projectContextUpdateSchema>;

export const updateProjectContextBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  updates: z.array(projectContextUpdateSchema).min(1).max(50),
});

export const projectContextSchema = z.looseObject({
  brandKey: z.string(),
  sections: z.array(
    z.looseObject({
      key: projectContextSectionKeySchema,
      content: z.string(),
      updatedAt: z.string(),
      updatedBy: contextAuthorSchema,
      updatedByUser: z.string().nullable(),
    }),
  ),
  missingSections: z.array(projectContextSectionKeySchema),
  customSections: z.array(
    z.looseObject({
      slug: z.string(),
      title: z.string().nullable(),
      content: z.string(),
      updatedAt: z.string(),
      updatedBy: contextAuthorSchema,
      updatedByUser: z.string().nullable(),
    }),
  ),
  competitors: z.array(
    z.looseObject({
      id: z.string(),
      domain: z.string(),
      name: z.string().nullable(),
      notes: z.string().nullable(),
      source: z.enum(["manual", "setup_research", "assistant", "brief_import"]),
      sourceUrl: z.string().nullable(),
      updatedAt: z.string(),
      updatedBy: contextAuthorSchema,
      updatedByUser: z.string().nullable(),
    }),
  ),
  keyPages: z.array(
    z.looseObject({
      id: z.string(),
      url: z.string(),
      role: keyPageRoleSchema,
      topic: z.string().nullable(),
      notes: z.string().nullable(),
      updatedAt: z.string(),
      updatedBy: contextAuthorSchema,
      updatedByUser: z.string().nullable(),
    }),
  ),
  researchLog: z.array(
    z.looseObject({
      id: z.string(),
      entryDate: z.string(),
      kind: z.string(),
      researchKey: z.string().nullable(),
      summary: z.string(),
      spendUsd: z.number().nullable(),
      createdBy: contextAuthorSchema,
    }),
  ),
  researchLogLimited: z.boolean(),
  brandIdentity: z.looseObject({
    displayName: z.string(),
    website: z.string(),
    matchNames: z.array(z.string()),
  }),
});

export type ProjectContext = z.infer<typeof projectContextSchema>;
