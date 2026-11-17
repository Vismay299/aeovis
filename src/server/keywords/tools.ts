// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * F13 §6.2.6 — Tools for F22 in-app assistant.
 *
 * In Phase 2: `researchKeywordsTool` only.
 * Saved keyword tools (`listSavedKeywordsTool`, `saveKeywordsTool`) follow in Phase 3.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../shared/http/appError.ts";
import { normalizeKeyword, toMetricUpsertRow } from "./helpers.ts";
import { resolveResearchMarket } from "./market.ts";
import {
  research,
  type ResearchDeps,
} from "./research.ts";
import { upsertKeywordMetrics } from "./metricsStore.ts";
import {
  requireApprovedPrice,
  type PricingContext,
} from "../../shared/pricing/pricedActions.ts";
import "../../shared/pricing/actions/index.ts";
import { createLabsClient } from "../../shared/providers/dataforseo/labs.ts";
import { createGoogleAdsClient } from "../../shared/providers/dataforseo/google-ads.ts";
import { keepAlive as defaultKeepAlive } from "../keepAlive.js";
import type { CacheDeps } from "../cache/providerCache.ts";

import {
  saveKeywords,
  getSavedKeywords,
} from "./savedKeywords.ts";
import {
  createSavedKeywordsRepository,
  type SavedKeywordsRepository,
} from "./repository.ts";

export type KeywordToolBrand = {
  brandKey: string;
  website_host?: string;
  website?: string;
};

export type KeywordToolContext = {
  admin: SupabaseClient;
  brand: KeywordToolBrand;
  userId: string;
  deps?: {
    research?: typeof research;
    requireApprovedPrice?: typeof requireApprovedPrice;
    labs?: ResearchDeps["labs"];
    ads?: ResearchDeps["ads"];
    upsertMetrics?: ResearchDeps["upsertMetrics"];
    cacheDeps?: CacheDeps;
    repo?: SavedKeywordsRepository;
  };
};

export const researchKeywordsInput = z.strictObject({
  keyword: z.string().min(1).max(200),
  locationCode: z.number().int().positive().optional(),
  resultLimit: z
    .union([z.literal(150), z.literal(300), z.literal(500)])
    .default(150),
  maxUsd: z.number().positive().max(10),
});

export const researchKeywordsOutput = z.looseObject({
  rows: z.array(z.looseObject({})),
  source: z.string(),
  cached: z.boolean(),
});

export const researchKeywordsTool = {
  name: "research_keywords",
  description:
    "Buy keyword ideas for one seed keyword in one country (DataForSEO). Paid: call the price estimate first and pass the approved maxUsd. Results are cached for 24 hours.",
  input: researchKeywordsInput,
  output: researchKeywordsOutput,
  handler: async (
    ctx: KeywordToolContext,
    rawInput: unknown,
  ): Promise<z.infer<typeof researchKeywordsOutput>> => {
    const input = researchKeywordsInput.parse(rawInput);
    const seed = normalizeKeyword(input.keyword);
    if (!seed) {
      throw new AppError(400, "invalid_request", "Seed keyword cannot be empty.");
    }

    const host = ctx.brand.website_host ?? ctx.brand.brandKey;
    const market = resolveResearchMarket(
      { locationCode: input.locationCode },
      { website_host: host },
    );

    const pricingCtx: PricingContext = {
      brandKey: ctx.brand.brandKey,
      admin: ctx.admin,
      env: process.env,
      now: new Date(),
    };

    const approvePrice =
      ctx.deps?.requireApprovedPrice ?? requireApprovedPrice;
    const approval = await approvePrice(
      "keywords.research.run",
      pricingCtx,
      {
        keyword: seed,
        locationCode: market.locationCode,
        languageCode: market.languageCode,
        resultLimit: input.resultLimit,
        mode: "auto",
        clickstream: false,
        groupKeywords: false,
      },
      input.maxUsd,
    );

    const labs = ctx.deps?.labs ?? createLabsClient();
    const ads = ctx.deps?.ads ?? createGoogleAdsClient();
    const upsert =
      ctx.deps?.upsertMetrics ??
      (async (rows, mkt) => {
        if (!ctx.admin) return;
        const upsertRows = rows.map((r) =>
          toMetricUpsertRow(r, mkt, "labs"),
        );
        await upsertKeywordMetrics(ctx.admin, upsertRows);
      });

    const researchFn = ctx.deps?.research ?? research;
    const res = await researchFn(
      {
        keyword: seed,
        locationCode: market.locationCode,
        languageCode: market.languageCode,
        resultLimit: input.resultLimit,
        mode: "auto",
        clickstream: false,
        groupKeywords: false,
      },
      {
        labs,
        ads,
        upsertMetrics: upsert,
        requestId: crypto.randomUUID(),
        maxUsd: approval.approvedMaxUsd,
        brandKey: ctx.brand.brandKey,
        keepAlive: defaultKeepAlive,
        cachedDeps: ctx.deps?.cacheDeps
          ? { cacheDeps: ctx.deps.cacheDeps }
          : undefined,
      },
    );

    return {
      rows: res.result.rows,
      source: res.result.source,
      cached: res.cached,
    };
  },
};

export const listSavedKeywordsInput = z.strictObject({
  tagNames: z.array(z.string().min(1).max(64)).max(20).optional(),
  search: z.string().max(200).optional(),
  sort: z
    .enum(["searchVolume", "keywordDifficulty", "cpc", "keyword", "fetchedAt"])
    .default("searchVolume"),
  limit: z.number().int().min(1).max(250).default(100),
});

export const listSavedKeywordsOutput = z.looseObject({
  rows: z.array(z.looseObject({})),
  totalCount: z.number().int(),
});

export const listSavedKeywordsTool = {
  name: "list_saved_keywords",
  description:
    "List this workspace's saved keywords with volume, CPC, difficulty, intent and tags. Filter by tag names or text. Free.",
  input: listSavedKeywordsInput,
  output: listSavedKeywordsOutput,
  handler: async (
    ctx: KeywordToolContext,
    rawInput: unknown,
  ): Promise<z.infer<typeof listSavedKeywordsOutput>> => {
    const input = listSavedKeywordsInput.parse(rawInput);
    const repo =
      ctx.deps?.repo ?? createSavedKeywordsRepository(ctx.admin);
    const result = await getSavedKeywords(repo, {
      brandKey: ctx.brand.brandKey,
      search: input.search,
      tagNames: input.tagNames,
      sort: input.sort,
      pageSize: input.limit,
    });
    return {
      rows: result.rows,
      totalCount: result.totalCount,
    };
  },
};

export const saveKeywordsInput = z.strictObject({
  keywords: z.array(z.string().min(1).max(200)).min(1).max(100),
  tags: z.array(z.string().min(1).max(64)).max(5).optional(),
  locationCode: z.number().int().positive().optional(),
});

export const saveKeywordsOutput = z.looseObject({
  savedKeywordIds: z.array(z.string()),
  created: z.number().int(),
});

export const saveKeywordsTool = {
  name: "save_keywords",
  description:
    "Save keywords to this workspace's list, optionally adding tags (append only). Free. Ask the user before tagging broadly.",
  input: saveKeywordsInput,
  output: saveKeywordsOutput,
  handler: async (
    ctx: KeywordToolContext,
    rawInput: unknown,
  ): Promise<z.infer<typeof saveKeywordsOutput>> => {
    const input = saveKeywordsInput.parse(rawInput);
    const repo =
      ctx.deps?.repo ?? createSavedKeywordsRepository(ctx.admin);
    const host = ctx.brand.website_host ?? ctx.brand.brandKey;
    const market = resolveResearchMarket(
      { locationCode: input.locationCode },
      { website_host: host },
    );
    const result = await saveKeywords(repo, {
      brandKey: ctx.brand.brandKey,
      keywords: input.keywords,
      locationCode: market.locationCode,
      languageCode: market.languageCode,
      tags: input.tags,
      tagMode: "append",
      actorUserId: ctx.userId,
    });
    return {
      savedKeywordIds: result.savedKeywordIds,
      created: result.created,
    };
  },
};
