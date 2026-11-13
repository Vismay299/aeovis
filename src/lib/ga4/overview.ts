// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ga4/services/Ga4OrganicOverviewService.ts
//   src/server/serverFunctions/ga4.ts:57-89
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { createGa4DataClient } from "./client.ts";
import {
  Ga4ReportError,
  Ga4TokenError,
} from "./errors.ts";
import { requireUsableConnection } from "./connection.ts";
import { getGrant } from "./grants.ts";
import { getGa4AccessToken } from "./tokens.ts";
import {
  buildGa4OverviewRequest,
  OVERVIEW_METRICS,
} from "./reportDefinitions.ts";
import { normalizeGa4Response } from "./normalization.ts";
import { comparisonValue, previousPeriod } from "./enhancements.ts";
import { resolveGa4DateRange, mapGa4ReportError } from "./reporting.ts";
import { ga4DateInTimeZone, presetRange, shiftGa4Date } from "./dates.ts";
import { cached, stableStringify } from "../cache/providerCache.ts";

function brandKeyOf(ws: unknown): string {
  if (typeof ws === "string") return ws;
  if (ws && typeof ws === "object") {
    const o = ws as Record<string, unknown>;
    if (typeof o.brandKey === "string") return o.brandKey;
    if (typeof o.brand_key === "string") return o.brand_key;
  }
  return "";
}

function metricComparison(
  current: Record<string, string | number | null> | null,
  previous: Record<string, string | number | null> | null,
) {
  return Object.fromEntries(
    OVERVIEW_METRICS.map((metric) => {
      const currentValue =
        typeof current?.[metric] === "number" ? current[metric] : null;
      const previousValue =
        typeof previous?.[metric] === "number" ? previous[metric] : null;
      return [metric, comparisonValue(currentValue, previousValue)];
    }),
  );
}

function keyEventDiagnostics(
  current: Record<string, string | number | null> | null,
  previous: Record<string, string | number | null> | null,
  hasLimitedData: boolean,
) {
  if (hasLimitedData) return [];
  const currentValue =
    typeof current?.keyEvents === "number" ? current.keyEvents : null;
  const previousValue =
    typeof previous?.keyEvents === "number" ? previous.keyEvents : null;
  if (currentValue == null || previousValue == null || previousValue < 5) {
    return [];
  }
  const percentChange = (currentValue - previousValue) / previousValue;
  if (percentChange > -0.5) return [];
  return [
    {
      code: "key_events_sharp_decline",
      severity: "warning",
      message:
        "Organic key events declined sharply compared with the previous equal-length period.",
      evidence: {
        current: currentValue,
        previous: previousValue,
        percentChange,
      },
      threshold: { minimumPreviousKeyEvents: 5, percentChange: -0.5 },
    },
  ];
}

function fillDailySessions(
  rows: Array<Record<string, string | number | null>>,
  range: { startDate: string; endDate: string },
): Array<{ date: string; sessions: number }> {
  const sessionsByDate = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.date !== "string" || typeof row.sessions !== "number") {
      continue;
    }
    const iso = `${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}`;
    sessionsByDate.set(iso, row.sessions);
  }
  const days: Array<{ date: string; sessions: number }> = [];
  for (
    let date = range.startDate;
    date <= range.endDate;
    date = shiftGa4Date(date, 1)
  ) {
    days.push({ date, sessions: sessionsByDate.get(date) ?? 0 });
  }
  return days;
}

export async function getOrganicOverview(
  admin: any,
  ws: unknown,
  input: any = {},
  deps: any = {},
): Promise<any> {
  const brandKey = brandKeyOf(ws) || (typeof ws === "string" ? ws : "");
  const conn: any = await requireUsableConnection(admin, ws);
  const grant = await getGrant(admin, conn.grant_id);

  const nowDate = deps.now ? new Date(deps.now()) : new Date();
  let startDate = input.startDate;
  let endDate = input.endDate;
  if (input.range && !startDate && !endDate) {
    const pr = presetRange(input.range, conn.property_time_zone, nowDate);
    startDate = pr.startDate;
    endDate = pr.endDate;
  }
  const dateRange = resolveGa4DateRange(
    { startDate, endDate },
    conn.property_time_zone,
    nowDate,
  );
  const previousDateRange = previousPeriod(dateRange.resolvedDateRange);
  const trend = input.trend ?? "daily";
  const currentRequest = buildGa4OverviewRequest(dateRange.resolvedDateRange);
  const previousRequest = buildGa4OverviewRequest({
    ...previousDateRange,
  });
  const trendRequest = buildGa4OverviewRequest({
    ...dateRange.resolvedDateRange,
    trend,
  });

  const cacheDeps = {
    store: deps.store,
    keepAlive: deps.keepAlive,
    now: deps.now,
    logger: deps.logger,
  };

  const cacheKeyParts = [
    conn.id,
    conn.property_id,
    conn.updated_at,
    dateRange.resolvedDateRange.startDate,
    dateRange.resolvedDateRange.endDate,
    trend,
  ];

  const { value, hit, fetchedAt } = await cached(
    {
      namespace: "ga4.overview",
      version: 1,
      keyParts: cacheKeyParts,
      ttlSeconds: 900,
      schema: z.looseObject({}),
      scope: "workspace",
      brandKey,
    },
    async () => {
      try {
        const client = createGa4DataClient({
          getToken: async () => getGa4AccessToken(admin, grant, deps),
          propertyId: conn.property_id,
          fetchImpl: deps.fetchImpl,
        });
        const [currentResponse, previousResponse, trendResponse] =
          await Promise.all([
            client.runReport(currentRequest),
            client.runReport(previousRequest),
            client.runReport(trendRequest),
          ]);
        const current = normalizeGa4Response(currentResponse, currentRequest);
        const previous = normalizeGa4Response(previousResponse, previousRequest);
        const trendReport = normalizeGa4Response(trendResponse, trendRequest);
        const currentSummary = current.rows[0] ?? null;
        const previousSummary = previous.rows[0] ?? null;
        const reports = [current, previous, trendReport];
        const hasLimitedData = reports.some(
          (report) => report.reportMetadata.hasLimitedData,
        );
        const trendComplete =
          trendReport.rows.length === trendReport.totalRowCount;
        const trendFilled =
          trend === "daily" && trendComplete && !hasLimitedData;
        const trendOut = trendFilled
          ? fillDailySessions(trendReport.rows, dateRange.resolvedDateRange)
          : trendReport.rows;

        return {
          status: "ok",
          source: {
            provider: "google_analytics",
            propertyId: conn.property_id,
            propertyDisplayName: conn.property_display_name,
          },
          request: {
            requestedDateRange: dateRange.requestedDateRange,
            resolvedDateRange: dateRange.resolvedDateRange,
            previousDateRange,
            propertyTimeZone: conn.property_time_zone,
            currencyCode: conn.property_currency_code,
            channel: "organic_search",
            trend,
          },
          current: currentSummary,
          previous: previousSummary,
          comparison: metricComparison(currentSummary, previousSummary),
          trend: trendOut,
          trendFilled,
          diagnostics: keyEventDiagnostics(
            currentSummary,
            previousSummary,
            hasLimitedData,
          ),
          reportMetadata: {
            hasLimitedData,
            reports: reports.map((report) => report.reportMetadata),
          },
          quota: trendReport.quota ?? current.quota,
          warnings: [
            ...dateRange.warnings,
            ...(trendReport.totalRowCount > trendReport.rows.length
              ? ["trend_truncated"]
              : []),
          ],
        };
      } catch (error) {
        mapGa4ReportError(error);
      }
    },
    cacheDeps,
  );

  return { ...value, dataAsOf: fetchedAt, cached: hit };
}