// Route contracts for the Local SEO API (F17 §6.5). Requests are closed
// (z.strictObject); responses are loose so the provider-derived rows may grow.

import { z } from "zod";
import { defineRouteContract, type RouteContract } from "../http/routeContract.ts";
import {
  businessIdentifierSchema,
  listingsNearSchema,
  localSerpNearSchema,
  nearSchema,
} from "./shared.ts";

const brandKey = z.string().min(1).max(200).optional();
const maxUsd = z.number().positive().max(1000).optional();
const requestId = z.uuid();

export const LOCAL_COMMON_ERROR_CODES = [
  "invalid_request",
  "invalid_json",
  "auth_not_configured",
  "unauthenticated",
  "unauthorized",
  "membership_unavailable",
  "workspace_not_found",
  "cross_site",
  "feature_unavailable",
  "feature_disabled",
  "daily_cap",
  "workspace_cap",
  "price_changed",
  "approval_required",
  "duplicate_paid_call",
  "local_unavailable",
];

const FETCH_DEPTHS = {
  reviews: [20, 50, 100, 200],
  updates: [10, 20, 50, 100],
  questions: [20, 50, 100],
} as const;

// --- queries -----------------------------------------------------------------

export const localBrandQuery = z.strictObject({ brand_key: brandKey });

export const categoriesQuery = z.strictObject({
  brand_key: brandKey,
  q: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const fetchesQuery = z.strictObject({
  brand_key: brandKey,
  businessId: z.uuid().optional(),
  kind: z.enum(["reviews", "extended_reviews", "updates", "questions"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const gridsQuery = z.strictObject({
  brand_key: brandKey,
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const businessIdParams = z.strictObject({ businessId: z.uuid() });
export const fetchIdParams = z.strictObject({ fetchId: z.uuid() });
export const gridIdParams = z.strictObject({ gridId: z.uuid() });

// --- request bodies ----------------------------------------------------------

export const saveBusinessBody = z.strictObject({
  brand_key: brandKey,
  role: z.enum(["own", "competitor"]),
  title: z.string().trim().min(1).max(300),
  cid: z.string().regex(/^[0-9]{1,30}$/).optional(),
  placeId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_:-]+$/).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  locationCode: z.number().int().min(1000).max(9_999_999).optional(),
  languageCode: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/).optional(),
});

export const updateBusinessBody = z.strictObject({
  brand_key: brandKey,
  role: z.enum(["own", "competitor"]),
});

export const profileBody = z.strictObject({
  brand_key: brandKey,
  identifier: businessIdentifierSchema,
  near: nearSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  save: z.enum(["own", "competitor"]).optional(),
  maxUsd,
  requestId,
});

export const refreshProfileBody = z.strictObject({
  brand_key: brandKey,
  maxUsd,
  requestId,
});

export const listingsBody = z.strictObject({
  brand_key: brandKey,
  near: listingsNearSchema,
  query: z.string().trim().min(1).max(200).optional(),
  categories: z.array(z.string().min(1).max(120)).max(10).optional(),
  minRating: z.number().min(1).max(5).optional(),
  minReviews: z.number().int().min(0).optional(),
  isClaimed: z.boolean().optional(),
  sortBy: z.enum(["relevance", "rating", "reviews"]).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(1000).default(0),
  maxUsd,
  requestId,
});

export const startFetchBody = z
  .strictObject({
    brand_key: brandKey,
    kind: z.enum(["reviews", "updates", "questions"]),
    businessId: z.uuid(),
    depth: z.number().int(),
    sortBy: z.enum(["newest", "highest_rating", "lowest_rating", "relevant"]).optional(),
    includeOtherSources: z.boolean().optional(),
    maxUsd,
    requestId,
  })
  .superRefine((value, ctx) => {
    const allowed: readonly number[] = FETCH_DEPTHS[value.kind];
    if (!allowed.includes(value.depth)) {
      ctx.addIssue({ code: "custom", path: ["depth"], message: `depth must be one of ${allowed.join(", ")}` });
    }
  });

export const serpBody = z.strictObject({
  brand_key: brandKey,
  keyword: z.string().trim().min(1).max(120),
  near: localSerpNearSchema,
  searchType: z.enum(["maps", "local_finder"]).default("maps"),
  device: z.enum(["desktop", "mobile"]).default("mobile"),
  depth: z.number().int().min(1).max(100).default(20),
  languageCode: z.string().min(2).max(8).optional(),
  maxUsd,
  requestId,
});

export const startGridBody = z.strictObject({
  brand_key: brandKey,
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
  target: z.strictObject({
    businessId: z.uuid().optional(),
    cid: z.string().regex(/^[0-9]{1,30}$/).optional(),
    placeId: z.string().min(1).max(256).optional(),
    name: z.string().trim().min(1).max(200).optional(),
  }),
  maxUsd,
  requestId,
});

// --- responses (loose) -------------------------------------------------------

const businessView = z.looseObject({
  id: z.string(),
  role: z.enum(["own", "competitor"]),
  title: z.string(),
  cid: z.string().nullable(),
  placeId: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  profile: z.looseObject({}).nullable(),
  profileFetchedAt: z.string().nullable(),
});

const errorView = z.looseObject({ code: z.string(), message: z.string() }).nullable();

export const fetchViewSchema = z.looseObject({
  id: z.string(),
  kind: z.enum(["reviews", "extended_reviews", "updates", "questions"]),
  status: z.enum(["processing", "completed", "failed"]),
  businessId: z.string().nullable(),
  params: z.looseObject({ depth: z.number() }),
  totals: z.looseObject({}).nullable(),
  items: z.array(z.unknown()).nullable(),
  itemCount: z.number(),
  reused: z.boolean(),
  error: errorView,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  pollAfterSeconds: z.number().nullable(),
});

export const gridViewSchema = z.looseObject({
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
  error: errorView,
  createdAt: z.string(),
  pollAfterSeconds: z.number().nullable(),
});

const businessesResponse = z.looseObject({ businesses: z.array(businessView) });
const businessResponse = z.looseObject({ business: businessView });
const removedResponse = z.looseObject({ removed: z.boolean() });
const profileResponse = z.looseObject({
  profile: z.looseObject({}).nullable(),
  businessId: z.string().nullable().optional(),
});
const listingsResponse = z.looseObject({
  businesses: z.array(z.looseObject({ title: z.string().nullable(), isSaved: z.enum(["own", "competitor"]).nullable() })),
  cached: z.boolean(),
  fetchedAt: z.string(),
});
const categoriesResponse = z.looseObject({
  categories: z.array(z.looseObject({ category: z.string(), businessCount: z.number().nullable() })),
  total: z.number(),
});
const fetchesResponse = z.looseObject({
  fetches: z.array(
    z.looseObject({
      id: z.string(),
      kind: z.string(),
      status: z.string(),
      itemCount: z.number(),
      createdAt: z.string(),
      params: z.looseObject({}),
    }),
  ),
});
const serpResponse = z.looseObject({
  results: z.array(z.looseObject({ rank: z.number().nullable(), title: z.string().nullable(), isOwn: z.boolean() })),
  ownRank: z.number().nullable(),
  cached: z.boolean(),
  fetchedAt: z.string(),
});
const gridsResponse = z.looseObject({
  grids: z.array(
    z.looseObject({
      id: z.string(),
      keyword: z.string(),
      gridSize: z.number(),
      spacingKm: z.number(),
      status: z.string(),
      summary: z.looseObject({}).nullable(),
      createdAt: z.string(),
    }),
  ),
});

// --- examples ----------------------------------------------------------------

const ID = "3c1e4f6a-0b7d-4c1a-9a55-2d3f4a5b6c7d";
const ISO = "2026-10-22T08:10:00.000Z";
const exampleBusiness = {
  id: ID,
  role: "own" as const,
  title: "Offcult Store",
  cid: "1234567890123456789",
  placeId: "ChIJ-example-place",
  latitude: 19.076,
  longitude: 72.8777,
  profile: null,
  profileFetchedAt: null,
};
const exampleFetch = {
  id: ID,
  kind: "reviews" as const,
  status: "completed" as const,
  businessId: ID,
  params: { depth: 20, sortBy: "newest", includeOtherSources: false },
  totals: { reviewsCount: 210, rating: 4.6, title: "Offcult Store" },
  items: [{ rank_absolute: 1, rating: { value: 5 }, review_text: "Great store." }],
  itemCount: 1,
  reused: false,
  error: null,
  createdAt: ISO,
  completedAt: ISO,
  pollAfterSeconds: null,
};
const exampleProcessingFetch = { ...exampleFetch, status: "processing" as const, items: null, itemCount: 0, completedAt: null, pollAfterSeconds: 5 };
const exampleGrid = {
  id: ID,
  status: "completed" as const,
  keyword: "streetwear store",
  center: { latitude: 19.076, longitude: 72.8777 },
  gridSize: 3,
  spacingKm: 2,
  zoom: 13,
  device: "mobile" as const,
  pointsReady: 9,
  pointsTotal: 9,
  points: [{ row: 0, col: 0, latitude: 19.0940872, longitude: 72.8586652, rank: 6, resultsCount: 20, topResult: { title: "Bonkers Corner", cid: "987" } }],
  summary: { pointsSearched: 9, pointsFound: 7, failed: 1, averageRank: 4.29, top3Count: 3, top10Count: 7 },
  matched: { title: "Offcult Store", cid: "1234567890123456789", placeId: "ChIJ-example-place" },
  reused: false,
  error: null,
  createdAt: ISO,
  pollAfterSeconds: null,
};
const exampleProcessingGrid = { ...exampleGrid, status: "processing" as const, pointsReady: 3, points: null, summary: null, matched: null, pollAfterSeconds: 5 };

const BASE = "/api/customer/local";
const ROUTE = "src/app/api/customer/local";

function contract(
  id: string,
  method: RouteContract["method"],
  path: string,
  file: string,
  parts: Pick<RouteContract, "request" | "query" | "response" | "examples"> & { extraErrors?: string[] },
): RouteContract {
  const { extraErrors, ...rest } = parts;
  return defineRouteContract({
    id: `customer.local.${id}`,
    method,
    path: `${BASE}${path}`,
    file: `${ROUTE}/${file}`,
    auth: "workspace",
    errorCodes: [...LOCAL_COMMON_ERROR_CODES, ...(extraErrors ?? [])],
    ...rest,
  });
}

export const contracts: RouteContract[] = [
  contract("businesses.list", "GET", "/businesses", "businesses/route.ts", {
    query: localBrandQuery,
    response: businessesResponse,
    examples: [{ response: { businesses: [exampleBusiness] } }],
  }),
  contract("businesses.save", "POST", "/businesses", "businesses/route.ts", {
    request: saveBusinessBody,
    response: businessResponse,
    examples: [{ response: { business: exampleBusiness } }],
    extraErrors: ["identifier_required", "competitor_limit"],
  }),
  contract("businesses.update", "PATCH", "/businesses/[businessId]", "businesses/[businessId]/route.ts", {
    request: updateBusinessBody,
    response: businessResponse,
    examples: [{ response: { business: exampleBusiness } }],
    extraErrors: ["business_not_found", "competitor_limit"],
  }),
  contract("businesses.remove", "DELETE", "/businesses/[businessId]", "businesses/[businessId]/route.ts", {
    query: localBrandQuery,
    response: removedResponse,
    examples: [{ response: { removed: true } }],
    extraErrors: ["business_not_found"],
  }),
  contract("profile.lookup", "POST", "/profile", "profile/route.ts", {
    request: profileBody,
    response: profileResponse,
    examples: [{ response: { profile: { title: "Offcult Store", category: "Clothing store" }, businessId: ID } }, { response: { profile: null, businessId: null } }],
    extraErrors: ["identifier_required", "competitor_limit"],
  }),
  contract("profile.refresh", "POST", "/businesses/[businessId]/profile", "businesses/[businessId]/profile/route.ts", {
    request: refreshProfileBody,
    response: profileResponse,
    examples: [{ response: { profile: { title: "Offcult Store" } } }],
    extraErrors: ["business_not_found", "identifier_required"],
  }),
  contract("listings.search", "POST", "/listings", "listings/route.ts", {
    request: listingsBody,
    response: listingsResponse,
    examples: [{ response: { businesses: [{ title: "Bonkers Corner", category: "Clothing store", rating: 4.3, votes: 812, isClaimed: true, isSaved: null }], cached: false, fetchedAt: ISO } }],
  }),
  contract("categories.list", "GET", "/categories", "categories/route.ts", {
    query: categoriesQuery,
    response: categoriesResponse,
    examples: [{ response: { categories: [{ category: "clothing_store", businessCount: 512334 }], total: 1 } }],
  }),
  contract("fetches.start", "POST", "/fetches", "fetches/route.ts", {
    request: startFetchBody,
    response: fetchViewSchema,
    examples: [{ response: exampleFetch }, { response: exampleProcessingFetch }],
    extraErrors: ["business_not_found", "business_location_required", "identifier_required"],
  }),
  contract("fetches.list", "GET", "/fetches", "fetches/route.ts", {
    query: fetchesQuery,
    response: fetchesResponse,
    examples: [{ response: { fetches: [{ id: ID, kind: "reviews", status: "completed", itemCount: 20, createdAt: ISO, params: { depth: 20 } }] } }],
  }),
  contract("fetches.get", "GET", "/fetches/[fetchId]", "fetches/[fetchId]/route.ts", {
    query: localBrandQuery,
    response: fetchViewSchema,
    examples: [{ response: exampleFetch }, { response: exampleProcessingFetch }],
    extraErrors: ["fetch_not_found"],
  }),
  contract("serp.search", "POST", "/serp", "serp/route.ts", {
    request: serpBody,
    response: serpResponse,
    examples: [{ response: { results: [{ rank: 1, title: "Bonkers Corner", rating: 4.6, votes: 1203, isOwn: false }], ownRank: 4, cached: true, fetchedAt: ISO } }],
  }),
  contract("grids.start", "POST", "/grids", "grids/route.ts", {
    request: startGridBody,
    response: gridViewSchema,
    examples: [{ response: exampleGrid }, { response: exampleProcessingGrid }],
    extraErrors: ["grid_target_required", "business_not_found", "local_grid_limit", "local_grid_failed"],
  }),
  contract("grids.list", "GET", "/grids", "grids/route.ts", {
    query: gridsQuery,
    response: gridsResponse,
    examples: [{ response: { grids: [{ id: ID, keyword: "streetwear store", gridSize: 3, spacingKm: 2, status: "completed", summary: exampleGrid.summary, createdAt: ISO }] } }],
  }),
  contract("grids.get", "GET", "/grids/[gridId]", "grids/[gridId]/route.ts", {
    query: localBrandQuery,
    response: gridViewSchema,
    examples: [{ response: exampleGrid }, { response: exampleProcessingGrid }],
    extraErrors: ["grid_not_found"],
  }),
];
