/**
 * F14 §6.2 / P1.T3.S3 — Assistant tool definitions for F22.
 *
 * Tools:
 * - `get_domain_overview`: Look up high-level organic traffic and keyword counts for a domain or subfolder.
 * - `get_ranked_keywords`: Fetch top organic ranked keywords for a domain or subfolder.
 *
 * Paid tools; inputs include `maxUsd`.
 * Both inputs are closed (`z.strictObject`) and both outputs are loose (`z.looseObject`).
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getOverview,
  getKeywordsPage,
  type DomainServiceDeps,
} from "./domainService.ts";
import { createLabsClient } from "../providers/dataforseo/labs.ts";
import {
  resolveLabsMarket,
  workspaceMarket,
} from "../../shared/keyword-locations.ts";

export type DomainToolBrand = {
  brandKey: string;
  website_host?: string;
  display_name?: string;
};

export type DomainToolContext = {
  brand: DomainToolBrand;
  admin?: SupabaseClient;
  userId?: string;
  requestId?: string;
  deps?: {
    getOverview?: typeof getOverview;
    getKeywordsPage?: typeof getKeywordsPage;
    createLabsClient?: typeof createLabsClient;
    serviceDeps?: Partial<DomainServiceDeps>;
  };
};

const getOverviewInput = z.strictObject({
  domain: z.string().min(1).max(2048),
  scope: z.enum(["subdomains", "subfolder"]).optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  maxUsd: z.number().nonnegative().optional(),
  cacheOnly: z.boolean().optional(),
});

const getOverviewOutput = z.looseObject({
  status: z.enum(["ok", "not_cached"]),
  domain: z.string(),
  displayTarget: z.string().optional(),
  scope: z.enum(["subdomains", "subfolder"]).optional(),
  organicTraffic: z.number().optional(),
  organicKeywords: z.number().optional(),
  hasData: z.boolean().optional(),
  cached: z.boolean().optional(),
  fetchedAt: z.string().optional(),
});

const getRankedKeywordsInput = z.strictObject({
  domain: z.string().min(1).max(2048),
  scope: z.enum(["subdomains", "subfolder"]).optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  page: z.number().int().min(1).max(100).default(1),
  pageSize: z.union([z.literal(50), z.literal(100), z.literal(200)]).default(50),
  sortMode: z.enum(["rank", "traffic", "volume", "score", "cpc"]).default("traffic"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  search: z.string().max(200).optional(),
  maxUsd: z.number().nonnegative().optional(),
  cacheOnly: z.boolean().optional(),
});

const getRankedKeywordsOutput = z.looseObject({
  status: z.enum(["ok", "not_cached"]),
  domain: z.string(),
  page: z.number().optional(),
  pageSize: z.number().optional(),
  totalCount: z.number().optional(),
  hasMore: z.boolean().optional(),
  keywords: z.array(z.unknown()).optional(),
  cached: z.boolean().optional(),
  fetchedAt: z.string().optional(),
});

export const getDomainOverviewTool = {
  name: "get_domain_overview",
  description:
    "Look up high-level organic traffic and keyword counts for a domain or subfolder. Paid tool; pass maxUsd to confirm approval.",
  input: getOverviewInput,
  output: getOverviewOutput,
  handler: async (ctx: DomainToolContext, rawInput?: unknown) => {
    const input = getOverviewInput.parse(rawInput ?? {});
    const getOverviewFn = ctx.deps?.getOverview ?? getOverview;
    const labs = (ctx.deps?.createLabsClient ?? createLabsClient)();
    const serviceDeps: DomainServiceDeps = {
      labs,
      brandKey: ctx.brand.brandKey,
      requestId: ctx.requestId ?? crypto.randomUUID(),
      maxUsd: input.maxUsd,
      cacheOnly: input.cacheOnly,
      ...ctx.deps?.serviceDeps,
    };
    const market = resolveLabsMarket(
      { locationCode: input.locationCode, languageCode: input.languageCode },
      workspaceMarket(ctx.brand),
    );
    const result = await getOverviewFn(
      {
        domain: input.domain,
        scope: input.scope,
        locationCode: market.locationCode,
        languageCode: market.languageCode,
      },
      serviceDeps,
    );
    if (!result) {
      return getOverviewOutput.parse({
        status: "not_cached",
        domain: input.domain,
        scope: input.scope ?? "subdomains",
      });
    }
    return getOverviewOutput.parse({
      status: "ok",
      ...result,
    });
  },
};

export const getRankedKeywordsTool = {
  name: "get_ranked_keywords",
  description:
    "Fetch top organic ranked keywords for a domain or subfolder. Paid tool; pass maxUsd to confirm approval.",
  input: getRankedKeywordsInput,
  output: getRankedKeywordsOutput,
  handler: async (ctx: DomainToolContext, rawInput?: unknown) => {
    const input = getRankedKeywordsInput.parse(rawInput ?? {});
    const getKeywordsPageFn = ctx.deps?.getKeywordsPage ?? getKeywordsPage;
    const labs = (ctx.deps?.createLabsClient ?? createLabsClient)();
    const serviceDeps: DomainServiceDeps = {
      labs,
      brandKey: ctx.brand.brandKey,
      requestId: ctx.requestId ?? crypto.randomUUID(),
      maxUsd: input.maxUsd,
      cacheOnly: input.cacheOnly,
      ...ctx.deps?.serviceDeps,
    };
    const market = resolveLabsMarket(
      { locationCode: input.locationCode, languageCode: input.languageCode },
      workspaceMarket(ctx.brand),
    );
    const result = await getKeywordsPageFn(
      {
        domain: input.domain,
        scope: input.scope,
        locationCode: market.locationCode,
        languageCode: market.languageCode,
        page: input.page,
        pageSize: input.pageSize,
        sortMode: input.sortMode,
        sortOrder: input.sortOrder,
        filters: {},
        search: input.search,
      },
      serviceDeps,
    );
    if (!result) {
      return getRankedKeywordsOutput.parse({
        status: "not_cached",
        domain: input.domain,
        page: input.page,
        pageSize: input.pageSize,
      });
    }
    return getRankedKeywordsOutput.parse({
      status: "ok",
      ...result,
    });
  },
};

export const domainTools = [getDomainOverviewTool, getRankedKeywordsTool];
