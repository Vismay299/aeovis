/**
 * F06 phase 3 — POST /api/customer/exports (F06-AC-12).
 *
 * Exercises the real route, server export and workspace_answers kind against an
 * in-memory PostgREST-shaped admin and a fake Storage. No network, no live
 * Storage, no provider call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("../customerRoutes.test.hooks.mjs", import.meta.url));

const ROUTE = await import(
  new URL("../../app/api/customer/exports/route.ts", import.meta.url).href
);
const { exportResponse } = await import("./exports.contract.ts");

const USER = { id: "user-1", email: "owner@example.test" };
const BRAND_KEY = "acme";
const NOW = new Date("2026-10-21T10:00:00.000Z");
const RANGE = { from: "2026-07-23", to: "2026-10-21" };

function brand() {
  return {
    brandKey: BRAND_KEY,
    role: "member",
    display_name: "Acme",
    website: "https://acme.example",
    website_host: "acme.example",
    aliases: ["Acme", "acme"],
    is_active: true,
  };
}

function compare(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a < b ? -1 : 1;
}

class Chain {
  constructor(db, table, mode, payload) {
    this.db = db;
    this.table = table;
    this.mode = mode;
    this.payload = payload;
    this.filters = [];
    this.orders = [];
    this.limitCount = null;
    this.rangeBounds = null;
    this.options = null;
  }

  select(_columns, options) {
    this.options = options ?? null;
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
  in(column, values) {
    this.filters.push(["in", column, values]);
    return this;
  }
  is(column, value) {
    this.filters.push(["is", column, value]);
    return this;
  }
  not(column, operator, value) {
    this.filters.push(["not", column, `${operator}:${value}`]);
    return this;
  }
  order(column, options = {}) {
    this.orders.push([column, options.ascending !== false]);
    return this;
  }
  limit(count) {
    this.limitCount = count;
    return this;
  }
  range(from, to) {
    this.rangeBounds = [from, to];
    return this;
  }

  matches(row) {
    return this.filters.every(([op, column, value]) => {
      const actual = row[column];
      if (op === "eq") return actual === value;
      if (op === "gte") return actual >= value;
      if (op === "lt") return actual < value;
      if (op === "in") return value.includes(actual);
      if (op === "is") return actual === value || (value === null && actual == null);
      if (op === "not") return actual != null;
      return true;
    });
  }

  rowsOf(table) {
    return table === "scans"
      ? this.db.scans
      : table === "prompt_results"
        ? this.db.promptResults
        : this.db.exportRequests;
  }

  run() {
    if (this.table === "export_requests" && this.mode === "insert") {
      this.db.exportRequests.push({ ...this.payload.row });
      return { data: null, error: null };
    }

    let rows = this.rowsOf(this.table).filter((row) => this.matches(row));

    if (this.table === "export_requests" && this.mode === "update") {
      for (const row of rows) Object.assign(row, this.payload.patch);
      return { data: null, error: null };
    }
    if (this.table === "export_requests" && this.mode === "delete") {
      const removed = new Set(rows);
      this.db.exportRequests = this.db.exportRequests.filter((row) => !removed.has(row));
      return { data: rows.map((row) => ({ id: row.id })), error: null };
    }

    for (const [column, ascending] of [...this.orders].reverse()) {
      rows = [...rows].sort((a, b) => (ascending ? compare(a[column], b[column]) : compare(b[column], a[column])));
    }
    if (this.limitCount != null) rows = rows.slice(0, this.limitCount);
    if (this.rangeBounds) rows = rows.slice(this.rangeBounds[0], this.rangeBounds[1] + 1);
    // PostgREST caps every response at max_rows and truncates silently.
    if (this.db.maxRows != null) rows = rows.slice(0, this.db.maxRows);

    if (this.table === "export_requests" && this.options?.head) {
      return { count: rows.length, data: null, error: null };
    }
    return { data: rows, error: null };
  }

  then(resolve, reject) {
    try {
      return Promise.resolve(this.run()).then(resolve, reject);
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

function makeStorage() {
  const storage = {
    uploads: [],
    signed: [],
    failUpload: false,
    failSign: false,
    from(bucket) {
      assert.equal(bucket, "exports");
      return {
        upload: async (path, body, options) => {
          if (storage.failUpload) return { data: null, error: { message: "upload failed" } };
          storage.uploads.push({ path, body, options });
          return { data: { path }, error: null };
        },
        createSignedUrl: async (path, ttl, options) => {
          if (storage.failSign) return { data: null, error: { message: "sign failed" } };
          storage.signed.push({ path, ttl, options });
          return {
            data: {
              signedUrl: `https://example.supabase.co/storage/v1/object/sign/exports/${path}?token=EXAMPLE-NOT-A-REAL-TOKEN`,
            },
            error: null,
          };
        },
        remove: async (paths) => ({ data: paths.map((path) => ({ name: path })), error: null }),
      };
    },
  };
  return storage;
}

function makeAdmin(seed = {}) {
  const admin = {
    scans: seed.scans ?? [],
    promptResults: seed.promptResults ?? [],
    exportRequests: seed.exportRequests ?? [],
    maxRows: seed.maxRows ?? null,
    storage: makeStorage(),
  };
  admin.from = (table) => ({
    select: (columns, options) => new Chain(admin, table, "select", null).select(columns, options),
    insert: (row) => new Chain(admin, table, "insert", { row }),
    update: (patch) => new Chain(admin, table, "update", { patch }),
    delete: () => new Chain(admin, table, "delete", null),
  });
  return admin;
}

function depsFor(admin, over = {}) {
  return {
    getCustomerContext: async () => ({
      client: null,
      user: USER,
      brands: [brand()],
      error: null,
    }),
    getSupabaseAdmin: () => admin,
    isFeatureEnabled: async () => true,
    now: () => NOW,
    ...over,
  };
}

function request(body, deps) {
  return ROUTE.POST(
    new Request("https://app.test/api/customer/exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    {},
    deps,
  );
}

async function read(response) {
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.json(),
  };
}

function validBody(over = {}) {
  return {
    brandKey: BRAND_KEY,
    kind: "workspace_answers",
    format: "csv",
    params: RANGE,
    ...over,
  };
}

function scan(over = {}) {
  return {
    id: "scan-1",
    brand_key: BRAND_KEY,
    scanned_at: "2026-08-01T10:00:00.000Z",
    visibility_pct: 50,
    prompts_tracked: 2,
    prompts_mentioned: 1,
    ...over,
  };
}

function answer(over = {}) {
  return {
    id: "answer-1",
    scan_id: "scan-1",
    query: "Which accounting tool?",
    engine: "chatgpt",
    answered: true,
    mentioned: true,
    brand_cited: true,
    position: 2,
    sentiment: 70,
    answer_text: "Acme is an option.",
    created_at: "2026-08-01T10:01:00.000Z",
    raw: null,
    failed: null,
    references: [{ href: "https://acme.example/a" }],
    brands: [{ name: "Acme", mentioned: true }],
    ...over,
  };
}

test("flag off -> 403 feature_disabled and no export row", async () => {
  const admin = makeAdmin({ scans: [scan()], promptResults: [answer()] });
  const response = await read(
    await request(validBody(), depsFor(admin, { isFeatureEnabled: async () => false })),
  );
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "feature_disabled");
  assert.equal(admin.exportRequests.length, 0);
});

test("an unknown body field -> 400 invalid_request, no row", async () => {
  const admin = makeAdmin();
  const response = await read(await request(validBody({ extra: true }), depsFor(admin)));
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "invalid_request");
  assert.equal(admin.exportRequests.length, 0);
});

test("a bad range -> 400 invalid_range, no row", async () => {
  for (const params of [
    { from: "2026-08-01", to: "2026-07-01" },
    { from: "2026-01-01", to: "2026-04-04" },
    { from: "2026-01-01", to: "2099-01-01" },
  ]) {
    const admin = makeAdmin();
    const response = await read(await request(validBody({ params }), depsFor(admin)));
    assert.equal(response.status, 400, JSON.stringify(params));
    assert.equal(response.body.code, "invalid_range");
    assert.equal(admin.exportRequests.length, 0);
  }
});

test("the 21st request in an hour -> 429 export_rate_limited, no new row", async () => {
  const recent = Array.from({ length: 20 }, (_, index) => ({
    id: `prior-${index}`,
    brand_key: BRAND_KEY,
    kind: "workspace_answers",
    format: "csv",
    status: "ready",
    created_at: "2026-10-21T09:30:00.000Z",
  }));
  const admin = makeAdmin({ scans: [scan()], promptResults: [answer()], exportRequests: recent });
  const response = await read(await request(validBody(), depsFor(admin)));
  assert.equal(response.status, 429);
  assert.equal(response.body.code, "export_rate_limited");
  assert.equal(admin.exportRequests.length, 20);
});

test("no rows in range -> 422 no_rows and a failed audit row", async () => {
  const admin = makeAdmin({ scans: [], promptResults: [] });
  const response = await read(await request(validBody(), depsFor(admin)));
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "no_rows");
  assert.equal(admin.exportRequests.length, 1);
  assert.equal(admin.exportRequests[0].status, "failed");
  assert.equal(admin.exportRequests[0].error_code, "no_rows");
  assert.equal(admin.storage.uploads.length, 0);
});

test("more than 50,000 rows -> 413 export_too_large with nothing uploaded", async () => {
  const scans = Array.from({ length: 500 }, (_, index) =>
    scan({ id: `scan-${index}`, scanned_at: "2026-08-01T10:00:00.000Z" }),
  );
  const promptResults = [];
  for (const current of scans) {
    for (let index = 0; index < 101; index++) {
      promptResults.push(
        answer({
          id: `answer-${current.id}-${index}`,
          scan_id: current.id,
          answer_text: "answer body",
        }),
      );
    }
  }
  const admin = makeAdmin({ scans, promptResults });
  const response = await read(await request(validBody(), depsFor(admin)));
  assert.equal(response.status, 413);
  assert.equal(response.body.code, "export_too_large");
  assert.equal(admin.storage.uploads.length, 0);
  assert.equal(admin.exportRequests[0].status, "failed");
  assert.equal(admin.exportRequests[0].error_code, "export_too_large");
});

test("answers beyond one PostgREST page are all exported (max_rows truncates silently)", async () => {
  const scans = [scan({ id: "scan-a" }), scan({ id: "scan-b", scanned_at: "2026-08-02T10:00:00.000Z" })];
  const promptResults = [];
  for (const current of scans) {
    for (let index = 0; index < 1_300; index++) {
      promptResults.push(answer({ id: `answer-${current.id}-${String(index).padStart(4, "0")}`, scan_id: current.id }));
    }
  }
  // A server max_rows below the page size must not end the read early either.
  const admin = makeAdmin({ scans, promptResults, maxRows: 700 });
  const response = await read(await request(validBody({ format: "json" }), depsFor(admin)));
  assert.equal(response.status, 200);
  assert.equal(response.body.rowCount, 2_600);
  const exported = JSON.parse(admin.storage.uploads[0].body).answers.map((row) => row.answer_id);
  assert.equal(new Set(exported).size, 2_600);
});

test("more than 500 scans in range -> 413 export_too_large rather than dropping scans", async () => {
  const scans = Array.from({ length: 501 }, (_, index) => scan({ id: `scan-${String(index).padStart(3, "0")}` }));
  const admin = makeAdmin({ scans, promptResults: [answer({ scan_id: "scan-000" })] });
  const response = await read(await request(validBody(), depsFor(admin)));
  assert.equal(response.status, 413);
  assert.equal(response.body.code, "export_too_large");
  assert.equal(admin.storage.uploads.length, 0);
});

test("success stores a private CSV, records the audit row and signs a one-hour URL", async () => {
  const admin = makeAdmin({
    scans: [scan(), scan({ id: "scan-beta", brand_key: "beta" })],
    promptResults: [
      answer(),
      answer({ id: "answer-2", query: "Which project tool?", mentioned: false, brand_cited: false }),
      answer({
        id: "answer-beta",
        scan_id: "scan-beta",
        query: "Which accounting tool?",
        answer_text: "BETA SECRET",
      }),
    ],
  });

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  let response;
  try {
    response = await read(await request(validBody(), depsFor(admin)));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(response.status, 200);
  assert.equal(response.cacheControl, "no-store");
  assert.equal(exportResponse.safeParse(response.body).success, true, "response matches its contract");

  assert.equal(admin.storage.uploads.length, 1);
  const upload = admin.storage.uploads[0];
  assert.match(upload.path, /^acme\/workspace_answers\/[0-9a-f-]{36}\.csv$/);
  assert.equal(upload.options.contentType, "text/csv; charset=utf-8");
  assert.equal(upload.options.upsert, false);
  assert.doesNotMatch(upload.body, /BETA SECRET/, "another workspace's answers are not in the file");

  assert.equal(admin.storage.signed.length, 1);
  assert.equal(admin.storage.signed[0].path, upload.path);
  assert.equal(admin.storage.signed[0].ttl, 3600);
  assert.equal(
    admin.storage.signed[0].options.download,
    "perceev-acme-answers-2026-07-23-to-2026-10-21.csv",
  );

  assert.equal(admin.exportRequests.length, 1);
  const row = admin.exportRequests[0];
  assert.equal(row.status, "ready");
  assert.equal(row.row_count, 2);
  assert.ok(row.byte_size > 0);
  assert.equal(row.storage_path, upload.path);
  assert.deepEqual(row.params, RANGE);
  assert.equal(row.created_by, USER.id);

  assert.equal(response.body.rowCount, 2);
  assert.equal(response.body.filename, "perceev-acme-answers-2026-07-23-to-2026-10-21.csv");
  assert.match(response.body.url, /token=EXAMPLE-NOT-A-REAL-TOKEN/);

  const logged = logs.join("\n");
  assert.doesNotMatch(logged, /token=/, "a signed URL is never logged");
  assert.doesNotMatch(logged, /SECRET ANSWER|Acme is an option/, "answer text is never logged");
});

test("Storage upload failure -> 503 storage_unavailable and a failed audit row", async () => {
  const admin = makeAdmin({ scans: [scan()], promptResults: [answer()] });
  admin.storage.failUpload = true;
  const response = await read(await request(validBody(), depsFor(admin)));
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "storage_unavailable");
  assert.equal(admin.exportRequests[0].status, "failed");
  assert.equal(admin.exportRequests[0].error_code, "storage_unavailable");
  // The path is recorded up front so retention removes any partial object.
  assert.match(admin.exportRequests[0].storage_path, /^acme\/workspace_answers\/.+\.csv$/);
});
