// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ga4/services/SearchOpportunityService.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { AppError } from "../../shared/http/appError.ts";
import { Ga4ReportError } from "./errors.ts";
import { requireUsableConnection } from "./connection.ts";
import { resolveGa4DateRange, runReport } from "./reporting.ts";
import { fetchGscPageRows, type GscFetchForBrandFn } from "./gscPages.ts";
import { ga4DateInTimeZone, shiftGa4Date } from "./dates.ts";
import { cached } from "../cache/providerCache.ts";

export type OpportunitiesInput = {
  range?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
};

export type OpportunitiesDeps = {
  now?: () => number;
  fetchImpl?: typeof fetch;
  gscFetch?: GscFetchForBrandFn;
  store?: unknown;
  keepAlive?: unknown;
  logger?: unknown;
};

function brandKeyOf(ws: unknown): string {
  if (typeof ws === "string") return ws;
  if (ws && typeof ws === "object") {
    const o = ws as Record<string, unknown>;
    if (typeof o.brandKey === "string") return o.brandKey;
    if (typeof o.brand_key === "string") return o.brand_key;
  }
  return "";
}

export function normalizePageKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "(not set)") return null;
  try {
    const url = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    );
    let host = url.hostname.toLowerCase();
    const defaultPort =
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443");
    if (url.port && !defaultPort) host += `:${url.port}`;
    let path = url.pathname || "/";
    if (path.length > 1) path = path.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return null;
  }
}

function numberField(
  row: Record<string, string | number | null>,
  name: string,
): number {
  const value = row[name];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function percentileRanks(values: number[]): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [1];
  return values.map((value) => {
    const lower = values.filter((candidate) => candidate < value).length;
    return lower / (values.length - 1);
  });
}

function roundComponent(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

const RANGE_DAYS: Record<string, number> = {
  last_7_days: 7,
  last_28_days: 28,
  last_90_days: 90,
};

export async function getOpportunities(
  admin: any,
  ws: unknown,
  input: OpportunitiesInput = {},
  deps: OpportunitiesDeps = {},
): Promise<any> {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Ga4ReportError(
      "validation_error",
      "limit must be an integer from 1 to 100.",
    );
  }

  const brandKey = brandKeyOf(ws) || (typeof ws === "string" ? ws : "");
  const conn: any = await requireUsableConnection(admin, ws);

  const now = deps.now ? new Date(deps.now()) : new Date();

  function resolveCombinedDates(): { startDate: string; endDate: string } {
    if (!input.startDate && !input.endDate) {
      // Search Console lags ~3 days: the shared default range ends 3 days
      // before today in the GA4 property's time zone (upstream behaviour).
      const days = RANGE_DAYS[input.range ?? ""] ?? 28;
      const endDate = shiftGa4Date(
        ga4DateInTimeZone(now, conn.property_time_zone),
        -3,
      );
      return { startDate: shiftGa4Date(endDate, -(days - 1)), endDate };
    }
    return resolveGa4DateRange(
      { startDate: input.startDate, endDate: input.endDate },
      conn.property_time_zone,
      now,
    ).resolvedDateRange;
  }

  const dates = resolveCombinedDates();

  // Read the Search Console connection before the cached fetch so the cache
  // key carries the live site and generation, and a workspace without Search
  // Console is refused before any provider call.
  const { data: gscConn } = await admin
    .from("gsc_connections")
    .select("site_url, connection_generation, enabled, auth_mode")
    .eq("brand_key", brandKey)
    .maybeSingle();
  if (!gscConn || !gscConn.enabled || gscConn.auth_mode !== "oauth") {
    throw new AppError(
      409,
      "gsc_not_connected",
      "Connect Search Console to see search opportunities.",
    );
  }
  const gscSiteUrl = gscConn.site_url as string;
  const gscGeneration = gscConn.connection_generation as number;

  const cacheDeps = {
    store: deps.store,
    keepAlive: deps.keepAlive,
    now: deps.now,
    logger: deps.logger,
  };

  const { value, hit, fetchedAt } = await cached(
    {
      namespace: "ga4.opportunities",
      version: 1,
      keyParts: [
        conn.id,
        conn.property_id,
        conn.updated_at,
        gscSiteUrl,
        gscGeneration,
        dates.startDate,
        dates.endDate,
        limit,
      ],
      ttlSeconds: 900,
      schema: z.looseObject({}),
      scope: "workspace",
      brandKey,
    },
    async () => {
      const gsc = await fetchGscPageRows(
        admin,
        ws,
        { startDate: dates.startDate, endDate: dates.endDate },
        { gscFetch: deps.gscFetch },
      );
      const ga4 = await runReport(
        admin,
        ws,
        {
          kind: "landing_pages",
          startDate: dates.startDate,
          endDate: dates.endDate,
          limit: 1000,
          offset: 0,
          channel: "organic_search",
        },
        deps,
      );

      const ga4ByPage = new Map<
        string,
        Record<string, string | number | null>
      >();
      let invalidGa4Rows = 0;
      for (const row of (ga4.rows ?? []) as Array<
        Record<string, string | number | null>
      >) {
        const host = typeof row.hostName === "string" ? row.hostName : "";
        const landing =
          typeof row.landingPage === "string" ? row.landingPage : "";
        const key = normalizePageKey(`${host}${landing}`);
        if (!key) {
          invalidGa4Rows += 1;
          continue;
        }
        ga4ByPage.set(key, row);
      }

      const candidates: any[] = ((gsc.rows ?? []) as any[])
        .filter((row: any) => row.position >= 4 && row.position <= 20)
        .map((row: any) => {
          const page = row.keys?.[0] ?? "";
          const normalizedPage = normalizePageKey(page);
          const analytics = normalizedPage
            ? ga4ByPage.get(normalizedPage)
            : undefined;
          return {
            page,
            normalizedPage,
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
            joinStatus: analytics ? "joined" : "gsc_only",
            ga4: analytics
              ? {
                  sessions: numberField(analytics, "sessions"),
                  activeUsers: numberField(analytics, "activeUsers"),
                  engagedSessions: numberField(analytics, "engagedSessions"),
                  engagementRate: numberField(analytics, "engagementRate"),
                  keyEvents: numberField(analytics, "keyEvents"),
                  sessionKeyEventRate: numberField(
                    analytics,
                    "sessionKeyEventRate",
                  ),
                  transactions: numberField(analytics, "transactions"),
                  purchaseRevenue:
                    typeof analytics.purchaseRevenue === "number"
                      ? analytics.purchaseRevenue
                      : null,
                }
              : null,
            score: null,
            scoreComponents: null,
          };
        });

      const joined = candidates.filter(
        (candidate: any): candidate is any => candidate.ga4 !== null,
      );
      const engagementFallback =
        joined.length > 0 &&
        joined.every((candidate: any) => candidate.ga4.keyEvents === 0);
      const demand = percentileRanks(
        joined.map((candidate: any) => Math.log1p(candidate.impressions)),
      );
      const businessValue = percentileRanks(
        joined.map((candidate: any) =>
          engagementFallback
            ? candidate.ga4.engagementRate
            : candidate.ga4.sessionKeyEventRate,
        ),
      );
      const reachability = percentileRanks(
        joined.map((candidate: any) => 20 - candidate.position),
      );
      joined.forEach((candidate: any, index: number) => {
        const components = {
          demand: roundComponent(demand[index] ?? 0),
          businessValue: roundComponent(businessValue[index] ?? 0),
          reachability: roundComponent(reachability[index] ?? 0),
        };
        candidate.scoreComponents = components;
        candidate.score = Math.round(
          100 *
            (0.5 * components.demand +
              0.3 * components.businessValue +
              0.2 * components.reachability),
        );
      });
      candidates.sort((a: any, b: any) => {
        if (a.score == null && b.score != null) return 1;
        if (a.score != null && b.score == null) return -1;
        return (b.score ?? 0) - (a.score ?? 0) || b.impressions - a.impressions;
      });

      const matchedRows = joined.length;
      const unmatchedGscRows = candidates.length - matchedRows;
      const returned = candidates.slice(0, limit);
      return {
        status: "ok",
        source: {
          searchConsoleSiteUrl: gsc.siteUrl,
          googleAnalyticsPropertyId: ga4.source.propertyId,
          googleAnalyticsPropertyDisplayName:
            ga4.source.propertyDisplayName,
        },
        request: {
          dateRange: dates,
          limit,
          searchConsoleTimeZone: "America/Los_Angeles",
          googleAnalyticsTimeZone: ga4.request.propertyTimeZone,
        },
        rowCount: returned.length,
        totalCandidateRows: candidates.length,
        rows: returned,
        scoring: {
          formula:
            "round(100 * (0.5 * demand + 0.3 * businessValue + 0.2 * reachability))",
          businessValueMetric: engagementFallback
            ? "engagementRate"
            : "sessionKeyEventRate",
          engagementFallback,
          scoreDataLimited: ga4.reportMetadata?.hasLimitedData ?? false,
        },
        coverage: {
          gscRowsConsidered: (gsc.rows ?? []).length,
          ga4RowsConsidered: (ga4.rows ?? []).length,
          matchedRows,
          unmatchedGscRows,
          unmatchedGa4Rows:
            Math.max(ga4ByPage.size - matchedRows, 0) + invalidGa4Rows,
        },
        truncated: {
          gsc: (gsc.rows ?? []).length >= 1000,
          ga4: (ga4.totalRowCount ?? 0) > (ga4.rows ?? []).length,
          candidates: returned.length < candidates.length,
        },
        warnings:
          ga4.request.propertyTimeZone === "America/Los_Angeles"
            ? [...(ga4.warnings ?? [])]
            : [...(ga4.warnings ?? []), "source_time_zones_differ"],
        reportMetadata: ga4.reportMetadata,
        quota: ga4.quota,
      };
    },
    cacheDeps as never,
  );

  return { ...value, dataAsOf: fetchedAt, cached: hit };
}
