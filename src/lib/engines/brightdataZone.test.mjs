import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveBrightDataSerpZone,
  getBrightDataConfig,
  brightDataSearch,
  invalidateBrightDataZoneCache,
  peekBrightDataZoneCache,
  brightDataZoneTtlMs,
  isBrightDataZoneError,
  DEFAULT_BRIGHTDATA_ZONE_TTL_MS,
} from "./brightdata.js";
import { resolveEnabledEngines, summarizeEngineSlice } from "../scoring/enginePipeline.js";

/**
 * R0.1.10 (finding C4) — the wrong Bright Data credential, validated.
 *
 * `check-secrets.mjs` used to call get_all_zones and pass if ANY active serp
 * zone existed, never reading BRIGHTDATA_SERP_ZONE — while `brightdata.js`
 * short-circuits on exactly that variable. A typo'd zone therefore reported
 * PASS on an account with a healthy zone list and not one working probe.
 *
 * Two halves to the accept: the check must exercise the configured zone (proven
 * live against the real account, and pinned below at the resolver), and a wrong
 * zone at probe time must surface as an ERROR row rather than a skipped result
 * with cost 0.0 — a free-looking zero from a credential that looked valid.
 *
 * R1.2.7 (same finding, later phase) then CHANGED the caching behaviour this
 * file used to pin. See "THE BEHAVIOUR CHANGE" below: the third test in this
 * file asserted, on purpose, that a suspended zone kept being served from a
 * cache with no invalidator. It no longer does, and the test now says so in
 * both directions rather than being deleted.
 *
 * TESTS IN THIS FILE SHARE THE MODULE'S ZONE CACHE — node --test gives the file
 * one process. Order is load-bearing and each test says what it inherits.
 */

const ENV = [
  "BRIGHTDATA_API_KEY",
  "BRIGHTDATA_SERP_ZONE",
  "BRIGHTDATA_ZONE_TTL_MS",
  "ENGINES",
  "SERP_PROVIDER",
];

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
  assert.equal(
    peekBrightDataZoneCache(),
    null,
    "and the configured path must not populate the auto-discovery cache — nothing to invalidate later"
  );
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
  assert.equal(peekBrightDataZoneCache()?.name, "serp_live", "and it is cached for reuse");
});

test("THE BEHAVIOUR CHANGE (R1.2.7) — cached WITHIN the TTL, re-checked once it expires", async (t) => {
  // WHAT THIS TEST USED TO ASSERT, verbatim in intent:
  //
  //     test("the auto-discovered zone is cached for the life of the process")
  //     assert.equal(zone, "serp_live", "the cache from the previous discovery wins");
  //     assert.equal(calls, 0, "and no lookup is made");
  //
  // — with a fixture offering ONLY a suspended zone. That was a true reading of
  // the code (`cachedZoneName` was module-level with no invalidator) and it was
  // pinned rather than worked around, which is why the "no active zone throws"
  // path had to be tested in a separate file entirely.
  //
  // R1.2.7 changed the code, so this test changes with it. The reason it is no
  // longer acceptable is a lifetime, not a taste: a Vercel function reloads the
  // module every few minutes, but the R1.2 fleet container runs for days, so a
  // zone suspended mid-run kept being sent to /request until someone restarted
  // the process — every AIO probe failing for a cause nothing named.
  //
  // The old assertion survives as the WITHIN-TTL half below: caching is still
  // the default, because get_all_zones is a real network call and re-listing per
  // probe would be ~30 extra calls per scan. What is gone is "for the life of
  // the process".
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

  // Inherited from the test above: "serp_live", cached seconds ago.
  const cached = peekBrightDataZoneCache();
  assert.equal(cached?.name, "serp_live");
  assert.ok(cached.ageMs < DEFAULT_BRIGHTDATA_ZONE_TTL_MS, "the fixture is only meaningful while the entry is fresh");

  // HALF ONE — unchanged from the old test: inside the TTL the cache wins and
  // no lookup is made.
  assert.equal(await resolveBrightDataSerpZone("bd-key"), "serp_live");
  assert.equal(calls, 0, "a fresh cache still costs zero network calls");

  // HALF TWO — the reversal. With the TTL expired (0 = never cache), the same
  // account state now produces a typed configuration error instead of a stale
  // name, and the dead entry is dropped rather than kept.
  process.env.BRIGHTDATA_ZONE_TTL_MS = "0";
  await assert.rejects(
    () => resolveBrightDataSerpZone("bd-key"),
    (err) => {
      assert.ok(isBrightDataZoneError(err), `expected a typed zone error, got ${err?.name}`);
      assert.equal(err.reason, "no_active_zone", "the reason must be machine-readable, not parsed out of the message");
      assert.match(err.message, /No active Bright Data SERP zone found on this account\./);
      assert.match(err.message, /"serp_live"/, "the message must name the zone that was dropped, or the operator cannot tell what changed");
      return true;
    },
    "an expired cache over a suspended-only account must throw, not serve the old name"
  );
  assert.equal(calls, 1, "exactly one re-check — expiry re-lists once, it does not hammer");
  assert.equal(
    peekBrightDataZoneCache(),
    null,
    "and the dead entry is gone: a name that failed re-verification must not survive the failure"
  );
});

test("the TTL is a real clock, not just the 0 special case", async (t) => {
  // Half two above uses TTL=0, which proves the setting is honoured but not that
  // elapsed time expires anything. This one waits out an actual TTL. 40ms is
  // chosen so the suite pays ~60ms for the guarantee; the default is 5 minutes.
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_ZONE_TTL_MS: "40" });
  assert.equal(peekBrightDataZoneCache(), null, "this test starts from the cold cache the test above left behind");

  let calls = 0;
  let account = [{ name: "zone_first", type: "serp", status: "active" }];
  mockFetch(t, async () => {
    calls++;
    return { ok: true, status: 200, json: async () => account };
  });

  assert.equal(await resolveBrightDataSerpZone("bd-key"), "zone_first");
  assert.equal(calls, 1);
  assert.equal(await resolveBrightDataSerpZone("bd-key"), "zone_first");
  assert.equal(calls, 1, "still inside the 40ms window");

  await new Promise((r) => setTimeout(r, 60));

  // The operator retired zone_first and built zone_second. Nothing told this
  // process; the clock is what makes it look again.
  account = [
    { name: "zone_first", type: "serp", status: "suspended" },
    { name: "zone_second", type: "serp", status: "active" },
  ];
  assert.equal(await resolveBrightDataSerpZone("bd-key"), "zone_second", "past the TTL the resolver re-lists and follows the account");
  assert.equal(calls, 2);
});

test("invalidateBrightDataZoneCache — the fleet's per-poll re-check, and it reports what it did", async (t) => {
  // The TTL is a backstop. R1.2's worker can force a re-check on its own poll
  // cadence with this, which is the other half of the accept ("re-checked at
  // least once per fleet poll cycle, OR the cache carries a TTL" — this build
  // does both).
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key" });
  // Inherited from the clock test: "zone_second", now under the default TTL and
  // therefore fresh. Clearing it is itself the first exercise of the invalidator.
  assert.equal(invalidateBrightDataZoneCache("test setup"), "zone_second");

  let calls = 0;
  mockFetch(t, async () => {
    calls++;
    return { ok: true, status: 200, json: async () => [{ name: "zone_live", type: "serp", status: "active" }] };
  });

  assert.equal(await resolveBrightDataSerpZone("bd-key"), "zone_live");
  assert.equal(calls, 1);

  assert.equal(
    invalidateBrightDataZoneCache("poll cycle"),
    "zone_live",
    "invalidating something must return the name it dropped"
  );
  assert.equal(
    invalidateBrightDataZoneCache("poll cycle"),
    null,
    "and invalidating nothing must return null — a cleared cache and an empty one are different events (rule 1)"
  );

  assert.equal(await resolveBrightDataSerpZone("bd-key"), "zone_live");
  assert.equal(calls, 2, "the forced re-check really re-listed, inside the default 5-minute TTL");
});

test("a malformed BRIGHTDATA_ZONE_TTL_MS fails loud rather than falling back to the default", async (t) => {
  // A silent fallback would tell an operator who set "30s" that they had a 30s
  // re-check while they actually had five minutes of a dead zone.
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_ZONE_TTL_MS: "30s" });
  assert.throws(
    () => brightDataZoneTtlMs(),
    (err) => {
      assert.ok(isBrightDataZoneError(err));
      assert.equal(err.reason, "bad_ttl_config");
      assert.match(err.message, /BRIGHTDATA_ZONE_TTL_MS="30s"/);
      return true;
    }
  );
  assert.equal(brightDataZoneTtlMs({}), DEFAULT_BRIGHTDATA_ZONE_TTL_MS, "unset still means the documented default");
  assert.equal(brightDataZoneTtlMs({ BRIGHTDATA_ZONE_TTL_MS: "0" }), 0, "0 is a legitimate 'never cache'");
});

test("a zone rejected at PROBE time drops the cache — the fleet recovers after one bad probe, not one TTL", async (t) => {
  // The scenario the finding describes, end to end, on the auto-discovery path
  // the live deployment actually runs (.env.local sets no BRIGHTDATA_SERP_ZONE).
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", ENGINES: "aio" });
  invalidateBrightDataZoneCache("test setup");

  let account = [{ name: "zone_old", type: "serp", status: "active" }];
  let serpCalls = 0;
  mockFetch(t, async (url, init) => {
    if (String(url).includes("get_all_zones")) {
      return { ok: true, status: 200, json: async () => account };
    }
    serpCalls++;
    const zone = JSON.parse(init.body).zone;
    if (!account.some((z) => z.name === zone && z.status === "active")) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: `zone not found: ${zone}` }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ body: JSON.stringify({ general: { query: "x" } }) }) };
  });

  assert.equal(await resolveBrightDataSerpZone("bd-key"), "zone_old");

  // Bright Data suspends zone_old and the operator stands up zone_new. Under the
  // old cache this process would have kept probing zone_old until restart.
  account = [
    { name: "zone_old", type: "serp", status: "suspended" },
    { name: "zone_new", type: "serp", status: "active" },
  ];

  const aio = resolveEnabledEngines().find((e) => e.name === "aio");
  const row = await aio.probe(
    { text: "best vitrified tiles", topic: "General", source: "test" },
    "Italica",
    ["Italica"],
    "italicatiles.com",
    [],
    null
  );

  assert.ok(row.error, "the probe that hit the dead zone is still an ERROR row (R0.1.10 must not regress)");
  assert.match(row.error, /rejected SERP zone "zone_old"/, "and it names the zone, not just an HTTP status");
  assert.equal(row.cost, 0, "a rejected probe bought nothing");
  assert.equal(summarizeEngineSlice([row], "aio").errored_queries, 1, "counted, never skipped");
  assert.equal(serpCalls, 1, "a zone Bright Data refused is not retried — that would spend the attempt budget for the same answer");

  assert.equal(peekBrightDataZoneCache(), null, "the rejection dropped the cached zone");
  assert.equal(
    await resolveBrightDataSerpZone("bd-key"),
    "zone_new",
    "so the very next resolve follows the account to the live zone — recovery without a restart"
  );
});

test("a typed zone error is never retried, even when its text looks transient", async (t) => {
  // Teeth for the `isBrightDataZoneError(err)` guard in brightDataSearch's catch.
  // Bright Data's zone errors arrive as free text, and that text is free to
  // mention an upstream 5xx — which the retry classifier reads as "transient".
  // Retrying a zone the account has already refused spends the attempt budget
  // to receive the same refusal and delays the re-resolve that fixes it.
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "pinned_zone" });
  let serpCalls = 0;
  mockFetch(t, async (url) => {
    if (String(url).includes("get_all_zones")) {
      return { ok: true, status: 200, json: async () => [] };
    }
    serpCalls++;
    return {
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: "unknown zone: pinned_zone (upstream HTTP 503)" }),
    };
  });

  await assert.rejects(
    () => brightDataSearch("best vitrified tiles", { attempts: 2, backoffMs: 1, timeout: 500 }),
    (err) => {
      assert.ok(isBrightDataZoneError(err), `expected a typed zone error, got ${err?.name}: ${err?.message}`);
      assert.equal(err.reason, "zone_rejected");
      assert.equal(err.zone, "pinned_zone");
      return true;
    }
  );
  assert.equal(serpCalls, 1, "one refusal, one call — the retry classifier must not reach a zone fault");
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

  // R1.2.7 addition: with the zone CONFIGURED there is no cache to drop, so the
  // error must say the deployment cannot heal itself. Telling an operator "the
  // next probe will re-resolve" when BRIGHTDATA_SERP_ZONE pins the zone would be
  // a comforting lie.
  assert.match(row.error, /cannot self-heal/, "a pinned bad zone needs a human, and the row must say so");

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
