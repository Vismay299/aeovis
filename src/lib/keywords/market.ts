// F13 market resolution and cache/log key helpers
import { AppError } from "../http/appError.ts";
import {
  getKeywordDataProvider,
  isSupportedLocationCode,
  resolveKeywordDataLanguage,
  resolveMarket,
  workspaceMarket,
  LOCATION_OPTIONS,
} from "../../shared/keyword-locations.ts";

export type ResolvedResearchMarket = {
  locationCode: number;
  languageCode: string;
  provider: "labs" | "google_ads";
  country: string;
};

export function resolveResearchMarket(
  body: { locationCode?: number; languageCode?: string },
  brand: { website_host: string },
): ResolvedResearchMarket {
  if (body.locationCode != null && !isSupportedLocationCode(body.locationCode)) {
    throw new AppError(400, "invalid_location", "This country is not supported.");
  }

  const baseMarket = resolveMarket(body, workspaceMarket(brand));
  const languageCode = resolveKeywordDataLanguage(
    baseMarket.locationCode,
    baseMarket.languageCode,
  );
  const provider = getKeywordDataProvider(baseMarket.locationCode);
  const locationOption = LOCATION_OPTIONS.find(
    (opt) => opt.code === baseMarket.locationCode,
  );
  const country = locationOption?.label ?? "United States";

  return {
    locationCode: baseMarket.locationCode,
    languageCode,
    provider,
    country,
  };
}

export function researchKey(params: {
  seed: string;
  locationCode: number;
  languageCode: string;
  locationName?: string | null;
}): string {
  return `${params.seed}|${params.locationCode}|${params.languageCode}|${params.locationName ?? ""}`;
}
