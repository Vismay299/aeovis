/**
 * F06 phase 5 — server-side Scans history (F06-AC-17 … -21).
 *
 * The Scans page needs every scan of a workspace, filtered, sorted and paged
 * in the database. The phase 2 page loaded the latest 20 rows and sorted them
 * in the browser, so filtering those 20 would hide older scans while looking
 * like a complete answer. Migration 066 derives the columns this module reads;
 * the route falls back to the phase 2 list behaviour when 066 is not applied
 * yet (production auto-deploys main, the migration may lag).
 */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

export const SCAN_HISTORY_PAGE_SIZES = [25, 50, 100] as const;
export const SCAN_HISTORY_SORTS = ["date", "visibility"] as const;

/**
 * Engine ids that can appear in `scans.engines`. These are the ids the workers
 * actually write into `raw_results->engines` (`aio`, `chatgpt`, `gemini`,
 * `perplexity`) plus the single-engine platform fallback (`google_ai_overview`).
 * Claude is deliberately absent (owner decision, 25 October 2026).
 */
export const SCAN_HISTORY_ENGINES = [
  "aio",
  "chatgpt",
  "gemini",
  "google_ai_overview",
  "perplexity",
] as const;

export type ScanHistoryEngine = (typeof SCAN_HISTORY_ENGINES)[number];

const DAY_MS = 86_400_000;
const MAX_DATE_SPAN_DAYS = 400;
const MAX_ENGINES = 10;

const isoDate = z.iso.date();

/** The plain shape, exported for the route contract (JSON-Schema friendly). */
export const scanHistoryQueryShape = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce
    .number()
    .int()
    .pipe(z.union([z.literal(25), z.literal(50), z.literal(100)]))
    .default(50),
  sort: z.enum(SCAN_HISTORY_SORTS).default("date"),
  order: z.enum(["asc", "desc"]).default("desc"),
  from: isoDate.optional(),
  to: isoDate.optional(),
  tz: z.string().min(1).max(64).default("UTC"),
  startedBy: z.enum(["manual", "scheduled"]).optional(),
  engines: z.string().max(400).optional(),
  collection: z.string().max(100).optional(),
  visMin: z.coerce.number().min(0).max(100).optional(),
  visMax: z.coerce.number().min(0).max(100).optional(),
});

export const scanHistoryQuerySchema = scanHistoryQueryShape.superRefine((value, ctx) => {
    if (value.from && value.to) {
      const from = Date.parse(`${value.from}T00:00:00.000Z`);
      const to = Date.parse(`${value.to}T00:00:00.000Z`);
      if (from > to) {
        ctx.addIssue({ code: "custom", path: ["from"], message: "`from` must be on or before `to`." });
      } else if (to - from > MAX_DATE_SPAN_DAYS * DAY_MS) {
        ctx.addIssue({
          code: "custom",
          path: ["to"],
          message: `Choose a date range of up to ${MAX_DATE_SPAN_DAYS} days.`,
        });
      }
    }

    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value.tz });
    } catch {
      ctx.addIssue({ code: "custom", path: ["tz"], message: "Unknown time zone." });
    }

    if (value.visMin != null && value.visMax != null && value.visMin > value.visMax) {
      ctx.addIssue({ code: "custom", path: ["visMax"], message: "`visMin` must be on or below `visMax`." });
    }

    if (value.engines) {
      const ids = splitList(value.engines);
      if (ids.length > MAX_ENGINES) {
        ctx.addIssue({ code: "custom", path: ["engines"], message: `At most ${MAX_ENGINES} engines.` });
      }
      for (const id of ids) {
        if (!SCAN_HISTORY_ENGINES.includes(id as ScanHistoryEngine)) {
          ctx.addIssue({ code: "custom", path: ["engines"], message: `Unknown engine "${id}".` });
        }
      }
    }

    if (value.collection) {
      for (const entry of splitList(value.collection)) {
        if (entry !== "complete" && entry !== "partial" && entry !== "pending") {
          ctx.addIssue({
            code: "custom",
            path: ["collection"],
            message: `Unknown collection state "${entry}".`,
          });
        }
      }
    }
  });

export type ScanHistoryQuery = z.infer<typeof scanHistoryQuerySchema>;

export type ScanHistoryRow = {
  id: string;
  brand: string | null;
  url: string | null;
  scanned_at: string | null;
  created_at: string | null;
  visibility_pct: number | null;
  prompts_tracked: number | null;
  prompts_mentioned: number | null;
  platform: string | string[] | null;
  engines?: string[];
  collection_partial: boolean;
  started_by: "manual" | "scheduled";
};

export type ScanHistoryResult = {
  scans: ScanHistoryRow[];
  totalCount: number;
  page: number;
  size: number;
};

const SCAN_HISTORY_COLUMNS =
  "id, brand, url, scanned_at, created_at, visibility_pct, prompts_tracked, prompts_mentioned, platform, engines, collection_partial, started_by";

export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseEngineList(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(splitList(value))];
}

export function parseCollectionList(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(splitList(value))];
}

/** The collection group is OR inside itself and AND with the other filters. */
export function buildCollectionFilter(collection: string[]): string | null {
  const parts: string[] = [];
  if (collection.includes("pending")) parts.push("visibility_pct.is.null");
  if (collection.includes("partial")) parts.push("collection_partial.eq.true");
  if (collection.includes("complete")) {
    parts.push("and(visibility_pct.not.is.null,collection_partial.eq.false)");
  }
  return parts.length ? parts.join(",") : null;
}

function toHistoryRow(row: Record<string, unknown>): ScanHistoryRow {
  const engines = Array.isArray(row.engines)
    ? row.engines.filter((engine): engine is string => typeof engine === "string")
    : [];
  const platform = engines.length ? engines : row.platform ?? null;
  return {
    ...row,
    platform,
    collection_partial: row.collection_partial === true,
    started_by: row.started_by === "scheduled" ? "scheduled" : "manual",
  } as ScanHistoryRow;
}

export async function listScanHistory(
  admin: SupabaseClient,
  brandKey: string,
  query: ScanHistoryQuery,
): Promise<ScanHistoryResult> {
  let builder = admin
    .from("scans")
    .select(SCAN_HISTORY_COLUMNS, { count: "exact" })
    .eq("brand_key", brandKey);

  if (query.from) {
    builder = builder.gte("listed_at", zonedDayStartUtc(query.from, query.tz).toISOString());
  }
  if (query.to) {
    builder = builder.lt("listed_at", zonedDayEndExclusive(query.to, query.tz).toISOString());
  }
  if (query.startedBy) {
    builder = builder.eq("started_by", query.startedBy);
  }

  const engines = parseEngineList(query.engines);
  if (engines.length) {
    builder = builder.overlaps("engines", engines);
  }

  const collectionFilter = buildCollectionFilter(parseCollectionList(query.collection));
  if (collectionFilter) {
    builder = builder.or(collectionFilter);
  }

  if (query.visMin != null) {
    builder = builder.gte("visibility_pct", query.visMin);
  }
  if (query.visMax != null) {
    builder = builder.lte("visibility_pct", query.visMax);
  }

  const ascending = query.order === "asc";
  const sortColumn = query.sort === "visibility" ? "visibility_pct" : "listed_at";
  builder = builder
    .order(sortColumn, { ascending, nullsFirst: false })
    .order("id", { ascending: true })
    .range((query.page - 1) * query.size, query.page * query.size - 1);

  const { data, error, count } = await builder;
  if (error) throw error;
  const rows = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
  return {
    scans: rows.map(toHistoryRow),
    totalCount: count ?? 0,
    page: query.page,
    size: query.size,
  };
}

/**
 * Owner-mandated degraded mode: when migration 066 has not been applied yet,
 * `engines` / `collection_partial` / `started_by` / `listed_at` do not exist.
 * Reproduce the phase 2 `GET /api/customer/scan` derivation (latest 20 by
 * `scanned_at`) so the live Scans page keeps working. Same response shape.
 */
export async function listScanHistoryFallback(
  admin: SupabaseClient,
  brandKey: string,
  query: ScanHistoryQuery,
): Promise<ScanHistoryResult> {
  const { data, error } = await admin
    .from("scans")
    .select(
      "id, brand, url, scanned_at, created_at, visibility_pct, prompts_tracked, prompts_mentioned, platform, engine_summaries:raw_results->engines",
    )
    .eq("brand_key", brandKey)
    .order("scanned_at", { ascending: false, nullsFirst: false })
    .limit(20);
  if (error) throw error;
  const rows = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
  const scans = rows.map(derivePhaseTwoRow);
  return { scans, totalCount: scans.length, page: 1, size: query.size };
}

/** Byte-for-byte the phase 2 GET derivation, extracted for the fallback. */
export function derivePhaseTwoRow(row: Record<string, unknown>): ScanHistoryRow {
  const summaries =
    row.engine_summaries && typeof row.engine_summaries === "object"
      ? (row.engine_summaries as Record<string, unknown> | unknown[])
      : null;
  const names = Array.isArray(summaries)
    ? summaries
        .map((slice) =>
          slice && typeof slice === "object"
            ? (slice as Record<string, unknown>).engine || (slice as Record<string, unknown>).name
            : null,
        )
        .filter(Boolean)
    : summaries
      ? Object.keys(summaries)
      : [];
  const slices = summaries ? Object.values(summaries) : [];
  const { engine_summaries: _engineSummaries, ...rest } = row;
  return {
    ...rest,
    platform: names.length ? names : row.platform ?? null,
    collection_partial: slices.some(
      (slice) =>
        Boolean(slice) &&
        typeof slice === "object" &&
        ((slice as Record<string, unknown>).data_source_issue === true ||
          (typeof (slice as Record<string, unknown>).error_rate_pct === "number" &&
            ((slice as Record<string, unknown>).error_rate_pct as number) > 0)),
    ),
    started_by: "manual",
  } as ScanHistoryRow;
}

/** Supabase/PostgREST reports `undefined_column` as the SQLSTATE 42703. */
export function isUndefinedColumnError(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "42703"
  );
}

/** Offset of `tz` from UTC at `at`, in milliseconds. */
export function tzOffsetMs(tz: string, at: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(at);
  const read = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };
  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Local midnight of `dateStr` in `tz`, as a UTC instant. */
export function zonedDayStartUtc(dateStr: string, tz: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  let instant = target;
  for (let index = 0; index < 2; index += 1) {
    instant = target - tzOffsetMs(tz, new Date(instant));
  }
  return new Date(instant);
}

/** First instant after the local day in `tz` (exclusive upper bound). */
export function zonedDayEndExclusive(dateStr: string, tz: string): Date {
  return new Date(zonedDayStartUtc(dateStr, tz).getTime() + DAY_MS);
}
