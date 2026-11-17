// Priced actions for Local SEO (F17 §6.2.9).

import { z } from "zod";
import {
  definePricedAction,
  type PricedActionEstimateResult,
  type PricingContext,
} from "../pricedActions.ts";
import { dataforseoPricing } from "../dataforseo.ts";
import {
  businessIdentifierSchema,
  listingsNearSchema,
  localSerpNearSchema,
  nearSchema,
} from "../../../server/local/shared.ts";
import { fetchQuoteDeps, gridQuoteDeps, listingsQuoteDeps, profileQuoteDeps } from "../../../server/local/quoteDeps.ts";

export type LocalPricingDeps = {
  checkGridLimitToday?: (brandKey: string) => Promise<number>;
  hasRecentResearch?: (brandKey: string, key: string) => Promise<boolean>;
  findReuse?: (brandKey: string, kind: string, hash: string) => Promise<{ minutesAgo: number } | null>;
  isCacheHit?: (brandKey: string, key: string) => Promise<boolean>;
};

// 1. local.profile.lookup
export const localProfileLookupInput = z.strictObject({
  identifier: businessIdentifierSchema,
  near: nearSchema.optional(),
  locationCode: z.number().int().positive().optional(),
});

export async function estimateLocalProfileLookup(
  ctx: PricingContext,
  _input: z.infer<typeof localProfileLookupInput>,
  deps?: LocalPricingDeps,
): Promise<PricedActionEstimateResult> {
  const cost = dataforseoPricing.business.myBusinessInfo({});
  const warnings: Array<{ code: string; message: string }> = [];

  if (deps?.hasRecentResearch) {
    const recent = await deps.hasRecentResearch(ctx.brandKey, "profile");
    if (recent) {
      warnings.push({
        code: "recent_research",
        message: "A Google Business Profile lookup ran in the last 90 days.",
      });
    }
  }

  return {
    totalUsd: cost,
    expectedUsd: cost,
    units: [{ key: "lookup", label: "Profile lookup", count: 1 }],
    lines: [
      {
        label: "Google Business Profile lookup",
        quantity: 1,
        unitUsd: cost,
        totalUsd: cost,
      },
    ],
    monthly: null,
    warnings,
    blocked: null,
  };
}

export const localProfileLookupAction = definePricedAction({
  key: "local.profile.lookup",
  feature: "local.business",
  input: localProfileLookupInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateLocalProfileLookup(ctx, input, profileQuoteDeps(ctx, input)),
});

// 2. local.listings.search
export const localListingsSearchInput = z.strictObject({
  near: listingsNearSchema,
  query: z.string().optional(),
  categories: z.array(z.string().min(1).max(120)).max(10).optional(),
  minRating: z.number().min(1).max(5).optional(),
  minReviews: z.number().int().min(0).optional(),
  isClaimed: z.boolean().optional(),
  sortBy: z.enum(["relevance", "rating", "reviews"]).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(1000).default(0),
});

export async function estimateLocalListingsSearch(
  _ctx: PricingContext,
  input: z.infer<typeof localListingsSearchInput>,
  deps?: LocalPricingDeps,
): Promise<PricedActionEstimateResult> {
  const limit = input.limit ?? 20;
  const isHit = deps?.isCacheHit ? await deps.isCacheHit(_ctx.brandKey, "listings") : false;
  const rawCost = dataforseoPricing.business.businessListings({ limit });
  const cost = isHit ? 0 : Number(rawCost.toFixed(6));

  const warnings: Array<{ code: string; message: string }> = [
    {
      code: "cache_note",
      message: "Repeating this search within 24 hours is free.",
    },
  ];

  return {
    totalUsd: cost,
    expectedUsd: cost,
    units: [{ key: "businesses", label: "Nearby businesses", count: limit }],
    lines: [
      {
        label: `Up to ${limit} nearby businesses`,
        quantity: 1,
        unitUsd: cost,
        totalUsd: cost,
      },
    ],
    monthly: null,
    warnings,
    blocked: null,
  };
}

export const localListingsSearchAction = definePricedAction({
  key: "local.listings.search",
  feature: "local.business",
  input: localListingsSearchInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateLocalListingsSearch(ctx, input, listingsQuoteDeps(ctx, input)),
});

// 3. local.reviews.collect
export const localReviewsCollectInput = z.strictObject({
  businessId: z.string().uuid(),
  depth: z.union([z.literal(20), z.literal(50), z.literal(100), z.literal(200)]),
  sortBy: z.enum(["newest", "highest_rating", "lowest_rating", "relevant"]).optional(),
  includeOtherSources: z.boolean().default(false),
});

export async function estimateLocalReviewsCollect(
  _ctx: PricingContext,
  input: z.infer<typeof localReviewsCollectInput>,
  deps?: LocalPricingDeps,
): Promise<PricedActionEstimateResult> {
  const depth = input.depth;
  const includeOtherSources = input.includeOtherSources ?? false;
  const reuse = deps?.findReuse ? await deps.findReuse(_ctx.brandKey, "reviews", "") : null;

  const rawCost = dataforseoPricing.business.reviewsTaskPost({ depth, includeOtherSources });
  const cost = reuse ? 0 : Number(rawCost.toFixed(6));

  const label = includeOtherSources
    ? `Collect up to ${depth} reviews from Google and other sites`
    : `Collect up to ${depth} Google reviews`;

  const warnings: Array<{ code: string; message: string }> = [];
  if (reuse) {
    warnings.push({
      code: "reuse_note",
      message: `You collected these reviews ${reuse.minutesAgo} minutes ago. That result is reused at no cost.`,
    });
  }

  return {
    totalUsd: cost,
    expectedUsd: cost,
    units: [{ key: "reviews", label: "Reviews", count: depth }],
    lines: [
      {
        label,
        quantity: 1,
        unitUsd: cost,
        totalUsd: cost,
      },
    ],
    monthly: null,
    warnings,
    blocked: null,
  };
}

export const localReviewsCollectAction = definePricedAction({
  key: "local.reviews.collect",
  feature: "local.reviews",
  input: localReviewsCollectInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateLocalReviewsCollect(ctx, input, fetchQuoteDeps(ctx, input, "reviews")),
});

// 4. local.updates.collect
export const localUpdatesCollectInput = z.strictObject({
  businessId: z.string().uuid(),
  depth: z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)]),
});

export async function estimateLocalUpdatesCollect(
  _ctx: PricingContext,
  input: z.infer<typeof localUpdatesCollectInput>,
  deps?: LocalPricingDeps,
): Promise<PricedActionEstimateResult> {
  const depth = input.depth;
  const reuse = deps?.findReuse ? await deps.findReuse(_ctx.brandKey, "updates", "") : null;
  const rawCost = dataforseoPricing.business.updatesTaskPost({ depth });
  const cost = reuse ? 0 : Number(rawCost.toFixed(6));

  const warnings: Array<{ code: string; message: string }> = [];
  if (reuse) {
    warnings.push({
      code: "reuse_note",
      message: `You collected these updates ${reuse.minutesAgo} minutes ago. That result is reused at no cost.`,
    });
  }

  return {
    totalUsd: cost,
    expectedUsd: cost,
    units: [{ key: "posts", label: "Profile posts", count: depth }],
    lines: [
      {
        label: `Collect up to ${depth} profile posts`,
        quantity: 1,
        unitUsd: cost,
        totalUsd: cost,
      },
    ],
    monthly: null,
    warnings,
    blocked: null,
  };
}

export const localUpdatesCollectAction = definePricedAction({
  key: "local.updates.collect",
  feature: "local.business",
  input: localUpdatesCollectInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateLocalUpdatesCollect(ctx, input, fetchQuoteDeps(ctx, input, "updates")),
});

// 5. local.questions.collect
export const localQuestionsCollectInput = z.strictObject({
  businessId: z.string().uuid(),
  depth: z.union([z.literal(20), z.literal(50), z.literal(100)]),
});

export async function estimateLocalQuestionsCollect(
  _ctx: PricingContext,
  input: z.infer<typeof localQuestionsCollectInput>,
  deps?: LocalPricingDeps,
): Promise<PricedActionEstimateResult> {
  const depth = input.depth;
  const reuse = deps?.findReuse ? await deps.findReuse(_ctx.brandKey, "questions", "") : null;
  const rawCost = dataforseoPricing.business.questionsAnswers({ depth });
  const cost = reuse ? 0 : Number(rawCost.toFixed(6));

  const warnings: Array<{ code: string; message: string }> = [];
  if (reuse) {
    warnings.push({
      code: "reuse_note",
      message: `You collected these questions ${reuse.minutesAgo} minutes ago. That result is reused at no cost.`,
    });
  }

  return {
    totalUsd: cost,
    expectedUsd: cost,
    units: [{ key: "questions", label: "Questions and answers", count: depth }],
    lines: [
      {
        label: `Collect up to ${depth} questions and answers`,
        quantity: 1,
        unitUsd: cost,
        totalUsd: cost,
      },
    ],
    monthly: null,
    warnings,
    blocked: null,
  };
}

export const localQuestionsCollectAction = definePricedAction({
  key: "local.questions.collect",
  feature: "local.business",
  input: localQuestionsCollectInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateLocalQuestionsCollect(ctx, input, fetchQuoteDeps(ctx, input, "questions")),
});

// 6. local.serp.search
export const localSerpSearchInput = z.strictObject({
  keyword: z.string().trim().min(1).max(120),
  near: localSerpNearSchema,
  searchType: z.enum(["maps", "local_finder"]).default("maps"),
  device: z.enum(["desktop", "mobile"]).default("mobile"),
  depth: z.number().int().min(1).max(100).default(20),
  languageCode: z.string().optional(),
});

export async function estimateLocalSerpSearch(
  _ctx: PricingContext,
  input: z.infer<typeof localSerpSearchInput>,
): Promise<PricedActionEstimateResult> {
  const searchType = input.searchType ?? "maps";
  const depth = input.depth ?? 20;
  const rawCost = dataforseoPricing.serp.local({ searchType, depth });
  const cost = Number(rawCost.toFixed(6));

  const label =
    searchType === "maps"
      ? `Google Maps results for “${input.keyword}”`
      : `Local Finder results for “${input.keyword}”`;

  return {
    totalUsd: cost,
    expectedUsd: cost,
    units: [{ key: "results", label: "Search results", count: depth }],
    lines: [
      {
        label,
        quantity: 1,
        unitUsd: cost,
        totalUsd: cost,
      },
    ],
    monthly: null,
    warnings: [
      {
        code: "cache_note",
        message: "Results for the same search and place are reused for 12 hours.",
      },
    ],
    blocked: null,
  };
}

export const localSerpSearchAction = definePricedAction({
  key: "local.serp.search",
  feature: "local.serp",
  input: localSerpSearchInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateLocalSerpSearch(ctx, input),
});

// 7. local.grid.run
export const localGridRunInput = z.strictObject({
  keyword: z.string().trim().min(1).max(120),
  center: z.strictObject({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
  gridSize: z.union([z.literal(3), z.literal(5)]).default(3),
  spacingKm: z.number().min(0.25).max(10).default(2),
  device: z.enum(["desktop", "mobile"]).default("mobile"),
  zoom: z.number().int().min(4).max(18).optional(),
  languageCode: z.string().optional(),
});

export async function estimateLocalGridRun(
  ctx: PricingContext,
  input: z.infer<typeof localGridRunInput>,
  deps?: LocalPricingDeps,
): Promise<PricedActionEstimateResult> {
  const gridSize = input.gridSize ?? 3;
  const spacingKm = input.spacingKm ?? 2;
  const n = gridSize * gridSize;

  let blocked: { code: string; message: string; recovery?: string } | null = null;
  if (deps?.checkGridLimitToday) {
    const count = await deps.checkGridLimitToday(ctx.brandKey);
    if (count >= 20) {
      blocked = {
        code: "local_grid_limit",
        message: "This workspace has run 20 map grids today. Try again tomorrow.",
      };
    }
  }

  const rawCost = dataforseoPricing.serp.localTaskPost({
    locationCoordinates: new Array(n).fill(""),
  });
  const cost = Number(rawCost.toFixed(6));

  const warnings: Array<{ code: string; message: string }> = [];
  if (gridSize === 5) {
    warnings.push({
      code: "grid_size_note",
      message: "A 5×5 grid runs 25 searches. Use it when your service area is wide.",
    });
  }
  warnings.push({
    code: "center_note",
    message: "Check that the centre is your storefront before running. A grid centred in the wrong place is worse than no grid.",
  });

  return {
    totalUsd: cost,
    expectedUsd: cost,
    units: [{ key: "points", label: "Grid points", count: n }],
    lines: [
      {
        label: `${n} Google Maps searches (${gridSize}×${gridSize} grid, ${spacingKm} km apart)`,
        quantity: 1,
        unitUsd: cost,
        totalUsd: cost,
      },
    ],
    monthly: null,
    warnings,
    blocked,
  };
}

export const localGridRunAction = definePricedAction({
  key: "local.grid.run",
  feature: "local.grid",
  input: localGridRunInput,
  requireApproval: true,
  estimate: (ctx, input) => estimateLocalGridRun(ctx, input, gridQuoteDeps(ctx)),
});
