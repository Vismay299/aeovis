// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/rank-tracking/services/RankTrackingService.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../http/appError.ts";
import { isSupportedLocationCode, resolveMarket, workspaceMarket } from "../../shared/keyword-locations.ts";
import { assertLocalResearchLocation } from "../keywords/localVolume.ts";

export function normalizeTrackedDomain(input: string): string {
  let domain = input.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "");
  domain = domain.replace(/[/?#].*$/, "");
  domain = domain.replace(/\/+$/, "");
  domain = domain.replace(/^www\./, "");
  if (!domain || domain.length < 3 || domain.length > 253 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new AppError(400, "invalid_domain", "Enter a valid domain, like example.com");
  }
  return domain;
}

export function resolveTrackerMarket(
  body: { locationCode?: number; languageCode?: string },
  brand: { website_host: string },
): { locationCode: number; languageCode: string } {
  if (body.locationCode != null && !isSupportedLocationCode(body.locationCode)) {
    throw new AppError(400, "invalid_location", "This country is not supported.");
  }
  return resolveMarket(body, workspaceMarket(brand));
}

export async function assertTrackedLocation(
  locationCode: number,
  locationName: string | null | undefined,
  deps?: { fetchSerpLocationsForCountry?: (iso: string) => Promise<unknown> },
): Promise<void> {
  if (!locationName) return;
  await assertLocalResearchLocation(locationCode, locationName, deps as any);
}
