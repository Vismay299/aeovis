// The four operator spend routes are driven through their real handlers with a
// fake PostgREST client, so the assertions are about the response body and the
// exact columns each write sends, not about a copy of them.
import test from "node:test";
import assert from "node:assert/strict";

const CONTROLS = await import(new URL("../../app/api/ops/spend/controls/route.ts", import.meta.url).href);
const CONTROL = await import(new URL("../../app/api/ops/spend/controls/[feature]/route.ts", import.meta.url).href);
const LIMITS = await import(new URL("../../app/api/ops/spend/limits/route.ts", import.meta.url).href);
const LIMIT = await import(new URL("../../app/api/ops/spend/limits/[brandKey]/route.ts", import.meta.url).href);

const CONTROL_ROW = {
  feature: "platform.selftest",
  enabled: false,
  mode: "allowlist",
  brand_allowlist: [],
  daily_cap_usd: null,
  max_call_usd: null,
  note: "Owner-run LLM helper live check.",
  updated_at: "2026-10-21T09:00:00.000Z",
};

const LIMIT_ROW = {
  brand_key: "example-workspace",
  daily_cap_usd: "25.000000",
  monthly_cap_usd: null,
  updated_at: "2026-10-21T09:00:00.000Z",
};

/**
 * A fake PostgREST client. Every chain the routes use is represented
 * (select/eq/order/upsert/select/single/maybeSingle), and each write is recorded
 * verbatim so a test can assert the columns instead of trusting the route.
 * The two reads `PUT /limits/[brandKey]` runs are recorded separately, in
 * `brandReads` and `limitReads`, so the write assertions keep counting writes only.
 */
function fakeAdmin({
  rows = [],
  error = null,
  brand = { brand_key: "example-workspace" },
  brandError = null,
  currentLimit = null,
  limitError = null,
  calls = [],
} = {}) {
  const brandReads = [];
  const limitReads = [];
  return {
    calls,
    brandReads,
    limitReads,
    admin: {
      from(table) {
        const state = { table, filters: [], payload: null };
        const builder = {
          select() {
            return builder;
          },
          eq(column, value) {
            state.filters.push([column, value]);
            return builder;
          },
          upsert(payload, options) {
            calls.push({ op: "upsert", table, payload, options });
            state.payload = payload;
            return builder;
          },
          async order(column) {
            calls.push({ op: "order", table, column, filters: state.filters });
            return { data: rows, error };
          },
          // Two single-row reads: the `customer_brands` lookup (`brand: null` is the
          // "no such workspace" row set) and the limit row the PUT merges omitted caps
          // into (`currentLimit: null` is a workspace with no row yet).
          async maybeSingle() {
            if (table === "workspace_spend_limits") {
              limitReads.push({ op: "select", table, filters: state.filters });
              if (limitError) return { data: null, error: limitError };
              return { data: currentLimit, error: null };
            }
            brandReads.push({ op: "select", table, filters: state.filters });
            if (brandError) return { data: null, error: brandError };
            return { data: brand, error: null };
          },
          async single() {
            return { data: state.payload, error };
          },
        };
        return builder;
      },
    },
  };
}

const asDeps = (fake) => ({ getSupabaseAdmin: () => fake.admin });

async function read(response) {
  return { status: response.status, cacheControl: response.headers.get("cache-control"), body: await response.json() };
}

function putControl(feature, body, fake) {
  return CONTROL.PUT(
    new Request(`https://ops.test/api/ops/spend/controls/${feature}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ feature }) },
    asDeps(fake)
  );
}

function putLimit(brandKey, body, fake) {
  return LIMIT.PUT(
    new Request(`https://ops.test/api/ops/spend/limits/${brandKey}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ brandKey }) },
    asDeps(fake)
  );
}

const VALID_CONTROL_BODY = {
  enabled: true,
  mode: "allowlist",
  brandAllowlist: ["example-workspace"],
  dailyCapUsd: 20.5,
  maxCallUsd: 1,
  note: "QA enablement",
  confirm: "platform.selftest",
};

test("PUT /api/ops/spend/controls/[feature] refuses a confirm that is not the feature key", async () => {
  const fake = fakeAdmin();
  const { status, body } = await read(await putControl("platform.selftest", { ...VALID_CONTROL_BODY, confirm: "platform.other" }, fake));
  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
  assert.equal(fake.calls.length, 0, "a mismatched confirm must not write");
});

test("PUT /api/ops/spend/controls/[feature] answers 404 unknown_spend_feature for an unregistered key", async () => {
  const fake = fakeAdmin();
  const { status, body } = await read(
    await putControl("platform.not_registered", { ...VALID_CONTROL_BODY, confirm: "platform.not_registered" }, fake)
  );
  assert.equal(status, 404);
  assert.equal(body.code, "unknown_spend_feature");
  assert.equal(fake.calls.length, 0);
});

test("PUT /api/ops/spend/controls/[feature] refuses unknown body fields", async () => {
  const fake = fakeAdmin();
  const { status, body } = await read(
    await putControl("platform.selftest", { ...VALID_CONTROL_BODY, surprise: 1 }, fake)
  );
  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
  assert.equal(fake.calls.length, 0);
});

test("PUT /api/ops/spend/controls/[feature] upserts exactly the control columns as the operator", async () => {
  const fake = fakeAdmin();
  const logs = [];
  const realLog = console.log;
  console.log = (...args) => logs.push(args);
  let response;
  try {
    response = await read(await putControl("platform.selftest", VALID_CONTROL_BODY, fake));
  } finally {
    console.log = realLog;
  }

  assert.equal(response.status, 200);
  assert.equal(response.cacheControl, "no-store");
  assert.equal(fake.calls.length, 1);
  const [write] = fake.calls;
  assert.equal(write.op, "upsert");
  assert.equal(write.table, "paid_feature_controls");
  assert.deepEqual(write.options, { onConflict: "feature" });
  assert.deepEqual(Object.keys(write.payload).sort(), [
    "brand_allowlist",
    "daily_cap_usd",
    "enabled",
    "feature",
    "max_call_usd",
    "mode",
    "note",
    "updated_at",
    "updated_by",
  ]);
  assert.equal(write.payload.feature, "platform.selftest");
  assert.equal(write.payload.enabled, true);
  assert.equal(write.payload.mode, "allowlist");
  assert.deepEqual(write.payload.brand_allowlist, ["example-workspace"]);
  assert.equal(write.payload.daily_cap_usd, 20.5);
  assert.equal(write.payload.max_call_usd, 1);
  assert.equal(write.payload.note, "QA enablement");
  assert.equal(write.payload.updated_by, "operator");
  assert.match(write.payload.updated_at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

  assert.deepEqual(logs, [["[ops] spend control changed", { feature: "platform.selftest", enabled: true }]]);
  assert.deepEqual(response.body, {
    feature: "platform.selftest",
    enabled: true,
    mode: "allowlist",
    brandAllowlist: ["example-workspace"],
    dailyCapUsd: 20.5,
    maxCallUsd: 1,
    note: "QA enablement",
    updatedAt: write.payload.updated_at,
  });
});

test("GET /api/ops/spend/controls lists every control with camelCase money fields", async () => {
  const fake = fakeAdmin({ rows: [CONTROL_ROW] });
  const { status, cacheControl, body } = await read(await CONTROLS.GET(new Request("https://ops.test/api/ops/spend/controls"), asDeps(fake)));
  assert.equal(status, 200);
  assert.equal(cacheControl, "no-store");
  assert.deepEqual(body, {
    controls: [
      {
        feature: "platform.selftest",
        enabled: false,
        mode: "allowlist",
        brandAllowlist: [],
        dailyCapUsd: null,
        maxCallUsd: null,
        note: "Owner-run LLM helper live check.",
        updatedAt: "2026-10-21T09:00:00.000Z",
      },
    ],
  });
  assert.deepEqual(fake.calls, [{ op: "order", table: "paid_feature_controls", column: "feature", filters: [] }]);
});

test("GET /api/ops/spend/controls answers 503 storage_unavailable without a service client", async () => {
  const { status, body } = await read(
    await CONTROLS.GET(new Request("https://ops.test/api/ops/spend/controls"), { getSupabaseAdmin: () => null })
  );
  assert.equal(status, 503);
  assert.equal(body.code, "storage_unavailable");
});

test("PUT /api/ops/spend/limits/[brandKey] upserts exactly the limit columns as the operator", async () => {
  const fake = fakeAdmin();
  const { status, cacheControl, body } = await read(
    await putLimit("example-workspace", { dailyCapUsd: 25, monthlyCapUsd: null }, fake)
  );
  assert.equal(status, 200);
  assert.equal(cacheControl, "no-store");
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.brandReads, [
    { op: "select", table: "customer_brands", filters: [["brand_key", "example-workspace"]] },
  ]);
  assert.deepEqual(fake.limitReads, [
    { op: "select", table: "workspace_spend_limits", filters: [["brand_key", "example-workspace"]] },
  ]);
  const [write] = fake.calls;
  assert.equal(write.table, "workspace_spend_limits");
  assert.deepEqual(write.options, { onConflict: "brand_key" });
  assert.deepEqual(Object.keys(write.payload).sort(), [
    "brand_key",
    "daily_cap_usd",
    "monthly_cap_usd",
    "updated_at",
    "updated_by",
  ]);
  assert.equal(write.payload.brand_key, "example-workspace");
  assert.equal(write.payload.daily_cap_usd, 25);
  assert.equal(write.payload.monthly_cap_usd, null);
  assert.equal(write.payload.updated_by, "operator");
  assert.deepEqual(body, {
    brandKey: "example-workspace",
    dailyCapUsd: 25,
    monthlyCapUsd: null,
    updatedAt: write.payload.updated_at,
  });
});

test("PUT /api/ops/spend/limits/[brandKey] keeps the cap a partial body omits", async () => {
  const fake = fakeAdmin({ currentLimit: { daily_cap_usd: "25.000000", monthly_cap_usd: "400.000000" } });
  const { status } = await read(await putLimit("example-workspace", { monthlyCapUsd: 900 }, fake));
  assert.equal(status, 200);
  const [write] = fake.calls;
  assert.equal(write.payload.monthly_cap_usd, 900);
  assert.equal(write.payload.daily_cap_usd, 25, "the untouched daily cap survives the write");
});

test("PUT /api/ops/spend/limits/[brandKey] carries the env default into a first partial write", async () => {
  const fake = fakeAdmin({ currentLimit: null });
  const deps = { ...asDeps(fake), env: { SPEND_DEFAULT_DAILY_CAP_USD: "12.5" } };
  const response = await LIMIT.PUT(
    new Request("https://ops.test/api/ops/spend/limits/example-workspace", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ monthlyCapUsd: 900 }),
    }),
    { params: Promise.resolve({ brandKey: "example-workspace" }) },
    deps
  );
  assert.equal(response.status, 200);
  const [write] = fake.calls;
  assert.equal(
    write.payload.daily_cap_usd,
    12.5,
    "a NULL column means no cap, so the env default must be written, not dropped"
  );
  assert.equal(write.payload.monthly_cap_usd, 900);
});

test("PUT /api/ops/spend/limits/[brandKey] still refuses a body that names no cap", async () => {
  const fake = fakeAdmin();
  const { status, body } = await read(await putLimit("example-workspace", {}, fake));
  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
  assert.equal(fake.calls.length, 0);
});

test("PUT /api/ops/spend/limits/[brandKey] answers 503 spend_unavailable when the limit read fails", async () => {
  const fake = fakeAdmin({ limitError: { message: "read timed out" } });
  const { status, body } = await read(
    await putLimit("example-workspace", { dailyCapUsd: 25 }, fake)
  );
  assert.equal(status, 503);
  assert.equal(body.code, "spend_unavailable");
  assert.equal(fake.calls.length, 0);
});

test("PUT /api/ops/spend/limits/[brandKey] rejects a negative or oversized cap", async () => {
  for (const body of [{ dailyCapUsd: -1, monthlyCapUsd: null }, { dailyCapUsd: 10_001, monthlyCapUsd: null }, { dailyCapUsd: null, monthlyCapUsd: 100_001 }]) {
    const fake = fakeAdmin();
    const { status, body: payload } = await read(await putLimit("example-workspace", body, fake));
    assert.equal(status, 400);
    assert.equal(payload.code, "invalid_request");
    assert.equal(fake.calls.length, 0);
  }
});

test("PUT /api/ops/spend/limits/[brandKey] rejects an out-of-bounds path brand key before any database call", async () => {
  const tooLong = fakeAdmin();
  const long = await read(
    await putLimit("k".repeat(201), { dailyCapUsd: 25, monthlyCapUsd: null }, tooLong)
  );
  assert.equal(long.status, 400);
  assert.equal(long.body.code, "invalid_request");
  assert.equal(tooLong.calls.length, 0, "an over-long key must not be written");
  assert.equal(tooLong.brandReads.length, 0, "an over-long key must not reach the database");

  const empty = fakeAdmin();
  const blank = await read(await putLimit("", { dailyCapUsd: 25, monthlyCapUsd: null }, empty));
  assert.equal(blank.status, 400);
  assert.equal(blank.body.code, "invalid_request");
  assert.equal(empty.calls.length, 0);
  assert.equal(empty.brandReads.length, 0);
});

test("PUT /api/ops/spend/limits/[brandKey] answers 404 workspace_not_found for an unknown workspace", async () => {
  const fake = fakeAdmin({ brand: null });
  const { status, body } = await read(
    await putLimit("no-such-workspace", { dailyCapUsd: 25, monthlyCapUsd: null }, fake)
  );
  assert.equal(status, 404);
  assert.equal(body.code, "workspace_not_found");
  assert.equal(body.error, "Workspace not found.");
  assert.equal(fake.calls.length, 0, "an unknown workspace must not be upserted");
  assert.deepEqual(fake.brandReads, [
    { op: "select", table: "customer_brands", filters: [["brand_key", "no-such-workspace"]] },
  ]);
});

test("PUT /api/ops/spend/limits/[brandKey] turns a foreign-key race on the write into 404 workspace_not_found", async () => {
  const fake = fakeAdmin({ error: { code: "23503", message: "violates foreign key constraint" } });
  const { status, body } = await read(
    await putLimit("example-workspace", { dailyCapUsd: 25, monthlyCapUsd: null }, fake)
  );
  assert.equal(status, 404);
  assert.equal(body.code, "workspace_not_found");
  assert.equal(body.error, "Workspace not found.");
  assert.equal(fake.calls.length, 1, "the upsert was attempted");
  assert.equal(fake.calls[0].op, "upsert");
});

test("PUT /api/ops/spend/limits/[brandKey] answers 503 spend_unavailable when the brand lookup fails", async () => {
  const fake = fakeAdmin({ brandError: { code: "08006", message: "connection failure" } });
  const { status, body } = await read(
    await putLimit("example-workspace", { dailyCapUsd: 25, monthlyCapUsd: null }, fake)
  );
  assert.equal(status, 503);
  assert.equal(body.code, "spend_unavailable");
  assert.equal(body.error, "Spend control is unavailable, so paid work is paused.");
  assert.equal(fake.calls.length, 0, "a failed brand lookup must not be followed by a write");
});

test("PUT /api/ops/spend/limits/[brandKey] keeps 503 spend_unavailable for a write error that is not a FK race", async () => {
  const fake = fakeAdmin({ error: { code: "42P01", message: "relation does not exist" } });
  const { status, body } = await read(
    await putLimit("example-workspace", { dailyCapUsd: 25, monthlyCapUsd: null }, fake)
  );
  assert.equal(status, 503);
  assert.equal(body.code, "spend_unavailable");
  assert.equal(body.error, "Spend control is unavailable, so paid work is paused.");
});

test("GET /api/ops/spend/limits filters by brand_key only when the query names one", async () => {
  const filtered = fakeAdmin({ rows: [LIMIT_ROW] });
  const first = await read(await LIMITS.GET(new Request("https://ops.test/api/ops/spend/limits?brand_key=example-workspace"), asDeps(filtered)));
  assert.equal(first.status, 200);
  assert.equal(first.cacheControl, "no-store");
  assert.deepEqual(filtered.calls, [
    { op: "order", table: "workspace_spend_limits", column: "brand_key", filters: [["brand_key", "example-workspace"]] },
  ]);
  assert.deepEqual(first.body, {
    limits: [{ brandKey: "example-workspace", dailyCapUsd: 25, monthlyCapUsd: null, updatedAt: "2026-10-21T09:00:00.000Z" }],
  });

  const unfiltered = fakeAdmin({ rows: [] });
  const second = await read(await LIMITS.GET(new Request("https://ops.test/api/ops/spend/limits"), asDeps(unfiltered)));
  assert.equal(second.status, 200);
  assert.deepEqual(unfiltered.calls, [{ op: "order", table: "workspace_spend_limits", column: "brand_key", filters: [] }]);
});

test("GET /api/ops/spend/limits refuses an unknown query field", async () => {
  const fake = fakeAdmin({ rows: [] });
  const { status, body } = await read(await LIMITS.GET(new Request("https://ops.test/api/ops/spend/limits?limit=5"), asDeps(fake)));
  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
});

test("the routes never check the operator token themselves", async () => {
  // The perimeter owns the token (src/middleware.js + src/server/operatorPerimeter.js),
  // so a request with no Authorization header must still reach the handler: a
  // second check here would be a second door on the same wall.
  const fake = fakeAdmin({ rows: [] });
  const { status } = await read(await CONTROLS.GET(new Request("https://ops.test/api/ops/spend/controls"), asDeps(fake)));
  assert.equal(status, 200);
});
