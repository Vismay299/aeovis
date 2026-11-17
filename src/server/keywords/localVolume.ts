// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/services/research/local-volume.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../shared/http/appError.ts";
import { fetchSerpLocationsForCountry } from "../../shared/providers/dataforseo/serp-locations.ts";
import { fetchAdsSearchVolumeForKeywords } from "../../shared/providers/dataforseo/keyword-metrics.ts";
import { getIsoCountryCode, LOCATION_OPTIONS, formatLocationLabel } from "../../shared/keyword-locations.ts";
import type { EnrichedKeyword } from "./helpers.ts";
import { mapAdsKeywordItems } from "./researchData.ts";
import type { GoogleAdsClient } from "../../shared/providers/dataforseo/google-ads.ts";
import type { DataforseoCallContext } from "../../shared/providers/dataforseo/client.ts";

export async function assertLocalResearchLocation(
  locationCode: number,
  locationName: string,
  deps?: {
    fetchSerpLocationsForCountry?: typeof fetchSerpLocationsForCountry;
  },
): Promise<void> {
  const fetchFn = deps?.fetchSerpLocationsForCountry ?? fetchSerpLocationsForCountry;
  const locations = await fetchFn(getIsoCountryCode(locationCode));
  if (locations.some((location) => location.locationName === locationName)) {
    return;
  }
  const country =
    LOCATION_OPTIONS.find((option) => option.code === locationCode)?.label ??
    "this country";
  throw new AppError(
    409,
    "unknown_location",
    `"${formatLocationLabel(locationName)}" is not a city, county, or region we can find in ${country}.`,
  );
}

export type LocalizeResearchRowsParams = {
  locationCode: number;
  locationName: string;
  languageCode: string;
  call: DataforseoCallContext;
};

export async function localizeResearchRows(
  rows: EnrichedKeyword[],
  params: LocalizeResearchRowsParams,
  deps: { ads: Pick<GoogleAdsClient, "adsSearchVolume"> },
): Promise<EnrichedKeyword[]> {
  const items = await fetchAdsSearchVolumeForKeywords(
    { ads: deps.ads as any, labs: {} as any },
    params.call,
    { keywords: rows.map((row) => row.keyword), locationCode: params.locationCode, languageCode: params.languageCode, locationName: params.locationName },
  );
  const localByKeyword = new Map(
    mapAdsKeywordItems(items).map((local) => [local.keyword, local]),
  );

  return rows.map((row) => {
    const local = localByKeyword.get(row.keyword);
    return {
      ...row,
      searchVolume: local?.searchVolume ?? null,
      trend: local?.trend ?? [],
      cpc: local?.cpc ?? null,
      competition: local?.competition ?? null,
    };
  });
}
