// `createSpendStore(admin).settle()` reports the flags but not the hold it priced them against, so a
// duplicate settle (`settled: false`) or a still-flagged one (`undershoot`/`overMax`) costs one extra
// `spend_holds` read that fills `feature`, `estimateUsd`, `maxUsd` and `actualUsd` for the caller's
// alert. These cases drive that read-back through a fake PostgREST client, so they assert the RPC name,
// the exact `{ p_hold, p_costs }` payload and the read itself — not a copy of them. `SupabaseClient` is
// imported as a type only (so it is erased at run time), no client is constructed, and nothing here
// touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSpendStore } from "./store.ts";
import type { SpendCostRow } from "./store.ts";

const FEATURE = "platform.selftest";
const HOLD_ID = "8b1d5f0e-2c47-4c2a-9a4c-0f6b8f2d7e11";

/** A `spend_holds` row as PostgREST returns it: numeric columns arrive as strings. */
const HOLD_ROW = {
  feature: FEATURE,
  estimate_usd: "1.250000",
  max_usd: "3.000000",
  actual_usd: "0.875000",
};

const COSTS: SpendCostRow[] = [
  { provider: "openrouter", endpoint: "chat:qa", units: 1200, actualUsd: 0.875, costSource: "provider_reported" },
];

const EXPECTED_COST_PAYLOAD = [
  { provider: "openrouter", endpoint: "chat:qa", actual_usd: 0.875, cost_source: "provider_reported", units: 1200 },
];

type Row = Record<string, unknown>;
type RpcCall = { name: string; args: Record<string, unknown> };
type HoldRead = { table: string; columns: string; filters: [string, unknown][] };
type ReadResponse = { data: Row | null; error: { message: string } | null };

type HoldBuilder = {
  select(columns: string): HoldBuilder;
  eq(column: string, value: unknown): HoldBuilder;
  maybeSingle(): Promise<ReadResponse>;
};

type FakeOptions = {
  /** The value `rpc("settle_spend", …)` resolves to. */
  rpcData?: Row;
  /** The `spend_holds` row the read-back returns; only consulted when no `readError` is set. */
  row?: Row;
  readError?: { message: string } | null;
};

type FakeAdmin = {
  admin: SupabaseClient;
  rpcs: RpcCall[];
  reads: HoldRead[];
};

/**
 * A fake PostgREST client: `rpc` records its name and arguments, and
 * `from("spend_holds").select(…).eq(…).maybeSingle()` records the read it was asked for.
 */
function fakeAdmin({ rpcData = {}, row = HOLD_ROW, readError = null }: FakeOptions = {}): FakeAdmin {
  const rpcs: RpcCall[] = [];
  const reads: HoldRead[] = [];

  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      rpcs.push({ name, args });
      return { data: rpcData, error: null };
    },
    from(table: string): HoldBuilder {
      const read: HoldRead = { table, columns: "", filters: [] };
      const builder: HoldBuilder = {
        select(columns) {
          read.columns = columns;
          return builder;
        },
        eq(column, value) {
          read.filters.push([column, value]);
          return builder;
        },
        async maybeSingle() {
          reads.push(read);
          if (readError) return { data: null, error: readError };
          return { data: row, error: null };
        },
      };
      return builder;
    },
  };

  return { admin: client as unknown as SupabaseClient, rpcs, reads };
}

/** Every triggered read-back must be the one read of the one row the settle priced. */
function assertOneHoldRead(fake: FakeAdmin): void {
  assert.equal(fake.reads.length, 1, "exactly one spend_holds read");
  assert.deepEqual(fake.reads[0], {
    table: "spend_holds",
    columns: "feature, estimate_usd, max_usd, actual_usd",
    filters: [["id", HOLD_ID]],
  });
}

test("settle reads the hold back once when settle_spend reports the hold already settled", async () => {
  const fake = fakeAdmin({ rpcData: { settled: false, status: "settled" } });
  const result = await createSpendStore(fake.admin).settle(HOLD_ID, COSTS);

  assert.equal(fake.rpcs.length, 1);
  assert.equal(fake.rpcs[0].name, "settle_spend");
  assertOneHoldRead(fake);
  assert.equal(result.settled, false);
  assert.equal(result.status, "settled");
  assert.equal(result.feature, FEATURE);
  assert.equal(result.estimateUsd, 1.25);
  assert.equal(result.maxUsd, 3);
  assert.equal(result.actualUsd, 0.875, "a duplicate settle still reports what the hold was actually charged");
});

test("settle reads the hold back once and fills the amounts when settle_spend reports undershoot", async () => {
  const fake = fakeAdmin({ rpcData: { settled: true, undershoot: true } });
  const result = await createSpendStore(fake.admin).settle(HOLD_ID, COSTS);

  assertOneHoldRead(fake);
  assert.equal(result.settled, true);
  assert.equal(result.undershoot, true);
  assert.equal(result.overMax, false);
  assert.equal(result.feature, FEATURE);
  assert.equal(result.estimateUsd, 1.25);
  assert.equal(result.maxUsd, 3);
  assert.equal(result.actualUsd, 0.875);
});

test("settle reads the hold back once and fills the amounts when settle_spend reports over_max", async () => {
  const fake = fakeAdmin({ rpcData: { settled: true, over_max: true } });
  const result = await createSpendStore(fake.admin).settle(HOLD_ID, COSTS);

  assertOneHoldRead(fake);
  assert.equal(result.settled, true);
  assert.equal(result.undershoot, false);
  assert.equal(result.overMax, true);
  assert.equal(result.feature, FEATURE);
  assert.equal(result.estimateUsd, 1.25);
  assert.equal(result.maxUsd, 3);
  assert.equal(result.actualUsd, 0.875);
});

test("a clean settle sends the exact settle_spend payload and reads no hold", async () => {
  const fake = fakeAdmin({ rpcData: { settled: true } });
  const result = await createSpendStore(fake.admin).settle(HOLD_ID, COSTS);

  assert.deepEqual(fake.rpcs, [{ name: "settle_spend", args: { p_hold: HOLD_ID, p_costs: EXPECTED_COST_PAYLOAD } }]);
  assert.equal(fake.reads.length, 0, "a clean settle has no flag to explain, so it costs no read");
  assert.equal(result.settled, true);
  assert.equal(result.undershoot, false);
  assert.equal(result.overMax, false);
  assert.equal(result.status, undefined);
  assert.equal(result.feature, undefined);
  assert.equal(result.estimateUsd, undefined);
  assert.equal(result.maxUsd, undefined);
  assert.equal(result.actualUsd, undefined);
});

test("a failed hold read keeps the settle flags and invents no amounts", async () => {
  const fake = fakeAdmin({
    rpcData: { settled: true, status: "settled", undershoot: true, actual_usd: 1.25 },
    readError: { message: "connection refused" },
  });
  const result = await createSpendStore(fake.admin).settle(HOLD_ID, COSTS);

  assertOneHoldRead(fake);
  assert.equal(result.settled, true);
  assert.equal(result.status, "settled");
  assert.equal(result.undershoot, true, "the flags survive the failed read");
  assert.equal(result.overMax, false);
  assert.equal(result.actualUsd, 1.25, "the RPC's own amount is kept and the missing row adds nothing");
  assert.equal(result.feature, undefined);
  assert.equal(result.estimateUsd, undefined);
  assert.equal(result.maxUsd, undefined);
});

test("a late settle maps late without needing a hold read", async () => {
  const fake = fakeAdmin({ rpcData: { settled: true, late: true } });
  const result = await createSpendStore(fake.admin).settle(HOLD_ID, COSTS);

  assert.equal(fake.rpcs.length, 1);
  assert.equal(fake.rpcs[0].name, "settle_spend");
  assert.equal(fake.reads.length, 0, "late is not one of the flags that triggers the read-back");
  assert.equal(result.settled, true);
  assert.equal(result.late, true);
  assert.equal(result.undershoot, false);
  assert.equal(result.overMax, false);
});
