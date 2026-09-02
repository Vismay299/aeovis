import test from "node:test";
import assert from "node:assert/strict";
import { resolveBrightDataSerpZone, getBrightDataConfig } from "./brightdata.js";
import { resolveEnabledEngines, summarizeEngineSlice } from "../scoring/enginePipeline.js";

/**
 * R0.1.10 (finding C4) — the wrong Bright Data credential, validated.
 *
 * `check-secrets.mjs` used to call get_all_zones and pass if ANY active serp
 * zone existed, never reading BRIGHTDATA_SERP_ZONE — while `brightdata.js:10`
 * short-circuits on exactly that variable. A typo'd zone therefore reported
 * PASS on an account with a healthy zone list and not one working probe.
 *
 * Two halves to the accept: the check must exercise the configured zone (proven
 * live against the real account, and pinned below at the resolver), and a wrong
 * zone at probe time must surface as an ERROR row rather than a skipped result
 * with cost 0.0 — a free-looking zero from a credential that looked valid.
 */

const ENV = ["BRIGHTDATA_API_KEY", "BRIGHTDATA_SERP_ZONE", "ENGINES", "SERP_PROVIDER"];

function useEnv(t, env) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  t.after(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = original;
  });
}

test("the configured zone short-circuits the lookup — which is why the check must read it", async (t) => {
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "my_zone" });
  let called = false;
  mockFetch(t, async () => {
    called = true;
    return { ok: true, status: 200, json: async () => [] };
  });

  const zone = await resolveBrightDataSerpZone("bd-key");
  assert.equal(zone, "my_zone");
  assert.equal(called, false, "with the zone set, the client never lists zones — so listing them proves nothing");
});

test("with no configured zone the client falls back to the first active serp zone", async (t) => {
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key" });
  mockFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => [
      { name: "unrelated", type: "unblocker", status: "active" },
      { name: "serp_inactive", type: "serp", status: "suspended" },
      { name: "serp_live", type: "serp", status: "active" },
    ],
  }));

  const zone = await resolveBrightDataSerpZone("bd-key");
  assert.equal(zone, "serp_live", "an inactive serp zone is not a usable zone");
});

test("the auto-discovered zone is cached for the life of the process", async (t) => {
  // Not the behaviour I expected, and worth pinning rather than working around.
  //
  // `cachedZoneName` in brightdata.js is module-level with no invalidation, so
  // once auto-discovery succeeds every later call returns that name without
  // asking the API again — even if the zone is suspended afterwards. Within a
  // process that is a reasonable optimisation; across a long-lived worker it
  // means a zone that dies mid-run keeps being used until restart.
  //
  // It also means the "no active zone throws" path is unreachable in this file
  // after the test above succeeds, which is why that case is asserted through
  // check:secrets (run live against the real account) rather than here.
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key" });
  let calls = 0;
  mockFetch(t, async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => [{ name: "serp_dead", type: "serp", status: "suspended" }],
    };
  });

  // Returns the previously cached name and never asks — despite this account
  // now offering no active serp zone at all.
  const zone = await resolveBrightDataSerpZone("bd-key");
  assert.equal(zone, "serp_live", "the cache from the previous discovery wins");
  assert.equal(calls, 0, "and no lookup is made");
});

test("THE POINT — a wrong zone at probe time is an ERROR row, not a cost-0.0 skip", async (t) => {
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "wrong_zone", ENGINES: "aio" });

  // Bright Data's response to a zone that does not exist.
  mockFetch(t, async (url) => {
    if (String(url).includes("get_all_zones")) {
      return { ok: true, status: 200, json: async () => [{ name: "real_zone", type: "serp", status: "active" }] };
    }
    return {
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "zone not found: wrong_zone" }),
    };
  });

  const aio = resolveEnabledEngines().find((e) => e.name === "aio");
  assert.ok(aio, "aio must resolve — it is the engine under test");

  const row = await aio.probe(
    { text: "best vitrified tiles", topic: "General", source: "test" },
    "Italica",
    ["Italica"],
    "italicatiles.com",
    [],
    null
  );

  // The failure this task is about: a row that looks like a clean, free
  // non-mention. It must not be one.
  assert.ok(row.error, `a failed probe must carry an error, got ${JSON.stringify(row.error)}`);
  assert.equal(row.answer_present, false, "a failed probe never counts as answered");
  assert.equal(row.visible, false);

  // And it must be COUNTED as an error, not merely carry one — that is what
  // keeps it out of the rate and into the error count an operator can see.
  const summary = summarizeEngineSlice([row], "aio");
  assert.equal(summary.errored_queries, 1, "the row must land in the error count");
  assert.equal(summary.error_rate_pct, 100, "one probe, one failure — the operator must see 100%");
});

test("getBrightDataConfig returns null without a key — never a half-config", async (t) => {
  // It returns null rather than throwing; callers branch on that. What matters
  // for this task is that it cannot hand back a config with a missing half,
  // which would produce requests that fail for a reason nothing reports.
  useEnv(t, {});
  assert.equal(await getBrightDataConfig(), null);
});
