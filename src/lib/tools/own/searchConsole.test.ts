import test from "node:test";
import assert from "node:assert/strict";
import {
  createGetSearchConsolePerformanceTool,
  utcDateDaysAgo,
} from "./searchConsole.ts";
import type { ToolHandlerContext } from "../types.ts";

type Row = Record<string, any>;

function context(): ToolHandlerContext {
  return {
    admin: {} as any,
    brand: {
      brandKey: "brand-a",
      role: "owner",
      display_name: "Acme",
      website: "https://acme.test",
      website_host: "acme.test",
      aliases: [],
      is_active: true,
    },
    userId: "user-a",
    user: { id: "user-a", email: "owner@acme.test" },
    role: "owner",
    requestId: "test",
    source: "test",
  };
}

function fakeAdmin(connections: Row[], rpcRows: Row[] = []) {
  const calls = { rpc: 0, rpcArgs: null as any, selects: [] as string[] };
  const admin = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const query: any = {
        select(columns: string) {
          calls.selects.push(table + ".select:" + columns);
          return query;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return query;
        },
        maybeSingle() {
          const row =
            (table === "gsc_connections" ? connections : []).find((candidate) =>
              filters.every(([key, value]) => candidate[key] === value),
            ) ?? null;
          return Promise.resolve({ data: row, error: null });
        },
      };
      return query;
    },
    rpc(name: string, args: any) {
      calls.rpc += 1;
      calls.rpcArgs = { name, args };
      return Promise.resolve({ data: rpcRows, error: null });
    },
  } as any;

  return { context: { ...context(), admin } as ToolHandlerContext, calls };
}

test("a disconnected Search Console returns connected:false and makes no RPC", async () => {
  const { context: ctx, calls } = fakeAdmin([
    { brand_key: "brand-a", enabled: false, connection_generation: 1, last_ingested_through: "2026-11-01" },
  ]);
  const tool = createGetSearchConsolePerformanceTool({
    now: () => new Date("2026-11-17T12:00:00.000Z"),
  });

  const output = (await tool.handler(ctx, {})) as any;

  assert.deepEqual(output, { connected: false, rows: [], dataThrough: null });
  assert.equal(calls.rpc, 0);
});

test("no connection row also returns connected:false without an RPC", async () => {
  const { context: ctx, calls } = fakeAdmin([]);
  const tool = createGetSearchConsolePerformanceTool();

  const output = (await tool.handler(ctx, {})) as any;

  assert.equal(output.connected, false);
  assert.equal(calls.rpc, 0);
});

test("an enabled connection calls the assistant summary RPC with the exact filters", async () => {
  const { context: ctx, calls } = fakeAdmin(
    [
      {
        brand_key: "brand-a",
        enabled: true,
        connection_generation: 2,
        last_ingested_through: "2026-11-10",
      },
    ],
    [
      { query: "running shoes", clicks: 12, impressions: 300, ctr: 0.04, avg_position: 3.2 },
      { query: "trail shoes", clicks: 1, impressions: 20, ctr: null, avg_position: null },
    ],
  );
  const tool = createGetSearchConsolePerformanceTool({
    now: () => new Date("2026-11-17T12:00:00.000Z"),
  });

  const output = (await tool.handler(ctx, {
    days: 28,
    minPosition: 1,
    maxPosition: 10,
    minImpressions: 5,
    query: "shoes",
    limit: 50,
  })) as any;

  assert.equal(calls.rpc, 1);
  assert.equal(calls.rpcArgs.name, "assistant_gsc_query_summary");
  assert.deepEqual(calls.rpcArgs.args, {
    p_brand: "brand-a",
    p_since: "2026-10-20",
    p_min_position: 1,
    p_max_position: 10,
    p_min_impressions: 5,
    p_query: "shoes",
    p_limit: 50,
  });
  assert.equal(output.connected, true);
  assert.equal(output.dataThrough, "2026-11-10");
  assert.deepEqual(output.rows, [
    { query: "running shoes", clicks: 12, impressions: 300, ctr: 0.04, position: 3.2 },
    { query: "trail shoes", clicks: 1, impressions: 20, ctr: null, position: null },
  ]);
});

test("utcDateDaysAgo subtracts whole UTC days", () => {
  assert.equal(utcDateDaysAgo(new Date("2026-11-17T23:30:00.000Z"), 28), "2026-10-20");
});
