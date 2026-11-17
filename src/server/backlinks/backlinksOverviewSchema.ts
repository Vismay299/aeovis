// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/backlinks/services/backlinksOverviewSchema.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";

export const backlinksRowSchema = z.looseObject({
  domainFrom: z.string().nullable(),
  urlFrom: z.string().nullable(),
  urlTo: z.string().nullable(),
  anchor: z.string().nullable(),
  itemType: z.string().nullable(),
  isDofollow: z.boolean().nullable(),
  relAttributes: z.array(z.string()),
  rank: z.number().nullable(),
  domainFromRank: z.number().nullable(),
  pageFromRank: z.number().nullable(),
  spamScore: z.number().nullable(),
  firstSeen: z.string().nullable(),
  lastSeen: z.string().nullable(),
  isLost: z.boolean(),
  isBroken: z.boolean(),
  linksCount: z.number().nullable(),
});

export const referringDomainRowSchema = z.looseObject({
  domain: z.string().nullable(),
  backlinks: z.number().nullable(),
  referringPages: z.number().nullable(),
  rank: z.number().nullable(),
  spamScore: z.number().nullable(),
  firstSeen: z.string().nullable(),
  brokenBacklinks: z.number().nullable(),
  brokenPages: z.number().nullable(),
});

export const topPageRowSchema = z.looseObject({
  page: z.string().nullable(),
  backlinks: z.number().nullable(),
  referringDomains: z.number().nullable(),
  rank: z.number().nullable(),
  brokenBacklinks: z.number().nullable(),
});

export const backlinksTrendRowSchema = z.looseObject({
  date: z.string(),
  backlinks: z.number().nullable(),
  referringDomains: z.number().nullable(),
  rank: z.number().nullable(),
});

export const backlinksNewLostTrendRowSchema = z.looseObject({
  date: z.string(),
  newBacklinks: z.number().nullable(),
  lostBacklinks: z.number().nullable(),
  newReferringDomains: z.number().nullable(),
  lostReferringDomains: z.number().nullable(),
});

export const backlinksOverviewSchema = z.looseObject({
  target: z.string(),
  displayTarget: z.string(),
  scope: z.enum(["exact_url", "subfolder", "domain", "subdomains"]),
  summary: z.looseObject({
    rank: z.number().nullable(),
    backlinks: z.number().nullable(),
    referringPages: z.number().nullable(),
    referringDomains: z.number().nullable(),
    brokenBacklinks: z.number().nullable(),
    brokenPages: z.number().nullable(),
    backlinksSpamScore: z.number().nullable(),
    targetSpamScore: z.number().nullable(),
    newBacklinks: z.number().nullable(),
    lostBacklinks: z.number().nullable(),
    newReferringDomains: z.number().nullable(),
    lostReferringDomains: z.number().nullable(),
  }),
  trends: z.array(backlinksTrendRowSchema),
  newLostTrends: z.array(backlinksNewLostTrendRowSchema),
  fetchedAt: z.string(),
});

export type BacklinksOverviewResult = z.infer<typeof backlinksOverviewSchema>;

function buildPageResultSchema<T extends z.ZodTypeAny>(rowSchema: T) {
  return z.looseObject({
    rows: z.array(rowSchema),
    totalCount: z.number().nullable(),
    hasMore: z.boolean(),
    page: z.number(),
    pageSize: z.number(),
    fetchedAt: z.string(),
  });
}

export const backlinksRowsPageResultSchema =
  buildPageResultSchema(backlinksRowSchema);
export const referringDomainsPageResultSchema = buildPageResultSchema(
  referringDomainRowSchema,
);
export const topPagesPageResultSchema = buildPageResultSchema(topPageRowSchema);

export type BacklinksRowsPageResult = z.infer<
  typeof backlinksRowsPageResultSchema
>;
export type ReferringDomainsPageResult = z.infer<
  typeof referringDomainsPageResultSchema
>;
export type TopPagesPageResult = z.infer<typeof topPagesPageResultSchema>;
