/**
 * F17 §6.2.10 — Tool definitions for the F22 in-app assistant.
 *
 * Eight tools under upstream's exact names with strict inputs, loose outputs,
 * maxUsd on paid tools and resume ids (fetchId, gridId). Handlers call the
 * §6.2.3–6.2.7 services. Descriptions follow upstream local-seo-tools and
 * dataforseo-research-tools texts with "Charges credits" replaced by the paid
 * price-estimate instruction.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../http/appError.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import {
  businessIdentifierSchema,
  listingsNearSchema,
  localSerpNearSchema,
  nearSchema,
} from "./shared.ts";
import { lookupBusinessProfile, refreshBusinessProfile } from "./profile.ts";
import { searchLocalBusinesses, listBusinessCategories } from "./listings.ts";
import { startFetch, collectFetch } from "./fetches.ts";
import { startGrid, collectGrid } from "./grid.ts";
import { getLocalSerpResults } from "./localSerp.ts";
import type { LocalDeps } from "./store.ts";

export type LocalToolBrand = {
  brandKey: string;
  display_name?: string;
  website?: string;
  website_host?: string;
  aliases?: string[];
  default_location_code?: number | null;
  default_language_code?: string | null;
};

export type LocalToolContext = {
  admin: SupabaseClient;
  brand: LocalToolBrand;
  userId: string;
  requestId?: string;
  deps?: LocalDeps & {
    lookupBusinessProfile?: typeof lookupBusinessProfile;
    refreshBusinessProfile?: typeof refreshBusinessProfile;
    searchLocalBusinesses?: typeof searchLocalBusinesses;
    listBusinessCategories?: typeof listBusinessCategories;
    startFetch?: typeof startFetch;
    collectFetch?: typeof collectFetch;
    startGrid?: typeof startGrid;
    collectGrid?: typeof collectGrid;
    getLocalSerpResults?: typeof getLocalSerpResults;
  };
};

function toolWorkspace(ctx: LocalToolContext): Workspace {
  return {
    user: { id: ctx.userId, email: "" },
    brandKey: ctx.brand.brandKey,
    brand: ctx.brand as unknown as Workspace["brand"],
    role: "member",
    admin: ctx.admin,
  };
}

function toolDeps(ctx: LocalToolContext): LocalDeps {
  const { lookupBusinessProfile: _l, refreshBusinessProfile: _r, searchLocalBusinesses: _s,
    listBusinessCategories: _c, startFetch: _sf, collectFetch: _cf,
    startGrid: _sg, collectGrid: _cg, getLocalSerpResults: _g, ...rest } = ctx.deps ?? {};
  return rest as LocalDeps;
}

function requestIdOf(ctx: LocalToolContext): string {
  return ctx.requestId ?? crypto.randomUUID();
}

async function resumeFetch(
  ctx: LocalToolContext,
  ws: Parameters<typeof collectFetch>[0],
  fetchId: string,
  kind: "reviews" | "updates" | "questions",
  deps: LocalDeps,
) {
  const collect = ctx.deps?.collectFetch ?? collectFetch;
  const view = await collect(ws, fetchId, deps);
  if (view.kind !== kind) {
    throw new AppError(400, "fetch_kind_mismatch", `That fetchId belongs to a ${view.kind} fetch, not ${kind}.`);
  }
  return view;
}

function requireMaxUsd(maxUsd: number | undefined, action: string): number {
  if (maxUsd == null) {
    throw new AppError(
      400,
      "approval_required",
      `Pass the approved maxUsd for ${action} first. Call the price estimate for ${action} and pass the approved maximum.`,
    );
  }
  return maxUsd;
}

// ---------------------------------------------------------------------------
// search_local_businesses
// ---------------------------------------------------------------------------

const searchLocalBusinessesInput = z.strictObject({
  near: listingsNearSchema,
  query: z.string().trim().min(1).max(200).optional(),
  categories: z.array(z.string().min(1).max(120)).max(10).optional(),
  minRating: z.number().min(1).max(5).optional(),
  minReviews: z.number().int().min(0).optional(),
  isClaimed: z.boolean().optional(),
  sortBy: z.enum(["relevance", "rating", "reviews"]).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(1000).default(0),
  maxUsd: z.number().positive().max(1000),
});

const searchLocalBusinessesOutput = z.looseObject({
  businesses: z.array(z.looseObject({})),
  cached: z.boolean(),
  fetchedAt: z.string(),
});

export const searchLocalBusinessesTool = {
  name: "search_local_businesses",
  description:
    "Searches local business listings near a coordinate, with optional rating, review-count, and claimed-status filters. Use this to discover businesses you cannot name yet: local candidates, nearby competitors, or unclaimed listings. It does not run Maps rank checks or Q&A. When you already know the business, use get_business_profile instead — it returns the full profile and costs less than half the credits, so it is also the cheap way to check whether a Google Business Profile exists at all. Paid: call the price estimate for local.listings.search first and pass the approved maxUsd.",
  input: searchLocalBusinessesInput,
  output: searchLocalBusinessesOutput,
  handler: async (ctx: LocalToolContext, rawInput?: unknown) => {
    const input = searchLocalBusinessesInput.parse(rawInput ?? {});
    const ws = toolWorkspace(ctx);
    const fn = ctx.deps?.searchLocalBusinesses ?? searchLocalBusinesses;
    const result = await fn(ws, { ...input, requestId: requestIdOf(ctx) }, toolDeps(ctx));
    return searchLocalBusinessesOutput.parse(result);
  },
};

// ---------------------------------------------------------------------------
// get_local_serp_results
// ---------------------------------------------------------------------------

const getLocalSerpResultsInput = z.strictObject({
  keyword: z.string().trim().min(1).max(120),
  near: localSerpNearSchema,
  searchType: z.enum(["maps", "local_finder"]).default("maps"),
  device: z.enum(["desktop", "mobile"]).default("mobile"),
  depth: z.number().int().min(1).max(100).default(20),
  languageCode: z.string().min(2).max(8).optional(),
  maxUsd: z.number().positive().max(1000),
});

const getLocalSerpResultsOutput = z.looseObject({
  results: z.array(z.looseObject({})),
  ownRank: z.number().nullable(),
  cached: z.boolean(),
  fetchedAt: z.string(),
});

export const getLocalSerpResultsTool = {
  name: "get_local_serp_results",
  description:
    "Fetches one Google Maps or Local Finder SERP near a coordinate. Returns trimmed provider rows (identity, rank, rating, categories, hours) with rank fields intact; callers decide how to match a target business. Paid: call the price estimate for local.serp.search first and pass the approved maxUsd.",
  input: getLocalSerpResultsInput,
  output: getLocalSerpResultsOutput,
  handler: async (ctx: LocalToolContext, rawInput?: unknown) => {
    const input = getLocalSerpResultsInput.parse(rawInput ?? {});
    const ws = toolWorkspace(ctx);
    const fn = ctx.deps?.getLocalSerpResults ?? getLocalSerpResults;
    const result = await fn(ws, { ...input, requestId: requestIdOf(ctx) }, toolDeps(ctx));
    return getLocalSerpResultsOutput.parse(result);
  },
};

// ---------------------------------------------------------------------------
// get_local_rank_grid
// ---------------------------------------------------------------------------

const gridTargetSchema = z.strictObject({
  businessId: z.string().uuid().optional(),
  cid: z.string().regex(/^[0-9]{1,30}$/).optional(),
  placeId: z.string().min(1).max(256).optional(),
  name: z.string().trim().min(1).max(200).optional(),
});

const getLocalRankGridInput = z.strictObject({
  keyword: z.string().trim().min(1).max(120),
  center: z.strictObject({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
  gridSize: z.union([z.literal(3), z.literal(5)]).default(3),
  spacingKm: z.number().min(0.25).max(10).default(2),
  device: z.enum(["desktop", "mobile"]).default("mobile"),
  zoom: z.number().int().min(4).max(18).optional(),
  languageCode: z.string().min(2).max(8).optional(),
  target: gridTargetSchema.optional(),
  maxUsd: z.number().positive().max(1000).optional(),
  gridId: z.string().uuid().optional(),
});

const getLocalRankGridOutput = z.looseObject({
  id: z.string(),
  status: z.enum(["processing", "completed", "failed"]),
  keyword: z.string(),
  center: z.looseObject({ latitude: z.number(), longitude: z.number() }),
  gridSize: z.number(),
  spacingKm: z.number(),
  zoom: z.number(),
  device: z.enum(["desktop", "mobile"]),
  pointsReady: z.number(),
  pointsTotal: z.number(),
  points: z.array(z.looseObject({})).nullable(),
  summary: z.looseObject({}).nullable(),
  matched: z.looseObject({}).nullable(),
  reused: z.boolean(),
  error: z.looseObject({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.string(),
  pollAfterSeconds: z.number().nullable(),
});

export const getLocalRankGridTool = {
  name: "get_local_rank_grid",
  description:
    "Runs one Google Maps search per point of a square grid around a coordinate and reports where the target business ranks at each point — plus each point's result count and #1 business — revealing how far its Maps visibility reaches. Cost scales with the grid: gridSize squared SERP calls (3x3 = 9, the sensible default; 5x5 = 25). Paid: call the price estimate for local.grid.run first and pass the approved maxUsd. The searches run as one queued batch that usually finishes within this call; if some are still running you get status 'processing'. Calling again with the same gridId or the same arguments within an hour collects the same searches at no extra charge, so repeat the call in about a minute to finish a 'processing' grid or to recover a lost response.",
  input: getLocalRankGridInput,
  output: getLocalRankGridOutput,
  handler: async (ctx: LocalToolContext, rawInput?: unknown) => {
    const input = getLocalRankGridInput.parse(rawInput ?? {});
    const ws = toolWorkspace(ctx);
    const deps = toolDeps(ctx);
    if (input.gridId) {
      const collect = ctx.deps?.collectGrid ?? collectGrid;
      const view = await collect(ws, input.gridId, deps);
      return getLocalRankGridOutput.parse(view);
    }
    const maxUsd = requireMaxUsd(input.maxUsd, "local.grid.run");
    if (!input.target) {
      throw new AppError(400, "grid_target_required", "Choose the business to find in each search.");
    }
    const start = ctx.deps?.startGrid ?? startGrid;
    const view = await start(
      ws,
      {
        keyword: input.keyword,
        center: input.center,
        gridSize: input.gridSize,
        spacingKm: input.spacingKm,
        device: input.device,
        zoom: input.zoom,
        languageCode: input.languageCode,
        target: input.target,
        maxUsd,
        requestId: requestIdOf(ctx),
      },
      deps,
    );
    return getLocalRankGridOutput.parse(view);
  },
};

// ---------------------------------------------------------------------------
// get_business_profile
// ---------------------------------------------------------------------------

const getBusinessProfileInput = z.strictObject({
  identifier: businessIdentifierSchema,
  near: nearSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  save: z.enum(["own", "competitor"]).optional(),
  maxUsd: z.number().positive().max(1000),
});

const getBusinessProfileOutput = z.looseObject({
  profile: z.looseObject({}).nullable(),
  businessId: z.string().nullable(),
});

export const getBusinessProfileTool = {
  name: "get_business_profile",
  description:
    "Reads one Google Business Profile by name, cid, or placeId: categories, rating and review count, rating breakdown, address, phone, website, claimed status, opening hours, and photo count. Use it to audit your own profile, to compare a named competitor's, or to check whether a business has a Google Business Profile at all — it is the cheapest tool for that question, less than half the credits of search_local_businesses. For identity or existence checks, reuse a business already present in your search results. Fetch the full profile when you need missing details such as opening hours or rating breakdown. Paid: call the price estimate for local.profile.lookup first and pass the approved maxUsd.",
  input: getBusinessProfileInput,
  output: getBusinessProfileOutput,
  handler: async (ctx: LocalToolContext, rawInput?: unknown) => {
    const input = getBusinessProfileInput.parse(rawInput ?? {});
    const ws = toolWorkspace(ctx) as Parameters<typeof lookupBusinessProfile>[0];
    const fn = ctx.deps?.lookupBusinessProfile ?? lookupBusinessProfile;
    const result = await fn(ws, { ...input, requestId: requestIdOf(ctx) }, toolDeps(ctx));
    return getBusinessProfileOutput.parse(result);
  },
};

// ---------------------------------------------------------------------------
// fetches (reviews / updates / questions)
// ---------------------------------------------------------------------------

const fetchViewOutput = z.looseObject({
  id: z.string(),
  kind: z.string(),
  status: z.enum(["processing", "completed", "failed"]),
  businessId: z.string().nullable(),
  params: z.looseObject({ depth: z.number() }),
  totals: z.looseObject({}).nullable(),
  items: z.array(z.unknown()).nullable(),
  itemCount: z.number(),
  reused: z.boolean(),
  error: z.looseObject({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  pollAfterSeconds: z.number().nullable(),
});

const getBusinessReviewsInput = z.strictObject({
  businessId: z.string().uuid().optional(),
  depth: z.union([z.literal(20), z.literal(50), z.literal(100), z.literal(200)]).optional(),
  sortBy: z.enum(["newest", "highest_rating", "lowest_rating", "relevant"]).optional(),
  includeOtherSources: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
  fetchId: z.string().uuid().optional(),
});

export const getBusinessReviewsTool = {
  name: "get_business_reviews",
  description:
    "Collects Google reviews for a business, with rating, author, text, and the owner's reply. Use it for review-gap analysis against competitors and to spot unanswered reviews. Usually completes within this call; if the queued job is still running you get status 'processing' plus a fetchId — call again with that fetchId in 30-60 seconds to collect the result at no extra cost. Paid: call the price estimate for local.reviews.collect first and pass the approved maxUsd.",
  input: getBusinessReviewsInput,
  output: fetchViewOutput,
  handler: async (ctx: LocalToolContext, rawInput?: unknown) => {
    const input = getBusinessReviewsInput.parse(rawInput ?? {});
    const ws = toolWorkspace(ctx) as Parameters<typeof startFetch>[0];
    const deps = toolDeps(ctx);
    if (input.fetchId) {
      return fetchViewOutput.parse(await resumeFetch(ctx, ws, input.fetchId, "reviews", deps));
    }
    const maxUsd = requireMaxUsd(input.maxUsd, "local.reviews.collect");
    if (!input.businessId || input.depth == null) {
      throw new AppError(400, "invalid_request", "Provide businessId and depth, or a fetchId to resume.");
    }
    const start = ctx.deps?.startFetch ?? startFetch;
    const view = await start(
      ws,
      {
        kind: "reviews",
        businessId: input.businessId,
        depth: input.depth,
        sortBy: input.sortBy,
        includeOtherSources: input.includeOtherSources,
        maxUsd,
        requestId: requestIdOf(ctx),
      },
      deps,
    );
    return fetchViewOutput.parse(view);
  },
};

const getBusinessUpdatesInput = z.strictObject({
  businessId: z.string().uuid().optional(),
  depth: z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)]).optional(),
  maxUsd: z.number().positive().max(1000).optional(),
  fetchId: z.string().uuid().optional(),
});

export const getBusinessUpdatesTool = {
  name: "get_business_updates",
  description:
    "Collects the posts (updates, offers, events) published on a Google Business Profile. Use it to check posting activity and recency on your profile or a competitor's. Usually completes within this call; a 'processing' response returns a fetchId to call back with in 30-60 seconds at no extra cost. Paid: call the price estimate for local.updates.collect first and pass the approved maxUsd.",
  input: getBusinessUpdatesInput,
  output: fetchViewOutput,
  handler: async (ctx: LocalToolContext, rawInput?: unknown) => {
    const input = getBusinessUpdatesInput.parse(rawInput ?? {});
    const ws = toolWorkspace(ctx) as Parameters<typeof startFetch>[0];
    const deps = toolDeps(ctx);
    if (input.fetchId) {
      return fetchViewOutput.parse(await resumeFetch(ctx, ws, input.fetchId, "updates", deps));
    }
    const maxUsd = requireMaxUsd(input.maxUsd, "local.updates.collect");
    if (!input.businessId || input.depth == null) {
      throw new AppError(400, "invalid_request", "Provide businessId and depth, or a fetchId to resume.");
    }
    const start = ctx.deps?.startFetch ?? startFetch;
    const view = await start(
      ws,
      { kind: "updates", businessId: input.businessId, depth: input.depth, maxUsd, requestId: requestIdOf(ctx) },
      deps,
    );
    return fetchViewOutput.parse(view);
  },
};

const getGoogleBusinessQuestionsInput = z.strictObject({
  businessId: z.string().uuid().optional(),
  depth: z.union([z.literal(20), z.literal(50), z.literal(100)]).optional(),
  maxUsd: z.number().positive().max(1000).optional(),
  fetchId: z.string().uuid().optional(),
});


export const getGoogleBusinessQuestionsTool = {
  name: "get_google_business_questions",
  description:
    "Fetches Google Business Profile questions and answers for one saved business (pass its businessId; save it first with get_business_profile, whose full profile also supplies the location the search needs). Run this only when Q&A evidence is needed. Usually completes within this call; a 'processing' response returns a fetchId to call back with in 30-60 seconds at no extra cost. Paid: call the price estimate for local.questions.collect first and pass the approved maxUsd.",
  input: getGoogleBusinessQuestionsInput,
  output: fetchViewOutput,
  handler: async (ctx: LocalToolContext, rawInput?: unknown) => {
    const input = getGoogleBusinessQuestionsInput.parse(rawInput ?? {});
    const ws = toolWorkspace(ctx) as Parameters<typeof startFetch>[0];
    const deps = toolDeps(ctx);
    if (input.fetchId) {
      return fetchViewOutput.parse(await resumeFetch(ctx, ws, input.fetchId, "questions", deps));
    }
    const maxUsd = requireMaxUsd(input.maxUsd, "local.questions.collect");
    if (!input.businessId || input.depth == null) {
      throw new AppError(400, "invalid_request", "Provide businessId and depth, or a fetchId to resume.");
    }
    const start = ctx.deps?.startFetch ?? startFetch;
    const view = await start(
      ws,
      { kind: "questions", businessId: input.businessId, depth: input.depth, maxUsd, requestId: requestIdOf(ctx) },
      deps,
    );
    return fetchViewOutput.parse(view);
  },
};

// ---------------------------------------------------------------------------
// list_business_categories (free)
// ---------------------------------------------------------------------------

const listBusinessCategoriesInput = z.strictObject({
  query: z.string().trim().min(1).max(80).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const listBusinessCategoriesOutput = z.looseObject({
  categories: z.array(z.looseObject({ category: z.string() })),
  total: z.number(),
});

export const listBusinessCategoriesTool = {
  name: "list_business_categories",
  description:
    "Lists the Google Business categories DataForSEO recognizes, ranked by how many businesses use them. Use it to find valid category slugs for search_local_businesses (e.g. 'pizza_restaurant'). Uses no credits (the full list is cached for 7 days).",
  input: listBusinessCategoriesInput,
  output: listBusinessCategoriesOutput,
  handler: async (ctx: LocalToolContext, rawInput?: unknown) => {
    const input = listBusinessCategoriesInput.parse(rawInput ?? {});
    const fn = ctx.deps?.listBusinessCategories ?? listBusinessCategories;
    const result = await fn(input, toolDeps(ctx));
    return listBusinessCategoriesOutput.parse(result);
  },
};

export const localTools = [
  searchLocalBusinessesTool,
  getLocalSerpResultsTool,
  getLocalRankGridTool,
  getBusinessProfileTool,
  getBusinessReviewsTool,
  getBusinessUpdatesTool,
  getGoogleBusinessQuestionsTool,
  listBusinessCategoriesTool,
];
