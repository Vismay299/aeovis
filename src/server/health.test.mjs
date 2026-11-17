import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildHealthPayload, vendorFlags, VENDORS } from "./health.js";

const NOW = "2026-08-29T12:00:00.000Z";
const FULL_ENV = Object.fromEntries(VENDORS.flatMap((v) => v.env.map((n) => [n, "set"])));

test("vendorFlags - reports configured-ness and NAMES what is missing", () => {
  const flags = vendorFlags({ LLM_API_KEY: "k", NEXT_PUBLIC_SUPABASE_URL: "u" });
  assert.equal(flags.llm.configured, true);
  assert.deepEqual(flags.llm.missing, []);
  // Supabase needs both vars; one is not enough.
  assert.equal(flags.supabase.configured, false);
  assert.deepEqual(flags.supabase.missing, ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]);
  assert.equal(flags.firecrawl.configured, false);
});

test("vendorFlags - whitespace is not a credential", () => {
  assert.equal(vendorFlags({ LLM_API_KEY: "   " }).llm.configured, false);
  assert.equal(vendorFlags({ OPENROUTER_API_KEY: "   " }).llm.configured, false);
});

// ---------------------------------------------------------------------------
// R5.1.1 (findings C4/S19) — the LLM credential is provider-neutral, and the
// deprecated OPENROUTER_* name must keep an existing deployment working while
// being VISIBLE as deprecated rather than silently equivalent.
// ---------------------------------------------------------------------------

test("vendorFlags - the deprecated OPENROUTER_API_KEY still configures the LLM, and says so", () => {
  const flags = vendorFlags({ OPENROUTER_API_KEY: "k" });
  assert.equal(flags.llm.configured, true, "an existing deployment must not break on deploy");
  assert.deepEqual(flags.llm.missing, []);
  assert.deepEqual(
    flags.llm.deprecated,
    ["OPENROUTER_API_KEY"],
    "a credential carried by a name we are removing must not look identical to the canonical one"
  );
});

test("vendorFlags - the canonical LLM_API_KEY reports nothing deprecated", () => {
  const flags = vendorFlags({ LLM_API_KEY: "k", OPENROUTER_API_KEY: "old" });
  assert.equal(flags.llm.configured, true);
  assert.deepEqual(flags.llm.deprecated, [], "canonical set: the legacy name is not in use");
});

test("vendorFlags - neither LLM name set names the CANONICAL one as the fix", () => {
  const flags = vendorFlags({});
  assert.equal(flags.llm.configured, false);
  assert.deepEqual(flags.llm.missing, ["LLM_API_KEY"]);
  assert.deepEqual(flags.llm.deprecated, []);
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
  // Both the canonical name and its deprecated alias must be absent — either
  // one alone still configures the vendor (R5.1.1).
  const env = { ...FULL_ENV, LLM_API_KEY: "", OPENROUTER_API_KEY: "" };
  const p = buildHealthPayload({ db: { ok: true }, env, now: NOW });
  assert.equal(p.status, "degraded");
  assert.deepEqual(p.missing_required, ["llm"]);
});

test("buildHealthPayload - an optional vendor being absent does NOT degrade the deployment", () => {
  const env = { ...FULL_ENV, FIRECRAWL_API_KEY: "" };
  const p = buildHealthPayload({ db: { ok: true }, env, now: NOW });
  assert.equal(p.status, "ok");
  assert.deepEqual(p.missing_required, []);
});

test("vendorFlags - one OpenRouter key configures OpenAI and Perplexity model engines", () => {
  const flags = vendorFlags({ LLM_API_KEY: "shared-openrouter-key" });
  assert.equal(flags.llm.configured, true);
  assert.equal(flags.openai.configured, true);
  assert.equal(flags.perplexity.configured, true);
  assert.deepEqual(flags.openai.missing, []);
  assert.deepEqual(flags.perplexity.missing, []);
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
// src/server/checkSecrets.test.mjs.
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
    env: { ...FULL_ENV, LLM_API_KEY: "sk-or-v1-super-secret" },
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

test("R3.1.7 — recordCronTick refuses to fabricate ticks in memory when no client is configured", async () => {
  const { recordCronTick, getCronTicks } = await import("./db/analytics.js");

  const recorded = await recordCronTick("test-worker", null, { client: null });
  assert.equal(recorded, null, "unconfigured client must return null and not fabricate a tick");

  const ticks = await getCronTicks({ client: null });
  assert.deepEqual(ticks, [], "unconfigured client must return empty array, not memory fallback");
});

test("R3.1.7 — /api/health reports unmeasured cron liveness as unknown, never fresh", () => {
  const p = buildHealthPayload({
    db: { ok: false },
    env: FULL_ENV,
    ticks: [],
    now: NOW,
  });

  assert.equal(p.cron["scan-worker"].last_tick_at, null, "last_tick_at must be null when unmeasured");
  assert.equal(p.cron["scan-worker"].age_ms, null, "age_ms must be null when unmeasured");
  assert.equal(p.cron["scan-worker"].stale, null, "stale must be null when unmeasured");
  assert.equal(p.cron["content-worker"].last_tick_at, null);
  assert.equal(p.cron["content-worker"].stale, null);
});

test("R3.1.7 — positive case: genuinely stored ticks report fresh with calculated age_ms", async () => {
  const { recordCronTick } = await import("./db/analytics.js");

  let storedRow = null;
  const mockClient = {
    from(table) {
      assert.equal(table, "system_heartbeats");
      return {
        upsert([row]) {
          storedRow = row;
          return { error: null };
        },
      };
    },
  };

  const tick = await recordCronTick("content-worker", { test: true }, { client: mockClient });
  assert.ok(tick, "tick recorded when client is configured");
  assert.equal(storedRow.name, "content-worker");

  const p = buildHealthPayload({
    db: { ok: true },
    env: FULL_ENV,
    ticks: [storedRow],
    now: new Date(Date.parse(storedRow.last_tick_at) + 5000).toISOString(),
  });

  assert.equal(p.cron["content-worker"].last_tick_at, storedRow.last_tick_at);
  assert.equal(p.cron["content-worker"].age_ms, 5000);
  assert.equal(p.cron["content-worker"].stale, false);
});
