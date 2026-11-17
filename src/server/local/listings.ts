// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/dataforseo-research-tools.ts:229-282, 533-559, 954-999
//   src/server/mcp/tools/local-seo-tools.ts:594-689
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { createHash } from "node:crypto";
import { z } from "zod";
import { safeHttpUrl } from "../../shared/safe-url.ts";
import { stableStringify } from "../cache/providerCache.ts";
import {
  createBusinessClient,
  fetchBusinessListingsCategories,
  type BusinessCategoryRow,
} from "../../shared/providers/dataforseo/business.ts";
import { joinClauses, type FilterClause } from "../../shared/providers/dataforseo/filters.ts";
import { cachedIf } from "../research/cache.ts";
import { toResearchError } from "../research/providerErrors.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import { LOCAL_BUSINESS_ROW_FIELDS } from "./rowFields.ts";
import { formatBusinessListingsCoordinate, pickRowFields, readPath } from "./shared.ts";
import { LOCAL_UNAVAILABLE_MESSAGE, localStoreFor, type LocalDeps } from "./store.ts";

export const LISTINGS_CACHE_TTL_SECONDS = 86_400;
export const CATEGORIES_CACHE_TTL_SECONDS = 604_800;

export type LocalBusinessRow = {
  title: string | null;
  category: string | null;
  additionalCategories: string[];
  rating: number | null;
  votes: number | null;
  isClaimed: boolean | null;
  domain: string | null;
  url: string | null;
  phone: string | null;
  address: string | null;
  cid: string | null;
  placeId: string | null;
  latitude: number | null;
  longitude: number | null;
  totalPhotos: number | null;
  checkUrl: string | null;
  isSaved: "own" | "competitor" | null;
};

export type ListingsInput = {
  near: { latitude: number; longitude: number; radiusKm: number };
  query?: string;
  categories?: string[];
  minRating?: number;
  minReviews?: number;
  isClaimed?: boolean;
  sortBy?: "relevance" | "rating" | "reviews";
  limit: number;
  offset: number;
  maxUsd?: number;
  requestId: string;
};

type Ws = Pick<Workspace, "brandKey" | "admin"> & Partial<Pick<Workspace, "user">>;

const rowsSchema = z.object({ rows: z.array(z.record(z.string(), z.unknown())) });
const categoriesSchema = z.object({
  categories: z.array(z.object({ category: z.string(), businessCount: z.number().nullable() })),
});

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildListingsFilters(i: { minRating?: number; minReviews?: number }): unknown[] | undefined {
  const clauses: FilterClause[] = [];
  if (i.minRating != null) clauses.push(["rating.value", ">=", i.minRating]);
  if (i.minReviews != null) clauses.push(["rating.votes_count", ">=", i.minReviews]);
  if (clauses.length === 0) return undefined;
  return joinClauses(clauses, "and");
}

export function listingsOrderBy(sortBy: ListingsInput["sortBy"]): string[] | undefined {
  if (sortBy === "rating") return ["rating.value,desc"];
  if (sortBy === "reviews") return ["rating.votes_count,desc"];
  return undefined;
}

export function toLocalBusinessRow(raw: Record<string, unknown>): Omit<LocalBusinessRow, "isSaved"> {
  const additional = readPath(raw, "additional_categories");
  const claimed = readPath(raw, "is_claimed");
  return {
    title: str(raw.title),
    category: str(raw.category),
    additionalCategories: Array.isArray(additional) ? additional.filter((c): c is string => typeof c === "string") : [],
    rating: num(readPath(raw, "rating", "value")),
    votes: num(readPath(raw, "rating", "votes_count")),
    isClaimed: typeof claimed === "boolean" ? claimed : null,
    domain: str(raw.domain),
    url: safeHttpUrl(str(raw.url)),
    phone: str(raw.phone),
    address: str(raw.address),
    cid: str(raw.cid),
    placeId: str(raw.place_id),
    latitude: num(raw.latitude),
    longitude: num(raw.longitude),
    totalPhotos: num(raw.total_photos),
    checkUrl: safeHttpUrl(str(raw.check_url)),
  };
}

export function listingsCacheParts(i: ListingsInput): unknown[] {
  return [
    i.near.latitude,
    i.near.longitude,
    i.near.radiusKm,
    i.query ?? null,
    i.categories ?? null,
    i.minRating ?? null,
    i.minReviews ?? null,
    i.isClaimed ?? null,
    i.sortBy ?? "relevance",
    i.limit,
    i.offset,
  ];
}

export function listingsCacheInput(i: ListingsInput) {
  return {
    namespace: "local.listings",
    version: 1,
    keyParts: listingsCacheParts(i),
    ttlSeconds: LISTINGS_CACHE_TTL_SECONDS,
    scope: "global" as const,
    schema: rowsSchema,
  };
}

export async function searchLocalBusinesses(
  ws: Ws,
  i: ListingsInput,
  deps?: LocalDeps,
): Promise<{ businesses: LocalBusinessRow[]; cached: boolean; fetchedAt: string }> {
  const business = deps?.business ?? createBusinessClient();
  const store = localStoreFor(ws, deps);

  let result: { value: z.infer<typeof rowsSchema>; hit: boolean; fetchedAt: string };
  try {
    result = await cachedIf(
      listingsCacheInput(i),
      async () => {
        const items = await business.businessListings(
          {
            brandKey: ws.brandKey,
            feature: "local.business",
            idempotencyKey: `local.listings:${i.requestId}`,
            maxUsd: i.maxUsd,
          },
          {
            categories: i.categories,
            title: i.query,
            locationCoordinate: formatBusinessListingsCoordinate(i.near),
            isClaimed: i.isClaimed,
            filters: buildListingsFilters(i),
            orderBy: listingsOrderBy(i.sortBy),
            limit: i.limit,
            offset: i.offset,
          },
        );
        return { rows: items.map((item) => pickRowFields(item, LOCAL_BUSINESS_ROW_FIELDS)) };
      },
      (value) => value.rows.length > 0,
      deps?.cacheDeps ? { cacheDeps: deps.cacheDeps } : undefined,
    );
  } catch (err) {
    throw toResearchError(err, {
      unavailableCode: "local_unavailable",
      unavailableMessage: LOCAL_UNAVAILABLE_MESSAGE,
    });
  }

  const saved = await store.listBusinesses(ws.brandKey);
  const businesses = result.value.rows.map((raw): LocalBusinessRow => {
    const row = toLocalBusinessRow(raw);
    const match = saved.find(
      (b) => (row.cid != null && b.cid === row.cid) || (row.placeId != null && b.place_id === row.placeId),
    );
    return { ...row, isSaved: match?.role ?? null };
  });

  try {
    await store.recordSearch({
      brandKey: ws.brandKey,
      kind: "listings",
      params: {
        near: i.near,
        query: i.query ?? null,
        categories: i.categories ?? null,
        minRating: i.minRating ?? null,
        minReviews: i.minReviews ?? null,
        isClaimed: i.isClaimed ?? null,
        sortBy: i.sortBy ?? "relevance",
        limit: i.limit,
        offset: i.offset,
      },
      resultCount: businesses.length,
      ownRank: null,
      cacheKey: createHash("sha256").update(stableStringify(listingsCacheParts(i))).digest("hex"),
      cached: result.hit,
      requestedBy: ws.user?.id ?? null,
    });
  } catch (err) {
    console.error("[local] search history failed", err instanceof Error ? err.name : typeof err);
  }

  return { businesses, cached: result.hit, fetchedAt: result.fetchedAt };
}

export async function listBusinessCategories(
  i: { query?: string; limit: number },
  deps?: LocalDeps,
): Promise<{ categories: BusinessCategoryRow[]; total: number }> {
  const fetchCategories = deps?.fetchCategories ?? fetchBusinessListingsCategories;
  let all: BusinessCategoryRow[];
  try {
    const res = await cachedIf(
      {
        namespace: "local.categories",
        version: 1,
        keyParts: [],
        ttlSeconds: CATEGORIES_CACHE_TTL_SECONDS,
        scope: "global" as const,
        schema: categoriesSchema,
      },
      async () => ({ categories: (await fetchCategories()).data }),
      (value) => value.categories.length > 0,
      deps?.cacheDeps ? { cacheDeps: deps.cacheDeps } : undefined,
    );
    all = res.value.categories;
  } catch (err) {
    throw toResearchError(err, {
      unavailableCode: "local_unavailable",
      unavailableMessage: LOCAL_UNAVAILABLE_MESSAGE,
    });
  }
  const needle = i.query?.trim().toLowerCase();
  const matches = needle ? all.filter((row) => row.category.toLowerCase().includes(needle)) : all;
  return { categories: matches.slice(0, i.limit), total: matches.length };
}
