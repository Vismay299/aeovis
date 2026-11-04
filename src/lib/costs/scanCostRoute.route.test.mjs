/**
 * F03 §6.5 — `GET /api/customer/scan/report/[scan_id]`, driven through the real
 * route handler and the real cost service.
 *
 * The route existed before F03 and its body must not change: this file holds
 * the response the old `route.js` produced for the same fixture, key by key,
 * and asserts that every one of those keys is still there, unchanged, with
 * `scan.cost` and `results[].cost` added.
 *
 * Only the authenticated request context and the storage transport are
 * substituted (`deps`); the cost mapping and the error mapping are the
 * shipped code.
 *
 * Hooks: `src/lib/customerRoutes.test.hooks.mjs`, the resolver the customer
 * route tests use. It maps only module specifiers; nothing under test is
 * replaced.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("../customerRoutes.test.hooks.mjs", import.meta.url));

const ROUTE = await import(
  new URL("../../app/api/customer/scan/report/[scan_id]/route.ts", import.meta.url).href
);
const { scanReportResponse } = await import(
  new URL("./scanReport.contract.ts", import.meta.url).href
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

/** The scan row the database holds. */
const SCAN = {
  id: "scan-a",
  brand: "Offcult",
  url: "https://offcult.in",
  scanned_at: "2026-10-21T09:00:00.000Z",
  created_at: "2026-10-21T09:00:00.000Z",
  visibility_pct: 42,
  prompts_tracked: 120,
  prompts_mentioned: 50,
  platform: ["aio", "chatgpt", "gemini", "perplexity"],
  raw_results: {
    summary_stats: { engines: 4 },
    engines: { aio: { error_rate_pct: 0 } },
    planned_questions: ["best running shoes"],
    engine_scores: { chatgpt: 40 },
    competitors: ["bewakoof.com"],
    share_of_voice_pct: 18.5,
    win_rate_pct: 42,
    brand_citation_share_pct: 12,
  },
  origin_job_id: "job-1",
  brand_key: BRAND_A,
};

/** The result rows the database holds. */
const RESULT_ROWS = [
  {
    id: "result-a",
    scan_id: "scan-a",
    query: "best running shoes",
    engine: "chatgpt",
    answer_text: "An answer",
    answered: true,
    mentioned: true,
    brand_cited: false,
    position: 1,
    sentiment: "positive",
    raw: { observation_id: "obs-a" },
    created_at: "2026-10-21T09:00:00.000Z",
  },
  {
    id: "result-b",
    scan_id: "scan-a",
    query: "best running shoes",
    engine: "gemini",
    answer_text: null,
    answered: false,
    mentioned: false,
    brand_cited: false,
    position: null,
    sentiment: null,
    raw: {},
    created_at: "2026-10-21T09:05:00.000Z",
  },
];

/**
 * The response the old `route.js` produced for this fixture, byte for byte.
 * The route may add `cost`; it may not change anything in here.
 */
const PRE_CHANGE_SCAN = {
  id: "scan-a",
  brand: "Offcult",
  url: "https://offcult.in",
  scanned_at: "2026-10-21T09:00:00.000Z",
  created_at: "2026-10-21T09:00:00.000Z",
  visibility_pct: 42,
  summary_stats: { engines: 4 },
  prompts_tracked: 120,
  prompts_mentioned: 50,
  platform: ["aio", "chatgpt", "gemini", "perplexity"],
  engines: { aio: { error_rate_pct: 0 } },
  planned_questions: ["best running shoes"],
  engine_scores: { chatgpt: 40 },
  competitors: ["bewakoof.com"],
  share_of_voice_pct: 18.5,
  win_rate_pct: 42,
  brand_citation_share_pct: 12,
};

/**
 * The result rows the old `route.js` answered with: the columns its SELECT
 * named, in that order. The database row carries `scan_id` too, but the old
 * route never selected it, so it was never in the answer.
 */
const PRE_CHANGE_RESULTS = RESULT_ROWS.map(({ scan_id: _scanId, ...row }) => row);

const TABLES = {
  scans: [SCAN, { id: "scan-b", brand: "Other", brand_key: BRAND_B }],
  prompt_results: RESULT_ROWS,
  scan_jobs: [{ id: "job-1", brand_key: BRAND_A, status: "complete" }],
  probe_observations: [
    { id: "obs-a", job_id: "job-1", purpose: "scan", engine: "chatgpt", state: "answered" },
  ],
  probe_attempts: [
    {
      observation_id: "obs-a",
      attempt_no: 1,
      reserved_usd: 0.2,
      charged_usd: 0.04,
      cost_state: "measured",
      dispatch_state: "recorded",
    },
  ],
  spend_holds: [],
};

/**
 * A small query builder over the fixture tables. It projects the selected
 * columns, the way PostgREST does, so the answer carries exactly the columns
 * the route asked for — no more, no less.
 */
function fakeAdmin(tables = TABLES) {
  const queries = [];
  const admin = {
    from(table) {
      let rows = (tables[table] ?? []).slice();
      let projection = null;
      const project = (row) => {
        if (!projection) return row;
        const out = {};
        for (const column of projection) if (column in row) out[column] = row[column];
        return out;
      };
      const query = {
        select: (columns) => {
          queries.push({ table, columns });
          projection =
            columns === "*"
              ? null
              : String(columns)
                  .split(",")
                  .map((column) => column.trim())
                  .filter(Boolean);
          return query;
        },
        eq: (column, value) => {
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        in: (column, values) => {
          rows = rows.filter((row) => values.includes(row[column]));
          return query;
        },
        order: () => query,
        limit: (value) => {
          rows = rows.slice(0, value);
          return query;
        },
        maybeSingle: async () => ({ data: rows[0] ? project(rows[0]) : null, error: null }),
        single: async () => ({ data: rows[0] ? project(rows[0]) : null, error: null }),
        then: (resolve) =>
          Promise.resolve({ data: rows.map(project), error: null }).then(resolve),
      };
      return query;
    },
  };
  return { admin, queries };
}

function deps(over = {}) {
  const { admin, queries } = fakeAdmin();
  globalThis.customerRouteFixture = {
    admin,
    context: {
      client: null,
      user: USER,
      error: null,
      brands: [brand(BRAND_A)],
    },
  };
  return {
    queries,
    deps: {
      getCustomerContext: async () => globalThis.customerRouteFixture.context,
      getSupabaseAdmin: () => admin,
      ...over,
    },
  };
}

/**
 * An admin whose one table fails. The failure is PostgREST's plain error
 * object, not an `Error` — the shape the route really sees.
 */
function failingAdmin(table, error) {
  return {
    from(name) {
      const failed = name === table;
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: async () =>
          failed ? { data: null, error } : { data: null, error: null },
        then: (resolve) =>
          Promise.resolve(failed ? { data: null, error } : { data: [], error: null }).then(resolve),
      };
      return query;
    },
  };
}

/** Runs `fn` with `console.error` captured, and returns what it logged. */
async function captureErrors(fn) {
  const logged = [];
  const original = console.error;
  console.error = (...args) => {
    logged.push(args);
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return logged;
}

function request() {
  return new Request("https://app.test/api/customer/scan/report/scan-a");
}

async function read(response) {
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.json(),
  };
}

test("the report keeps every field the route returned before F03, unchanged", async () => {
  const { deps: injected } = deps();

  const { status, cacheControl, body } = await read(
    await ROUTE.GET(request(), { params: { scan_id: "scan-a" } }, injected)
  );

  assert.equal(status, 200);
  assert.equal(cacheControl, "no-store");

  // The key list is the old one, in the old order, with `cost` appended.
  assert.deepEqual(Object.keys(body.scan), [...Object.keys(PRE_CHANGE_SCAN), "cost"]);
  for (const [key, value] of Object.entries(PRE_CHANGE_SCAN)) {
    assert.deepEqual(body.scan[key], value, `scan.${key} must not change`);
  }

  assert.equal(body.results.length, PRE_CHANGE_RESULTS.length);
  for (const [index, expected] of PRE_CHANGE_RESULTS.entries()) {
    assert.deepEqual(
      Object.keys(body.results[index]),
      [...Object.keys(expected), "cost"],
      `results[${index}] keeps its columns and gains only "cost"`
    );
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(
        body.results[index][key],
        value,
        `results[${index}].${key} must not change`
      );
    }
  }
});

test("the scan gains its cost and each result row gains its own", async () => {
  const { deps: injected } = deps();

  const { status, body } = await read(
    await ROUTE.GET(request(), { params: { scan_id: "scan-a" } }, injected)
  );

  assert.equal(status, 200);
  assert.equal(body.scan.cost.state, "final");
  assert.equal(body.scan.cost.jobId, "job-1");
  assert.equal(body.scan.cost.answers, 1);
  assert.equal(body.scan.cost.attempts, 1);
  assert.equal(body.scan.cost.knownUsd, 0.04);
  assert.equal(body.scan.cost.unknownAttempts, 0);
  assert.equal(body.scan.cost.reservedUnknownUsd, 0);
  assert.equal(body.scan.cost.totalAccountedUsd, 0.04);
  assert.equal(body.scan.cost.perAnswerUsd, 0.04);
  assert.equal(body.scan.cost.heldUsd, null);
  assert.deepEqual(body.scan.cost.byEngine, [
    {
      engine: "chatgpt",
      label: "ChatGPT",
      answers: 1,
      attempts: 1,
      knownUsd: 0.04,
      unknownAttempts: 0,
      perAnswerUsd: 0.04,
    },
  ]);

  // The cost is joined on the observation the result row carries.
  assert.deepEqual(body.results[0].cost, { usd: 0.04, attempts: 1, unknownAttempts: 0 });
  // A row with no observation has no cost: `null`, never a zero.
  assert.equal(body.results[1].cost, null);

  const parsed = scanReportResponse.safeParse(body);
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

test("the route reads the scan id from a promised params object too", async () => {
  const { deps: injected } = deps();

  const { status, body } = await read(
    await ROUTE.GET(request(), { params: Promise.resolve({ scan_id: "scan-a" }) }, injected)
  );

  assert.equal(status, 200);
  assert.equal(body.scan.id, "scan-a");
});

test("a legacy scan with no job has no cost, never a zero", async () => {
  const tables = { ...TABLES, scans: [{ ...SCAN, origin_job_id: null }] };
  const { admin } = fakeAdmin(tables);
  const { deps: injected } = deps({ getSupabaseAdmin: () => admin });

  const { status, body } = await read(
    await ROUTE.GET(request(), { params: { scan_id: "scan-a" } }, injected)
  );

  assert.equal(status, 200);
  assert.equal(body.scan.cost.state, "unavailable");
  assert.equal(body.scan.cost.jobId, null);
  assert.equal(body.scan.cost.totalAccountedUsd, 0);
  assert.equal(body.results[0].cost, null);
});

/**
 * The body the old `route.js` produced, asserted field by field. The route may
 * add `cost`; it may not change anything in here.
 */
function assertPreChangeBody(body) {
  assert.deepEqual(Object.keys(body.scan), [...Object.keys(PRE_CHANGE_SCAN), "cost"]);
  for (const [key, value] of Object.entries(PRE_CHANGE_SCAN)) {
    assert.deepEqual(body.scan[key], value, `scan.${key} must not change`);
  }
  assert.equal(body.results.length, PRE_CHANGE_RESULTS.length);
  for (const [index, expected] of PRE_CHANGE_RESULTS.entries()) {
    assert.deepEqual(
      Object.keys(body.results[index]),
      [...Object.keys(expected), "cost"],
      `results[${index}] keeps its columns and gains only "cost"`
    );
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(
        body.results[index][key],
        value,
        `results[${index}].${key} must not change`
      );
    }
  }
}

test("a scan whose job has no usable ledger still answers the whole report", async () => {
  // The scan names a job the database does not hold, and a job that belongs
  // to another workspace. Neither is a tenant violation: the route has
  // already authorised the scan, so the cost is simply unavailable and the
  // report still reads.
  for (const scanJobs of [
    [],
    [{ id: "job-1", brand_key: BRAND_B, status: "complete" }],
  ]) {
    const { admin } = fakeAdmin({ ...TABLES, scan_jobs: scanJobs });
    const { deps: injected } = deps({ getSupabaseAdmin: () => admin });

    const { status, body } = await read(
      await ROUTE.GET(request(), { params: { scan_id: "scan-a" } }, injected)
    );

    assert.equal(status, 200, "an unreadable cost never costs the customer the report");
    assertPreChangeBody(body);
    assert.equal(body.scan.cost.state, "unavailable");
    assert.equal(body.scan.cost.totalAccountedUsd, 0);
    for (const row of body.results) {
      assert.equal(row.cost, null, "an answer with no ledger has no cost, never a zero");
    }
  }
});

test("a database failure inside the cost read answers this route's own 500", async () => {
  const { deps: injected } = deps({
    getScanCost: async () => {
      throw new Error("the database is unavailable");
    },
  });

  const { status, body } = await read(
    await ROUTE.GET(request(), { params: { scan_id: "scan-a" } }, injected)
  );

  assert.equal(status, 500);
  assert.equal(body.code, "internal_error");
  assert.equal(body.error, "Could not load the scan report.");
});

test("a database failure is logged with the scan id and the error", async () => {
  let answer = null;
  const logged = await captureErrors(async () => {
    const { deps: injected } = deps({
      getScanCost: async () => {
        throw new Error("the database is unavailable");
      },
    });

    answer = await read(
      await ROUTE.GET(request(), { params: { scan_id: "scan-a" } }, injected)
    );
  });

  // The answer is the one the route answered before the log was restored.
  assert.equal(answer.status, 500);
  assert.equal(answer.body.error, "Could not load the scan report.");

  assert.equal(logged.length, 1, "the failure is logged once");
  assert.match(String(logged[0][0]), /scan-a/, "the log names the scan id");
  assert.match(
    String(logged[0][1]),
    /the database is unavailable/,
    "the log carries the error's message"
  );
  assert.ok(
    !JSON.stringify(logged).includes("An answer"),
    "the log carries no answer text"
  );
  assert.ok(
    !JSON.stringify(logged).includes(BRAND_A),
    "the log carries no workspace key"
  );
});

test("a failing scans read is logged and answers the route's own 500", async () => {
  let answer = null;
  const logged = await captureErrors(async () => {
    const { deps: injected } = deps({
      getSupabaseAdmin: () =>
        failingAdmin("scans", { message: "the database is unavailable", code: "PGRST116" }),
    });

    answer = await read(
      await ROUTE.GET(request(), { params: { scan_id: "scan-a" } }, injected)
    );
  });

  assert.equal(answer.status, 500);
  assert.equal(answer.body.error, "Could not load the scan report.");

  assert.equal(logged.length, 1, "the failure is logged once");
  assert.match(String(logged[0][0]), /scan-a/, "the log names the scan id");
  assert.match(
    String(logged[0][1]),
    /the database is unavailable/,
    "the log carries the error's message"
  );
});

test("another workspace's scan answers exactly like a scan that does not exist", async () => {
  const { deps: injected } = deps();

  const { status, body } = await read(
    await ROUTE.GET(request(), { params: { scan_id: "scan-b" } }, injected)
  );

  assert.equal(status, 404);
  assert.equal(body.code, "scan_not_found");
  assert.equal(body.error, "Scan not found.");
});

test("a missing scan id is a 400 and an anonymous reader is a 401", async () => {
  const { deps: injected } = deps();

  const missing = await read(await ROUTE.GET(request(), { params: {} }, injected));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "scan_id is required.");

  const { deps: anonymous } = deps({
    getCustomerContext: async () => ({ client: null, user: null, brands: [], error: null }),
  });
  const unauthorised = await read(
    await ROUTE.GET(request(), { params: { scan_id: "scan-a" } }, anonymous)
  );
  assert.equal(unauthorised.status, 401);
  assert.equal(unauthorised.body.code, "unauthenticated");
  assert.equal(unauthorised.body.error, "Please sign in.");
});
