// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/billing/usage.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * F03 §6.2 — what one workspace has spent, read from the ledger.
 *
 * The ported upstream file (openseo:src/server/billing/usage.ts) aggregated
 * Autumn billing events into one bin per local day and one row per credit
 * feature. Here the same shape is read out of Postgres: migration 051's
 * `workspace_usage_days` groups the ledger by
 * `(occurred_at AT TIME ZONE p_tz)::date` and feature, so the "Other" fallback
 * and the positive-only feature rows are kept, and the unknown-cost split and
 * the workspace caps are added.
 *
 * Two rules the page depends on:
 *   - `days[].usd` is the accounted total and ALREADY contains `unknownUsd`, so
 *     the chart stacks `knownUsd` and `unknownUsd`, never `usd` itself.
 *   - A day with no rows is a measured zero, not a gap: every paid call writes
 *     a row, so a missing day really did cost nothing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { spendFeatureLabel } from "../../shared/spend-features.ts";
import type { CostSource } from "./types.ts";

/** The ranges the Usage page offers. */
export const USAGE_RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;

export type UsageRange = keyof typeof USAGE_RANGES;

export type WorkspaceUsage = {
  range: UsageRange;
  timeZone: string;
  from: string;
  to: string;
  totals: { accountedUsd: number; knownUsd: number; unknownUsd: number; calls: number };
  /** Every local date in the range, oldest first. */
  days: { date: string; usd: number; knownUsd: number; unknownUsd: number }[];
  /** The accounted spend per feature, `usd` descending, positive rows only. */
  features: { feature: string; label: string; usd: number; unknownUsd: number; calls: number }[];
  /** The newest 50 calls. */
  recent: {
    occurredAt: string;
    feature: string;
    label: string;
    provider: string;
    endpoint: string;
    usd: number;
    costSource: CostSource;
    notBilled: boolean;
  }[];
  position: {
    todayUsd: number;
    monthUsd: number;
    dailyCapUsd: number | null;
    monthlyCapUsd: number | null;
    openHoldsUsd: number;
    openHolds: number;
    dayStartsAt: string;
    monthStartsAt: string;
  };
  generatedAt: string;
};

type LocalDate = { year: number; month: number; day: number };

/** The calendar date an instant falls on in a zone, as Y/M/D numbers. */
function localDateOf(instant: Date, timeZone: string): LocalDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const values: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") values[part.type] = part.value;
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

/** The zone's offset from UTC, in milliseconds, at that instant. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const values: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") values[part.type] = part.value;
  const hour = Number(values.hour) % 24;
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    hour,
    Number(values.minute),
    Number(values.second)
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant of local midnight on a local date. */
function localMidnight(date: LocalDate, timeZone: string): Date {
  const guess = Date.UTC(date.year, date.month - 1, date.day);
  let instant = guess - zoneOffsetMs(new Date(guess), timeZone);
  instant = guess - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** A local date shifted by whole days. */
function addLocalDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function localDateString(date: LocalDate): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${date.year}-${month}-${day}`;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** F01's cap defaults: unset or blank means no cap. */
function capFromEnv(env: Record<string, string | undefined>, name: string): number | null {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Spend configuration is invalid: ${name}`);
  }
  return value;
}

type UsageDayRow = {
  day: string;
  feature: string;
  accounted_usd: number | string;
  known_usd: number | string;
  unknown_usd: number | string;
  calls: number | string;
};

type LedgerRow = {
  occurred_at: string;
  feature: string;
  provider: string;
  endpoint: string;
  actual_usd: number | string | null;
  accounted_usd: number | string | null;
  cost_source: CostSource;
  meta: Record<string, unknown> | null;
};

/** A 'none' row the operator closed as not_billed still belongs in the list. */
function isReconciled(row: LedgerRow): boolean {
  return row.cost_source === "none" && Boolean(row.meta && row.meta.reconciled);
}

/**
 * What one workspace has spent over the last `range` days, in the viewer's own
 * time zone.
 */
export async function getWorkspaceUsage(
  admin: SupabaseClient,
  brandKey: string,
  opts: { range: UsageRange; timeZone: string; now?: Date; env?: Record<string, string | undefined> }
): Promise<WorkspaceUsage> {
  const now = opts.now ?? new Date();
  const timeZone = opts.timeZone;
  const env = opts.env ?? process.env;
  const span = USAGE_RANGES[opts.range];

  const today = localDateOf(now, timeZone);
  const firstDay = addLocalDays(today, -(span - 1));
  const from = localMidnight(firstDay, timeZone);
  const to = now;

  const { data: dayRows, error: dayError } = await admin.rpc("workspace_usage_days", {
    p_brand: brandKey,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_tz: timeZone,
  });
  if (dayError) throw dayError;

  const days = new Map<string, { date: string; usd: number; knownUsd: number; unknownUsd: number }>();
  for (let index = 0; index < span; index += 1) {
    const date = localDateString(addLocalDays(firstDay, index));
    days.set(date, { date, usd: 0, knownUsd: 0, unknownUsd: 0 });
  }

  const features = new Map<string, { feature: string; usd: number; unknownUsd: number; calls: number }>();
  for (const raw of (dayRows ?? []) as UsageDayRow[]) {
    const date = String(raw.day).slice(0, 10);
    const knownUsd = number(raw.known_usd);
    const unknownUsd = number(raw.unknown_usd);
    const day = days.get(date);
    if (day) {
      day.knownUsd += knownUsd;
      day.unknownUsd += unknownUsd;
      // The accounted total is the known and unknown halves; computing it this
      // way keeps `usd === knownUsd + unknownUsd` exact on every day.
      day.usd = day.knownUsd + day.unknownUsd;
    }
    const feature = features.get(raw.feature) ?? {
      feature: raw.feature,
      usd: 0,
      unknownUsd: 0,
      calls: 0,
    };
    feature.usd += knownUsd + unknownUsd;
    feature.unknownUsd += unknownUsd;
    feature.calls += number(raw.calls);
    features.set(raw.feature, feature);
  }

  const dayList = [...days.values()];
  const totals = {
    accountedUsd: dayList.reduce((sum, day) => sum + day.usd, 0),
    knownUsd: dayList.reduce((sum, day) => sum + day.knownUsd, 0),
    unknownUsd: dayList.reduce((sum, day) => sum + day.unknownUsd, 0),
    calls: [...features.values()].reduce((sum, feature) => sum + feature.calls, 0),
  };

  const featureList = [...features.values()]
    .filter((feature) => feature.usd > 0)
    .map((feature) => ({
      feature: feature.feature,
      label: spendFeatureLabel(feature.feature),
      usd: feature.usd,
      unknownUsd: feature.unknownUsd,
      calls: feature.calls,
    }))
    .sort((a, b) => (b.usd - a.usd) || a.feature.localeCompare(b.feature));

  const recent = await readRecent(admin, brandKey, from, to);

  const { data: positionRow, error: positionError } = await admin.rpc("workspace_spend_position", {
    p_brand: brandKey,
    p_default_daily: capFromEnv(env, "SPEND_DEFAULT_DAILY_CAP_USD"),
    p_default_monthly: capFromEnv(env, "SPEND_DEFAULT_MONTHLY_CAP_USD"),
  });
  if (positionError) throw positionError;
  const position = (positionRow ?? {}) as Record<string, unknown>;

  return {
    range: opts.range,
    timeZone,
    from: from.toISOString(),
    to: to.toISOString(),
    totals,
    days: dayList,
    features: featureList,
    recent,
    position: {
      todayUsd: number(position.today_usd),
      monthUsd: number(position.month_usd),
      dailyCapUsd: nullableNumber(position.daily_cap_usd),
      monthlyCapUsd: nullableNumber(position.monthly_cap_usd),
      openHoldsUsd: number(position.open_holds_usd),
      openHolds: number(position.open_holds),
      // Postgres renders `timestamptz` as `+00:00`, which the wire schema's
      // z.iso.datetime() rejects, so the instant is normalised here.
      dayStartsAt: new Date(String(position.day_starts_at)).toISOString(),
      monthStartsAt: new Date(String(position.month_starts_at)).toISOString(),
    },
    generatedAt: now.toISOString(),
  };
}

/**
 * The newest calls in the window. A 'none' row the operator resolved as
 * not_billed is KEPT — a call the customer saw yesterday must not vanish
 * because it was closed — and a 'none' row that was never a paid call is left
 * out.
 */
async function readRecent(
  admin: SupabaseClient,
  brandKey: string,
  from: Date,
  to: Date
): Promise<WorkspaceUsage["recent"]> {
  const columns = "occurred_at, feature, provider, endpoint, actual_usd, accounted_usd, cost_source, meta";
  const { data: paidRows, error: paidError } = await admin
    .from("spend_ledger")
    .select(columns)
    .eq("brand_key", brandKey)
    .neq("cost_source", "none")
    .gte("occurred_at", from.toISOString())
    .lt("occurred_at", to.toISOString())
    .order("occurred_at", { ascending: false })
    .limit(50);
  if (paidError) throw paidError;

  const { data: unbilledRows, error: unbilledError } = await admin
    .from("spend_ledger")
    .select(columns)
    .eq("brand_key", brandKey)
    .eq("cost_source", "none")
    .gte("occurred_at", from.toISOString())
    .lt("occurred_at", to.toISOString())
    .order("occurred_at", { ascending: false })
    .limit(50);
  if (unbilledError) throw unbilledError;

  const rows = [...((paidRows ?? []) as LedgerRow[]), ...((unbilledRows ?? []) as LedgerRow[])]
    .filter((row) => row.cost_source !== "none" || isReconciled(row))
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0))
    .slice(0, 50);

  return rows.map((row) => ({
    occurredAt: new Date(row.occurred_at).toISOString(),
    feature: row.feature,
    label: spendFeatureLabel(row.feature),
    provider: row.provider,
    endpoint: row.endpoint,
    usd: row.cost_source === "none" ? 0 : number(row.actual_usd ?? row.accounted_usd),
    costSource: row.cost_source,
    notBilled: row.cost_source === "none",
  }));
}
