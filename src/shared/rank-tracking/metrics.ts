// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/rank-tracking/services/RankTrackingService.ts:328-380
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../http/appError.ts";
import {
  getKeywordDataProvider,
  resolveKeywordDataLanguage,
} from "../keyword-locations.ts";
import {
  KEYWORD_METRICS_BATCH_SIZE,
  fetchKeywordMetricsForList,
  type KeywordMetricsClient,
  type KeywordMetricRow,
} from "../providers/dataforseo/keyword-metrics.ts";
import { createLabsClient } from "../providers/dataforseo/labs.ts";
import { createGoogleAdsClient } from "../providers/dataforseo/google-ads.ts";
import type { DataforseoCallContext } from "../providers/dataforseo/client.ts";
import { normalizeIntent } from "../../server/keywords/helpers.ts";
import { upsertKeywordMetrics as defaultUpsertKeywordMetrics } from "../../server/keywords/metricsStore.ts";
import { appendResearch as defaultAppendResearch } from "../../server/projectContext/service.ts";
import { toResearchError } from "../../server/research/providerErrors.ts";
import { createRankTrackingRepository } from "./repository.ts";
import type { Workspace } from "./service.ts";

export const METRICS_FRESH_DAYS = 7;

export type RefreshMetricsInput = {
  maxUsd: number;
  requestId: string;
};

export type RefreshMetricsDeps = {
  repo?: ReturnType<typeof createRankTrackingRepository>;
  client?: KeywordMetricsClient;
  fetchKeywordMetricsForList?: typeof fetchKeywordMetricsForList;
  upsertMetrics?: typeof defaultUpsertKeywordMetrics;
  appendResearch?: typeof defaultAppendResearch;
  now?: () => Date;
};

export type RefreshMetricsResult = {
  updated: number;
  fromCache: number;
  bought: number;
};

function uniqueLowered(keywords: string[]): string[] {
  return Array.from(new Set(keywords.map((keyword) => keyword.toLowerCase())));
}

function freshCutoffIso(now: Date): string {
  return new Date(now.getTime() - METRICS_FRESH_DAYS * 86_400_000).toISOString();
}

function metricsCall(
  ws: Workspace,
  input: RefreshMetricsInput,
): (tag: string) => DataforseoCallContext {
  return (tag: string) => ({
    brandKey: ws.brandKey,
    feature: "rank_tracking.metrics",
    idempotencyKey: `rank_tracking.metrics:${input.requestId}:${tag}`,
    maxUsd: input.maxUsd,
  });
}

function toKeywordPatch(
  id: string,
  row: KeywordMetricRow,
  nowIso: string,
  metricsSource: string,
): { id: string; search_volume: number | null; keyword_difficulty: number | null; cpc: number | null; metrics_fetched_at: string; metrics_source: string } {
  return {
    id,
    search_volume: row.searchVolume,
    keyword_difficulty: row.keywordDifficulty,
    cpc: row.cpc,
    metrics_fetched_at: nowIso,
    metrics_source: metricsSource,
  };
}

export async function refreshKeywordMetrics(
  ws: Workspace,
  configId: string,
  input: RefreshMetricsInput,
  deps?: RefreshMetricsDeps,
): Promise<RefreshMetricsResult> {
  const admin = ws.admin;
  const repo = deps?.repo ?? createRankTrackingRepository(admin);
  const config = await repo.getConfig(ws.brandKey, configId);
  if (!config) {
    throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
  }
  const keywords = await repo.listKeywords(ws.brandKey, configId);
  const now = deps?.now?.() ?? new Date();
  const nowIso = now.toISOString();

  const append = deps?.appendResearch ?? defaultAppendResearch;
  const log = async (): Promise<void> => {
    if (keywords.length === 0) return;
    await append(
      admin,
      {
        brandKey: ws.brandKey,
        kind: "rank_tracking.metrics",
        researchKey: configId,
        summary: `Keyword stats for ${keywords.length} tracked keywords of ${config.domain}.`,
        spendUsd: null,
        author: "user",
        actorUserId: ws.userId,
      },
    ).catch(() => {});
  };

  try {
    if (config.location_name != null) {
      if (keywords.length === 0) return { updated: 0, fromCache: 0, bought: 0 };
      const dataLang = resolveKeywordDataLanguage(config.location_code, config.language_code);
      const client: KeywordMetricsClient = deps?.client ?? {
        labs: createLabsClient().labs,
        ads: createGoogleAdsClient(),
      };
      const fetchMetrics = deps?.fetchKeywordMetricsForList ?? fetchKeywordMetricsForList;
      const rows = await fetchMetrics(client, {
        keywords: uniqueLowered(keywords.map((keyword) => keyword.keyword)),
        locationCode: config.location_code,
        languageCode: dataLang,
        locationName: config.location_name,
        call: metricsCall(ws, input),
      });
      const byKeyword = new Map(rows.map((row) => [row.keyword.toLowerCase(), row]));
      const patches: Array<ReturnType<typeof toKeywordPatch>> = [];
      for (const keyword of keywords) {
        const row = byKeyword.get(keyword.keyword.toLowerCase());
        if (!row) continue;
        patches.push(toKeywordPatch(keyword.id, row, nowIso, "google_ads"));
      }
      if (patches.length > 0) {
        await repo.updateKeywordMetrics(ws.brandKey, patches);
      }
      await log();
      return { updated: patches.length, fromCache: 0, bought: patches.length };
    }

    const dataLang = resolveKeywordDataLanguage(config.location_code, config.language_code);
    const lowered = uniqueLowered(keywords.map((keyword) => keyword.keyword));
    const freshByKeyword = new Map<string, { search_volume: number | null; keyword_difficulty: number | null; cpc: number | null; fetched_at: string }>();
    if (lowered.length > 0) {
      // Batched so a large tracker never overflows one request URL. A failed
      // read must not fall through to "everything is stale" — that would buy
      // every keyword again.
      const cutoff = freshCutoffIso(now);
      for (let index = 0; index < lowered.length; index += 100) {
        const { data, error } = await admin
          .from("keyword_metrics")
          .select("keyword, search_volume, keyword_difficulty, cpc, fetched_at")
          .eq("location_code", config.location_code)
          .eq("language_code", dataLang)
          .in("keyword", lowered.slice(index, index + 100));
        if (error) throw new AppError(503, "rank_metrics_unavailable", "Keyword stats could not be loaded. Please retry.", { cause: error });
        for (const row of (data as Array<{ keyword: string; search_volume: number | null; keyword_difficulty: number | null; cpc: number | null; fetched_at: string }> ?? [])) {
          if (Date.parse(row.fetched_at) > Date.parse(cutoff)) {
            freshByKeyword.set(row.keyword.toLowerCase(), row);
          }
        }
      }
    }

    const cachePatches: Array<{ id: string; search_volume: number | null; keyword_difficulty: number | null; cpc: number | null; metrics_fetched_at: string; metrics_source: string }> = [];
    const staleKeywords: Array<{ id: string; keyword: string }> = [];
    for (const keyword of keywords) {
      const fresh = freshByKeyword.get(keyword.keyword.toLowerCase());
      if (fresh) {
        cachePatches.push({
          id: keyword.id,
          search_volume: fresh.search_volume,
          keyword_difficulty: fresh.keyword_difficulty,
          cpc: fresh.cpc,
          metrics_fetched_at: fresh.fetched_at,
          metrics_source: "cache",
        });
      } else {
        staleKeywords.push(keyword);
      }
    }

    let bought = 0;
    const boughtPatches: Array<ReturnType<typeof toKeywordPatch>> = [];
    if (staleKeywords.length > 0) {
      const provider = getKeywordDataProvider(config.location_code);
      const source = provider === "google_ads" ? "google_ads" : "labs";
      const client: KeywordMetricsClient = deps?.client ?? {
        labs: createLabsClient().labs,
        ads: createGoogleAdsClient(),
      };
      const fetchMetrics = deps?.fetchKeywordMetricsForList ?? fetchKeywordMetricsForList;
      const rows = await fetchMetrics(client, {
        keywords: uniqueLowered(staleKeywords.map((keyword) => keyword.keyword)),
        locationCode: config.location_code,
        languageCode: dataLang,
        call: metricsCall(ws, input),
      });
      const byKeyword = new Map(rows.map((row) => [row.keyword.toLowerCase(), row]));
      for (const keyword of staleKeywords) {
        const row = byKeyword.get(keyword.keyword.toLowerCase());
        if (!row) continue;
        boughtPatches.push(toKeywordPatch(keyword.id, row, nowIso, source));
      }
      if (boughtPatches.length > 0) {
        const upsert = deps?.upsertMetrics ?? defaultUpsertKeywordMetrics;
        const staleIds = new Set(staleKeywords.map((keyword) => keyword.keyword.toLowerCase()));
        await upsert(
          admin,
          rows
            .filter((row) => staleIds.has(row.keyword.toLowerCase()))
            .map((row) => ({
              keyword: row.keyword,
              location_code: config.location_code,
              language_code: dataLang,
              search_volume: row.searchVolume,
              cpc: row.cpc,
              competition: row.competition,
              keyword_difficulty: row.keywordDifficulty,
              intent: normalizeIntent(row.intent),
              monthly_searches: row.monthlySearches ?? [],
              source: source as "labs" | "google_ads",
            })),
        );
      }
      bought = boughtPatches.length;
    }

    const patches = [...cachePatches, ...boughtPatches];
    if (patches.length > 0) {
      await repo.updateKeywordMetrics(ws.brandKey, patches);
    }
    await log();
    return { updated: cachePatches.length + bought, fromCache: cachePatches.length, bought };
  } catch (err) {
    throw toResearchError(err, {
      unavailableCode: "rank_metrics_unavailable",
      unavailableMessage: "Keyword stats could not be loaded. Please retry.",
    });
  }
}

export { KEYWORD_METRICS_BATCH_SIZE };
