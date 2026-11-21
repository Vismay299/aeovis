/**
 * T9 — GET /api/customer/overview `dailyMentions` and `engines`.
 *
 * Runs the real route against an in-memory PostgREST-shaped client. Rows exist
 * only on days a scan ran; every other day must come back null, never 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("../../../../server/customerRoutes.test.hooks.mjs", import.meta.url));

const ROUTE = await import(new URL("./route.js", import.meta.url).href);

const DAY = 86_400_000;
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);

function client(tables, { failTable = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      let rows = [...(tables[table] || [])];
      const call = { table, columns: null, range: null, limit: null };
      calls.push(call);
      const finish = () =>
        table === failTable
          ? { data: null, error: { message: "boom" } }
          : { data: rows, error: null };
      return {
        select(columns) { call.columns = columns; return this; },
        eq(column, value) { rows = rows.filter((row) => row[column] === value); return this; },
        in(column, values) { rows = rows.filter((row) => values.includes(row[column])); return this; },
        gte(column, value) { rows = rows.filter((row) => row[column] >= value); return this; },
        order() { return this; },
        limit(value) { call.limit = value; rows = rows.slice(0, value); return this; },
        range(start, end) { call.range = [start, end]; rows = rows.slice(start, end + 1); return this; },
        maybeSingle: async () => ({ ...finish(), data: finish().data?.[0] ?? null }),
        then(resolve, reject) { return Promise.resolve(finish()).then(resolve, reject); },
      };
    },
  };
}

function useFixture(tables, options) {
  const admin = client(tables, options);
  globalThis.customerRouteFixture = {
    admin,
    context: {
      client: admin,
      user: { id: "user-1" },
      error: null,
      brands: [{ brandKey: "acme", display_name: "Acme", website: "https://acme.example", role: "owner" }],
    },
  };
  return admin;
}

async function get() {
  const response = await ROUTE.GET(new Request("https://app.example.test/api/customer/overview?brand_key=acme"));
  return { status: response.status, body: await response.json() };
}

const row = (date, engine, sov_state, prompts_mentioned, brand = "acme") => ({
  brand, date, engine, sov_state, prompts_mentioned, prompts_total: 20,
});

test("sparse scan days come back as a 90-day calendar with unmeasured days null", async () => {
  useFixture({
    brand_metrics_daily: [
      row(daysAgo(40), "all", "measured", 6),
      row(daysAgo(40), "chatgpt", "measured", 5),
      row(daysAgo(40), "gemini", "failed", null),
      row(daysAgo(12), "all", "measured_zero", 0),
      row(daysAgo(12), "chatgpt", "measured_zero", 0),
      row(daysAgo(12), "gemini", "not_assessed", 0),
      row(daysAgo(2), "all", "measured", 9),
      row(daysAgo(2), "chatgpt", "measured", 7),
      row(daysAgo(2), "gemini", "measured", 4),
      // Another workspace's rows never reach this one.
      row(daysAgo(2), "all", "measured", 99, "other"),
      row(daysAgo(2), "perplexity", "measured", 99, "other"),
      // Older than the window.
      row(daysAgo(120), "all", "measured", 3),
    ],
  });
  const { status, body } = await get();
  assert.equal(status, 200);

  assert.equal(body.dailyMentions.length, 90);
  assert.equal(body.dailyMentions[0].date, daysAgo(89));
  assert.equal(body.dailyMentions.at(-1).date, today);
  const measured = body.dailyMentions.filter((d) => d.mentioned !== null);
  assert.deepEqual(measured.map((d) => [d.date, d.mentioned]), [
    [daysAgo(40), 6],
    [daysAgo(12), 0],
    [daysAgo(2), 9],
  ]);
  // A day with no row is null, not zero.
  assert.equal(body.dailyMentions.find((d) => d.date === daysAgo(3)).mentioned, null);
  assert.deepEqual(body.dailyMentions.find((d) => d.date === daysAgo(2)).byEngine, { chatgpt: 7, gemini: 4 });
  assert.deepEqual(body.dailyMentions.find((d) => d.date === daysAgo(3)).byEngine, { chatgpt: null, gemini: null });

  assert.deepEqual(body.engines.map((e) => e.engine), ["chatgpt", "gemini"]);
  const gemini = body.engines.find((e) => e.engine === "gemini");
  assert.equal(gemini.days.length, 90);
  const stateOn = (n) => gemini.days.find((d) => d.date === daysAgo(n)).state;
  assert.equal(stateOn(40), "failed");
  assert.equal(stateOn(12), "not_assessed");
  assert.equal(stateOn(2), "measured");
  assert.equal(stateOn(1), null);
});

test("a workspace with no metric rows gets null days and no engines", async () => {
  useFixture({ brand_metrics_daily: [] });
  const { status, body } = await get();
  assert.equal(status, 200);
  assert.equal(body.dailyMentions.length, 90);
  assert.ok(body.dailyMentions.every((d) => d.mentioned === null));
  assert.deepEqual(body.engines, []);
  assert.deepEqual(body.metrics, []);
});

test("history pages past one page and keeps the existing fields as they were", async () => {
  const engines = ["a1", "a2", "a3", "a4", "a5", "a6"];
  const rows = [];
  for (let n = 89; n >= 0; n -= 1) {
    rows.push(row(daysAgo(n), "all", "measured", n));
    for (const engine of engines) rows.push(row(daysAgo(n), engine, "measured", 1));
  }
  const admin = useFixture({ brand_metrics_daily: rows });
  const { status, body } = await get();
  assert.equal(status, 200);

  const history = admin.calls.filter((c) => c.table === "brand_metrics_daily" && c.range);
  assert.deepEqual(history.map((c) => c.range), [[0, 499], [500, 999]]);
  assert.ok(history.every((c) => !/prompts_total|visibility/.test(c.columns)));
  assert.equal(body.engines.length, 6);
  assert.equal(body.dailyMentions.at(-1).mentioned, 0);
  assert.equal(body.dailyMentions[0].mentioned, 89);

  // The legacy `metrics` read is untouched: same columns, last 30 rows.
  const legacy = admin.calls.find((c) => c.table === "brand_metrics_daily" && c.limit !== null);
  assert.equal(legacy.limit, 30);
  assert.equal(
    legacy.columns,
    "date, engine, visibility_pct, sov_pct, citation_share_pct, prompts_total, prompts_answered, prompts_mentioned",
  );
  assert.equal(body.metrics.length, 30);
  for (const key of ["brand", "latest_scan", "scans", "scan_jobs", "metrics", "content_items", "features"]) {
    assert.ok(key in body, `${key} is still returned`);
  }
});

test("a failed history read fails the overview instead of returning partial data", async () => {
  useFixture({ brand_metrics_daily: [] }, { failTable: "brand_metrics_daily" });
  const { status } = await get();
  assert.equal(status, 500);
});
