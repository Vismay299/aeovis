// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/serp-locations.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { dataforseoGet } from "./core.ts";
import { assertOk, type DataforseoTaskLike, type DataforseoResponseLike } from "./envelope.ts";
import { formatLocationLabel } from "../../../shared/keyword-locations.ts";
import { cached, type CacheDeps } from "../../cache/providerCache.ts";

export interface SerpLocationResult {
  locationCode: number;
  locationName: string;
  locationType: string;
  displayLabel: string;
}

const INCLUDED_LOCATION_TYPES = new Set([
  "City",
  "County",
  "Municipality",
  "DMA Region",
  "Region",
]);

const locationItemSchema = z.object({
  location_code: z.number(),
  location_name: z.string(),
  location_type: z.string().nullable().optional(),
});

export const serpLocationResultSchema = z.looseObject({
  locationCode: z.number(),
  locationName: z.string(),
  locationType: z.string(),
  displayLabel: z.string(),
});

export const SERP_LOCATIONS_CACHE = {
  namespace: "dataforseo.serp_locations",
  version: 1,
  ttlSeconds: 2592000, // 30 days
  scope: "global" as const,
};

export function serpLocationsCacheInput(iso: string) {
  const isoLower = iso.toLowerCase();
  return {
    namespace: SERP_LOCATIONS_CACHE.namespace,
    version: SERP_LOCATIONS_CACHE.version,
    ttlSeconds: SERP_LOCATIONS_CACHE.ttlSeconds,
    scope: SERP_LOCATIONS_CACHE.scope,
    schema: z.array(serpLocationResultSchema),
    keyParts: [isoLower],
  };
}

export type FetchSerpLocationsDeps = {
  cached?: typeof cached;
  cacheDeps?: CacheDeps;
  dataforseoGet?: <T extends DataforseoTaskLike>(
    path: string,
    options?: unknown,
  ) => Promise<DataforseoResponseLike<T> | null>;
};

export async function fetchSerpLocationsForCountry(
  iso: string,
  deps?: FetchSerpLocationsDeps,
): Promise<SerpLocationResult[]> {
  const isoLower = iso.toLowerCase();
  const cachedFn = deps?.cached ?? cached;
  const getFn = deps?.dataforseoGet ?? (dataforseoGet as any);

  const fetcher = async (): Promise<SerpLocationResult[]> => {
    const response = await getFn(
      `/v3/serp/google/locations/${encodeURIComponent(isoLower)}`,
    );
    const task = assertOk(response);
    return (task.result ?? [])
      .map((item: unknown) => locationItemSchema.safeParse(item))
      .flatMap((parsed: { success: boolean; data?: any }) =>
        parsed.success ? [parsed.data] : [],
      )
      .filter((item: any) =>
        INCLUDED_LOCATION_TYPES.has(item.location_type ?? ""),
      )
      .map((item: any) => ({
        locationCode: item.location_code,
        locationName: item.location_name,
        displayLabel: formatLocationLabel(item.location_name),
        locationType: item.location_type ?? "",
      }));
  };

  const res = await cachedFn(serpLocationsCacheInput(isoLower), fetcher, deps?.cacheDeps);
  return res.value;
}
