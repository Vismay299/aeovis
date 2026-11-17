import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  runSerpRequest,
  type RunSerpDeps,
  type RunSerpRequestInput,
} from "../../keywords/serp.ts";
import { runSerpCompetitorsRequest } from "../../domain/serpCompetitors.ts";
import type { ToolDefinition } from "../types.ts";
import { toWorkspace } from "./workspace.ts";

const serpInput = z.strictObject({
  keyword: z.string().trim().min(1).max(200),
  locationCode: z.int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  depth: z.union([z.literal(20), z.literal(100)]).default(20),
  maxUsd: z.number().positive().max(1000),
});

const serpOutput = z.looseObject({
  items: z.array(
    z.looseObject({
      rank: z.number(),
      title: z.string(),
      url: z.string(),
      domain: z.string(),
      description: z.string(),
    }),
  ),
  cached: z.boolean(),
  fetchedAt: z.string(),
  depth: z.number(),
});

const competitorsInput = z.strictObject({
  domain: z.string().trim().min(1).max(253),
  keywords: z.array(z.string().trim().min(1).max(120)).min(1).max(100),
  limit: z.int().min(10).max(100).default(50),
  maxUsd: z.number().positive().max(1000),
});

const competitorsOutput = z.looseObject({
  competitors: z.array(z.looseObject({})),
  totalCount: z.number(),
});

export type SerpToolDeps = {
  runSerpRequest?: typeof runSerpRequest;
  runSerpDeps?: RunSerpDeps;
  runSerpCompetitorsRequest?: typeof runSerpCompetitorsRequest;
};

export function createGetSerpResultsTool(deps: SerpToolDeps = {}): ToolDefinition {
  return {
    name: "get_serp_results",
    description: "Read the current organic Google results for one keyword.",
    input: serpInput,
    output: serpOutput,
    handler: async (ctx, raw) => {
      const input = serpInput.parse(raw);
      const runFn = deps.runSerpRequest ?? runSerpRequest;
      const params: RunSerpRequestInput = {
        keyword: input.keyword,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        depth: input.depth,
        maxUsd: input.maxUsd,
        requestId: randomUUID(),
        cacheOnly: false,
      };

      const result = await runFn(toWorkspace(ctx), params, deps.runSerpDeps);

      return serpOutput.parse({
        items: result.items.map((item) => ({
          rank: item.rank,
          title: item.title,
          url: item.url,
          domain: item.domain,
          description: item.description,
        })),
        cached: result.cached,
        fetchedAt: result.fetchedAt,
        depth: result.depth,
      });
    },
  };
}

export function createFindSerpCompetitorsTool(
  deps: SerpToolDeps = {},
): ToolDefinition {
  return {
    name: "find_serp_competitors",
    description:
      "Find the domains that share the most search results with a target domain.",
    input: competitorsInput,
    output: competitorsOutput,
    handler: async (ctx, raw) => {
      const input = competitorsInput.parse(raw);
      const runFn = deps.runSerpCompetitorsRequest ?? runSerpCompetitorsRequest;

      const result = await runFn(toWorkspace(ctx), {
        domain: input.domain,
        keywords: input.keywords,
        limit: input.limit,
        maxUsd: input.maxUsd,
        requestId: randomUUID(),
      });

      return competitorsOutput.parse({
        competitors: result.competitors,
        totalCount: result.competitors.length,
      });
    },
  };
}

export const getSerpResultsTool = createGetSerpResultsTool();
export const findSerpCompetitorsTool = createFindSerpCompetitorsTool();
