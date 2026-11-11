// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/backlinks/services/backlinksSubfolderOverview.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { BacklinksClient } from "../providers/dataforseo/backlinks.ts";
import { buildBacklinksScopeFilter } from "../providers/dataforseo/researchScopeFilters.ts";
import type { BacklinksOverviewResult } from "./backlinksOverviewSchema.ts";
import type { SpendFeature } from "../../shared/spend-features.ts";

export type SubfolderOverviewContext = {
  brandKey: string;
  requestId: string;
  maxUsd?: number;
  feature?: SpendFeature;
};

/**
 * The summary and history endpoints only take a whole target, so subfolder
 * totals come from two filtered `total_count` reads of the backlinks list:
 * every link (`as_is`) and one per referring domain. Rank, spam scores,
 * new/lost, and trends have no filtered source and stay null/empty.
 * Sequenced, not parallel: hosted billing checks balance per call.
 */
export async function buildSubfolderOverview(
  client: BacklinksClient,
  normalizedTarget: {
    apiTarget: string;
    displayTarget: string;
    scope: "subfolder";
    includeSubdomains: boolean;
    path: string;
  },
  now: Date,
  ctx: SubfolderOverviewContext,
): Promise<BacklinksOverviewResult> {
  const filters = buildBacklinksScopeFilter("url_to", normalizedTarget).clauses;
  const baseKey = `backlinks.research:${ctx.requestId}`;

  const allLinks = await client.rows(
    {
      brandKey: ctx.brandKey,
      feature: ctx.feature ?? ("backlinks.research" as SpendFeature),
      idempotencyKey: `${baseKey}:subfolder_all`,
      maxUsd: ctx.maxUsd,
    },
    {
      target: normalizedTarget.apiTarget,
      includeSubdomains: normalizedTarget.includeSubdomains,
      limit: 1,
      mode: "as_is",
      hideSpam: false,
      filters,
    },
  );

  const perDomain = await client.rows(
    {
      brandKey: ctx.brandKey,
      feature: ctx.feature ?? ("backlinks.research" as SpendFeature),
      idempotencyKey: `${baseKey}:subfolder_domains`,
      maxUsd: ctx.maxUsd,
    },
    {
      target: normalizedTarget.apiTarget,
      includeSubdomains: normalizedTarget.includeSubdomains,
      limit: 1,
      mode: "one_per_domain",
      hideSpam: false,
      filters,
    },
  );

  const allTotalCount =
    (allLinks as { data?: { totalCount?: number | null } })?.data
      ?.totalCount ??
    (allLinks as { totalCount?: number | null })?.totalCount ??
    null;

  const perDomainTotalCount =
    (perDomain as { data?: { totalCount?: number | null } })?.data
      ?.totalCount ??
    (perDomain as { totalCount?: number | null })?.totalCount ??
    null;

  return {
    target: normalizedTarget.apiTarget,
    displayTarget: normalizedTarget.displayTarget,
    scope: "subfolder",
    summary: {
      rank: null,
      backlinks: allTotalCount,
      referringPages: null,
      referringDomains: perDomainTotalCount,
      brokenBacklinks: null,
      brokenPages: null,
      backlinksSpamScore: null,
      targetSpamScore: null,
      newBacklinks: null,
      lostBacklinks: null,
      newReferringDomains: null,
      lostReferringDomains: null,
    },
    trends: [],
    newLostTrends: [],
    fetchedAt: now.toISOString(),
  };
}
