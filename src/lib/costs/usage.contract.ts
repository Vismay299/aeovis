/**
 * F03 §6.5 — the wire contract for `GET /api/customer/usage`.
 *
 * The query is closed (an unknown parameter is a client error) and the response
 * is loose at every level, so a later field may be added without breaking a
 * client that already parses the payload.
 */

import { z } from "zod";
import { defineRouteContract } from "../http/routeContract.ts";
import type { RouteContract } from "../http/routeContract.ts";

const ROUTE_FILE = "src/app/api/customer/usage/route.ts";

/**
 * Module-level on purpose: building the ~450-entry array inside the refine
 * runs on every request.
 *
 * The list holds the CANONICAL ids only. CLDR renamed zones, so the list
 * carries `Asia/Calcutta` and not `Asia/Kolkata` — but both are real IANA
 * zones, both are what `Intl` and the database accept, and `Asia/Kolkata` is
 * the zone §6.5's own example uses. So the list is the fast path, not the
 * whole answer.
 */
const TIME_ZONES = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);

/**
 * The zones the canonical list does not carry: the legacy IANA aliases
 * (`Asia/Kolkata`, `US/Eastern`) and the UTC spellings. Every probe is
 * memoised, a hit and a miss alike, so a repeated zone costs one map lookup.
 *
 * The key is the LOWERCASED zone. `Intl` reads a zone name case-insensitively,
 * so one zone is one entry however the client spells it — without that, the
 * spellings of a single zone would each cost an entry and an ICU probe.
 *
 * The map is BOUNDED, like the feature-flag cache
 * (`src/lib/features/flags.ts:13-33`). The key is client-supplied, the refine
 * runs BEFORE the session check, and the map is never emptied on its own, so
 * an unbounded map would let an anonymous caller grow the process heap without
 * limit. On overflow the map is cleared; the next probes fill it again.
 */
const TIME_ZONE_PROBES = new Map<string, boolean>();

/** The most probes the memo may hold. See `TIME_ZONE_PROBES`. */
export const TIME_ZONE_PROBE_LIMIT = 5_000;

/**
 * How many probes are memoised right now. Exported for the route test that
 * proves the memo stays inside its cap; a client never sees it.
 */
export function timeZoneProbeCacheSize(): number {
  return TIME_ZONE_PROBES.size;
}

/**
 * True when `Intl` can actually format the zone — a canonical id or a legacy
 * alias alike. `Intl.DateTimeFormat` throws for anything it does not know,
 * which is exactly the test we want: `Not/AZone`, an empty string and plain
 * garbage all fail it.
 */
function probeTimeZone(tz: string): boolean {
  // An offset ("+05:30") is not a zone name. The database reads it as an
  // interval rather than as a zone, so it is not one of ours.
  if (tz.startsWith("+") || tz.startsWith("-")) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * True for every IANA zone the runtime can format, canonical or alias.
 *
 * The memo is keyed by the lowercased zone and never grows past its cap.
 */
function isKnownTimeZone(tz: string): boolean {
  if (TIME_ZONES.has(tz)) return true;
  const key = tz.toLowerCase();
  const cached = TIME_ZONE_PROBES.get(key);
  if (cached !== undefined) return cached;
  const known = probeTimeZone(tz);
  if (TIME_ZONE_PROBES.size >= TIME_ZONE_PROBE_LIMIT) TIME_ZONE_PROBES.clear();
  TIME_ZONE_PROBES.set(key, known);
  return known;
}

/** §6.5 GET query. Closed: an unknown query parameter is a client error. */
export const usageQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  range: z.enum(["7d", "30d", "90d"]).default("30d"),
  tz: z.string().min(1).max(64).refine(isKnownTimeZone, "Unknown time zone").default("UTC"),
});

export const usageResponse = z.looseObject({
  range: z.enum(["7d", "30d", "90d"]),
  timeZone: z.string(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  totals: z.looseObject({
    accountedUsd: z.number().min(0),
    knownUsd: z.number().min(0),
    unknownUsd: z.number().min(0),
    calls: z.int().min(0),
    unknownCalls: z.int().min(0).optional(),
  }),
  days: z.array(
    z.looseObject({
      date: z.iso.date(),
      usd: z.number().min(0),
      knownUsd: z.number().min(0),
      unknownUsd: z.number().min(0),
    })
  ),
  features: z.array(
    z.looseObject({
      feature: z.string(),
      label: z.string(),
      usd: z.number().min(0),
      unknownUsd: z.number().min(0),
      calls: z.int().min(0),
    })
  ),
  recent: z.array(
    z.looseObject({
      occurredAt: z.iso.datetime(),
      feature: z.string(),
      label: z.string(),
      provider: z.string(),
      endpoint: z.string(),
      usd: z.number().min(0),
      notBilled: z.boolean(),
      costSource: z.enum(["provider_reported", "price_table", "reservation", "none"]),
    })
  ),
  position: z.looseObject({
    todayUsd: z.number().min(0),
    monthUsd: z.number().min(0),
    dailyCapUsd: z.number().min(0).nullable(),
    monthlyCapUsd: z.number().min(0).nullable(),
    openHoldsUsd: z.number().min(0),
    openHolds: z.int().min(0),
    dayStartsAt: z.iso.datetime(),
    monthStartsAt: z.iso.datetime(),
  }),
  generatedAt: z.iso.datetime(),
});

/** §6.5's example, with the truncated parts filled in so it parses. */
const EXAMPLE_USAGE = {
  range: "30d",
  timeZone: "Asia/Kolkata",
  from: "2026-09-21T18:30:00.000Z",
  to: "2026-10-21T09:12:00.000Z",
  totals: { accountedUsd: 7.412, knownUsd: 7.012, unknownUsd: 0.4, calls: 122 },
  days: [
    { date: "2026-09-22", usd: 0, knownUsd: 0, unknownUsd: 0 },
    { date: "2026-10-20", usd: 7.412, knownUsd: 7.012, unknownUsd: 0.4 },
  ],
  features: [
    {
      feature: "ai_visibility.scan",
      label: "AI visibility scans",
      usd: 7.412,
      unknownUsd: 0.4,
      calls: 122,
    },
  ],
  recent: [
    {
      occurredAt: "2026-10-20T11:02:31.000Z",
      feature: "ai_visibility.scan",
      label: "AI visibility scans",
      provider: "openrouter",
      endpoint: "probe:chatgpt",
      usd: 0.0612,
      notBilled: false,
      costSource: "provider_reported",
    },
  ],
  position: {
    todayUsd: 0,
    monthUsd: 7.412,
    dailyCapUsd: null,
    monthlyCapUsd: 50,
    openHoldsUsd: 0,
    openHolds: 0,
    dayStartsAt: "2026-10-21T00:00:00.000Z",
    monthStartsAt: "2026-10-01T00:00:00.000Z",
  },
  generatedAt: "2026-10-21T09:12:00.000Z",
};

/**
 * The status/code pairs §6.5 lists, plus the codes `requireWorkspace` can answer
 * with. A GET never answers 403: `requireWorkspace` raises `cross_site` only for
 * a non-GET request.
 */
const ERROR_CODES = [
  "invalid_request",
  "auth_not_configured",
  "unauthenticated",
  "membership_unavailable",
  "workspace_not_found",
  "storage_unavailable",
  "feature_unavailable",
  "usage_unavailable",
];

export const usageGetContract = defineRouteContract({
  id: "customer.usage.get",
  method: "GET",
  path: "/api/customer/usage",
  file: ROUTE_FILE,
  auth: "workspace",
  query: usageQuery,
  response: usageResponse,
  errorCodes: ERROR_CODES,
  examples: [{ response: EXAMPLE_USAGE }],
});

export const contracts: RouteContract[] = [usageGetContract];
