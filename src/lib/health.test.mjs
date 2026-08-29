import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildHealthPayload, vendorFlags, VENDORS } from "./health.js";

const NOW = "2026-08-29T12:00:00.000Z";
const FULL_ENV = Object.fromEntries(VENDORS.flatMap((v) => v.env.map((n) => [n, "set"])));

test("vendorFlags - reports configured-ness and NAMES what is missing", () => {
  const flags = vendorFlags({ OPENROUTER_API_KEY: "k", NEXT_PUBLIC_SUPABASE_URL: "u" });
  assert.equal(flags.llm.configured, true);
  assert.deepEqual(flags.llm.missing, []);
  // Supabase needs both vars; one is not enough.
  assert.equal(flags.supabase.configured, false);
  assert.deepEqual(flags.supabase.missing, ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]);
  assert.equal(flags.firecrawl.configured, false);
});

test("vendorFlags - whitespace is not a credential", () => {
  assert.equal(vendorFlags({ OPENROUTER_API_KEY: "   " }).llm.configured, false);
});

test("buildHealthPayload - the accept criterion: db status, vendor flags, last cron tick", () => {
  const p = buildHealthPayload({
    db: { ok: true, latency_ms: 12 },
    env: FULL_ENV,
    ticks: [{ name: "scan-worker", last_tick_at: "2026-08-29T11:30:00.000Z" }],
    now: NOW,
  });
  assert.equal(p.status, "ok");
  assert.equal(p.db.ok, true);
  assert.equal(p.db.latency_ms, 12);
  assert.equal(p.vendors.brightdata.configured, true);
  assert.equal(p.cron["scan-worker"].last_tick_at, "2026-08-29T11:30:00.000Z");
  assert.equal(p.cron["scan-worker"].age_ms, 30 * 60 * 1000);
  assert.equal(p.cron["scan-worker"].stale, false);
});

test("buildHealthPayload - an unreachable DB is 'down' and keeps the error", () => {
  const p = buildHealthPayload({
    db: { ok: false, error: "connection refused", latency_ms: 5000 },
    env: FULL_ENV,
    now: NOW,
  });
  assert.equal(p.status, "down");
  assert.equal(p.db.error, "connection refused");
});

test("buildHealthPayload - a missing REQUIRED vendor is 'degraded', never 'ok'", () => {
  // An endpoint reporting ok while the LLM is unconfigured is the health-check
  // equivalent of a 100% share of voice.
  const env = { ...FULL_ENV, OPENROUTER_API_KEY: "" };
  const p = buildHealthPayload({ db: { ok: true }, env, now: NOW });
  assert.equal(p.status, "degraded");
  assert.deepEqual(p.missing_required, ["llm"]);
});

test("buildHealthPayload - an optional vendor being absent does NOT degrade the deployment", () => {
  const env = { ...FULL_ENV, FIRECRAWL_API_KEY: "", PERPLEXITY_API_KEY: "" };
  const p = buildHealthPayload({ db: { ok: true }, env, now: NOW });
  assert.equal(p.status, "ok");
  assert.deepEqual(p.missing_required, []);
});

// ---------------------------------------------------------------------------
// R0.1.9 — a stale SERPAPI_KEY must not make the SERP provider look configured.
//
// Bright Data is the SERP provider
// (docs/decisions/2026-08-29-serp-provider-bright-data.md); SERPAPI_KEY is
// superseded. These assert through buildHealthPayload — the object /api/health
// actually returns — rather than through vendorFlags one layer below it,
// because the failure being guarded is a deployment reading HEALTHY at boot and
// only discovering the missing SERP credential at probe time. The matching
// half for check:secrets, and the test that the two AGREE, is in
// src/lib/checkSecrets.test.mjs.
// ---------------------------------------------------------------------------

test("buildHealthPayload - only SERPAPI_KEY set: the SERP vendor reads NOT configured", () => {
  // Everything else configured, so brightdata is the only variable and the
  // verdict below cannot be caused by some other absent vendor.
  const env = { ...FULL_ENV, BRIGHTDATA_API_KEY: "", SERPAPI_KEY: "stale-serpapi-key" };
  const p = buildHealthPayload({ db: { ok: true }, env, ticks: [], now: NOW });

  assert.equal(
    p.vendors.brightdata.configured,
    false,
    "a superseded SERPAPI_KEY is not a SERP credential"
  );
  assert.deepEqual(p.vendors.brightdata.missing, ["BRIGHTDATA_API_KEY"], "name the fix, not just a red flag");
  assert.deepEqual(p.missing_required, ["brightdata"]);
});

test("buildHealthPayload - only SERPAPI_KEY set: the OVERALL verdict is degraded, never ok", () => {
  // The finding: a deployment that cannot run a SERP probe reported healthy.
  const env = { ...FULL_ENV, BRIGHTDATA_API_KEY: "", SERPAPI_KEY: "stale-serpapi-key" };
  const p = buildHealthPayload({ db: { ok: true }, env, ticks: [], now: NOW });
  assert.notEqual(p.status, "ok", "a deployment with no SERP provider must not render as healthy");
  assert.equal(p.status, "degraded");
});

test("buildHealthPayload - POSITIVE CONTROL: with BRIGHTDATA_API_KEY it is ok again", () => {
  // Proves the two assertions above pin the CREDENTIAL and not the env shape:
  // same payload call, brightdata restored, SERPAPI_KEY still absent.
  const p = buildHealthPayload({ db: { ok: true }, env: FULL_ENV, ticks: [], now: NOW });
  assert.equal(p.vendors.brightdata.configured, true);
  assert.equal(p.status, "ok");
  assert.deepEqual(p.missing_required, []);
});

test("buildHealthPayload - SERPAPI_KEY changes NOTHING about the payload", () => {
  // Strongest form of "it is not a credential here": adding it is a no-op on
  // an otherwise identical environment, for every vendor, not just brightdata.
  const bare = buildHealthPayload({ db: { ok: true }, env: {}, ticks: [], now: NOW });
  const stale = buildHealthPayload({
    db: { ok: true },
    env: { SERPAPI_KEY: "stale-serpapi-key" },
    ticks: [],
    now: NOW,
  });
  assert.deepEqual(stale, bare);
  assert.equal(stale.vendors.brightdata.configured, false);
});

test("buildHealthPayload - no vendor in the table is satisfied by SERPAPI_KEY", () => {
  // A drift guard on the DATA, not on the file text: if anyone re-adds
  // SERPAPI_KEY to a vendor's env list, this fails.
  const allEnvVars = VENDORS.flatMap((v) => v.env);
  assert.equal(
    allEnvVars.includes("SERPAPI_KEY"),
    false,
    `SERPAPI_KEY is superseded by BRIGHTDATA_API_KEY; vendor table lists ${allEnvVars.join(", ")}`
  );
});

test("buildHealthPayload - a cron that has NEVER ticked reports null, not zero or absent", () => {
  // Standing rule 1: never-ran must not render the same as just-ran.
  const p = buildHealthPayload({ db: { ok: true }, env: FULL_ENV, ticks: [], now: NOW });
  assert.deepEqual(p.cron["scan-worker"], { last_tick_at: null, age_ms: null, stale: null });
  assert.deepEqual(p.cron["content-worker"], { last_tick_at: null, age_ms: null, stale: null });
});

test("buildHealthPayload - an old tick is marked stale", () => {
  const p = buildHealthPayload({
    db: { ok: true },
    env: FULL_ENV,
    ticks: [{ name: "scan-worker", last_tick_at: "2026-08-28T00:00:00.000Z" }],
    now: NOW,
    staleTickMs: 60 * 60 * 1000,
  });
  assert.equal(p.cron["scan-worker"].stale, true);
});

test("buildHealthPayload - an unparseable tick timestamp yields null age, not a bogus number", () => {
  const p = buildHealthPayload({
    db: { ok: true },
    env: FULL_ENV,
    ticks: [{ name: "scan-worker", last_tick_at: "not a date" }],
    now: NOW,
  });
  assert.equal(p.cron["scan-worker"].age_ms, null);
  assert.equal(p.cron["scan-worker"].stale, null);
});

test("buildHealthPayload - the payload leaks no credential VALUES, only their names", async () => {
  const p = buildHealthPayload({
    db: { ok: true },
    env: { ...FULL_ENV, OPENROUTER_API_KEY: "sk-or-v1-super-secret" },
    ticks: [],
    now: NOW,
  });
  assert.doesNotMatch(JSON.stringify(p), /super-secret/);
});

test("GUARD — /api/health exists, is force-dynamic, and returns buildHealthPayload", async () => {
  const src = await readFile(new URL("../app/api/health/route.js", import.meta.url), "utf8");
  assert.match(src, /export async function GET/);
  assert.match(src, /export const dynamic = "force-dynamic"/, "must not be prerendered at build time");
  assert.match(src, /buildHealthPayload/, "the route must return the tested payload, not its own shape");
  assert.match(src, /getCronTicks/, "the route must read real ticks");
  assert.doesNotMatch(src, /generateContent|llmJson|fetch\(/, "health must make no live vendor calls");
});

test("GUARD — both worker routes record their tick AFTER the auth gate", async () => {
  for (const [rel, name] of [
    ["../app/api/scan/worker/route.js", "scan-worker"],
    ["../app/api/content/worker/route.js", "content-worker"],
  ]) {
    const src = await readFile(new URL(rel, import.meta.url), "utf8");
    const unauthorized = src.indexOf('{ detail: "Unauthorized." }');
    const tick = src.indexOf(`recordCronTick("${name}")`);
    assert.ok(tick !== -1, `${rel} must record a ${name} tick`);
    assert.ok(
      unauthorized !== -1 && unauthorized < tick,
      `${rel} must record the tick after the 401, or a rejected request makes a dead cron look alive`
    );
  }
});
