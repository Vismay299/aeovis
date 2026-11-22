/**
 * The sample workspace must never read a real workspace, write anything or
 * start paid work, and every portal page must have sample data to show.
 */
import test from "node:test";
import { register } from "node:module";
import assert from "node:assert/strict";
import { SAMPLE_COOKIE, isSampleApiPath } from "./mode.js";
import { sampleGuardDecision } from "../../server/sampleGuard.js";

// Resolves "next/server" and "@/..." for the route modules, as other route tests do.
register(new URL("../../server/customerRoutes.test.hooks.mjs", import.meta.url));

const cookieJar = (value) => (name) => (name === SAMPLE_COOKIE ? value : null);

test("server guard: with the sample cookie, every portal API path is refused before it runs", () => {
  for (const pathname of ["/api/customer/overview", "/api/customer/scan", "/api/content-items/abc/decision", "/api/agents", "/api/content", "/api/brand-briefs", "/api/knowledge/1", "/api/lessons"]) {
    const d = sampleGuardDecision({ pathname, cookie: cookieJar("1") });
    assert.equal(d.block, true, pathname);
    assert.equal(d.status, 409);
    assert.match(d.body.error, /sample workspace/i);
  }
});

test("server guard: without the cookie nothing is refused, and public routes are never refused", () => {
  assert.equal(sampleGuardDecision({ pathname: "/api/customer/overview", cookie: cookieJar(null) }).block, false);
  assert.equal(sampleGuardDecision({ pathname: "/api/customer/overview", cookie: cookieJar("0") }).block, false);
  for (const pathname of ["/api/scan", "/api/scan/123", "/api/demo/scan", "/api/health", "/api/contentx"]) {
    assert.equal(sampleGuardDecision({ pathname, cookie: cookieJar("1") }).block, false, pathname);
  }
  assert.equal(isSampleApiPath("/api/customer"), true);
  assert.equal(isSampleApiPath("/api/customerx"), false);
});

function withWindow(run) {
  const previous = globalThis.window;
  globalThis.window = { location: { href: "https://app.test/portal", origin: "https://app.test" } };
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
}

test("browser layer: writes are refused with an explanation, Supabase is never reached, other traffic passes", async () => {
  const { sampleAnswer, SAMPLE_WRITE_MESSAGE } = await import("./sampleFetch.js");
  await withWindow(async () => {
    for (const [url, method] of [["/api/customer/scan", "POST"], ["/api/customer/content", "POST"], ["/api/customer/team", "POST"], ["/api/customer/questions/approve", "POST"], ["/api/content-items/x/decision", "POST"], ["/api/customer/schedule", "PUT"], ["/api/customer/audit/x", "DELETE"]]) {
      const res = await sampleAnswer(url, { method, body: "{}" });
      assert.equal(res.status, 403, `${method} ${url}`);
      assert.equal((await res.json()).error, SAMPLE_WRITE_MESSAGE);
    }
    const supabase = await sampleAnswer("https://abc.supabase.co/auth/v1/user");
    assert.equal(supabase.status, 200);
    assert.equal(await supabase.json(), null);
    assert.equal(await sampleAnswer("/_next/static/chunk.js"), null);
    assert.equal(await sampleAnswer("https://elsewhere.test/api/customer/overview"), null);
    const unknown = await sampleAnswer("/api/customer/does-not-exist");
    assert.equal(unknown.status, 404);
  });
});

test("browser layer: read-only POSTs (lookups, quotes) answer with sample data, never a charge", async () => {
  const { sampleAnswer } = await import("./sampleFetch.js");
  await withWindow(async () => {
    const research = await sampleAnswer("/api/customer/keywords/research", { method: "POST", body: JSON.stringify({ keyword: "nabh software", cacheOnly: true }) });
    assert.equal(research.status, 200);
    const body = await research.json();
    assert.ok(body.rows.length > 5);
    const quote = await (await sampleAnswer("/api/customer/price/estimate", { method: "POST", body: JSON.stringify({ action: "keywords.research.run" }) })).json();
    assert.match(quote.lines[0].label, /nothing is charged/i);
  });
});

test("fixtures: every page of the portal has sample data", async () => {
  const { sampleResponse } = await import("./fixtures/index.js");
  const get = (p) => sampleResponse(new URL(p, "https://app.test"), "GET");
  const paths = [
    "/api/customer/features", "/api/customer/overview", "/api/customer/gsc", "/api/customer/schedule", "/api/customer/scan",
    "/api/customer/scans/history", "/api/customer/scan/report/sample-scan-6", "/api/customer/questions", "/api/customer/repairs/panel",
    "/api/customer/repairs/opportunity", "/api/customer/measurement", "/api/customer/context", "/api/customer/team", "/api/customer/usage",
    "/api/customer/email/preferences", "/api/customer/privacy", "/api/customer/explore", "/api/customer/keywords/saved",
    "/api/customer/keywords/locations", "/api/customer/domain/competitors/declared", "/api/customer/backlinks/snapshot-targets",
    "/api/customer/backlinks/snapshots", "/api/customer/local/businesses", "/api/customer/local/grids", "/api/customer/local/fetches",
    "/api/customer/audit", "/api/customer/audit/crawler-access", "/api/customer/rank-tracking/configs", "/api/customer/ga4",
    "/api/customer/ga4/overview", "/api/customer/ga4/accounts", "/api/customer/content", "/api/customer/agents",
    "/api/customer/assistant/config", "/api/customer/assistant/sessions", "/api/customer/reports", "/api/customer/reports/templates",
    "/api/customer/indexnow", "/api/customer/gsc/data",
  ];
  for (const p of paths) {
    const answer = get(p);
    assert.ok(answer && answer.body, `no sample data for GET ${p}`);
  }
  const features = get("/api/customer/features").body.features;
  for (const name of ["keyword_research", "domain_research", "local_seo", "backlinks", "site_audit", "rank_tracking", "ga4", "assistant", "reports", "prompt_explorer"]) {
    assert.equal(features[name], true, `${name} must be on in the sample`);
  }
  assert.equal(features.price_review, false, "the sample never shows a spend approval");
});

test("fixtures: the sample scan figures are computed and agree across surfaces", async () => {
  const { sampleResponse } = await import("./fixtures/index.js");
  const get = (p) => sampleResponse(new URL(p, "https://app.test"), "GET").body;
  const overview = get("/api/customer/overview");
  const latest = overview.latest_scan;
  assert.equal(typeof latest.visibility_pct, "number", "the headline is qualified, not withheld");
  const report = get(`/api/customer/scan/report/${latest.id}`);
  assert.equal(report.scan.visibility_pct, latest.visibility_pct);
  assert.equal(report.scan.prompts_mentioned, latest.prompts_mentioned);
  const named = new Set(report.results.filter((r) => r.mentioned).map((r) => r.query)).size;
  assert.equal(named, latest.prompts_mentioned, "questions naming the brand match the rows behind them");
  assert.equal(new Set(report.results.map((r) => r.query)).size, latest.prompts_tracked);
});

test("enter and exit routes set and clear the sample cookie", async () => {
  const { GET: enter } = await import("../../app/sample/route.js");
  const { GET: exit } = await import("../../app/sample/exit/route.js");
  const on = enter(new Request("https://app.test/sample"));
  assert.equal(on.status, 307);
  assert.equal(on.headers.get("location"), "/portal", "a relative redirect, never the server's own host");
  assert.match(on.headers.get("set-cookie"), new RegExp(`${SAMPLE_COOKIE}=1`));
  const off = exit(new Request("https://app.test/sample/exit?to=/signup"));
  assert.equal(off.headers.get("location"), "/signup");
  assert.match(off.headers.get("set-cookie"), new RegExp(`${SAMPLE_COOKIE}=;`));
  const unsafe = exit(new Request("https://app.test/sample/exit?to=//evil.test"));
  assert.equal(unsafe.headers.get("location"), "/");
});
