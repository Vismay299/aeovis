/**
 * R4.1.1 — weekly GSC ingest: window, row mapping, per-brand failure isolation,
 * watermark honesty, chunked upsert, the cron route's perimeter and status,
 * and the connect route's property resolution. No network, no live database:
 * every Google and Supabase call is injected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import {
  BACKFILL_DAYS,
  OVERLAP_DAYS,
  ingestConnection,
  ingestWindow,
  runGscIngest,
  toDailyRows,
} from "./ingest.js";
import { GSC_UPSERT_CHUNK, listGscConnections, upsertGscDaily } from "../db/gsc.js";
import { authorizeOperatorRequest, isSelfGated, PERIMETER } from "../operatorPerimeter.js";

const NOW = new Date("2026-09-15T10:00:00Z");

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

test("a never-ingested connection backfills BACKFILL_DAYS ending 2 days ago", () => {
  const w = ingestWindow({ last_ingested_through: null }, NOW);
  assert.equal(w.endDate, "2026-09-13");
  const days = (Date.parse(w.endDate) - Date.parse(w.startDate)) / 86400000 + 1;
  assert.equal(days, BACKFILL_DAYS);
});

test("an ingested connection re-reads OVERLAP_DAYS back from its watermark", () => {
  const w = ingestWindow({ last_ingested_through: "2026-09-06" }, NOW);
  assert.equal(w.endDate, "2026-09-13");
  assert.equal(w.startDate, "2026-08-31");
  assert.equal((Date.parse("2026-09-06") - Date.parse(w.startDate)) / 86400000 + 1, OVERLAP_DAYS);
});

test("a watermark already past the lag end still yields an overlap window, not null", () => {
  const w = ingestWindow({ last_ingested_through: "2026-09-13" }, NOW);
  assert.deepEqual(w, { startDate: "2026-09-07", endDate: "2026-09-13" });
});

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

test("toDailyRows drops rows missing a date or query instead of coercing them", () => {
  const rows = toDailyRows("x.com", "sc-domain:x.com", [
    { date: "2026-09-01", query: "a", clicks: 3, impressions: 10, ctr: 0.3, position: 2.5 },
    { date: "", query: "b", clicks: 1, impressions: 1, ctr: 1, position: 1 },
    { date: "2026-09-01", query: "", clicks: 1, impressions: 1, ctr: 1, position: 1 },
  ], "t");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    brand: "x.com", site_url: "sc-domain:x.com", date: "2026-09-01", query: "a",
    clicks: 3, impressions: 10, ctr: 0.3, position: 2.5, ingested_at: "t", brand_key: null, connection_generation: 1,
  });
});

// ---------------------------------------------------------------------------
// ingestConnection / runGscIngest
// ---------------------------------------------------------------------------

function harness({ fetchImpl, listImpl, upsertImpl } = {}) {
  const recorded = [];
  const upserts = [];
  const deps = {
    now: () => NOW,
    fetchDailyQueryRows: fetchImpl ?? (async () => ({
      rows: [{ date: "2026-09-10", query: "tiles", clicks: 2, impressions: 40, ctr: 0.05, position: 7 }],
      truncated: false,
    })),
    upsertGscDaily: upsertImpl ?? (async (rows) => { upserts.push(rows); return rows.length; }),
    recordGscAttempt: async (brand, outcome) => { recorded.push({ brand, ...outcome }); },
    listGscConnections: listImpl ?? (async () => []),
  };
  return { deps, recorded, upserts };
}

test("a successful pass writes rows and advances the watermark to the window end", async () => {
  const { deps, recorded, upserts } = harness();
  const out = await ingestConnection({ brand: "x.com", site_url: "sc-domain:x.com", last_ingested_through: null }, deps);
  assert.equal(out.status, "ok");
  assert.equal(out.rowsWritten, 1);
  assert.equal(out.ingestedThrough, "2026-09-13");
  assert.equal(upserts[0][0].brand, "x.com");
  assert.equal(recorded[0].status, "ok");
  assert.equal(out.recorded, true);
});

test("a Google failure is recorded as failed and does NOT advance the watermark", async () => {
  const { deps, recorded } = harness({ fetchImpl: async () => { throw new Error("GSC access denied"); } });
  const out = await ingestConnection({ brand: "x.com", site_url: "sc-domain:x.com", last_ingested_through: "2026-09-01" }, deps);
  assert.equal(out.status, "failed");
  assert.match(out.error, /access denied/);
  assert.equal(out.ingestedThrough, null);
  assert.equal(recorded[0].status, "failed");
});

test("a truncated pull writes what it read but keeps the old watermark", async () => {
  const { deps } = harness({
    fetchImpl: async () => ({ rows: [{ date: "2026-09-10", query: "q", clicks: 0, impressions: 1, ctr: 0, position: 1 }], truncated: true }),
  });
  const out = await ingestConnection({ brand: "x.com", site_url: "s", last_ingested_through: "2026-09-01" }, deps);
  assert.equal(out.status, "ok");
  assert.equal(out.truncated, true);
  assert.equal(out.ingestedThrough, "2026-09-01");
});

test("an empty GSC window is a measured zero: ok, 0 rows, no upsert call", async () => {
  const { deps, upserts } = harness({ fetchImpl: async () => ({ rows: [], truncated: false }) });
  const out = await ingestConnection({ brand: "x.com", site_url: "s" }, deps);
  assert.equal(out.status, "ok");
  assert.equal(out.rowsWritten, 0);
  assert.equal(upserts.length, 0);
});

test("one brand failing does not stop the next brand", async () => {
  const { deps } = harness({
    listImpl: async () => [{ brand: "bad.com", site_url: "a" }, { brand: "good.com", site_url: "b" }],
    fetchImpl: async (site) => {
      if (site === "a") throw new Error("boom");
      return { rows: [{ date: "2026-09-10", query: "q", clicks: 1, impressions: 1, ctr: 1, position: 1 }], truncated: false };
    },
  });
  const report = await runGscIngest(deps);
  assert.equal(report.connections, 2);
  assert.equal(report.failed, 1);
  assert.equal(report.ok, 1);
  assert.equal(report.rows_written, 1);
});

test("an unreadable connection list throws — it is not 'no brand connected'", async () => {
  const client = { from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: null, error: { message: "ECONNREFUSED" } }) }) }) }) };
  await assert.rejects(() => listGscConnections({ client }), /ECONNREFUSED/);
});

test("upsertGscDaily fences every chunk by connection generation and throws on a failed chunk", async () => {
  const calls = [];
  let fail = false;
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    return fail && calls.length === 2 ? { error: { message: "generation changed" } } : { error: null };
  } };
  const rows = Array.from({ length: GSC_UPSERT_CHUNK + 5 }, (_, i) => ({ brand: "workspace-a", connection_generation: 2, query: `q${i}` }));
  assert.equal(await upsertGscDaily(rows, { client }), rows.length);
  assert.deepEqual(calls.map((c) => c.args.p_rows.length), [GSC_UPSERT_CHUNK, 5]);
  assert.equal(calls[0].name, "write_gsc_generation");
  assert.equal(calls[0].args.p_brand, "workspace-a");
  assert.equal(calls[0].args.p_generation, 2);
  calls.length = 0;
  fail = true;
  await assert.rejects(() => upsertGscDaily(rows, { client }), /generation changed/);
});

// ---------------------------------------------------------------------------
// Perimeter
// ---------------------------------------------------------------------------

test("the GSC cron path is self-gated; the connect route stays operator-gated", () => {
  assert.equal(isSelfGated("/api/gsc/worker"), true);
  assert.equal(isSelfGated("/api/brands/x.com/gsc"), false);
  const verdict = authorizeOperatorRequest({
    method: "POST",
    pathname: "/api/brands/x.com/gsc",
    operatorToken: "tok",
    nodeEnv: "production",
    header: () => null,
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, PERIMETER.DENY_BAD_TOKEN);
});

// ---------------------------------------------------------------------------
// Routes (real handlers; see src/server/cronAuth.route.test.mjs for the hooks)
// ---------------------------------------------------------------------------

process.env.NODE_ENV = "production";
process.env.CRON_SECRET = "gsc-test-secret";
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
register("../cronAuth.route.hooks.mjs", import.meta.url);

const worker = await import("../../app/api/gsc/worker/route.js");
const connect = await import("../../app/api/brands/[brand]/gsc/route.js");
const WORKER_URL = "https://aeovis.test/api/gsc/worker";

test("ROUTE — the GSC worker refuses a request without the cron secret", async () => {
  let ran = false;
  const res = await worker.GET(new Request(WORKER_URL), { runGscIngest: async () => { ran = true; } });
  assert.equal(res.status, 401);
  assert.equal(ran, false, "a refused request must not start an ingest");
});

test("ROUTE — authorized: 200 on a partial success, 500 when every brand failed or the list is unreadable", async () => {
  const auth = { headers: { authorization: "Bearer gsc-test-secret" } };
  const ok = await worker.GET(new Request(WORKER_URL, auth), {
    runGscIngest: async () => ({ connections: 2, ok: 1, failed: 1, rows_written: 5, results: [] }),
  });
  assert.equal(ok.status, 200);

  const zero = await worker.GET(new Request(WORKER_URL, auth), {
    runGscIngest: async () => ({ connections: 0, ok: 0, failed: 0, rows_written: 0, results: [] }),
  });
  assert.equal(zero.status, 200, "no connections is a measured zero");

  const allFailed = await worker.GET(new Request(WORKER_URL, auth), {
    runGscIngest: async () => ({ connections: 1, ok: 0, failed: 1, rows_written: 0, results: [] }),
  });
  assert.equal(allFailed.status, 500);

  const unreadable = await worker.GET(new Request(WORKER_URL, auth), {
    runGscIngest: async () => { throw new Error("db down"); },
  });
  assert.equal(unreadable.status, 500);
  assert.equal((await unreadable.json()).unavailable.reason, "connections_unreadable");
});

test("connect: resolves the domain property first, and ignores unverified access", () => {
  const sites = [
    { siteUrl: "https://x.com/", permissionLevel: "siteRestrictedUser" },
    { siteUrl: "sc-domain:x.com", permissionLevel: "siteUnverifiedUser" },
  ];
  assert.equal(connect.resolveAccessibleProperty("x.com", sites).siteUrl, "https://x.com/");
  sites[1].permissionLevel = "siteFullUser";
  assert.equal(connect.resolveAccessibleProperty("x.com", sites).siteUrl, "sc-domain:x.com");
  assert.equal(connect.resolveAccessibleProperty("other.com", sites).siteUrl, null);
});

test("ROUTE — connect answers 422 naming the service-account email when no property is readable", async () => {
  let saved = false;
  const res = await connect.POST(
    new Request("https://aeovis.test/api/brands/x.com/gsc", { method: "POST", body: "{}" }),
    { params: { brand: "x.com" } },
    {
      getGscServiceAccount: () => ({ client_email: "sa@example.iam.gserviceaccount.com" }),
      listGscSites: async () => [],
      upsertGscConnection: async () => { saved = true; },
    }
  );
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.service_account_email, "sa@example.iam.gserviceaccount.com");
  assert.ok(body.tried.includes("sc-domain:x.com"));
  assert.equal(saved, false);
});

test("ROUTE — connect saves the resolved property", async () => {
  let saved = null;
  const res = await connect.POST(
    new Request("https://aeovis.test/api/brands/x.com/gsc", { method: "POST", body: "{}" }),
    { params: { brand: "X.com" } },
    {
      getGscServiceAccount: () => ({ client_email: "sa@x" }),
      listGscSites: async () => [{ siteUrl: "sc-domain:x.com", permissionLevel: "siteRestrictedUser" }],
      upsertGscConnection: async (arg) => { saved = arg; return { brand: arg.brand, site_url: arg.siteUrl }; },
    }
  );
  assert.equal(res.status, 200);
  assert.deepEqual(saved, { brand: "x.com", siteUrl: "sc-domain:x.com" });
});
