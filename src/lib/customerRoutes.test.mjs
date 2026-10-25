import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./customerRoutes.test.hooks.mjs", import.meta.url);
const { DuplicateScanError } = await import("./duplicateScan.js");
const listing = await import("../app/api/customer/scan/route.js");
const report = await import("../app/api/customer/scan/report/[scan_id]/route.js");
const gscData = await import("../app/api/customer/gsc/data/route.js");
const contentListing = await import("../app/api/customer/content/route.js");
const contentItem = await import("../app/api/customer/content/[id]/route.js");

function fixture({ resultError = null } = {}) {
  const scans = [
    { id: "scan-a", brand: "%", url: "https://same.example", brand_key: "workspace-a" },
    { id: "scan-b", brand: "%", url: "https://same.example", brand_key: "workspace-b" },
    { id: "legacy", brand: "%", url: "https://same.example" },
  ];
  const tables = {
    scans, scan_jobs: scans.map((scan) => ({ ...scan, status: "pending" })),
    prompt_results: [{ id: "result-a", scan_id: "scan-a", query: "best beans", engine: "chatgpt", answer_text: "An answer", mentioned: true }],
    gsc_connections: [{ brand_key: "workspace-a", connection_generation: 2, enabled: true }],
    gsc_daily: [{ brand_key: "workspace-a", connection_generation: 2, date: "2099-01-01", query: "q", clicks: 2, impressions: 20, ctr: 0.1, position: 3 }],
    content_items: [{ id: "draft-a", brand: "workspace-a", title: "Own draft", body_md: "Private draft" }, { id: "draft-b", brand: "workspace-b", title: "Other draft" }],
    content_jobs: [{ id: "content-job-a", brand: "workspace-a" }, { id: "content-job-b", brand: "workspace-b" }],
  };
  const queries = [];
  const admin = {
    from(table) {
      let rows = tables[table] || [];
      let error;
      const finish = (single = false) => ({ data: error ? null : single ? rows[0] || null : rows, error: error || null });
      const query = {
        select(columns) {
          queries.push({ table, columns });
          if (table === "prompt_results") {
            error = resultError;
            if (/prompt_text|visibility_score|brand_mentioned|citations/.test(columns)) error = { message: "unknown column" };
          }
          return this;
        },
        eq(column, value) { rows = rows.filter((row) => row[column] === value); return this; },
        ilike() { throw new Error("Customer reads must not authorize by labels or patterns"); },
        gte(column, value) { assert.match(value, /^\d{4}-\d{2}-\d{2}$/); rows = rows.filter((row) => row[column] >= value); return this; },
        order() { return this; }, limit(value) { rows = rows.slice(0, value); return this; },
        range(start, end) { rows = rows.slice(start, end + 1); return this; },
        single: async () => finish(true), maybeSingle: async () => finish(true),
        then(resolve, reject) { return Promise.resolve(finish()).then(resolve, reject); },
      };
      return query;
    },
  };
  globalThis.customerRouteFixture = {
    admin, context: { client: admin, user: { id: "owner-a" }, error: null, brands: [{ brandKey: "workspace-a", display_name: "%", website: "https://same.example", role: "owner" }] },
  };
  return { queries, tables };
}

test("customer content listing, draft and export are isolated by workspace", async () => {
  fixture();
  const url = "https://app.example.test/api/customer/content?brand_key=workspace-a";
  const listing = await contentListing.GET(new Request(url));
  assert.equal(listing.status, 200);
  const data = await listing.json();
  assert.deepEqual(data.items.map((row) => row.id), ["draft-a"]);
  assert.deepEqual(data.jobs.map((row) => row.id), ["content-job-a"]);
  assert.equal((await contentItem.GET(new Request(url), { params: { id: "draft-b" } })).status, 404);
  const exported = await contentItem.GET(new Request(url + "&export=markdown"), { params: { id: "draft-a" } });
  assert.match(await exported.text(), /Private draft/);
  assert.equal((await contentItem.PATCH(new Request(url, { method: "PATCH", headers: { origin: "https://attacker.example" }, body: "{}" }), { params: { id: "draft-a" } })).status, 403);
});

test("content lists expose the selected output format without leaking snapshot instructions or brief", async () => {
  const {tables}=fixture();
  const snapshot={name:"FAQ Writer",format:"faq",custom_instructions:"Private instructions"};
  tables.content_jobs[0].agent_snapshot=snapshot;
  tables.content_jobs[0].input={query:"A topic",brief:"Private brief"};
  tables.content_items[0].agent_snapshot=snapshot;
  const response=await contentListing.GET(new Request("https://app.example.test/api/customer/content?brand_key=workspace-a"));
  const body=await response.json();
  assert.equal(body.jobs[0].agent_format,"faq");
  assert.equal(body.items[0].agent_format,"faq");
  assert.deepEqual(body.jobs[0].input,{query:"A topic"});
  assert.ok(!JSON.stringify(body).includes("Private instructions"));
  assert.ok(!JSON.stringify(body).includes("Private brief"));
});

test("scan listing cannot expose matching names, websites, or wildcard labels from other workspaces", async () => {
  fixture();
  const response = await listing.GET(new Request("https://app.example.test/api/customer/scan"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.scans.map((scan) => scan.id), ["scan-a"]);
  assert.deepEqual(body.jobs.map((job) => job.id), ["scan-a"]);
});

test("starting a scan distinguishes an unapproved question panel from a scan already running", async () => {
  const { tables } = fixture();
  const start = () => listing.POST(new Request("https://app.example.test/api/customer/scan", { method: "POST", body: JSON.stringify({ brand_key: "workspace-a" }) }));
  let created = 0;
  globalThis.customerRouteFixture.createScanJob = async () => { created++; throw new DuplicateScanError("workspace-a", "job-running"); };

  const noPanel = await start();
  assert.equal(noPanel.status, 409);
  assert.deepEqual(await noPanel.json(), { error: "Review and approve a question panel before starting measurement.", code: "panel_not_approved" });
  assert.equal(created, 0, "no job is created without an approved panel");

  tables.repair_artifact_heads = [{ brand: "workspace-a", kind: "panel", artifact: { artifact_key: "default", state: "draft", payload: { context: {} } } }];
  assert.equal((await (await start()).json()).code, "panel_not_approved", "a draft panel is not approved");

  tables.repair_artifact_heads[0].artifact.state = "approved";
  const running = await start();
  assert.equal(running.status, 409);
  assert.deepEqual(await running.json(), { error: "A scan is already running for this workspace.", code: "scan_already_running" });
  assert.equal(created, 1);
});

test("scan report rejects another workspace and unassigned historical rows even when names match", async () => {
  fixture();
  for (const id of ["scan-b", "legacy"]) {
    assert.equal((await report.GET(new Request("https://app.example.test/report"), { params: { scan_id: id } })).status, 404);
  }
});

test("scan history exposes measured engine names and collection warnings without returning summaries", async () => {
  const { tables, queries } = fixture();
  tables.scans[0].engine_summaries = { aio: { data_source_issue: true, error_rate_pct: 50 }, chatgpt: { error_rate_pct: 0 }, gemini: {}, perplexity: {} };
  const response = await listing.GET(new Request("https://app.example.test/api/customer/scan"));
  const { scans } = await response.json();
  assert.deepEqual(scans[0].platform, ["aio", "chatgpt", "gemini", "perplexity"]);
  assert.equal(scans[0].collection_partial, true);
  assert.equal(scans[0].engine_summaries, undefined);
  assert.match(queries.find((query) => query.table === "scans").columns, /engine_summaries:raw_results->engines/);
  tables.scans[0].engine_summaries = [{ engine: "aio", error_rate_pct: 0 }, { engine: "chatgpt", error_rate_pct: 0 }];
  const clean = await (await listing.GET(new Request("https://app.example.test/api/customer/scan"))).json();
  assert.equal(clean.scans[0].collection_partial, false);
  assert.deepEqual(clean.scans[0].platform, ["aio", "chatgpt"]);
});

test("scan report reads the actual result columns and reports failed queries", async () => {
  fixture();
  const response = await report.GET(new Request("https://app.example.test/report"), { params: { scan_id: "scan-a" } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).results[0].query, "best beans");
  fixture({ resultError: { message: "DB unavailable" } });
  assert.equal((await report.GET(new Request("https://app.example.test/report"), { params: { scan_id: "scan-a" } })).status, 500);
});

test("GSC data returns the active generation with a valid bounded date window", async () => {
  fixture();
  const response = await gscData.GET(new Request("https://app.example.test/api/customer/gsc/data?days=30"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].clicks, 2);
});

test("customer report preserves measured zero percentages instead of replacing them with unknown", async () => {
  const { tables } = fixture();
  tables.scans[0].raw_results = { share_of_voice_pct: 0, win_rate_pct: 0, brand_citation_share_pct: 0 };
  const response = await report.GET(new Request("https://app.example.test/report"), { params: { scan_id: "scan-a" } });
  const { scan } = await response.json();
  assert.equal(scan.share_of_voice_pct, 0);
  assert.equal(scan.win_rate_pct, 0);
  assert.equal(scan.brand_citation_share_pct, 0);
});
