// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/dataforseo-research-tools.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { cached as defaultCached, type CacheDeps } from "../cache/providerCache.ts";
import { cachedIf, peekCached, CacheOnlyMiss } from "../research/cache.ts";
import { parseResearchTargetOrThrow } from "../research/target.ts";
import type { ResearchScope } from "../../shared/researchScope.ts";
import type { LabsClient, SerpCompetitorItem } from "../providers/dataforseo/labs.ts";
import { createLabsClient } from "../providers/dataforseo/labs.ts";
import {
  isLabsLocationCode,
  resolveLabsMarket,
  workspaceMarket,
} from "../../shared/keyword-locations.ts";
import {
  requireApprovedPrice,
  type PricingContext,
} from "../pricing/pricedActions.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import {
  appendResearch as defaultAppendResearch,
  declaredCompetitors as defaultDeclaredCompetitors,
} from "../projectContext/service.ts";
import { formatCompetitorsResearchSummary } from "./researchLog.ts";
import { AppError } from "../http/appError.ts";
import { toResearchError } from "../research/providerErrors.ts";
import { isFeatureEnabled } from "../features/flags.ts";

export const DOMAIN_CACHE_SCOPE = "workspace" as const;
export const DOMAIN_TTL_SECONDS = 12 * 60 * 60; // 12 hours

export const SERP_COMPETITOR_RESULT_TYPES = [
  "organic",
  "paid",
  "featured_snippet",
  "local_pack",
] as const;

export type SerpCompetitorResultType =
  (typeof SERP_COMPETITOR_RESULT_TYPES)[number];

export type SerpCompetitorSortBy =
  | "visibility"
  | "traffic_estimate"
  | "avg_position"
  | "keyword_count";

export type CompetitorRow = {
  domain: string;
  keywordsCount: number | null;
  avgPosition: number | null;
  medianPosition: number | null;
  visibility: number | null;
  etv: number | null;
  isOwnSite: boolean;
  isDeclaredCompetitor: boolean;
};

export type SerpCompetitorsDeps = {
  labs: LabsClient;
  brandKey: string;
  requestId: string;
  maxUsd?: number;
  cacheOnly?: boolean;
  cached?: typeof defaultCached;
  cacheDeps?: CacheDeps;
  declaredCompetitors?: typeof defaultDeclaredCompetitors;
  appendResearch?: typeof defaultAppendResearch;
  requireApprovedPrice?: typeof requireApprovedPrice;
  isFeatureEnabled?: typeof isFeatureEnabled;
};

const competitorCacheItemSchema = z.looseObject({
  domain: z.string(),
  keywordsCount: z.number().nullable().optional(),
  avgPosition: z.number().nullable().optional(),
  medianPosition: z.number().nullable().optional(),
  visibility: z.number().nullable().optional(),
  etv: z.number().nullable().optional(),
});

const competitorCacheSchema = z.array(competitorCacheItemSchema);

export function hostMatchesDomain(host: string, domain: string): boolean {
  const normalizedHost = host.replace(/^www\./, "").toLowerCase();
  const normalizedDomain = domain.replace(/^www\./, "").toLowerCase();
  return (
    normalizedHost === normalizedDomain ||
    normalizedHost.endsWith(`.${normalizedDomain}`)
  );
}

export function sortCompetitors<T extends Record<string, unknown>>(
  items: T[],
  sortBy: SerpCompetitorSortBy = "visibility",
): T[] {
  const direction = sortBy === "avg_position" ? 1 : -1;
  return [...items].sort((a, b) => {
    let aValue: number;
    let bValue: number;

    if (sortBy === "avg_position") {
      aValue = typeof a.avgPosition === "number" ? a.avgPosition : 0;
      bValue = typeof b.avgPosition === "number" ? b.avgPosition : 0;
    } else if (sortBy === "keyword_count") {
      aValue = typeof a.keywordsCount === "number" ? a.keywordsCount : 0;
      bValue = typeof b.keywordsCount === "number" ? b.keywordsCount : 0;
    } else if (sortBy === "traffic_estimate") {
      aValue = typeof a.etv === "number" ? a.etv : 0;
      bValue = typeof b.etv === "number" ? b.etv : 0;
    } else {
      aValue = typeof a.visibility === "number" ? a.visibility : 0;
      bValue = typeof b.visibility === "number" ? b.visibility : 0;
    }

    return (aValue - bValue) * direction;
  });
}

function mapRawItemToCacheRow(item: SerpCompetitorItem) {
  return {
    domain: typeof item.domain === "string" ? item.domain : "",
    keywordsCount:
      typeof item.keywords_count === "number" ? item.keywords_count : null,
    avgPosition:
      typeof item.avg_position === "number" ? item.avg_position : null,
    medianPosition:
      typeof item.median_position === "number" ? item.median_position : null,
    visibility: typeof item.visibility === "number" ? item.visibility : null,
    etv: typeof item.etv === "number" ? item.etv : null,
  };
}

export async function findSerpCompetitors(
  input: {
    targetDomain: string;
    keywords: string[];
    locationCode: number;
    languageCode: string;
    resultTypes?: SerpCompetitorResultType[];
    includeSubdomains?: boolean;
    limit?: number;
    sortBy?: SerpCompetitorSortBy;
    ownHost?: string;
    declaredCompetitors?: string[];
  },
  deps: SerpCompetitorsDeps,
): Promise<{
  competitors: CompetitorRow[];
  cached: boolean;
  fetchedAt: string;
  provenance: { gateway: "dataforseo" };
} | null> {
  const sortedKeywords = [...input.keywords].sort();
  const sortedResultTypes = input.resultTypes
    ? [...input.resultTypes].sort()
    : ["local_pack", "organic"];
  const includeSubdomains = input.includeSubdomains ?? true;
  const limit = input.limit ?? 50;

  const cacheInput = {
    namespace: "domain.competitors",
    version: 1,
    keyParts: [
      sortedKeywords,
      input.locationCode,
      input.languageCode,
      sortedResultTypes,
      includeSubdomains,
      limit,
    ],
    ttlSeconds: DOMAIN_TTL_SECONDS,
    schema: competitorCacheSchema,
    scope: DOMAIN_CACHE_SCOPE,
    brandKey: deps.brandKey,
  };

  let rows: Array<{
    domain: string;
    keywordsCount?: number | null;
    avgPosition?: number | null;
    medianPosition?: number | null;
    visibility?: number | null;
    etv?: number | null;
  }> = [];
  let cached = false;
  let fetchedAt = new Date().toISOString();

  if (deps.cacheOnly) {
    const peek = await peekCached(cacheInput, {
      cached: deps.cached,
      cacheDeps: deps.cacheDeps,
    });
    if (!peek) return null;
    rows = peek.value;
    cached = true;
    fetchedAt = peek.fetchedAt;
  } else {
    const fetchCompetitors = async () => {
      const response = await deps.labs.labs.serpCompetitors(
        {
          brandKey: deps.brandKey,
          feature: "domain.competitors",
          idempotencyKey: `domain.competitors:${deps.requestId}`,
          maxUsd: deps.maxUsd,
        },
        {
          keywords: input.keywords,
          locationCode: input.locationCode,
          languageCode: input.languageCode,
          itemTypes: input.resultTypes ?? ["organic", "local_pack"],
          includeSubdomains,
          limit,
          offset: 0,
        },
      );
      const items = Array.isArray(response) ? response : (response as any)?.data ?? [];
      return items.map(mapRawItemToCacheRow);
    };

    const result = await cachedIf(
      cacheInput,
      fetchCompetitors,
      (data) => data.length > 0,
      { cached: deps.cached, cacheDeps: deps.cacheDeps },
    );
    rows = result.value;
    cached = result.hit;
    fetchedAt = result.fetchedAt;
  }

  const targetHost = input.targetDomain.toLowerCase().replace(/^www\./, "");
  const ownHostNorm = (input.ownHost ?? "").toLowerCase().replace(/^www\./, "");
  const declaredList = (input.declaredCompetitors ?? []).map((d) =>
    d.toLowerCase().replace(/^www\./, ""),
  );

  const filtered = rows.filter((item) => {
    if (!item.domain) return false;
    return !hostMatchesDomain(item.domain, targetHost);
  });

  const mapped: CompetitorRow[] = filtered.map((item) => {
    const domain = item.domain.toLowerCase();
    const isOwnSite = Boolean(ownHostNorm && hostMatchesDomain(domain, ownHostNorm));
    const isDeclaredCompetitor = declaredList.some((d) =>
      hostMatchesDomain(domain, d),
    );

    return {
      domain: item.domain,
      keywordsCount: item.keywordsCount ?? null,
      avgPosition: item.avgPosition ?? null,
      medianPosition: item.medianPosition ?? null,
      visibility: item.visibility ?? null,
      etv: item.etv ?? null,
      isOwnSite,
      isDeclaredCompetitor,
    };
  });

  const sorted = sortCompetitors(mapped, input.sortBy ?? "visibility");
  const bounded = sorted.slice(0, limit);

  return {
    competitors: bounded,
    cached,
    fetchedAt,
    provenance: { gateway: "dataforseo" },
  };
}

export async function runSerpCompetitorsRequest(
  ws: Workspace,
  i: {
    domain: string;
    scope?: ResearchScope;
    locationCode?: number;
    languageCode?: string;
    keywords: string[];
    resultTypes?: SerpCompetitorResultType[];
    includeSubdomains?: boolean;
    sortBy?: SerpCompetitorSortBy;
    limit?: number;
    cacheOnly?: boolean;
    maxUsd?: number;
    requestId: string;
  },
  deps?: Partial<SerpCompetitorsDeps>,
): Promise<{
  status: "ok" | "not_cached";
  keywordCount: number;
  competitors: CompetitorRow[];
  cached?: boolean;
  fetchedAt?: string;
  provenance?: { gateway: "dataforseo" };
}> {
  const target = parseResearchTargetOrThrow(i.domain, i.scope);

  if (i.locationCode !== undefined && !isLabsLocationCode(i.locationCode)) {
    throw new AppError(
      400,
      "invalid_location",
      "Domain research is not available for this country.",
    );
  }

  const market = resolveLabsMarket(
    { locationCode: i.locationCode, languageCode: i.languageCode },
    workspaceMarket(ws.brand),
  );

  const limit = i.limit ?? 50;

  if (!i.cacheOnly) {
    const pricingCtx: PricingContext = {
      brandKey: ws.brandKey,
      admin: ws.admin,
      env: process.env,
      now: new Date(),
    };
    const approveFn = deps?.requireApprovedPrice ?? requireApprovedPrice;
    await approveFn(
      "domain.competitors.run",
      pricingCtx,
      {
        domain: target.display,
        scope: target.scope,
        locationCode: market.locationCode,
        languageCode: market.languageCode,
        keywordCount: i.keywords.length,
        limit,
      },
      i.maxUsd,
    );
  }

  const labs = deps?.labs ?? createLabsClient();
  const serviceDeps: SerpCompetitorsDeps = {
    labs,
    brandKey: ws.brandKey,
    requestId: i.requestId,
    maxUsd: i.maxUsd,
    cacheOnly: i.cacheOnly,
    ...deps,
  };

  const ownHost = (ws.brand?.website_host ?? "")
    .toLowerCase()
    .replace(/^www\./, "");

  let declaredList: string[] = [];
  try {
    const declaredFn = deps?.declaredCompetitors ?? defaultDeclaredCompetitors;
    const comps = await declaredFn(ws.admin, ws.brandKey);
    declaredList = comps.map((c) => c.domain);
  } catch {
    // If declared competitors lookup fails, proceed with empty list
  }

  let result;
  try {
    result = await findSerpCompetitors(
      {
        targetDomain: target.hostname,
        keywords: i.keywords,
        locationCode: market.locationCode,
        languageCode: market.languageCode,
        resultTypes: i.resultTypes,
        includeSubdomains: i.includeSubdomains,
        limit,
        sortBy: i.sortBy,
        ownHost,
        declaredCompetitors: declaredList,
      },
      serviceDeps,
    );
  } catch (err) {
    throw toResearchError(err, {
      unavailableCode: "domain_unavailable",
      unavailableMessage: "Domain data is unavailable right now. Please retry.",
    });
  }

  if (!result) {
    return {
      status: "not_cached",
      keywordCount: i.keywords.length,
      competitors: [],
    };
  }

  if (!result.cached && !i.cacheOnly) {
    const appendFn = deps?.appendResearch ?? defaultAppendResearch;
    try {
      await appendFn(ws.admin, {
        brandKey: ws.brandKey,
        kind: "domain.competitors",
        summary: formatCompetitorsResearchSummary({
          keywordCount: i.keywords.length,
          display: target.display,
          topDomains: result.competitors.map((c) => c.domain),
        }),
        author: "user",
        actorUserId: ws.user.id,
      });
    } catch (err) {
      console.error("appendResearch failed:", err);
    }
  }

  return {
    status: "ok",
    keywordCount: i.keywords.length,
    competitors: result.competitors,
    cached: result.cached,
    fetchedAt: result.fetchedAt,
    provenance: result.provenance,
  };
}
