/**
 * F16 §6.2.3 / P2.T3.S3 — Assistant tool definitions for F22.
 *
 * Tools:
 * - `get_backlinks_overview`: Look up high-level backlink counts and metrics for a domain, subfolder or exact URL.
 * - `list_backlinks`: Fetch individual backlinks for a target.
 * - `list_referring_domains`: Fetch referring domains pointing to a domain or subdomains target.
 *
 * Paid tools; inputs include `maxUsd`.
 * All inputs are closed (`z.strictObject`) and all outputs are loose (`z.looseObject`).
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  profileOverview,
  profileBacklinksPage,
  profileReferringDomainsPage,
  type BacklinksServiceDeps,
} from "./backlinksService.ts";
import { createBacklinksClient } from "../../shared/providers/dataforseo/backlinks.ts";
import {
  backlinksRowsModeSchema,
  backlinksRowsSortFieldSchema,
  backlinksScopeParamSchema,
  referringDomainsSortFieldSchema,
} from "../../shared/backlinks.ts";
import { researchScopeSchema } from "../../shared/researchScope.ts";
import { listSnapshots } from "./snapshots.ts";
import { AppError } from "../../shared/http/appError.ts";

export type BacklinksToolBrand = {
  brandKey: string;
  website_host?: string;
  display_name?: string;
};

export type BacklinksToolContext = {
  brand: BacklinksToolBrand;
  admin?: SupabaseClient;
  userId?: string;
  requestId?: string;
  deps?: {
    profileOverview?: typeof profileOverview;
    profileBacklinksPage?: typeof profileBacklinksPage;
    profileReferringDomainsPage?: typeof profileReferringDomainsPage;
    createBacklinksClient?: typeof createBacklinksClient;
    serviceDeps?: Partial<BacklinksServiceDeps>;
  };
};

const getOverviewInput = z.strictObject({
  target: z.string().min(1).max(2048),
  scope: backlinksScopeParamSchema.optional(),
  maxUsd: z.number().nonnegative().optional(),
  cacheOnly: z.boolean().optional(),
});

const getOverviewOutput = z.looseObject({
  status: z.enum(["ok", "not_cached"]),
  target: z.string(),
  displayTarget: z.string().optional(),
  scope: researchScopeSchema.optional(),
  summary: z.looseObject({
    rank: z.number().nullable().optional(),
    backlinks: z.number().nullable().optional(),
    referringPages: z.number().nullable().optional(),
    referringDomains: z.number().nullable().optional(),
    brokenBacklinks: z.number().nullable().optional(),
    brokenPages: z.number().nullable().optional(),
    backlinksSpamScore: z.number().nullable().optional(),
    targetSpamScore: z.number().nullable().optional(),
    newBacklinks: z.number().nullable().optional(),
    lostBacklinks: z.number().nullable().optional(),
    newReferringDomains: z.number().nullable().optional(),
    lostReferringDomains: z.number().nullable().optional(),
  }).optional(),
  cached: z.boolean().optional(),
  fetchedAt: z.string().optional(),
});

const listBacklinksInput = z.strictObject({
  target: z.string().min(1).max(2048),
  scope: backlinksScopeParamSchema.optional(),
  page: z.number().int().min(1).max(100).default(1),
  pageSize: z.union([z.literal(50), z.literal(100), z.literal(200)]).default(50),
  sortField: backlinksRowsSortFieldSchema.default("firstSeen"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  mode: backlinksRowsModeSchema.default("one_per_domain"),
  hideSpam: z.boolean().default(true),
  maxUsd: z.number().nonnegative().optional(),
  cacheOnly: z.boolean().optional(),
});

const listBacklinksOutput = z.looseObject({
  status: z.enum(["ok", "not_cached"]),
  target: z.string(),
  page: z.number().optional(),
  pageSize: z.number().optional(),
  totalCount: z.number().optional(),
  hasMore: z.boolean().optional(),
  rows: z.array(z.unknown()).optional(),
  cached: z.boolean().optional(),
  fetchedAt: z.string().optional(),
});

const listReferringDomainsInput = z.strictObject({
  target: z.string().min(1).max(2048),
  scope: backlinksScopeParamSchema.optional(),
  page: z.number().int().min(1).max(100).default(1),
  pageSize: z.union([z.literal(50), z.literal(100), z.literal(200)]).default(50),
  sortField: referringDomainsSortFieldSchema.default("backlinks"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  maxUsd: z.number().nonnegative().optional(),
  cacheOnly: z.boolean().optional(),
});

const listReferringDomainsOutput = z.looseObject({
  status: z.enum(["ok", "not_cached"]),
  target: z.string(),
  page: z.number().optional(),
  pageSize: z.number().optional(),
  totalCount: z.number().optional(),
  hasMore: z.boolean().optional(),
  rows: z.array(z.unknown()).optional(),
  cached: z.boolean().optional(),
  fetchedAt: z.string().optional(),
});

export const getBacklinksOverviewTool = {
  name: "get_backlinks_overview",
  description:
    "Look up high-level backlink counts and metrics for a domain, subfolder or exact URL. Paid tool; pass maxUsd to confirm approval.",
  input: getOverviewInput,
  output: getOverviewOutput,
  handler: async (ctx: BacklinksToolContext, rawInput?: unknown) => {
    const input = getOverviewInput.parse(rawInput ?? {});
    const profileOverviewFn = ctx.deps?.profileOverview ?? profileOverview;
    const client = (ctx.deps?.createBacklinksClient ?? createBacklinksClient)();
    const serviceDeps: BacklinksServiceDeps = {
      client,
      brandKey: ctx.brand.brandKey,
      requestId: ctx.requestId ?? crypto.randomUUID(),
      maxUsd: input.maxUsd,
      cacheOnly: input.cacheOnly,
      ...ctx.deps?.serviceDeps,
    };
    const result = await profileOverviewFn(
      {
        target: input.target,
        scope: input.scope,
      },
      serviceDeps,
    );
    if (!result) {
      return getOverviewOutput.parse({
        status: "not_cached",
        target: input.target,
        scope: input.scope ?? "subdomains",
      });
    }
    return getOverviewOutput.parse({
      status: "ok",
      target: result.overview.target,
      displayTarget: result.overview.displayTarget,
      scope: result.overview.scope,
      summary: result.overview.summary,
      cached: result.cached,
      fetchedAt: result.fetchedAt,
    });
  },
};

export const listBacklinksTool = {
  name: "list_backlinks",
  description:
    "Fetch individual backlinks for a target. Paid tool; pass maxUsd to confirm approval.",
  input: listBacklinksInput,
  output: listBacklinksOutput,
  handler: async (ctx: BacklinksToolContext, rawInput?: unknown) => {
    const input = listBacklinksInput.parse(rawInput ?? {});
    const profileBacklinksPageFn =
      ctx.deps?.profileBacklinksPage ?? profileBacklinksPage;
    const client = (ctx.deps?.createBacklinksClient ?? createBacklinksClient)();
    const serviceDeps: BacklinksServiceDeps = {
      client,
      brandKey: ctx.brand.brandKey,
      requestId: ctx.requestId ?? crypto.randomUUID(),
      maxUsd: input.maxUsd,
      cacheOnly: input.cacheOnly,
      ...ctx.deps?.serviceDeps,
    };
    const result = await profileBacklinksPageFn(
      {
        target: input.target,
        scope: input.scope,
        page: input.page,
        pageSize: input.pageSize,
        sortField: input.sortField,
        sortOrder: input.sortOrder,
        mode: input.mode,
      },
      serviceDeps,
      { hideSpam: input.hideSpam },
    );
    if (!result) {
      return listBacklinksOutput.parse({
        status: "not_cached",
        target: input.target,
        page: input.page,
        pageSize: input.pageSize,
      });
    }
    return listBacklinksOutput.parse({
      status: "ok",
      target: input.target,
      page: result.page,
      pageSize: result.pageSize,
      totalCount: result.totalCount,
      hasMore: result.hasMore,
      rows: result.rows,
      cached: result.cached,
      fetchedAt: result.fetchedAt,
    });
  },
};

export const listReferringDomainsTool = {
  name: "list_referring_domains",
  description:
    "Fetch referring domains pointing to a domain or subdomains target. Paid tool; pass maxUsd to confirm approval.",
  input: listReferringDomainsInput,
  output: listReferringDomainsOutput,
  handler: async (ctx: BacklinksToolContext, rawInput?: unknown) => {
    const input = listReferringDomainsInput.parse(rawInput ?? {});
    const profileReferringDomainsPageFn =
      ctx.deps?.profileReferringDomainsPage ?? profileReferringDomainsPage;
    const client = (ctx.deps?.createBacklinksClient ?? createBacklinksClient)();
    const serviceDeps: BacklinksServiceDeps = {
      client,
      brandKey: ctx.brand.brandKey,
      requestId: ctx.requestId ?? crypto.randomUUID(),
      maxUsd: input.maxUsd,
      cacheOnly: input.cacheOnly,
      ...ctx.deps?.serviceDeps,
    };
    const result = await profileReferringDomainsPageFn(
      {
        target: input.target,
        scope: input.scope,
        page: input.page,
        pageSize: input.pageSize,
        sortField: input.sortField,
        sortOrder: input.sortOrder,
      },
      serviceDeps,
    );
    if (!result) {
      return listReferringDomainsOutput.parse({
        status: "not_cached",
        target: input.target,
        page: input.page,
        pageSize: input.pageSize,
      });
    }
    return listReferringDomainsOutput.parse({
      status: "ok",
      target: input.target,
      page: result.page,
      pageSize: result.pageSize,
      totalCount: result.totalCount,
      hasMore: result.hasMore,
      rows: result.rows,
      cached: result.cached,
      fetchedAt: result.fetchedAt,
    });
  },
};

const getBacklinkHistoryInput = z.strictObject({
  target: z.string().trim().min(3).max(255),
  scope: z.enum(["domain", "subdomains"]),
});

const getBacklinkHistoryOutput = z.looseObject({
  snapshots: z.array(
    z.looseObject({
      capturedOn: z.string(),
      source: z.enum(["scheduled", "lookup"]),
      rank: z.number().nullable(),
      backlinks: z.number().nullable(),
      referringDomains: z.number().nullable(),
      referringPages: z.number().nullable(),
      brokenBacklinks: z.number().nullable(),
      brokenPages: z.number().nullable(),
      newBacklinks: z.number().nullable(),
      lostBacklinks: z.number().nullable(),
      newReferringDomains: z.number().nullable(),
      lostReferringDomains: z.number().nullable(),
      backlinksSpamScore: z.number().nullable(),
      targetSpamScore: z.number().nullable(),
    }),
  ),
});

export const getBacklinkHistoryTool = {
  name: "get_backlink_history",
  description: "Read stored backlink snapshots for a tracked domain. Free; reads stored history only and never calls a provider.",
  input: getBacklinkHistoryInput,
  output: getBacklinkHistoryOutput,
  handler: async (ctx: BacklinksToolContext, rawInput?: unknown) => {
    const input = getBacklinkHistoryInput.parse(rawInput ?? {});
    if (!ctx.admin) throw new AppError(503, "snapshots_unavailable", "Backlink history is unavailable. Please retry.");
    const snapshots = await listSnapshots(ctx.admin, {
      brandKey: ctx.brand.brandKey,
      target: input.target,
      scope: input.scope,
    });
    return getBacklinkHistoryOutput.parse({ snapshots });
  },
};

export const backlinksTools = [
  getBacklinksOverviewTool,
  listBacklinksTool,
  listReferringDomainsTool,
  getBacklinkHistoryTool,
];
