// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/services/research/research-data.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type {
  LabsKeywordDataItem,
} from "../../shared/providers/dataforseo/labs.ts";
import type { LabsClient } from "../../shared/providers/dataforseo/labs.ts";
import type {
  AdsKeywordIdeaItem,
  GoogleAdsClient,
} from "../../shared/providers/dataforseo/google-ads.ts";
import type { DataforseoCallContext } from "../../shared/providers/dataforseo/client.ts";
import {
  normalizeIntent,
  normalizeKeyword,
  type EnrichedKeyword,
} from "./helpers.ts";
import type { KeywordSource } from "./selection.ts";

export type FetchResearchRowsParams = {
  seedKeyword: string;
  locationCode: number;
  languageCode: string;
  resultLimit: number;
  source: KeywordSource;
  includeClickstreamData?: boolean;
  ignoreSynonyms?: boolean;
  call: DataforseoCallContext;
};

export type ResearchDataDeps = {
  labs: LabsClient;
  ads: GoogleAdsClient;
};

export function mapKeywordDataItems(items: LabsKeywordDataItem[]): EnrichedKeyword[] {
  const rows: EnrichedKeyword[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const keyword = item.keyword;
    if (!keyword) continue;

    const normalized = normalizeKeyword(keyword);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    // The clickstream-normalized block only exists when the caller opted into
    // clickstream data (it doubles the request cost); prefer it when present.
    const keywordInfo = item.keyword_info_normalized_with_clickstream?.search_volume
      ? item.keyword_info_normalized_with_clickstream
      : item.keyword_info;

    rows.push({
      keyword: normalized,
      searchVolume: keywordInfo?.search_volume ?? null,
      trend: (keywordInfo?.monthly_searches ?? []).map((entry) => ({
        year: entry.year ?? 0,
        month: entry.month ?? 0,
        searchVolume: entry.search_volume ?? 0,
      })),
      cpc: item.keyword_info?.cpc ?? null,
      competition: item.keyword_info?.competition ?? null,
      keywordDifficulty: item.keyword_properties?.keyword_difficulty ?? null,
      intent: normalizeIntent(item.search_intent_info?.main_intent),
    });
  }

  return rows;
}

/**
 * Google Ads items carry volume / CPC / paid competition but no keyword
 * difficulty or search intent (those are Labs-only).
 */
export function mapAdsKeywordItems(
  items: AdsKeywordIdeaItem[],
): EnrichedKeyword[] {
  const rows: EnrichedKeyword[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const keyword = item.keyword;
    if (!keyword) continue;

    const normalized = normalizeKeyword(keyword);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    rows.push({
      keyword: normalized,
      searchVolume: item.search_volume ?? null,
      trend: (item.monthly_searches ?? []).map((entry) => ({
        year: entry.year ?? 0,
        month: entry.month ?? 0,
        searchVolume: entry.search_volume ?? 0,
      })),
      cpc: item.cpc ?? null,
      competition:
        item.competition_index != null ? item.competition_index / 100 : null,
      keywordDifficulty: null,
      intent: "unknown",
    });
  }

  return rows;
}

/** Research rows for countries DataForSEO Labs doesn't support. */
export async function fetchGoogleAdsResearchRows(
  params: Omit<FetchResearchRowsParams, "source">,
  deps: { ads: Pick<GoogleAdsClient, "adsIdeas"> },
): Promise<EnrichedKeyword[]> {
  const items = await deps.ads.adsIdeas(params.call, {
    keyword: params.seedKeyword,
    locationCode: params.locationCode,
    languageCode: params.languageCode,
    limit: params.resultLimit,
  });
  return mapAdsKeywordItems(items);
}

async function fetchRelatedRows(
  params: Omit<FetchResearchRowsParams, "source">,
  deps: { labs: Pick<LabsClient, "keywords"> },
) {
  const items = await deps.labs.keywords.related(params.call, {
    keyword: params.seedKeyword,
    locationCode: params.locationCode,
    languageCode: params.languageCode,
    limit: params.resultLimit,
    depth: 3,
    includeClickstreamData: params.includeClickstreamData,
    ignoreSynonyms: params.ignoreSynonyms,
  });

  // Related items wrap the keyword payload one level deeper; unwrap and reuse
  // the same mapper as suggestions/ideas.
  return mapKeywordDataItems(
    items
      .map((item) => item.keyword_data)
      .filter((data): data is NonNullable<typeof data> => data != null),
  );
}

export async function fetchResearchRowsBySource(
  params: FetchResearchRowsParams,
  deps: { labs: Pick<LabsClient, "keywords"> },
): Promise<EnrichedKeyword[]> {
  if (params.source === "related") {
    return fetchRelatedRows(params, deps);
  }

  if (params.source === "suggestions") {
    const items = await deps.labs.keywords.suggestions(params.call, {
      keyword: params.seedKeyword,
      locationCode: params.locationCode,
      languageCode: params.languageCode,
      limit: params.resultLimit,
      includeClickstreamData: params.includeClickstreamData,
      ignoreSynonyms: params.ignoreSynonyms,
    });
    return mapKeywordDataItems(items);
  }

  const items = await deps.labs.keywords.ideas(params.call, {
    keyword: params.seedKeyword,
    locationCode: params.locationCode,
    languageCode: params.languageCode,
    limit: params.resultLimit,
    includeClickstreamData: params.includeClickstreamData,
    ignoreSynonyms: params.ignoreSynonyms,
  });
  return mapKeywordDataItems(items);
}
