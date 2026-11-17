// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/dataforseo-research-tools.ts:284-309, 1001-1048
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { createHash } from "node:crypto";
import { z } from "zod";
import { workspaceMarket } from "../../shared/keyword-locations.ts";
import { safeHttpUrl } from "../../shared/safe-url.ts";
import { stableStringify } from "../cache/providerCache.ts";
import { createDataforseoClient } from "../../shared/providers/dataforseo/client.ts";
import { cachedIf } from "../research/cache.ts";
import { toResearchError } from "../research/providerErrors.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import { appendLocalResearch, serpResearchKey, serpResearchSummary } from "./research.ts";
import { LOCAL_SERP_ROW_FIELDS } from "./rowFields.ts";
import {
  DEFAULT_LOCAL_SERP_ZOOM,
  formatLocalSerpCoordinate,
  pickRowFields,
  readPath,
} from "./shared.ts";
import { LOCAL_UNAVAILABLE_MESSAGE, localStoreFor, type LocalDeps } from "./store.ts";

export const LOCAL_SERP_CACHE_TTL_SECONDS = 43_200;

export type LocalSerpRow = {
  rank: number | null;
  title: string | null;
  domain: string | null;
  url: string | null;
  phone: string | null;
  address: string | null;
  category: string | null;
  additionalCategories: string[];
  rating: number | null;
  votes: number | null;
  priceLevel: string | null;
  isClaimed: boolean | null;
  cid: string | null;
  placeId: string | null;
  latitude: number | null;
  longitude: number | null;
  totalPhotos: number | null;
  isOwn: boolean;
  isCompetitor: boolean;
};

export type LocalSerpInput = {
  keyword: string;
  near: { latitude: number; longitude: number; zoom?: number };
  searchType: "maps" | "local_finder";
  device: "desktop" | "mobile";
  depth: number;
  languageCode?: string;
  maxUsd?: number;
  requestId: string;
};

type Ws = Pick<Workspace, "brandKey" | "brand" | "admin"> & Partial<Pick<Workspace, "user">>;

const rowsSchema = z.object({ rows: z.array(z.record(z.string(), z.unknown())) });

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bareHost(host: string | null | undefined): string {
  return (host ?? "").toLowerCase().replace(/^www\./, "");
}

export function localSerpCacheParts(i: LocalSerpInput, languageCode: string): unknown[] {
  return [
    i.keyword.trim().toLowerCase(),
    i.near.latitude,
    i.near.longitude,
    i.near.zoom ?? DEFAULT_LOCAL_SERP_ZOOM,
    i.searchType,
    i.device,
    i.depth,
    languageCode,
  ];
}

export async function getLocalSerpResults(
  ws: Ws,
  i: LocalSerpInput,
  deps?: LocalDeps,
): Promise<{ results: LocalSerpRow[]; ownRank: number | null; cached: boolean; fetchedAt: string }> {
  const store = localStoreFor(ws, deps);
  const serp = deps?.serp ?? createDataforseoClient().serp;
  const languageCode = i.languageCode ?? workspaceMarket(ws.brand).languageCode;
  const zoom = i.near.zoom ?? DEFAULT_LOCAL_SERP_ZOOM;
  const keyword = i.keyword.trim();
  const parts = localSerpCacheParts(i, languageCode);

  let result: { value: z.infer<typeof rowsSchema>; hit: boolean; fetchedAt: string };
  try {
    result = await cachedIf(
      {
        namespace: "local.serp",
        version: 1,
        keyParts: parts,
        ttlSeconds: LOCAL_SERP_CACHE_TTL_SECONDS,
        scope: "global" as const,
        schema: rowsSchema,
      },
      async () => {
        const items = await serp.local(
          {
            brandKey: ws.brandKey,
            feature: "local.serp",
            idempotencyKey: `local.serp:${i.requestId}`,
            maxUsd: i.maxUsd,
          },
          {
            keyword,
            locationCoordinate: formatLocalSerpCoordinate({ ...i.near, zoom }),
            languageCode,
            searchType: i.searchType,
            device: i.device,
            depth: i.depth,
            searchPlaces: false,
          },
        );
        return {
          rows: items
            .filter((item) => typeof readPath(item, "title") === "string")
            .map((item) => pickRowFields(item, LOCAL_SERP_ROW_FIELDS)),
        };
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
  const own = saved.find((b) => b.role === "own");
  const ownHost = bareHost(ws.brand.website_host);
  const matchesSaved = (cid: string | null, placeId: string | null, role: "own" | "competitor") =>
    saved.some(
      (b) => b.role === role && ((cid != null && b.cid === cid) || (placeId != null && b.place_id === placeId)),
    );

  const results = result.value.rows.map((raw): LocalSerpRow => {
    const cid = str(raw.cid);
    const placeId = str(raw.place_id);
    const domain = str(raw.domain);
    const additional = readPath(raw, "additional_categories");
    const claimed = readPath(raw, "is_claimed");
    const price = raw.price_level;
    const byId = own != null && ((cid != null && own.cid === cid) || (placeId != null && own.place_id === placeId));
    const byDomain = ownHost !== "" && domain != null && bareHost(domain) === ownHost;
    return {
      rank: num(raw.rank_absolute) ?? num(raw.rank_group),
      title: str(raw.title),
      domain,
      url: safeHttpUrl(str(raw.url)),
      phone: str(raw.phone),
      address: str(raw.address),
      category: str(raw.category),
      additionalCategories: Array.isArray(additional)
        ? additional.filter((c): c is string => typeof c === "string")
        : [],
      rating: num(readPath(raw, "rating", "value")),
      votes: num(readPath(raw, "rating", "votes_count")),
      priceLevel: typeof price === "string" ? price : null,
      isClaimed: typeof claimed === "boolean" ? claimed : null,
      cid,
      placeId,
      latitude: num(raw.latitude),
      longitude: num(raw.longitude),
      totalPhotos: num(raw.total_photos),
      isOwn: byId || byDomain,
      isCompetitor: matchesSaved(cid, placeId, "competitor"),
    };
  });

  const ownRank = results.find((row) => row.isOwn && row.rank != null)?.rank ?? null;

  try {
    await store.recordSearch({
      brandKey: ws.brandKey,
      kind: "local_serp",
      params: {
        keyword,
        near: { latitude: i.near.latitude, longitude: i.near.longitude, zoom },
        searchType: i.searchType,
        device: i.device,
        depth: i.depth,
        languageCode,
      },
      resultCount: results.length,
      ownRank: ownRank != null && ownRank >= 1 && ownRank <= 700 ? ownRank : null,
      cacheKey: createHash("sha256").update(stableStringify(parts)).digest("hex"),
      cached: result.hit,
      requestedBy: ws.user?.id ?? null,
    });
  } catch (err) {
    console.error("[local] search history failed", err instanceof Error ? err.name : typeof err);
  }

  if (!result.hit && ws.user) {
    await appendLocalResearch(
      { admin: ws.admin, brandKey: ws.brandKey, user: ws.user },
      {
        kind: "local.serp",
        researchKey: serpResearchKey({
          keyword,
          latitude: i.near.latitude,
          longitude: i.near.longitude,
          zoom,
          searchType: i.searchType,
        }),
        summary: serpResearchSummary({
          keyword,
          latitude: i.near.latitude,
          longitude: i.near.longitude,
          count: results.length,
          ownRank,
        }),
      },
      deps,
    );
  }

  return { results, ownRank, cached: result.hit, fetchedAt: result.fetchedAt };
}
