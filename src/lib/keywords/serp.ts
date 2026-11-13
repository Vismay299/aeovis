// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/services/research/serp.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { AppError } from "../http/appError.ts";
import type { CacheDeps } from "../cache/providerCache.ts";
import { cachedIf, peekCached, CacheOnlyMiss } from "../research/cache.ts";
import type { SerpResultItem } from "../../shared/keywords.ts";
import type { SerpLiveItem } from "../providers/dataforseo/serp.ts";
import { createDataforseoClient } from "../providers/dataforseo/client.ts";
import { normalizeKeyword } from "./helpers.ts";
import { resolveResearchMarket } from "./market.ts";
import { assertLocalResearchLocation } from "./localVolume.ts";
import {
  requireApprovedPrice,
  type PricingContext,
} from "../pricing/pricedActions.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";

export const SERP_CACHE = {
  namespace: "keywords.serp",
  version: 1,
  ttlSeconds: 43200, // 12 hours
  scope: "global" as const,
};

export const serpResultItemSchema = z.looseObject({
  rank: z.number().int(),
  title: z.string(),
  url: z.string(),
  domain: z.string(),
  description: z.string(),
  etv: z.number().nullable(),
  estimatedPaidTrafficCost: z.number().nullable(),
  referringDomains: z.number().nullable(),
  backlinks: z.number().nullable(),
  isNew: z.boolean(),
  rankChange: z.number().nullable(),
});

export const serpAnalysisResultSchema = z.looseObject({
  requestedKeyword: z.string(),
  items: z.array(serpResultItemSchema),
  depth: z.number().int(),
  reason: z.enum(["no_organic_results"]).optional(),
});

export type SerpAnalysisResult = z.infer<typeof serpAnalysisResultSchema>;

export function serpCacheInput(
  input: {
    keyword: string;
    locationCode: number;
    languageCode: string;
    locationName?: string | null;
  },
  depth: number,
) {
  return {
    namespace: SERP_CACHE.namespace,
    version: SERP_CACHE.version,
    ttlSeconds: SERP_CACHE.ttlSeconds,
    scope: SERP_CACHE.scope,
    schema: serpAnalysisResultSchema,
    keyParts: [
      normalizeKeyword(input.keyword),
      input.locationCode,
      input.languageCode,
      input.locationName ?? null,
      depth,
    ],
  };
}

export function mapOrganicSerpItems(items: SerpLiveItem[]): SerpResultItem[] {
  return items
    .filter((item) => item.type === "organic")
    .map((item) => ({
      rank: item.rank_group ?? item.rank_absolute ?? 0,
      title: item.title ?? "",
      url: item.url ?? "",
      domain: item.domain ?? "",
      description: item.description ?? "",
      etv: item.etv ?? null,
      estimatedPaidTrafficCost: item.estimated_paid_traffic_cost ?? null,
      referringDomains: item.backlinks_info?.referring_domains ?? null,
      backlinks: item.backlinks_info?.backlinks ?? null,
      isNew: false,
      rankChange: null,
    }));
}

export type SerpClient = {
  live(
    call: {
      brandKey: string;
      feature: "keywords.serp";
      idempotencyKey: string;
      maxUsd?: number;
    },
    input: {
      keyword: string;
      locationCode: number;
      languageCode: string;
      locationName?: string;
      depth: number;
    },
  ): Promise<SerpLiveItem[]>;
};

export type SerpDeps = {
  serp: SerpClient;
  brandKey: string;
  requestId: string;
  maxUsd?: number;
  cachedDeps?: { cacheDeps?: CacheDeps };
  assertLocalLocation?(code: number, name: string): Promise<void>;
};

export async function getSerpAnalysis(
  input: {
    keyword: string;
    locationCode: number;
    languageCode: string;
    depth?: number;
    locationName?: string | null;
  },
  deps: SerpDeps,
): Promise<SerpAnalysisResult & { cached: boolean; fetchedAt: string }> {
  const keyword = normalizeKeyword(input.keyword);
  if (!keyword) {
    throw new AppError(400, "invalid_request", "Keyword cannot be empty.");
  }
  const depth = (input.depth === 100 ? 100 : 20) as 20 | 100;

  if (input.locationName && deps.assertLocalLocation) {
    await deps.assertLocalLocation(input.locationCode, input.locationName);
  }

  const fetchLive = (targetDepth: number) => async (): Promise<SerpAnalysisResult> => {
    const liveItems = await deps.serp.live(
      {
        brandKey: deps.brandKey,
        feature: "keywords.serp",
        idempotencyKey: `keywords.serp:${deps.requestId}`,
        maxUsd: deps.maxUsd,
      },
      {
        keyword,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        locationName: input.locationName ?? undefined,
        depth: targetDepth,
      },
    );

    const items = mapOrganicSerpItems(liveItems);
    const result: SerpAnalysisResult = {
      requestedKeyword: keyword,
      items,
      depth: targetDepth,
    };
    if (items.length === 0) {
      result.reason = "no_organic_results";
    }
    return result;
  };

  if (depth === 20) {
    const peek100 = await peekCached(
      serpCacheInput(input, 100),
      deps.cachedDeps,
    );
    if (peek100 && peek100.value.items.length > 0) {
      return {
        ...peek100.value,
        depth: 100,
        cached: true,
        fetchedAt: peek100.fetchedAt,
      };
    }

    const res = await cachedIf(
      serpCacheInput(input, 20),
      fetchLive(20),
      (r) => r.items.length > 0,
      deps.cachedDeps,
    );
    return {
      ...res.value,
      cached: res.hit,
      fetchedAt: res.fetchedAt,
    };
  }

  // depth === 100
  const res = await cachedIf(
    serpCacheInput(input, 100),
    fetchLive(100),
    (r) => r.items.length > 0,
    deps.cachedDeps,
  );
  return {
    ...res.value,
    cached: res.hit,
    fetchedAt: res.fetchedAt,
  };
}

export type RunSerpRequestInput = {
  keyword: string;
  locationCode?: number;
  languageCode?: string;
  locationName?: string | null;
  depth?: 20 | 100;
  maxUsd?: number;
  requestId: string;
  cacheOnly?: boolean;
};

export type RunSerpDeps = {
  serp?: SerpClient;
  cachedDeps?: { cacheDeps?: CacheDeps };
  assertLocalLocation?(code: number, name: string): Promise<void>;
  requireApprovedPrice?: typeof requireApprovedPrice;
};

export async function runSerpRequest(
  ws: Pick<Workspace, "brandKey" | "brand"> & Partial<Pick<Workspace, "user" | "role" | "admin">>,
  input: RunSerpRequestInput,
  deps?: RunSerpDeps,
): Promise<{
  items: SerpResultItem[];
  depth: number;
  cached: boolean;
  fetchedAt: string;
  requestedKeyword: string;
  reason?: "no_organic_results";
}> {
  const keyword = normalizeKeyword(input.keyword);
  if (!keyword) {
    throw new AppError(400, "invalid_request", "Keyword cannot be empty.");
  }
  const market = resolveResearchMarket(
    { locationCode: input.locationCode, languageCode: input.languageCode },
    ws.brand,
  );
  const depth = (input.depth === 100 ? 100 : 20) as 20 | 100;

  const targetInput = {
    keyword,
    locationCode: market.locationCode,
    languageCode: market.languageCode,
    locationName: input.locationName ?? null,
  };

  if (input.cacheOnly) {
    const peek100 = await peekCached(
      serpCacheInput(targetInput, 100),
      deps?.cachedDeps,
    );
    if (peek100 && peek100.value.items.length > 0) {
      return {
        ...peek100.value,
        depth: 100,
        cached: true,
        fetchedAt: peek100.fetchedAt,
      };
    }
    if (depth === 20) {
      const peek20 = await peekCached(
        serpCacheInput(targetInput, 20),
        deps?.cachedDeps,
      );
      if (peek20 && peek20.value.items.length > 0) {
        return {
          ...peek20.value,
          depth: 20,
          cached: true,
          fetchedAt: peek20.fetchedAt,
        };
      }
    }
    throw new CacheOnlyMiss();
  }

  // Check cache before spending or requiring approval
  if (depth === 20) {
    const peek100 = await peekCached(
      serpCacheInput(targetInput, 100),
      deps?.cachedDeps,
    );
    if (peek100 && peek100.value.items.length > 0) {
      return {
        ...peek100.value,
        depth: 100,
        cached: true,
        fetchedAt: peek100.fetchedAt,
      };
    }
    const peek20 = await peekCached(
      serpCacheInput(targetInput, 20),
      deps?.cachedDeps,
    );
    if (peek20 && peek20.value.items.length > 0) {
      return {
        ...peek20.value,
        depth: 20,
        cached: true,
        fetchedAt: peek20.fetchedAt,
      };
    }
  } else {
    const peek100 = await peekCached(
      serpCacheInput(targetInput, 100),
      deps?.cachedDeps,
    );
    if (peek100 && peek100.value.items.length > 0) {
      return {
        ...peek100.value,
        depth: 100,
        cached: true,
        fetchedAt: peek100.fetchedAt,
      };
    }
  }

  // Cache missed - require approved price before live metered call
  const pricingCtx: PricingContext = {
    brandKey: ws.brandKey,
    admin: ws.admin ?? ({} as any),
    env: process.env,
    now: new Date(),
  };

  const approveFn = deps?.requireApprovedPrice ?? requireApprovedPrice;
  const priceApproval = await approveFn(
    "keywords.serp.run",
    pricingCtx,
    {
      keyword,
      locationCode: market.locationCode,
      languageCode: market.languageCode,
      depth,
      locationName: input.locationName ?? undefined,
    },
    input.maxUsd,
  );

  const serpClient: SerpClient =
    deps?.serp ?? createDataforseoClient().serp;

  return await getSerpAnalysis(
    {
      keyword,
      locationCode: market.locationCode,
      languageCode: market.languageCode,
      depth,
      locationName: input.locationName,
    },
    {
      serp: serpClient,
      brandKey: ws.brandKey,
      requestId: input.requestId,
      maxUsd: priceApproval.approvedMaxUsd,
      cachedDeps: deps?.cachedDeps,
      assertLocalLocation:
        deps?.assertLocalLocation ??
        ((code, name) => assertLocalResearchLocation(code, name)),
    },
  );
}
