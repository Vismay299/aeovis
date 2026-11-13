/**
 * F03 §6.2 — what one workspace has spent.
 *
 * The fake admin answers the two read functions migration 051 added, the
 * ledger reads behind the recent-activity list and the ledger count behind the
 * unknown-call total, so these cases are about the aggregation: gap-filled
 * days, the known/unknown split and the honest recent list.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getWorkspaceUsage } from "./usage.ts";

type Row = Record<string, unknown>;

/**
 * A ledger row as the fake hands it over. `occurred_at` is always a string
 * here, so the fake can sort on it without guessing at the column type.
 */
type LedgerRow = {
  brand_key: string;
  occurred_at: string;
  feature: string;
  provider: string;
  endpoint: string;
  actual_usd: number | null;
  accounted_usd: number | null;
  cost_source: string;
  meta: Record<string, unknown> | null;
};

type Query = {
  /** A count read (`count: "exact", head: true`) resolves `{ count }` instead of rows. */
  select: (columns?: string, options?: { count?: string; head?: boolean }) => Query;
  eq: (column: string, value: unknown) => Query;
  neq: (column: string, value: unknown) => Query;
  gte: (column: string, value: unknown) => Query;
  lt: (column: string, value: unknown) => Query;
  order: (column?: string, options?: { ascending?: boolean }) => Query;
  limit: (value: number) => Query;
  then: (resolve: (value: unknown) => unknown) => Promise<unknown>;
};

const BRAND = "workspace-a";
const NOW = new Date("2026-10-21T09:12:00.000Z");

const DAY_ROWS = [
  {
    day: "2026-10-20",
    feature: "ai_visibility.scan",
    accounted_usd: 0.06,
    known_usd: 0.04,
    unknown_usd: 0.02,
    calls: 2,
  },
  {
    day: "2026-10-20",
    feature: "platform.selftest",
    accounted_usd: 0.01,
    known_usd: 0,
    unknown_usd: 0.01,
    calls: 1,
  },
  {
    day: "2026-10-21",
    feature: "ai_visibility.scan",
    accounted_usd: 0.06,
    known_usd: 0.04,
    unknown_usd: 0.02,
    calls: 2,
  },
  {
    day: "2026-10-21",
    feature: "some.other.feature",
    accounted_usd: 0.5,
    known_usd: 0.5,
    unknown_usd: 0,
    calls: 1,
  },
];

const LEDGER_ROWS: LedgerRow[] = [
  {
    brand_key: BRAND,
    occurred_at: "2026-10-21T08:00:00.000Z",
    feature: "ai_visibility.scan",
    provider: "openrouter",
    endpoint: "probe:chatgpt",
    actual_usd: 0.04,
    accounted_usd: 0.04,
    cost_source: "provider_reported",
    meta: {},
  },
  {
    // The operator closed this one as not_billed: the customer saw the call,
    // so it stays in the list.
    brand_key: BRAND,
    occurred_at: "2026-10-20T08:00:00.000Z",
    feature: "ai_visibility.scan",
    provider: "openrouter",
    endpoint: "probe:gemini",
    actual_usd: 0,
    accounted_usd: 0,
    cost_source: "none",
    meta: { reconciled: "not_billed" },
  },
  {
    // Never a paid call: it was never dispatched, so it is not activity.
    brand_key: BRAND,
    occurred_at: "2026-10-19T08:00:00.000Z",
    feature: "ai_visibility.scan",
    provider: "openrouter",
    endpoint: "probe:aio",
    actual_usd: 0,
    accounted_usd: 0,
    cost_source: "none",
    meta: {},
  },
];

function fakeAdmin(days: Row[], ledger: LedgerRow[]): SupabaseClient {
  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      if (name === "workspace_usage_days") {
        return Promise.resolve({ data: days, error: null });
      }
      if (name === "workspace_spend_position") {
        return Promise.resolve({
          data: {
            today_usd: 0.25,
            month_usd: 3,
            daily_cap_usd: args.p_default_daily ?? null,
            monthly_cap_usd: args.p_default_monthly ?? null,
            open_holds_usd: 0.5,
            open_holds: 1,
            // Postgres renders `timestamptz` as `+00:00`.
            day_starts_at: "2026-10-21T00:00:00+00:00",
            month_starts_at: "2026-10-01T00:00:00+00:00",
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      let rows: LedgerRow[] = (table === "spend_ledger" ? ledger : []).slice();
      // A count read is answered the way PostgREST answers a `head` request:
      // `data: null` and the number of rows the filters left behind.
      let counted = false;
      const column = (row: LedgerRow, name: string): unknown =>
        (row as unknown as Record<string, unknown>)[name];
      const query: Query = {
        select: (_columns, options) => {
          if (options?.count) counted = true;
          return query;
        },
        eq: (name, value) => {
          rows = rows.filter((row) => column(row, name) === value);
          return query;
        },
        neq: (name, value) => {
          rows = rows.filter((row) => column(row, name) !== value);
          return query;
        },
        gte: (name, value) => {
          rows = rows.filter((row) => String(column(row, name)) >= String(value));
          return query;
        },
        lt: (name, value) => {
          rows = rows.filter((row) => String(column(row, name)) < String(value));
          return query;
        },
        order: () => {
          rows = rows.slice().sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
          return query;
        },
        limit: (value: number) => {
          rows = rows.slice(0, value);
          return query;
        },
        then: (resolve) =>
          Promise.resolve(
            counted ? { data: null, error: null, count: rows.length } : { data: rows, error: null }
          ).then(resolve),
      };
      return query;
    },
  };
  return admin as unknown as SupabaseClient;
}

function usage(admin: SupabaseClient, range: "7d" | "30d" | "90d" = "7d") {
  return getWorkspaceUsage(admin, BRAND, {
    range,
    timeZone: "Asia/Kolkata",
    now: NOW,
    env: { SPEND_DEFAULT_DAILY_CAP_USD: "25" },
  });
}

function near(actual: number, expected: number, what: string) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} is not ${expected}`);
}

test("the range starts at the viewer's local midnight and ends now", async () => {
  const result = await usage(fakeAdmin(DAY_ROWS, LEDGER_ROWS));
  assert.equal(result.range, "7d");
  assert.equal(result.timeZone, "Asia/Kolkata");
  // 2026-10-15T00:00 in Asia/Kolkata is 2026-10-14T18:30Z.
  assert.equal(result.from, "2026-10-14T18:30:00.000Z");
  assert.equal(result.to, "2026-10-21T09:12:00.000Z");
  assert.equal(result.generatedAt, "2026-10-21T09:12:00.000Z");
});

test("every local day in the range is present, oldest first", async () => {
  const result = await usage(fakeAdmin(DAY_ROWS, LEDGER_ROWS));
  assert.equal(result.days.length, 7);
  assert.equal(result.days[0].date, "2026-10-15");
  assert.equal(result.days[6].date, "2026-10-21");
  assert.deepEqual(
    result.days.map((day) => day.date),
    [
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
    ]
  );
});

test("a day with no rows is a measured zero, not a gap", async () => {
  const result = await usage(fakeAdmin(DAY_ROWS, LEDGER_ROWS));
  const empty = result.days.find((day) => day.date === "2026-10-16");
  assert.ok(empty);
  assert.deepEqual(empty, { date: "2026-10-16", usd: 0, knownUsd: 0, unknownUsd: 0 });
});

test("usd is the known and unknown halves on every day", async () => {
  const result = await usage(fakeAdmin(DAY_ROWS, LEDGER_ROWS));
  for (const day of result.days) {
    near(day.usd, day.knownUsd + day.unknownUsd, `usd on ${day.date}`);
  }
  const busy = result.days.find((day) => day.date === "2026-10-20");
  assert.ok(busy);
  near(busy.knownUsd, 0.04, "knownUsd on 2026-10-20");
  near(busy.unknownUsd, 0.03, "unknownUsd on 2026-10-20");
  near(busy.usd, 0.07, "usd on 2026-10-20");
});

test("the totals are the sum of the days", async () => {
  const result = await usage(fakeAdmin(DAY_ROWS, LEDGER_ROWS));
  near(result.totals.accountedUsd, 0.63, "accountedUsd");
  near(result.totals.knownUsd, 0.58, "knownUsd");
  near(result.totals.unknownUsd, 0.05, "unknownUsd");
  assert.equal(result.totals.calls, 6);
});

test("the totals count the calls whose cost is still a reservation", async () => {
  // Two rows in the window are still counted at the amount reserved before
  // they ran; the shared fixture has none, so they are added here.
  const ledger: LedgerRow[] = [
    ...LEDGER_ROWS,
    {
      brand_key: BRAND,
      occurred_at: "2026-10-20T10:00:00.000Z",
      feature: "ai_visibility.scan",
      provider: "openrouter",
      endpoint: "probe:perplexity",
      actual_usd: null,
      accounted_usd: 0.02,
      cost_source: "reservation",
      meta: {},
    },
    {
      brand_key: BRAND,
      occurred_at: "2026-10-21T02:00:00.000Z",
      feature: "platform.selftest",
      provider: "openrouter",
      endpoint: "probe:chatgpt",
      actual_usd: null,
      accounted_usd: 0.01,
      cost_source: "reservation",
      meta: {},
    },
  ];
  const result = await usage(fakeAdmin(DAY_ROWS, ledger));
  assert.equal(result.totals.unknownCalls, 2);
});

test("the features are ordered by spend, and an unknown feature is 'Other'", async () => {
  const result = await usage(fakeAdmin(DAY_ROWS, LEDGER_ROWS));
  assert.deepEqual(
    result.features.map((feature) => feature.feature),
    ["some.other.feature", "ai_visibility.scan", "platform.selftest"]
  );
  assert.deepEqual(
    result.features.map((feature) => feature.label),
    ["Other", "AI visibility scans", "Platform check"]
  );
  near(result.features[1].usd, 0.12, "ai_visibility.scan usd");
  near(result.features[1].unknownUsd, 0.04, "ai_visibility.scan unknownUsd");
  assert.equal(result.features[1].calls, 4);
});

test("the recent list keeps a not-billed row and drops a never-paid one", async () => {
  const result = await usage(fakeAdmin(DAY_ROWS, LEDGER_ROWS));
  assert.equal(result.recent.length, 2);
  assert.equal(result.recent[0].endpoint, "probe:chatgpt");
  assert.equal(result.recent[0].usd, 0.04);
  assert.equal(result.recent[0].notBilled, false);
  assert.equal(result.recent[0].costSource, "provider_reported");
  assert.equal(result.recent[0].label, "AI visibility scans");

  const notBilled = result.recent[1];
  assert.equal(notBilled.endpoint, "probe:gemini");
  assert.equal(notBilled.notBilled, true);
  assert.equal(notBilled.usd, 0);
  assert.equal(notBilled.costSource, "none");
  assert.ok(
    !result.recent.some((row) => row.endpoint === "probe:aio"),
    "a row that was never a paid call is not activity"
  );
});

test("the position carries the workspace caps and the open holds", async () => {
  const result = await usage(fakeAdmin(DAY_ROWS, LEDGER_ROWS));
  near(result.position.todayUsd, 0.25, "todayUsd");
  near(result.position.monthUsd, 3, "monthUsd");
  near(result.position.dailyCapUsd ?? 0, 25, "dailyCapUsd");
  assert.equal(result.position.monthlyCapUsd, null, "no monthly default was configured");
  near(result.position.openHoldsUsd, 0.5, "openHoldsUsd");
  assert.equal(result.position.openHolds, 1);
  // Postgres renders `timestamptz` as `+00:00`, which the wire schema rejects.
  assert.equal(result.position.dayStartsAt, "2026-10-21T00:00:00.000Z");
  assert.equal(result.position.monthStartsAt, "2026-10-01T00:00:00.000Z");
});

test("a wider range fills more days and keeps the same window shape", async () => {
  const result = await usage(fakeAdmin(DAY_ROWS, LEDGER_ROWS), "30d");
  assert.equal(result.days.length, 30);
  assert.equal(result.days[0].date, "2026-09-22");
  assert.equal(result.days[29].date, "2026-10-21");
  assert.equal(result.from, "2026-09-21T18:30:00.000Z");
});
