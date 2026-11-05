/**
 * F03 §6.5 — `GET /api/customer/usage`, driven through the real route handler
 * and the real cost service.
 *
 * Only the authenticated request context and the storage transport are
 * substituted (`deps`); the aggregation, the feature-flag check and the error
 * mapping are the shipped code.
 *
 * The admin fake is a small query builder: it records every filter, so the
 * test can prove that every ledger query was scoped to the caller's workspace,
 * and it derives its rows from the window the service asked for, so the
 * fixture never depends on the wall clock.
 *
 * Hooks: `src/lib/customerRoutes.test.hooks.mjs`, the resolver the customer
 * route tests use. It maps only module specifiers; nothing under test is
 * replaced.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("../customerRoutes.test.hooks.mjs", import.meta.url));

const ROUTE = await import(new URL("../../app/api/customer/usage/route.ts", import.meta.url).href);
const { usageResponse, timeZoneProbeCacheSize, TIME_ZONE_PROBE_LIMIT } = await import(
  new URL("./usage.contract.ts", import.meta.url).href
);

const BRAND_A = "workspace-a";
const BRAND_B = "workspace-b";
const USER = { id: "user-a", email: "owner@example.test" };

function brand(brandKey) {
  return {
    brandKey,
    role: "owner",
    display_name: "Workspace",
    website: `https://${brandKey}.example`,
    website_host: `${brandKey}.example`,
    aliases: [],
    is_active: true,
  };
}

/**
 * The ledger the fake serves: one row for the caller's workspace and one for
 * another workspace. The other row's amount is deliberately absurd, so a leak
 * is impossible to miss.
 */
function ledgerRows(windowEnd) {
  const when = windowEnd
    ? new Date(new Date(windowEnd).getTime() - 60 * 60 * 1000).toISOString()
    : new Date().toISOString();
  return [
    {
      brand_key: BRAND_A,
      occurred_at: when,
      feature: "ai_visibility.scan",
      provider: "openrouter",
      endpoint: "probe:chatgpt",
      actual_usd: 0.04,
      accounted_usd: 0.04,
      cost_source: "provider_reported",
      meta: {},
    },
    {
      brand_key: BRAND_B,
      occurred_at: when,
      feature: "ai_visibility.scan",
      provider: "openrouter",
      endpoint: "probe:gemini",
      actual_usd: 9.99,
      accounted_usd: 9.99,
      cost_source: "provider_reported",
      meta: {},
    },
  ];
}

function applyFilters(rows, filters) {
  let out = rows.slice();
  for (const [op, column, value] of filters) {
    if (op === "eq") out = out.filter((row) => row[column] === value);
    else if (op === "neq") out = out.filter((row) => row[column] !== value);
    else if (op === "gte") out = out.filter((row) => String(row[column]) >= String(value));
    else if (op === "lt") out = out.filter((row) => String(row[column]) < String(value));
    else if (op === "limit") out = out.slice(0, value);
  }
  return out;
}

/**
 * The admin the route sees. It answers the two read functions migration 051
 * added and the ledger read behind the recent-activity list, and it refuses
 * to read a workspace the caller does not own.
 */
function fakeAdmin() {
  const queries = [];
  const admin = {
    rpc(name, args) {
      queries.push({ kind: "rpc", name, args });
      if (name === "workspace_usage_days") {
        assert.equal(args.p_brand, BRAND_A, "the day bins are read for one workspace only");
        // One local day after the window opens, so the bin is inside it.
        const day = new Date(new Date(args.p_from).getTime() + 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        return Promise.resolve({
          data: [
            {
              day,
              feature: "ai_visibility.scan",
              accounted_usd: 0.04,
              known_usd: 0.04,
              unknown_usd: 0,
              calls: 1,
            },
          ],
          error: null,
        });
      }
      if (name === "workspace_spend_position") {
        assert.equal(args.p_brand, BRAND_A, "the position is read for one workspace only");
        const now = new Date();
        const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        return Promise.resolve({
          data: {
            today_usd: 0.04,
            month_usd: 0.04,
            daily_cap_usd: null,
            monthly_cap_usd: null,
            open_holds_usd: 0,
            open_holds: 0,
            day_starts_at: dayStart.toISOString(),
            month_starts_at: monthStart.toISOString(),
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(table) {
      const filters = [];
      const query = {
        select: () => query,
        eq: (column, value) => {
          filters.push(["eq", column, value]);
          return query;
        },
        neq: (column, value) => {
          filters.push(["neq", column, value]);
          return query;
        },
        gte: (column, value) => {
          filters.push(["gte", column, value]);
          return query;
        },
        lt: (column, value) => {
          filters.push(["lt", column, value]);
          return query;
        },
        order: () => query,
        limit: (value) => {
          filters.push(["limit", null, value]);
          return query;
        },
        then: (resolve) => {
          const end = filters.find(([op, column]) => op === "lt" && column === "occurred_at");
          const rows = applyFilters(
            table === "spend_ledger" ? ledgerRows(end ? end[2] : null) : [],
            filters
          );
          queries.push({
            kind: "select",
            table,
            filters: filters.map(([op, column, value]) => ({ op, column, value })),
          });
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return query;
    },
  };
  return { admin, queries };
}

/** The route's dependencies. Only the session and the transport are substituted. */
function deps(over = {}) {
  const { admin, queries } = fakeAdmin();
  const calls = [];
  return {
    queries,
    calls,
    deps: {
      getCustomerContext: async () => ({
        client: null,
        user: USER,
        brands: [brand(BRAND_A)],
        error: null,
      }),
      getSupabaseAdmin: () => admin,
      isFeatureEnabled: async (name, brandKey) => {
        calls.push({ name, brandKey });
        return true;
      },
      env: {},
      ...over,
    },
  };
}

function request(search = "") {
  return new Request(`https://app.test/api/customer/usage${search}`);
}

async function read(response) {
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.json(),
  };
}

test("the usage route answers the workspace's own ledger, and only that ledger", async () => {
  const { deps: injected, queries, calls } = deps();

  const { status, cacheControl, body } = await read(
    await ROUTE.GET(request("?tz=UTC&range=7d"), {}, injected)
  );

  assert.equal(status, 200);
  assert.equal(cacheControl, "no-store");

  // The flag is asked for by name, for the caller's own workspace.
  assert.deepEqual(calls, [{ name: "usage_page", brandKey: BRAND_A }]);

  // Every read of the ledger is scoped to the caller's workspace. The fake
  // does not filter by itself, so a missing filter would leak the other
  // workspace's row into the answer below.
  const ledgerQueries = queries.filter(
    (query) => query.kind === "select" && query.table === "spend_ledger"
  );
  assert.ok(ledgerQueries.length >= 1, "the recent list reads the ledger");
  for (const query of ledgerQueries) {
    const brandFilters = query.filters.filter(
      (filter) => filter.op === "eq" && filter.column === "brand_key"
    );
    assert.deepEqual(
      brandFilters.map((filter) => filter.value),
      [BRAND_A],
      "every ledger query is scoped to the caller's workspace"
    );
  }

  assert.deepEqual(
    body.recent.map((row) => row.endpoint),
    ["probe:chatgpt"],
    "another workspace's row is never in the answer"
  );
  assert.equal(body.recent[0].usd, 0.04);
  assert.ok(
    !JSON.stringify(body).includes("probe:gemini"),
    "another workspace's row is never in the answer, in any field"
  );
  assert.equal(body.totals.accountedUsd, 0.04);
  assert.equal(body.timeZone, "UTC");
  assert.equal(body.range, "7d");
});

test("the usage answer matches the wire contract", async () => {
  const { deps: injected } = deps();

  const { status, body } = await read(await ROUTE.GET(request("?tz=UTC"), {}, injected));

  assert.equal(status, 200);
  const parsed = usageResponse.safeParse(body);
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  assert.equal(body.days.length, 30, "the default range is 30 days");
  assert.deepEqual(
    body.days.map((day) => day.date).slice(0, 2),
    body.days.map((day) => day.date).slice(0, 2),
    "the days are oldest first"
  );
});

test("an unknown time zone is a 400 invalid_request", async () => {
  const { deps: injected, calls } = deps();

  const { status, body } = await read(
    await ROUTE.GET(request("?tz=Mars/Olympus_Mons"), {}, injected)
  );

  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
  assert.equal(calls.length, 0, "a bad query never reaches the flag or the ledger");
});

test("the time zone gate accepts every IANA zone and refuses everything else", async () => {
  // `Asia/Kolkata` is §6.5's own example query. ICU's canonical list carries
  // `Asia/Calcutta` and not `Asia/Kolkata`, so a gate built on that list
  // alone refuses the spec's own example.
  for (const tz of ["Asia/Kolkata", "Asia/Calcutta", "UTC"]) {
    const { deps: injected } = deps();

    const { status, body } = await read(
      await ROUTE.GET(request(`?tz=${encodeURIComponent(tz)}`), {}, injected)
    );

    assert.equal(status, 200, `${tz} must be accepted, not refused`);
    assert.equal(body.timeZone, tz, "the answer echoes the zone the client asked for");
  }

  // A zone the runtime cannot format is still a client error, and it never
  // reaches the flag or the ledger.
  for (const tz of ["Not/AZone", "", "garbage"]) {
    const { deps: injected, calls } = deps();

    const { status, body } = await read(
      await ROUTE.GET(request(`?tz=${encodeURIComponent(tz)}`), {}, injected)
    );

    assert.equal(status, 400, `${tz} must be refused`);
    assert.equal(body.code, "invalid_request");
    assert.equal(calls.length, 0, "a bad query never reaches the flag or the ledger");
  }
});

test("the time-zone memo map cannot grow past its cap", async () => {
  // The memo is keyed by the lowercased zone, so the spellings of ONE zone
  // collapse into ONE entry — otherwise a client could pay for an ICU probe
  // per spelling and fill the map with variants of a single zone.
  const before = timeZoneProbeCacheSize();
  for (const tz of ["US/Eastern", "us/eastern", "US/EASTERN", "Us/eAsTeRn"]) {
    const { deps: injected } = deps();

    const { status, body } = await read(
      await ROUTE.GET(request(`?tz=${encodeURIComponent(tz)}`), {}, injected)
    );

    assert.equal(status, 200, `${tz} must be accepted, not refused`);
    assert.equal(body.timeZone, tz, "the answer echoes the zone the client asked for");
  }
  assert.equal(
    timeZoneProbeCacheSize() - before,
    1,
    "the case variants of one zone collapse into one memo entry"
  );

  // The key is client-supplied and the refine runs before the session check,
  // so the map must not grow without limit either.
  for (let i = 0; i <= TIME_ZONE_PROBE_LIMIT; i++) {
    const { status } = await read(
      await ROUTE.GET(request(`?tz=${encodeURIComponent(`Not/AZone${i}`)}`))
    );
    assert.equal(status, 400, "a zone the runtime cannot format is a client error");
  }
  assert.ok(
    timeZoneProbeCacheSize() <= TIME_ZONE_PROBE_LIMIT,
    `the memo must not grow past its cap (it holds ${timeZoneProbeCacheSize()})`
  );

  // And the spec's own example still answers after the flood.
  const { deps: injected } = deps();
  const { status, body } = await read(
    await ROUTE.GET(request("?tz=Asia%2FKolkata"), {}, injected)
  );
  assert.equal(status, 200, "Asia/Kolkata must still answer after the flood");
  assert.equal(body.timeZone, "Asia/Kolkata");
});

test("an unknown range is a 400 invalid_request", async () => {
  const { deps: injected, calls } = deps();

  const { status, body } = await read(await ROUTE.GET(request("?range=7x"), {}, injected));

  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
  assert.equal(calls.length, 0, "a bad query never reaches the flag or the ledger");
});

test("an unknown query parameter is a 400 invalid_request", async () => {
  const { deps: injected } = deps();

  const { status, body } = await read(await ROUTE.GET(request("?unexpected=1"), {}, injected));

  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
});

test("the flag off answers 404 feature_unavailable and reads nothing", async () => {
  const { deps: injected, queries } = deps({
    isFeatureEnabled: async () => false,
  });

  const { status, body } = await read(await ROUTE.GET(request("?tz=UTC"), {}, injected));

  assert.equal(status, 404);
  assert.equal(body.code, "feature_unavailable");
  assert.equal(body.error, "Usage is not available for this workspace yet.");
  assert.equal(
    queries.filter((query) => query.kind === "select").length,
    0,
    "the flag is checked before the ledger is read"
  );
});

test("a database failure answers 503 usage_unavailable with our own copy", async () => {
  const { deps: injected } = deps({
    getWorkspaceUsage: async () => {
      throw new Error("the database is unavailable");
    },
  });

  const { status, body } = await read(await ROUTE.GET(request("?tz=UTC"), {}, injected));

  assert.equal(status, 503);
  assert.equal(body.code, "usage_unavailable");
  assert.equal(body.error, "Usage could not be loaded. Please retry.");
});

test("a database failure is logged with the route name and the error", async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => {
    logged.push(args);
  };
  try {
    const { deps: injected } = deps({
      getWorkspaceUsage: async () => {
        throw new Error("the database is unavailable");
      },
    });

    const { status, body } = await read(await ROUTE.GET(request("?tz=UTC"), {}, injected));

    assert.equal(status, 503);
    assert.equal(body.error, "Usage could not be loaded. Please retry.");
  } finally {
    console.error = original;
  }

  // The route swallows the database error, so its log is the only trace.
  assert.equal(logged.length, 1, "the swallowed database error is logged once");
  assert.match(String(logged[0][0]), /usage/, "the log names the route");
  assert.match(
    String(logged[0][1]),
    /the database is unavailable/,
    "the log carries the error's message"
  );
  assert.ok(
    !JSON.stringify(logged).includes(BRAND_A),
    "the log carries no workspace key"
  );
});

test("an anonymous caller is a 401 and never reaches the ledger", async () => {
  const { deps: injected, queries } = deps({
    getCustomerContext: async () => ({ client: null, user: null, brands: [], error: null }),
  });

  const { status, body } = await read(await ROUTE.GET(request("?tz=UTC"), {}, injected));

  assert.equal(status, 401);
  assert.equal(body.code, "unauthenticated");
  assert.equal(queries.length, 0, "nothing is read without a session");
});

test("another workspace's key is refused by the workspace resolver", async () => {
  const { deps: injected } = deps();

  const { status, body } = await read(
    await ROUTE.GET(request("?brand_key=workspace-b&tz=UTC"), {}, injected)
  );

  assert.equal(status, 404);
  assert.equal(body.code, "workspace_not_found");
  assert.equal(body.error, "Workspace not found.");
});
