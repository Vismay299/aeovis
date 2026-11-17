// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/serverFunctions/serp-locations.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../server/workspace/requireWorkspace.ts";
import {
  fetchSerpLocationsForCountry,
  type FetchSerpLocationsDeps,
} from "../../../../../shared/providers/dataforseo/serp-locations.ts";
import { rankSerpLocations } from "../../../../../shared/serp-location-search.ts";

export const dynamic = "force-dynamic";

export type LocationsRouteDeps = RequireWorkspaceDeps &
  FetchSerpLocationsDeps & {
    requireWorkspace?: typeof requireWorkspace;
    isFeatureEnabled?: typeof isFeatureEnabled;
    fetchSerpLocationsForCountry?: typeof fetchSerpLocationsForCountry;
  };

const UNAVAILABLE_MESSAGE = "This page is not available for your workspace yet.";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function GET(
  request: Request,
  _ctx?: unknown,
  deps?: LocationsRouteDeps,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const brandKey = url.searchParams.get("brand_key") ?? "";
    if (!brandKey) {
      throw new AppError(400, "invalid_request", "brand_key is required.");
    }

    const country = url.searchParams.get("country") ?? "";
    if (!/^[a-z]{2}$/i.test(country)) {
      throw new AppError(400, "invalid_request", "country must be a 2-letter ISO code.");
    }

    const q = url.searchParams.get("q") ?? "";
    if (q.length < 1 || q.length > 100) {
      throw new AppError(400, "invalid_request", "q must be between 1 and 100 characters.");
    }

    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey },
      deps,
    );

    // F13 §6.4: keyword_research OR rank_tracking OR local_seo. rank_tracking
    // joins once F15 registers that flag.
    const checkFlag = deps?.isFeatureEnabled ?? isFeatureEnabled;
    const enabled =
      (await checkFlag("keyword_research", workspace.brandKey)) ||
      (await checkFlag("local_seo", workspace.brandKey));
    if (!enabled) {
      throw new AppError(404, "feature_unavailable", UNAVAILABLE_MESSAGE);
    }

    const fetchFn = deps?.fetchSerpLocationsForCountry ?? fetchSerpLocationsForCountry;
    let locations: Awaited<ReturnType<typeof fetchSerpLocationsForCountry>>;
    try {
      locations = await fetchFn(country.toLowerCase(), deps);
    } catch {
      throw new AppError(503, "locations_unavailable", "Locations could not be loaded. Please retry.");
    }

    const ranked = rankSerpLocations(q, locations, country.toLowerCase()).slice(0, 20);
    const mapped = ranked.map((loc) => ({
      locationName: loc.locationName,
      displayLabel: loc.displayLabel,
      locationType: loc.locationType,
    }));

    return json({ locations: mapped });
  } catch (err) {
    return toErrorResponse(err);
  }
}
