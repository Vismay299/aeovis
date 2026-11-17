// AI Crawler access evaluation for Perceev site audit.
// Uses Perceev's crawler registry (AI_BOTS) and RFC 9309 robots parser.

import { AI_BOTS } from "../crawlers/bots.js";
import { evaluateBot, type parseRobotsTxt } from "../crawlers/robots.js";

export interface AiAccessRow {
  name: string;
  operator: string;
  platform: string;
  purpose: string;
  status: "open" | "partial" | "blocked";
  matchedGroup: string | null;
  reason: string;
  unknown?: boolean;
}

export interface BlockedAiBots {
  search: string[];
  agent: string[];
  training: string[];
}

export function aiAccessRows(
  parsed: ReturnType<typeof parseRobotsTxt>,
  path: string = "/",
): AiAccessRow[] {
  return AI_BOTS.map((bot) => {
    const verdict = evaluateBot(parsed, bot.name, path);
    return {
      name: bot.name,
      operator: bot.operator,
      platform: bot.platform,
      purpose: bot.purpose,
      status: verdict.status,
      matchedGroup: verdict.matchedGroup,
      reason: verdict.reason,
      unknown: verdict.unknown,
    };
  });
}

export function blockedAiBots(
  parsed: ReturnType<typeof parseRobotsTxt>,
  path: string = "/",
): BlockedAiBots {
  const result: BlockedAiBots = {
    search: [],
    agent: [],
    training: [],
  };

  for (const bot of AI_BOTS) {
    const verdict = evaluateBot(parsed, bot.name, path);
    if (verdict.status === "blocked") {
      if (bot.purpose === "search") {
        result.search.push(bot.name);
      } else if (bot.purpose === "agent") {
        result.agent.push(bot.name);
      } else if (bot.purpose === "training") {
        result.training.push(bot.name);
      }
    }
  }

  return result;
}
