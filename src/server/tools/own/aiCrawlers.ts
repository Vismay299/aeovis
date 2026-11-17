import { z } from "zod";
import { AppError } from "../../../shared/http/appError.ts";
import {
  fetchRobots,
  type RobotsFetchResult,
} from "../../audit/robotsFile.ts";
import { parseRobotsTxt } from "../../crawlers/robots.js";
import {
  aiAccessRows,
  blockedAiBots,
  type BlockedAiBots,
} from "../../audit/aiAccess.ts";
import { checkLlmsTxt, type LlmsTxtResult } from "../../audit/llmsTxt.ts";
import type { ToolDefinition } from "../types.ts";
import { normaliseHost } from "./siteReading.ts";

const input = z.strictObject({
  path: z.string().regex(/^\/[^\s]{0,500}$/).default("/"),
});

const output = z.looseObject({
  host: z.string(),
  robots: z.looseObject({
    status: z.string(),
    httpStatus: z.number().nullable(),
  }),
  bots: z.array(
    z.looseObject({
      name: z.string(),
      operator: z.string(),
      platform: z.string(),
      purpose: z.string(),
      status: z.string(),
    }),
  ),
  blocked: z.looseObject({
    search: z.array(z.string()),
    agent: z.array(z.string()),
    training: z.array(z.string()),
  }),
  llmsTxt: z.looseObject({
    status: z.string(),
    httpStatus: z.number().nullable(),
  }),
});

export type AiCrawlerDeps = {
  fetchRobots?: typeof fetchRobots;
  parseRobotsTxt?: typeof parseRobotsTxt;
  aiAccessRows?: typeof aiAccessRows;
  blockedAiBots?: typeof blockedAiBots;
  checkLlmsTxt?: typeof checkLlmsTxt;
};

export function createCheckAiCrawlerAccessTool(
  deps: AiCrawlerDeps = {},
): ToolDefinition {
  return {
    name: "check_ai_crawler_access",
    description:
      "Check which AI crawlers this workspace's robots.txt blocks and whether llms.txt is present.",
    input,
    output,
    handler: async (ctx, raw) => {
      const parsedInput = input.parse(raw);
      const host = normaliseHost(ctx.brand.website_host || ctx.brand.website || "");
      if (!host) {
        throw new AppError(400, "no_website", "This workspace has no website yet.");
      }

      const origin = `https://${host}`;
      const robotsFn = deps.fetchRobots ?? fetchRobots;
      const llmsFn = deps.checkLlmsTxt ?? checkLlmsTxt;
      const parseFn = deps.parseRobotsTxt ?? parseRobotsTxt;
      const rowsFn = deps.aiAccessRows ?? aiAccessRows;
      const blockedFn = deps.blockedAiBots ?? blockedAiBots;

      const [robots, llmsTxt]: [RobotsFetchResult, LlmsTxtResult] = await Promise.all([
        robotsFn(origin),
        llmsFn(origin),
      ]);
      const parsed = parseFn(robots.text ?? "");
      const rows = rowsFn(parsed, parsedInput.path);
      const blocked: BlockedAiBots = blockedFn(parsed, parsedInput.path);

      return output.parse({
        host,
        robots: { status: robots.status, httpStatus: robots.httpStatus },
        bots: rows.map((row) => ({
          name: row.name,
          operator: row.operator,
          platform: row.platform,
          purpose: row.purpose,
          status: row.status,
        })),
        blocked: {
          search: blocked.search,
          agent: blocked.agent,
          training: blocked.training,
        },
        llmsTxt: { status: llmsTxt.status, httpStatus: llmsTxt.httpStatus },
      });
    },
  };
}

export const checkAiCrawlerAccessTool = createCheckAiCrawlerAccessTool();
