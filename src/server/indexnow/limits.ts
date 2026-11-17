import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../shared/http/errors.ts";

export type IndexNowLimits = {
  maxRequestsPerHour: number;
  maxUrlsPerDay: number;
  maxChecksPerHour: number;
  resubmitCooldownSeconds: number;
};

export type IndexNowUsage = {
  requestsLastHour: number;
  oldestRequestInHour: string | null;
  urlsToday: number;
  checksLastHour: number;
  oldestCheckInHour: string | null;
};

export function readIndexNowLimits(env: Record<string, string | undefined> = process.env): IndexNowLimits {
  function parseVal(
    raw: string | undefined,
    defaultVal: number,
    minVal: number,
    maxVal: number
  ): number {
    if (raw === undefined || raw === null || raw.trim() === "") {
      return defaultVal;
    }
    const parsed = Number(raw.trim());
    if (!Number.isInteger(parsed) || parsed < minVal || parsed > maxVal) {
      throw new AppError(500, "indexnow_config_invalid", "IndexNow limits configuration is invalid.");
    }
    return parsed;
  }

  return {
    maxRequestsPerHour: parseVal(env.INDEXNOW_MAX_REQUESTS_PER_HOUR, 30, 1, 1000),
    maxUrlsPerDay: parseVal(env.INDEXNOW_MAX_URLS_PER_DAY, 10000, 1, 100000),
    maxChecksPerHour: parseVal(env.INDEXNOW_MAX_HOST_CHECKS_PER_HOUR, 60, 2, 1000),
    resubmitCooldownSeconds: parseVal(env.INDEXNOW_RESUBMIT_COOLDOWN_SECONDS, 600, 0, 86400),
  };
}

export async function fetchIndexNowUsage(
  admin: SupabaseClient,
  brandKey: string,
  now: Date
): Promise<IndexNowUsage> {
  const { data, error } = await admin.rpc("indexnow_usage", {
    p_brand: brandKey,
    p_now: now.toISOString(),
  });

  if (error || !data) {
    throw new AppError(503, "indexnow_unavailable", "IndexNow could not be reached. Please retry.");
  }

  const raw = typeof data === "string" ? JSON.parse(data) : data;
  return {
    requestsLastHour: Number(raw.requestsLastHour ?? 0),
    oldestRequestInHour: raw.oldestRequestInHour ?? null,
    urlsToday: Number(raw.urlsToday ?? 0),
    checksLastHour: Number(raw.checksLastHour ?? 0),
    oldestCheckInHour: raw.oldestCheckInHour ?? null,
  };
}

export async function assertSubmitAllowed(
  admin: SupabaseClient,
  brandKey: string,
  urlCount: number,
  now: Date,
  limits?: IndexNowLimits,
  deps?: { getUsage?: () => Promise<IndexNowUsage> }
): Promise<void> {
  const activeLimits = limits ?? readIndexNowLimits();
  const usage = deps?.getUsage
    ? await deps.getUsage()
    : await fetchIndexNowUsage(admin, brandKey, now);

  if (usage.requestsLastHour >= activeLimits.maxRequestsPerHour) {
    const oldest = usage.oldestRequestInHour ? new Date(usage.oldestRequestInHour).getTime() : now.getTime();
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + 3600_000 - now.getTime()) / 1000));
    const retryMinutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    throw new AppError(
      429,
      "indexnow_rate_limited",
      `You've submitted to IndexNow ${usage.requestsLastHour} times in the last hour. Try again in ${retryMinutes} minutes.`,
      {
        recovery: "Submit only pages you added or changed.",
        details: { retryAfterSeconds },
      }
    );
  }

  if (usage.urlsToday + urlCount > activeLimits.maxUrlsPerDay) {
    const nextMidnightUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const retryAfterSeconds = Math.max(1, Math.ceil((nextMidnightUtc.getTime() - now.getTime()) / 1000));
    throw new AppError(
      429,
      "indexnow_rate_limited",
      `This workspace has submitted ${usage.urlsToday} URLs today. The daily limit is ${activeLimits.maxUrlsPerDay}. Try again tomorrow.`,
      {
        recovery: "Submit only pages you added or changed.",
        details: { retryAfterSeconds },
      }
    );
  }
}

export async function assertCheckAllowed(
  admin: SupabaseClient,
  brandKey: string,
  hostCount: number,
  now: Date,
  limits?: IndexNowLimits,
  deps?: { getUsage?: () => Promise<IndexNowUsage> }
): Promise<void> {
  const activeLimits = limits ?? readIndexNowLimits();
  const usage = deps?.getUsage
    ? await deps.getUsage()
    : await fetchIndexNowUsage(admin, brandKey, now);

  if (usage.checksLastHour + hostCount > activeLimits.maxChecksPerHour) {
    const oldest = usage.oldestCheckInHour ? new Date(usage.oldestCheckInHour).getTime() : now.getTime();
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + 3600_000 - now.getTime()) / 1000));
    const retryMinutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    throw new AppError(
      429,
      "indexnow_rate_limited",
      `The key file was checked ${usage.checksLastHour} times in the last hour. Try again in ${retryMinutes} minutes.`,
      {
        recovery: "Submit only pages you added or changed.",
        details: { retryAfterSeconds },
      }
    );
  }
}
