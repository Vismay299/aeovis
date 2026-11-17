/**
 * F04 §6.5 — the wire contract for `GET /api/customer/features`.
 *
 * The query is closed (an unknown parameter is a client error) and the
 * response is loose, so a later flag may be added without breaking a client
 * that already parses the payload.
 */

import { z } from "zod";
import { defineRouteContract } from "../../shared/http/routeContract.ts";
import type { RouteContract } from "../../shared/http/routeContract.ts";

const ROUTE_FILE = "src/app/api/customer/features/route.ts";

export const featuresQuery = z.strictObject({
  brand_key: z.string().min(1).max(120),
});

export const featuresResponse = z.looseObject({
  brandKey: z.string(),
  features: z.record(z.string(), z.boolean()),
});

/**
 * The status/code pairs §6.5 lists. A GET never answers 403:
 * `requireWorkspace` raises `cross_site` only for a non-GET request, and
 * `owner_required` only when the caller asks for the owner role.
 */
const ERROR_CODES = [
  "invalid_request",
  "auth_not_configured",
  "unauthenticated",
  "membership_unavailable",
  "workspace_not_found",
  "storage_unavailable",
  "internal_error",
];

export const featuresGetContract = defineRouteContract({
  id: "customer.features.get",
  method: "GET",
  path: "/api/customer/features",
  file: ROUTE_FILE,
  auth: "workspace",
  query: featuresQuery,
  response: featuresResponse,
  errorCodes: ERROR_CODES,
  examples: [
    { response: { brandKey: "acme", features: { usage_page: true, price_review: false } } },
  ],
});

export const contracts: RouteContract[] = [featuresGetContract];
