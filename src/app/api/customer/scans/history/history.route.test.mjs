/**
 * F06 phase 5 — GET /api/customer/scans/history (F06-AC-17, -18, -21 route half).
 *
 * Exercises the real route and the real query builder against an in-memory
 * PostgREST-shaped admin. No network, no database, no provider call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("../../../../../lib/customerRoutes.test.hooks.mjs", import.meta.url));

const ROUTE = await import(new URL("./route.ts", import.meta.url).href);

const USER = { id: "user-1", email: "owner@example.test" };

function brand(over = {}) {
  return {
    brandKey: "acme",
    role: "member",
    display_name: "Acme",
    website: "https://acme.example",
    website_host: "acme.example",
    aliases: ["Acme", "acme"],
    is_active: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A PostgREST-shaped in-memory admin.
// ---------------------------------------------------------------------------

function compare(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a < b ? -1 : 1;
}

function splitTop(expression) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(expression.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(expression.slice(start));
  return parts;
}

function evalCondition(expression, row) {
  const expr = expression.trim();
  if (expr.startsWith("and(") && expr.endsWith(")")) {
    return splitTop(expr.slice(4, -1)).every((part) => evalCondition(part, row));
  }
  if (expr === "visibility_pct.is.null") return row.visibility_pct == null;
  const notNull = expr.match(/^([A-Za-z_]+)\.not\.is\.null$/);
  if (notNull) return row[notNull[1]] != null;
  const eq = expr.match(/^([A-Za-z_]+)\.eq\.(.+)$/);
  if (eq) {
    const expected = eq[2] === "true" ? true : eq[2] === "false" ? false : eq[2];
    return row[eq[1]] === expected;
  }
  return false;
}

class Chain {
  constructor(admin, table, mode, payload) {
    this.admin = admin;
    this.table = table;
    this.mode = mode;
    this.payload = payload;
    this.columns = "";
    this.head = false;
    this.filters = [];
    this.orders = [];
    this.rangeBounds = null;
    this.limitCount = null;
  }

  select(columns, options) {
    this.columns = columns;
    this.head = Boolean(options?.count);
    return this;
  }

  eq(column, value) {
    this.filters.push(["eq", column, value]);
    return this;
  }

  gte(column, value) {
    this.filters.push(["gte", column, value]);
    return this;
  }

  lt(column, value) {
    this.filters.push(["lt", column, value]);
    return this;
  }

  lte(column, value) {
    this.filters.push(["lte", column, value]);
    return this;
  }

  overlaps(column, values) {
    this.filters.push(["cs", column, values]);
    return this;
  }

  or(expression) {
    this.filters.push(["or", expression]);
    return this;
  }

  order(column, options) {
    this.orders.push([column, options.ascending !== false, options.nullsFirst === true]);
    return this;
  }

  range(from, to) {
    this.rangeBounds = [from, to];
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  matches(row) {
    return this.filters.every((filter) => {
      const [op, column, value] = filter;
      if (op === "eq") return row[column] === value;
      if (op === "gte") return compare(row[column], value) >= 0;
      if (op === "lte") return compare(row[column], value) <= 0;
      if (op === "lt") return compare(row[column], value) < 0;
      if (op === "cs") {
        return Array.isArray(row[column]) && value.some((entry) => row[column].includes(entry));
      }
      if (op === "or") {
        return splitTop(column).some((part) => evalCondition(part, row));
      }
      return true;
    });
  }

  run() {
    if (this.table !== "scans") return { data: [], error: null, count: 0 };

    // The owner-mandated degraded mode: migration 066 absent, so the derived
    // columns are missing and the main query fails with 42703.
    if (!this.columns.includes("engine_summaries") && this.admin.mainError) {
      return { data: null, error: this.admin.mainError, count: null };
    }

    let rows = this.admin.scans.filter((row) => this.matches(row));
    const total = rows.length;

    for (const [column, ascending, nullsFirst] of [...this.orders].reverse()) {
      rows = [...rows].sort((a, b) => {
        const result = compare(a[column], b[column]);
        if (result === 0) return 0;
        if (a[column] == null) return nullsFirst ? -1 : 1;
        if (b[column] == null) return nullsFirst ? 1 : -1;
        return ascending ? result : -result;
      });
    }

    if (this.rangeBounds) rows = rows.slice(this.rangeBounds[0], this.rangeBounds[1] + 1);
    if (this.limitCount != null) rows = rows.slice(0, this.limitCount);

    if (this.head) return { data: rows, error: null, count: total };
    return { data: rows, error: null, count: null };
  }

  then(resolve, reject) {
    try {
      return Promise.resolve(this.run()).then(resolve, reject);
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

function makeAdmin(seed = []) {
  const admin = { scans: seed, mainError: null };
  admin.from = (table) => ({
    select: (columns, options) => new Chain(admin, table, "select", null).select(columns, options),
  });
  return admin;
}

function depsFor(admin, over = {}) {
  return {
    getCustomerContext: async () => ({ client: null, user: USER, brands: [brand()], error: null }),
    getSupabaseAdmin: () => admin,
    ...over,
  };
}

function request(query, deps) {
  return ROUTE.GET(
    new Request(`https://app.test/api/customer/scans/history?${query}`, { method: "GET" }),
    {},
    deps,
  );
}

async function read(response) {
  return { status: response.status, cacheControl: response.headers.get("cache-control"), body: await response.json() };
}

function scan(over = {}) {
  return {
    id: "scan-1",
    brand: "Acme",
    url: "https://acme.example",
    brand_key: "acme",
    scanned_at: "2026-10-21T09:00:00.000Z",
    created_at: "2026-10-21T09:00:00.000Z",
    listed_at: "2026-10-21T09:00:00.000Z",
    visibility_pct: 72,
    prompts_tracked: 30,
    prompts_mentioned: 22,
    platform: ["chatgpt", "gemini"],
    engines: ["chatgpt", "gemini"],
    collection_partial: false,
    started_by: "manual",
    ...over,
  };
}

function historySeed(count, over = {}) {
  return Array.from({ length: count }, (_, index) =>
    scan({
      id: `scan-${String(index + 1).padStart(3, "0")}`,
      listed_at: new Date(Date.UTC(2026, 9, 21, 9) - index * 3_600_000).toISOString(),
      scanned_at: new Date(Date.UTC(2026, 9, 21, 9) - index * 3_600_000).toISOString(),
      visibility_pct: index % 7 === 0 ? null : 50 - index,
      ...over,
    }),
  );
}

test("defaults: page 1 of 50 newest by listed_at with the exact total", async () => {
  const admin = makeAdmin(historySeed(3));
  const response = await read(await request("brand_key=acme", depsFor(admin)));
  assert.equal(response.status, 200);
  assert.equal(response.cacheControl, "no-store");
  assert.equal(response.body.brand_key, "acme");
  assert.equal(response.body.page, 1);
  assert.equal(response.body.size, 50);
  assert.equal(response.body.totalCount, 3);
  assert.deepEqual(response.body.scans.map((row) => row.id), ["scan-001", "scan-002", "scan-003"]);
});

test("page=2&size=25 returns rows 26-50 of the filtered history", async () => {
  const admin = makeAdmin(historySeed(60));
  const response = await read(await request("brand_key=acme&page=2&size=25", depsFor(admin)));
  assert.equal(response.status, 200);
  assert.equal(response.body.totalCount, 60);
  assert.equal(response.body.page, 2);
  assert.equal(response.body.size, 25);
  assert.equal(response.body.scans.length, 25);
  assert.equal(response.body.scans[0].id, "scan-026");
  assert.equal(response.body.scans[24].id, "scan-050");
});

test("startedBy=scheduled returns only scheduled scans", async () => {
  const admin = makeAdmin([
    scan({ id: "manual-1", started_by: "manual" }),
    scan({ id: "scheduled-1", started_by: "scheduled" }),
    scan({ id: "scheduled-2", started_by: "scheduled" }),
  ]);
  const response = await read(await request("brand_key=acme&startedBy=scheduled", depsFor(admin)));
  assert.equal(response.status, 200);
  assert.equal(response.body.totalCount, 2);
  assert.deepEqual(response.body.scans.map((row) => row.id), ["scheduled-1", "scheduled-2"]);
});

test("engines combine with OR inside the group", async () => {
  const admin = makeAdmin([
    scan({ id: "a", engines: ["chatgpt"] }),
    scan({ id: "b", engines: ["gemini"] }),
    scan({ id: "c", engines: ["perplexity"] }),
  ]);
  const response = await read(await request("brand_key=acme&engines=chatgpt,gemini", depsFor(admin)));
  assert.equal(response.status, 200);
  assert.equal(response.body.totalCount, 2);
  assert.deepEqual(response.body.scans.map((row) => row.id).sort(), ["a", "b"]);
});

test("collection filters: pending = unmeasured, partial, complete = measured and not partial", async () => {
  const admin = makeAdmin([
    scan({ id: "pending", visibility_pct: null }),
    scan({ id: "partial", visibility_pct: 40, collection_partial: true }),
    scan({ id: "complete", visibility_pct: 60, collection_partial: false }),
  ]);
  const pending = await read(await request("brand_key=acme&collection=pending", depsFor(admin)));
  assert.deepEqual(pending.body.scans.map((row) => row.id), ["pending"]);
  const partial = await read(await request("brand_key=acme&collection=partial", depsFor(admin)));
  assert.deepEqual(partial.body.scans.map((row) => row.id), ["partial"]);
  const complete = await read(await request("brand_key=acme&collection=complete", depsFor(admin)));
  assert.deepEqual(complete.body.scans.map((row) => row.id), ["complete"]);
});

test("visibility bounds exclude unmeasured scans", async () => {
  const admin = makeAdmin([
    scan({ id: "low", visibility_pct: 10 }),
    scan({ id: "mid", visibility_pct: 50 }),
    scan({ id: "high", visibility_pct: 90 }),
    scan({ id: "none", visibility_pct: null }),
  ]);
  const response = await read(await request("brand_key=acme&visMin=40&visMax=60", depsFor(admin)));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.scans.map((row) => row.id), ["mid"]);
});

test("date range uses listed_at and the requested time zone", async () => {
  const admin = makeAdmin([
    scan({ id: "before", listed_at: "2026-09-30T18:29:59.999Z", scanned_at: "2026-09-30T18:29:59.999Z" }),
    scan({ id: "inside", listed_at: "2026-09-30T18:30:00.000Z", scanned_at: "2026-09-30T18:30:00.000Z" }),
    scan({ id: "after", listed_at: "2026-10-01T18:30:00.000Z", scanned_at: "2026-10-01T18:30:00.000Z" }),
  ]);
  const response = await read(
    await request("brand_key=acme&from=2026-10-01&to=2026-10-01&tz=Asia/Kolkata", depsFor(admin)),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.scans.map((row) => row.id), ["inside"]);
});

test("an invalid visibility bound is a 400 before any query runs", async () => {
  const admin = makeAdmin([scan()]);
  const response = await read(await request("brand_key=acme&visMin=120", depsFor(admin)));
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "invalid_request");
});

test("another workspace's brand_key is refused by requireWorkspace", async () => {
  const admin = makeAdmin([scan()]);
  const response = await read(await request("brand_key=beta", depsFor(admin)));
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "workspace_not_found");
});

test("a missing derived column (42703) falls back to the phase 2 list behaviour", async () => {
  const admin = makeAdmin(
    Array.from({ length: 25 }, (_, index) =>
      scan({
        id: `scan-${index + 1}`,
        scanned_at: new Date(Date.UTC(2026, 9, 21, 9) - index * 3_600_000).toISOString(),
        engine_summaries: [{ engine: "chatgpt" }],
      }),
    ),
  );
  admin.mainError = { code: "42703", message: 'column "engines" does not exist' };

  const response = await read(await request("brand_key=acme", depsFor(admin)));
  assert.equal(response.status, 200);
  assert.equal(response.body.brand_key, "acme");
  assert.equal(response.body.totalCount, 20, "the fallback keeps the phase 2 latest-20 cap");
  assert.equal(response.body.scans.length, 20);
  assert.equal(response.body.scans[0].id, "scan-1", "newest scanned_at first");
  assert.deepEqual(response.body.scans[0].platform, ["chatgpt"], "platform is derived from raw_results->engines");
});

test("the fallback is used only for 42703; another error still surfaces", async () => {
  const admin = makeAdmin([scan()]);
  admin.mainError = { code: "42P02", message: "relation does not exist" };
  const response = await read(await request("brand_key=acme", depsFor(admin)));
  assert.equal(response.status, 500);
  assert.equal(response.body.code, "internal_error");
});
