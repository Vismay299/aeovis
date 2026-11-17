// Robots.txt fetcher, parser, and crawler access check for Perceev site audit.

import { safeFetch as defaultSafeFetch } from "../../shared/http/safeFetch.ts";
import { parseRobotsTxt, evaluateBot } from "../crawlers/robots.js";
import { AUDIT_ROBOTS_TOKEN } from "../../shared/audit.ts";

export type RobotsStatus = "found" | "missing" | "error" | "unreachable";

export interface RobotsFetchResult {
  status: RobotsStatus;
  httpStatus: number | null;
  text: string | null;
}

export function pathAndQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return "/";
  }
}

export async function fetchRobots(
  origin: string,
  deps?: {
    safeFetch?: typeof defaultSafeFetch;
    lookup?: (host: string) => Promise<string[]>;
  },
): Promise<RobotsFetchResult> {
  const fetcher = deps?.safeFetch ?? defaultSafeFetch;
  const robotsUrl = `${origin.replace(/\/+$/, "")}/robots.txt`;

  try {
    const res = await fetcher(
      robotsUrl,
      {
        method: "GET",
        maxRedirects: 5,
        maxBytes: 512_000,
        truncate: true,
        timeoutMs: 10_000,
      },
      deps?.lookup ? { lookup: deps.lookup } : undefined,
    );

    if (res.status >= 200 && res.status < 300) {
      return {
        status: "found",
        httpStatus: res.status,
        text: res.text(),
      };
    }

    if (res.status === 404 || res.status === 410) {
      return {
        status: "missing",
        httpStatus: res.status,
        text: null,
      };
    }

    return {
      status: "error",
      httpStatus: res.status,
      text: null,
    };
  } catch {
    return {
      status: "unreachable",
      httpStatus: null,
      text: null,
    };
  }
}

export function parseAuditRobots(text: string | null): ReturnType<typeof parseRobotsTxt> {
  return parseRobotsTxt(text ?? "");
}

export function crawlerAllows(
  parsed: ReturnType<typeof parseRobotsTxt>,
  url: string,
): boolean {
  return evaluateBot(parsed, AUDIT_ROBOTS_TOKEN, pathAndQuery(url)).status !== "blocked";
}
