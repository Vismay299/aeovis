/**
 * F03 §6.5 — the three operator cost routes, driven through their real
 * handlers and the real cost service.
 *
 * The operator token is NOT checked here: the `/api` perimeter refuses a
 * request without it before a route ever runs (`src/middleware.js` +
 * `src/lib/operatorPerimeter.js`), and `src/lib/operatorPerimeter.test.mjs`
 * proves it. These cases therefore assert what the routes own: the data
 * mapping and the 400/409 mapping. There is deliberately no route-level 401
 * case, because a route-level token check is not what these routes do.
 *
 * Only the storage transport is substituted (`deps`); the service and the
 * error mapping are the shipped code.
 *
 * Hooks: `src/lib/customerRoutes.test.hooks.mjs`, the resolver the customer
 * route tests use. It maps only module specifiers; nothing under test is
 * replaced.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("../customerRoutes.test.hooks.mjs", import.meta.url));

const COSTS = await import(new URL("../../app/api/ops/costs/route.ts", import.meta.url).href);
const RESOLVE = await import(
  new URL("../../app/api/ops/costs/reconciliations/[id]/route.ts", import.meta.url).href
);
const BULK = await import(
  new URL("../../app/api/ops/costs/reconciliations/bulk/route.ts", import.meta.url).href
);
const { opsCostsResponse } = await import(new URL("./ops.contract.ts", import.meta.url).href);

const RECONCILIATION_ID = "9a7c-reconciliation";

const TABLES = {
  spend_holds: [],
  cost_reconciliations: [
    {
      id: RECONCILIATION_ID,
      ledger_id: "ledger-1",
      brand_key: "workspace-a",
      feature: "ai_visibility.scan",
      provider: "openrouter",
      endpoint: "probe:gemini",
      kind: "unknown_cost",
      estimate_usd: 0.2,
      actual_usd: null,
      price_version: "2026-10-21.1",
      created_at: "2026-10-21T08:05:00.000Z",
    },
  ],
  spend_ledger: [{ id: "ledger-1", source_ref: "probe_attempt:abc" }],
};

const RPC_ROWS = {
  operator_costs_by_workspace: [
    {
      brand_key: "workspace-a",
      feature: "ai_visibility.scan",
      accounted_usd: 7.412,
      known_usd: 7.012,
      unknown_usd: 0.4,
      calls: 122,
      open_reconciliations: 2,
    },
  ],
  operator_costs_by_endpoint: [
    {
      provider: "openrouter",
      endpoint: "probe:chatgpt",
      calls: 122,
      estimate_usd: 8,
      actual_usd: 7.012,
      unknown_calls: 2,
      undershoots: 0,
      max_ratio: 0.88,
    },
  ],
  engine_cost_stats: [{ engine: "chatgpt", samples: 24, median_usd: 0.004, p90_usd: 0.009 }],
};

/**
 * The admin the routes see. `rpcError` is the message the database refuses
 * with, so the mapping under test is the real one.
 */
function fakeAdmin({ rpcError = null, rpcData = null, rpcRows = RPC_ROWS } = {}) {
  const calls = [];
  const admin = {
    rpc(name, args) {
      calls.push({ name, args });
      if (rpcError) return Promise.resolve({ data: null, error: { message: rpcError } });
      if (rpcData !== null) return Promise.resolve({ data: rpcData, error: null });
      return Promise.resolve({ data: rpcRows[name] ?? [], error: null });
    },
    from(table) {
      let rows = (TABLES[table] ?? []).slice();
      const query = {
        select: () => query,
        eq: (column, value) => {
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        in: (column, values) => {
          rows = rows.filter((row) => values.includes(row[column]));
          return query;
        },
        is: (column, value) => {
          // A column that is absent is null, the way the database reads it.
          rows = rows.filter((row) => (row[column] ?? null) === value);
          return query;
        },
        order: () => query,
        limit: (value) => {
          rows = rows.slice(0, value);
          return query;
        },
        then: (resolve) => Promise.resolve({ data: rows, error: null }).then(resolve),
      };
      return query;
    },
  };
  return { admin, calls };
}

function deps(over = {}) {
  const { admin, calls } = fakeAdmin();
  return { calls, deps: { getSupabaseAdmin: () => admin, ...over } };
}

function post(body) {
  return new Request("https://app.test/api/ops/costs/reconciliations/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function read(response) {
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.json(),
  };
}

test("the operator cost view answers the ledger rows it was given", async () => {
  const { deps: injected } = deps();

  const { status, cacheControl, body } = await read(
    await COSTS.GET(new Request("https://app.test/api/ops/costs?from=2026-10-01T00:00:00.000Z&to=2026-10-21T00:00:00.000Z"), injected)
  );

  assert.equal(status, 200);
  assert.equal(cacheControl, "no-store");
  assert.deepEqual(body.byWorkspace, [
    {
      brandKey: "workspace-a",
      feature: "ai_visibility.scan",
      accountedUsd: 7.412,
      knownUsd: 7.012,
      unknownUsd: 0.4,
      calls: 122,
      openReconciliations: 2,
    },
  ]);
  assert.deepEqual(body.byEndpoint, [
    {
      provider: "openrouter",
      endpoint: "probe:chatgpt",
      calls: 122,
      estimateUsd: 8,
      actualUsd: 7.012,
      unknownCalls: 2,
      undershoots: 0,
      maxRatio: 0.88,
    },
  ]);
  assert.deepEqual(body.engineStats, [
    { engine: "chatgpt", samples: 24, medianUsd: 0.004, p90Usd: 0.009 },
  ]);
  // A probe attempt is reconciled from Measurement operations, and the queue
  // says so.
  assert.equal(body.reconciliations[0].isProbe, true);
  assert.equal(body.reconciliations[0].kind, "unknown_cost");
  assert.equal(body.reconciliations[0].createdAt, "2026-10-21T08:05:00.000Z");
  assert.equal(body.priceVersion, "2026-10-21.1");

  const parsed = opsCostsResponse.safeParse(body);
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

test("a window longer than 400 days is a 400 invalid_range", async () => {
  const { deps: injected } = deps();

  const { status, body } = await read(
    await COSTS.GET(
      new Request("https://app.test/api/ops/costs?from=2024-01-01T00:00:00.000Z&to=2026-10-21T00:00:00.000Z"),
      injected
    )
  );

  assert.equal(status, 400);
  assert.equal(body.code, "invalid_range");
  assert.equal(body.error, "Choose a range of 400 days or less.");
});

test("a malformed window is a 400 invalid_request", async () => {
  const { deps: injected } = deps();

  const { status, body } = await read(
    await COSTS.GET(new Request("https://app.test/api/ops/costs?from=yesterday"), injected)
  );

  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
});

test("resolving one reconciliation answers 200 { resolved: true }", async () => {
  const { deps: injected, calls } = deps();

  const { status, body } = await read(
    await RESOLVE.POST(
      post({ resolution: "accepted", note: "checked with the provider" }),
      { params: { id: RECONCILIATION_ID } },
      injected
    )
  );

  assert.equal(status, 200);
  assert.deepEqual(body, { resolved: true });
  const rpc = calls.find((call) => call.name === "resolve_cost_reconciliation");
  assert.ok(rpc, "the reconciliation is resolved through the database function");
  assert.equal(rpc.args.p_id, RECONCILIATION_ID);
  assert.equal(rpc.args.p_resolution, "accepted");
  assert.equal(rpc.args.p_note, "checked with the provider");
});

test("a probe attempt is refused with 409 use_probe_reconciliation and its recovery", async () => {
  const { admin } = fakeAdmin({
    rpcError: "probe attempts are reconciled with reconcile_probe_dispatch",
  });
  const injected = { getSupabaseAdmin: () => admin };

  const { status, body } = await read(
    await RESOLVE.POST(
      post({ resolution: "not_billed", note: "this one was never dispatched" }),
      { params: { id: RECONCILIATION_ID } },
      injected
    )
  );

  assert.equal(status, 409);
  assert.equal(body.code, "use_probe_reconciliation");
  assert.equal(
    body.recovery,
    "Reconcile this attempt from Measurement operations with reconcile_probe_dispatch."
  );
});

test("only an unknown cost can be marked not billed: 409 not_unknown_cost", async () => {
  const { admin } = fakeAdmin({
    rpcError: "only unknown costs can be marked not billed",
  });
  const injected = { getSupabaseAdmin: () => admin };

  const { status, body } = await read(
    await RESOLVE.POST(
      post({ resolution: "not_billed", note: "this one was never dispatched" }),
      { params: { id: RECONCILIATION_ID } },
      injected
    )
  );

  assert.equal(status, 409);
  assert.equal(body.code, "not_unknown_cost");
});

test("a reconciliation that does not exist is a 404", async () => {
  const { admin } = fakeAdmin({ rpcError: "reconciliation not found" });
  const injected = { getSupabaseAdmin: () => admin };

  const { status, body } = await read(
    await RESOLVE.POST(
      post({ resolution: "accepted", note: "checked with the provider" }),
      { params: { id: RECONCILIATION_ID } },
      injected
    )
  );

  assert.equal(status, 404);
  assert.equal(body.code, "reconciliation_not_found");
});

test("a short note is a 400 note_required, on both routes", async () => {
  const { deps: injected } = deps();

  const one = await read(
    await RESOLVE.POST(
      post({ resolution: "accepted", note: "short" }),
      { params: { id: RECONCILIATION_ID } },
      injected
    )
  );
  assert.equal(one.status, 400);
  assert.equal(one.body.code, "note_required");
  assert.equal(one.body.error, "Add a note of at least 10 characters.");

  const bulk = await read(
    await BULK.POST(
      post({ kind: "unknown_cost", beforeDays: 30, note: "short" }),
      injected
    )
  );
  assert.equal(bulk.status, 400);
  assert.equal(bulk.body.code, "note_required");
  assert.equal(bulk.body.error, "Add a note of at least 10 characters.");
});

test("the database's own note refusal is a 400 note_required too", async () => {
  const { admin } = fakeAdmin({
    rpcError: "resolution and a note of at least 10 characters are required",
  });
  const injected = { getSupabaseAdmin: () => admin };

  const { status, body } = await read(
    await RESOLVE.POST(
      post({ resolution: "accepted", note: "checked with the provider" }),
      { params: { id: RECONCILIATION_ID } },
      injected
    )
  );

  assert.equal(status, 400);
  assert.equal(body.code, "note_required");
});

test("the bulk resolve answers the number of rows it resolved", async () => {
  const { admin, calls } = fakeAdmin({ rpcData: 12 });
  const injected = { getSupabaseAdmin: () => admin };

  const { status, body } = await read(
    await BULK.POST(
      post({ kind: "unknown_cost", beforeDays: 30, note: "older than a month", limit: 500 }),
      injected
    )
  );

  assert.equal(status, 200);
  assert.deepEqual(body, { resolved: 12 });
  const rpc = calls.find((call) => call.name === "resolve_unknown_cost_backlog");
  assert.ok(rpc, "the backlog is resolved through the database function");
  assert.equal(rpc.args.p_limit, 500);
  assert.equal(rpc.args.p_by, "operator");
});

test("a bulk resolve with an unknown field is a 400 invalid_request", async () => {
  const { deps: injected } = deps();

  const { status, body } = await read(
    await BULK.POST(
      post({ kind: "unknown_cost", beforeDays: 30, note: "older than a month", surprise: true }),
      injected
    )
  );

  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
});

test("a bulk resolve with the wrong kind is a 400 invalid_request", async () => {
  const { deps: injected } = deps();

  const { status, body } = await read(
    await BULK.POST(
      post({ kind: "anything", beforeDays: 30, note: "older than a month" }),
      injected
    )
  );

  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
});
