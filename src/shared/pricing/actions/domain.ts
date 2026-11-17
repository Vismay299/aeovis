// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/domain/services/domainCost.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import {
  definePricedAction,
  type PricingContext,
  type PricedActionEstimateResult,
} from "../pricedActions.ts";
import { dataforseoPricing } from "../dataforseo.ts";
import { fromMicros, toMicros } from "../../spend/money.ts";
import {
  parseResearchTarget,
  researchScopeSchema,
} from "../../researchScope.ts";
import {
  DEFAULT_LOCATION_CODE,
  resolveLabsMarket,
} from "../../keyword-locations.ts";
import { findRecentResearch as defaultFindRecentResearch } from "../../../server/projectContext/service.ts";
import { domainResearchKey } from "../../../server/domain/researchLog.ts";

export type DomainQuoteDeps = {
  findRecentResearch?: typeof defaultFindRecentResearch;
};

export const domainLookupRunInput = z.strictObject({
  domain: z.string().min(1).max(2048),
  scope: researchScopeSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  tab: z.enum(["keywords", "pages", "competitors"]).default("keywords"),
  pageSize: z
    .union([z.literal(50), z.literal(100), z.literal(200)])
    .default(50),
});

export const domainKeywordsPageInput = z.strictObject({
  domain: z.string().min(1).max(2048),
  scope: researchScopeSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  pageSize: z
    .union([z.literal(50), z.literal(100), z.literal(200)])
    .default(50),
});

export const domainPagesPageInput = z.strictObject({
  domain: z.string().min(1).max(2048),
  scope: researchScopeSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  pageSize: z
    .union([z.literal(50), z.literal(100), z.literal(200)])
    .default(50),
});

export const domainCompetitorsRunInput = z.strictObject({
  domain: z.string().min(1).max(2048),
  scope: researchScopeSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  keywordCount: z.number().int().min(1).max(100),
  limit: z.number().int().min(10).max(100).default(50),
});

export async function estimateDomainLookupRun(
  ctx: PricingContext,
  input: z.infer<typeof domainLookupRunInput>,
  deps?: DomainQuoteDeps,
): Promise<PricedActionEstimateResult> {
  const parsed = parseResearchTarget(input.domain, input.scope);
  if (!parsed.ok) {
    return {
      totalUsd: 0,
      expectedUsd: null,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: {
        code: "invalid_target",
        message: parsed.message,
      },
    };
  }

  const market = resolveLabsMarket(
    { locationCode: input.locationCode, languageCode: input.languageCode },
    { locationCode: DEFAULT_LOCATION_CODE, languageCode: "en" },
  );

  const researchKey = domainResearchKey({
    hostname: parsed.target.hostname,
    scope: parsed.target.scope,
    path: parsed.target.path,
    locationCode: market.locationCode,
    languageCode: market.languageCode,
  });

  const findRecent = deps?.findRecentResearch ?? defaultFindRecentResearch;
  let recentWarning: { code: string; message: string } | null = null;
  try {
    const recent = await findRecent(ctx.admin, {
      brandKey: ctx.brandKey,
      kind: "domain.research",
      researchKey,
      days: 90,
    });
    if (recent) {
      recentWarning = {
        code: "recent_research",
        message: `You looked this up on ${recent.entryDate}: ${recent.summary}`,
      };
    }
  } catch {
    // Ignore lookup errors in pricing
  }

  const warnings: Array<{ code: string; message: string }> = [
    {
      code: "cache_note",
      message:
        "Looking up the same domain and market again within 12 hours is free.",
    },
    ...(recentWarning ? [recentWarning] : []),
  ];

  const overviewCost = fromMicros(toMicros(dataforseoPricing.domain.rankOverview({})));
  const overviewLine = {
    label: "Domain overview",
    quantity: 1,
    unitUsd: overviewCost,
    totalUsd: overviewCost,
  };

  const secondUnitUsd =
    input.tab === "keywords"
      ? fromMicros(toMicros(dataforseoPricing.domain.rankedKeywords({ limit: input.pageSize })))
      : input.tab === "pages"
      ? fromMicros(toMicros(dataforseoPricing.domain.relevantPages({ limit: input.pageSize })))
      : null;

  const secondLine =
    input.tab === "keywords" && secondUnitUsd !== null
      ? {
          label: `First ${input.pageSize} ranked keywords`,
          quantity: 1,
          unitUsd: secondUnitUsd,
          totalUsd: secondUnitUsd,
        }
      : input.tab === "pages" && secondUnitUsd !== null
      ? {
          label: `First ${input.pageSize} top pages`,
          quantity: 1,
          unitUsd: secondUnitUsd,
          totalUsd: secondUnitUsd,
        }
      : null;

  const lines = secondLine ? [overviewLine, secondLine] : [overviewLine];
  const totalUsd = fromMicros(
    lines.reduce((sum, l) => sum + toMicros(l.totalUsd), 0),
  );

  const units = [
    { key: "overview", label: "Overview", count: 1 },
    ...(secondLine
      ? [
          {
            key: input.tab,
            label: input.tab === "pages" ? "Top pages" : "Ranked keywords",
            count: input.pageSize,
          },
        ]
      : []),
  ];

  return {
    totalUsd,
    expectedUsd: null,
    units,
    lines,
    monthly: null,
    warnings,
    blocked: null,
  };
}

export async function estimateDomainKeywordsPage(
  _ctx: PricingContext,
  input: z.infer<typeof domainKeywordsPageInput>,
): Promise<PricedActionEstimateResult> {
  const unitUsd = fromMicros(toMicros(dataforseoPricing.domain.rankedKeywords({
    limit: input.pageSize,
  })));
  const lines = [
    {
      label: `${input.pageSize} ranked keywords`,
      quantity: 1,
      unitUsd,
      totalUsd: unitUsd,
    },
  ];

  return {
    totalUsd: unitUsd,
    expectedUsd: null,
    units: [{ key: "keywords", label: "Ranked keywords", count: input.pageSize }],
    lines,
    monthly: null,
    warnings: [],
    blocked: null,
  };
}

export async function estimateDomainPagesPage(
  _ctx: PricingContext,
  input: z.infer<typeof domainPagesPageInput>,
): Promise<PricedActionEstimateResult> {
  const unitUsd = fromMicros(toMicros(dataforseoPricing.domain.relevantPages({
    limit: input.pageSize,
  })));
  const lines = [
    {
      label: `${input.pageSize} top pages`,
      quantity: 1,
      unitUsd,
      totalUsd: unitUsd,
    },
  ];

  return {
    totalUsd: unitUsd,
    expectedUsd: null,
    units: [{ key: "pages", label: "Top pages", count: input.pageSize }],
    lines,
    monthly: null,
    warnings: [],
    blocked: null,
  };
}

export async function estimateDomainCompetitorsRun(
  _ctx: PricingContext,
  input: z.infer<typeof domainCompetitorsRunInput>,
): Promise<PricedActionEstimateResult> {
  const unitUsd = fromMicros(toMicros(dataforseoPricing.labs.serpCompetitors({ limit: input.limit })));
  const lines = [
    {
      label: `Competitor analysis across ${input.keywordCount} keywords (up to ${input.limit} domains)`,
      quantity: 1,
      unitUsd,
      totalUsd: unitUsd,
    },
  ];

  return {
    totalUsd: unitUsd,
    expectedUsd: null,
    units: [
      {
        key: "competitors",
        label: "SERP competitors",
        count: input.limit,
      },
    ],
    lines,
    monthly: null,
    warnings: [
      {
        code: "cache_note",
        message: "The same keywords and market are reused for 12 hours.",
      },
    ],
    blocked: null,
  };
}

export const domainLookupRunAction = definePricedAction({
  key: "domain.lookup.run",
  feature: "domain.research",
  input: domainLookupRunInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateDomainLookupRun(ctx, input),
});

export const domainKeywordsPageAction = definePricedAction({
  key: "domain.keywords.page",
  feature: "domain.research",
  input: domainKeywordsPageInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateDomainKeywordsPage(ctx, input),
});

export const domainPagesPageAction = definePricedAction({
  key: "domain.pages.page",
  feature: "domain.research",
  input: domainPagesPageInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateDomainPagesPage(ctx, input),
});

export const domainCompetitorsRunAction = definePricedAction({
  key: "domain.competitors.run",
  feature: "domain.competitors",
  input: domainCompetitorsRunInput,
  requireApproval: true,
  estimate: (ctx, input) => estimateDomainCompetitorsRun(ctx, input),
});
