import { z } from "zod";
import type { ToolDefinition, ToolHandlerContext } from "../types.ts";

const input = z.strictObject({
  days: z.int().min(7).max(90).default(28),
  minPosition: z.number().min(1).max(100).optional(),
  maxPosition: z.number().min(1).max(100).optional(),
  minImpressions: z.int().min(0).max(100000).default(0),
  query: z.string().max(200).optional(),
  limit: z.int().min(1).max(500).default(100),
});

const output = z.looseObject({
  connected: z.boolean(),
  rows: z.array(
    z.looseObject({
      query: z.string(),
      clicks: z.number(),
      impressions: z.number(),
      ctr: z.number().nullable(),
      position: z.number().nullable(),
    }),
  ),
  dataThrough: z.string().nullable(),
});

type Row = Record<string, any>;
type Admin = ToolHandlerContext["admin"];

async function read<T>(query: unknown): Promise<T> {
  const response = (await query) as { data: T; error: unknown };
  if (response.error) throw response.error;
  return response.data;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** UTC calendar date `days` before `now`, as yyyy-mm-dd. */
export function utcDateDaysAgo(now: Date, days: number): string {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - days * 86_400_000).toISOString().slice(0, 10);
}

export type SearchConsoleDeps = {
  now?: () => Date;
};

export function createGetSearchConsolePerformanceTool(
  deps: SearchConsoleDeps = {},
): ToolDefinition {
  return {
    name: "get_search_console_performance",
    description:
      "Read Search Console query totals for this workspace's connected property.",
    input,
    output,
    handler: async (ctx, raw) => {
      const parsed = input.parse(raw);
      const admin: Admin = ctx.admin;
      const connection = await read<Row | null>(
        admin
          .from("gsc_connections")
          .select("connection_generation, enabled, last_ingested_through")
          .eq("brand_key", ctx.brand.brandKey)
          .maybeSingle(),
      );

      if (!connection?.enabled) {
        return output.parse({ connected: false, rows: [], dataThrough: null });
      }

      const now = deps.now ? deps.now() : new Date();
      const { data, error } = await admin.rpc("assistant_gsc_query_summary", {
        p_brand: ctx.brand.brandKey,
        p_since: utcDateDaysAgo(now, parsed.days),
        p_min_position: parsed.minPosition ?? null,
        p_max_position: parsed.maxPosition ?? null,
        p_min_impressions: parsed.minImpressions,
        p_query: parsed.query ?? null,
        p_limit: parsed.limit,
      });
      if (error) throw error;

      const rows = Array.isArray(data) ? (data as Row[]) : [];

      return output.parse({
        connected: true,
        rows: rows.map((row) => ({
          query: String(row.query ?? ""),
          clicks: Number(row.clicks ?? 0),
          impressions: Number(row.impressions ?? 0),
          ctr: nullableNumber(row.ctr),
          position: nullableNumber(row.avg_position),
        })),
        dataThrough:
          typeof connection.last_ingested_through === "string"
            ? connection.last_ingested_through
            : null,
      });
    },
  };
}

export const getSearchConsolePerformanceTool =
  createGetSearchConsolePerformanceTool();
