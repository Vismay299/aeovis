// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ga4/services/Ga4MeasurementHealthService.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { createGa4AdminClient } from "./client.ts";
import { Ga4ReportError } from "./errors.ts";
import { requireUsableConnection } from "./connection.ts";
import { getGrant } from "./grants.ts";
import { getGa4AccessToken } from "./tokens.ts";
import { mapGa4ReportError } from "./reporting.ts";
import { cached } from "../cache/providerCache.ts";

function brandKeyOf(ws: unknown): string {
  if (typeof ws === "string") return ws;
  if (ws && typeof ws === "object") {
    const o = ws as Record<string, unknown>;
    if (typeof o.brandKey === "string") return o.brandKey;
    if (typeof o.brand_key === "string") return o.brand_key;
  }
  return "";
}

export async function getMeasurementHealth(
  admin: any,
  ws: unknown,
  deps: any = {},
): Promise<any> {
  const brandKey = brandKeyOf(ws) || (typeof ws === "string" ? ws : "");
  const conn: any = await requireUsableConnection(admin, ws);
  const grant = await getGrant(admin, conn.grant_id);

  const cacheDeps = {
    store: deps.store,
    keepAlive: deps.keepAlive,
    now: deps.now,
    logger: deps.logger,
  };

  const { value, hit, fetchedAt } = await cached(
    {
      namespace: "ga4.health",
      version: 1,
      keyParts: [conn.id, conn.property_id, conn.updated_at],
      ttlSeconds: 3600,
      schema: z.looseObject({}),
      scope: "workspace",
      brandKey,
    },
    async () => {
      try {
        const client = createGa4AdminClient({
          getToken: async () => getGa4AccessToken(admin, grant, deps),
          fetchImpl: deps.fetchImpl,
        });
        const streams = await client.listDataStreams(conn.property_id);
        const webStreams = [];
        for (const stream of streams) {
          if (stream.type !== "WEB_DATA_STREAM") continue;
          const enhancedMeasurement = await client.getEnhancedMeasurementSettings(
            stream.name,
          );
          webStreams.push({
            streamId: stream.name.split("/").at(-1) ?? stream.name,
            displayName: stream.displayName,
            measurementId: stream.webStreamData?.measurementId ?? null,
            defaultUri: stream.webStreamData?.defaultUri ?? null,
            createTime: stream.createTime ?? null,
            updateTime: stream.updateTime ?? null,
            enhancedMeasurement,
          });
        }
        const [keyEvents, customDimensions, customMetrics] = await Promise.all([
          client.listKeyEvents(conn.property_id),
          client.listCustomDimensions(conn.property_id),
          client.listCustomMetrics(conn.property_id),
        ]);
        const issues: string[] = [];
        if (webStreams.length === 0) issues.push("no_web_stream");
        if (
          webStreams.length > 0 &&
          webStreams.every((stream) => !stream.enhancedMeasurement.streamEnabled)
        ) {
          issues.push("enhanced_measurement_disabled");
        }
        if (
          webStreams.length > 0 &&
          webStreams.every(
            (stream) =>
              !stream.enhancedMeasurement.streamEnabled ||
              !stream.enhancedMeasurement.siteSearchEnabled,
          )
        ) {
          issues.push("site_search_measurement_disabled");
        }
        if (keyEvents.length === 0) issues.push("no_key_events_configured");

        return {
          status: "ok",
          source: {
            provider: "google_analytics_admin",
            propertyId: conn.property_id,
            propertyDisplayName: conn.property_display_name,
          },
          summary: {
            dataStreamCount: streams.length,
            webStreamCount: webStreams.length,
            keyEventCount: keyEvents.length,
            customDimensionCount: customDimensions.length,
            customMetricCount: customMetrics.length,
            issueCount: issues.length,
          },
          issues,
          webStreams,
          otherStreams: streams
            .filter((stream) => stream.type !== "WEB_DATA_STREAM")
            .map((stream) => ({
              streamId: stream.name.split("/").at(-1) ?? stream.name,
              type: stream.type,
              displayName: stream.displayName,
            })),
          keyEvents,
          customDefinitions: {
            dimensions: customDimensions,
            metrics: customMetrics,
          },
        };
      } catch (error) {
        mapGa4ReportError(error);
      }
    },
    cacheDeps,
  );

  return { ...value, dataAsOf: fetchedAt, cached: hit };
}