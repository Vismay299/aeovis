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

/* ===========================================================================
 * R1.2.10 — THE 200 ENVELOPE.
 *
 * Every zone-rejection test above this line answers the probe with `ok: false`.
 * That is the easy half: an HTTP 4xx is already a failure, and any reader
 * looking at brightDataSearch expects the not-ok branch to do something.
 *
 * Bright Data also refuses a zone with HTTP **200** and an error envelope in the
 * body — `{"error": "zone not found: X"}` or `{"status":"error","message":...}`.
 * That is the case a naive reader does not expect and a status-code-only check
 * reads as success. brightdata.js handles it (the `data.error || data.status ===
 * "error"` branch re-runs zoneRejectionDetail on the envelope message), but when
 * this task was filed you could DELETE that branch and the whole suite stayed
 * green: nothing pinned it. Deleting it degrades a one-probe recovery into a
 * five-minute TTL of probes against a zone the account has already refused, and
 * strips the zone name and the consequence out of the operator-facing message.
 *
 * The three tests below are the teeth. Each was confirmed to FAIL with the
 * envelope branch commented out and to pass with it restored.
 *
 * These tests share the module zone cache with everything above (see the file
 * header). Each one states what it does to the cache before it starts.
 * ======================================================================== */

test("R1.2.10 — a zone refusal inside an HTTP 200 envelope is a zone rejection, not a success", async (t) => {
  // Form one: `{"error": ...}` on a 200, on the auto-discovery path the live
  // deployment actually runs. The full recovery loop is asserted, because the
  // point of typing this failure is that the NEXT probe works.
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key" });
  invalidateBrightDataZoneCache("test setup");

  let account = [{ name: "zone_alpha", type: "serp", status: "active" }];
  let serpCalls = 0;
  mockFetch(t, async (url, init) => {
    if (String(url).includes("get_all_zones")) {
      return { ok: true, status: 200, json: async () => account };
    }
    serpCalls++;
    const zone = JSON.parse(init.body).zone;
    if (!account.some((z) => z.name === zone && z.status === "active")) {
      // THE FIXTURE THAT MATTERS: HTTP 200, `ok: true`, and a refusal in the
      // body. Observed shape for Bright Data /request zone faults — the
      // transport succeeded, the request did not.
      return { ok: true, status: 200, text: async () => JSON.stringify({ error: `zone not found: ${zone}` }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ body: JSON.stringify({ general: { query: "x" } }) }) };
  });

  assert.equal(await resolveBrightDataSerpZone("bd-key"), "zone_alpha");

  // The account retires zone_alpha behind this process's back.
  account = [
    { name: "zone_alpha", type: "serp", status: "suspended" },
    { name: "zone_beta", type: "serp", status: "active" },
  ];

  await assert.rejects(
    () => brightDataSearch("best vitrified tiles", { attempts: 2, backoffMs: 1, timeout: 500 }),
    (err) => {
      assert.ok(
        isBrightDataZoneError(err),
        `a 200 with an error envelope must still type as a zone fault, got ${err?.name}: ${err?.message}`
      );
      assert.equal(err.reason, "zone_rejected", "machine-readable, so callers do not parse the message");
      assert.equal(err.zone, "zone_alpha");
      assert.match(err.message, /rejected SERP zone "zone_alpha"/, "the operator must be told WHICH zone");
      return true;
    },
    "an HTTP 200 carrying a zone refusal must not be read as a successful response"
  );

  assert.equal(serpCalls, 1, "a refusal the account already issued is not retried, envelope or not");
  assert.equal(
    peekBrightDataZoneCache(),
    null,
    "the envelope rejection must drop the cache too — otherwise recovery waits out the TTL"
  );
  assert.equal(
    await resolveBrightDataSerpZone("bd-key"),
    "zone_beta",
    "and the next resolve follows the account: recovery after ONE bad probe"
  );
});

test("R1.2.10 — the envelope's other form: status:\"error\" with the cause in `message`", async (t) => {
  // Form two. Bright Data does not commit to one envelope shape, and the branch
  // reads `data.error || data.message` for exactly that reason. With the zone
  // PINNED there is no cache to drop, so the message must say so rather than
  // promise a self-heal that cannot happen.
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "envelope_zone" });
  let serpCalls = 0;
  mockFetch(t, async (url) => {
    if (String(url).includes("get_all_zones")) {
      return { ok: true, status: 200, json: async () => [] };
    }
    serpCalls++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "error", message: "no such zone: envelope_zone" }),
    };
  });

  await assert.rejects(
    () => brightDataSearch("best vitrified tiles", { attempts: 2, backoffMs: 1, timeout: 500 }),
    (err) => {
      assert.ok(isBrightDataZoneError(err), `expected a typed zone error, got ${err?.name}: ${err?.message}`);
      assert.equal(err.reason, "zone_rejected");
      assert.equal(err.zone, "envelope_zone");
      assert.match(err.message, /cannot self-heal/, "a pinned zone needs a human, and the row must say so");
      return true;
    }
  );
  assert.equal(serpCalls, 1);
});

test("R1.2.10 — a 200-envelope refusal reaches the caller as an ERROR row, not an answered non-mention", async (t) => {
  // The end-to-end shape of the finding: an HTTP 200 is the single most likely
  // thing to be mistaken for a clean result. Pinned at the probe boundary, where
  // a false success would actually be scored.
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "envelope_zone", ENGINES: "aio" });
  mockFetch(t, async (url) => {
    if (String(url).includes("get_all_zones")) {
      return { ok: true, status: 200, json: async () => [] };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ error: "zone not found: envelope_zone" }) };
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

  assert.ok(row.error, `a 200 that refused the zone must still produce an error row, got ${JSON.stringify(row.error)}`);
  assert.match(row.error, /rejected SERP zone "envelope_zone"/, "typed, and naming the zone — not a bare envelope message");
  assert.equal(row.answer_present, false, "a refused probe never counts as answered");
  assert.equal(row.visible, false);
  assert.equal(row.cost, 0, "a refused probe bought nothing");

  const summary = summarizeEngineSlice([row], "aio");
  assert.equal(summary.errored_queries, 1, "counted, never skipped");
  assert.equal(summary.error_rate_pct, 100);
});

test("R1.2.10 — snake_case zone states are zone rejections too (zone_suspended, zone_disabled, zone_expired)", async (t) => {
  // Bright Data returns machine-readable error CODES as well as prose, and
  // zoneRejectionDetail already anticipates that: its first pattern is
  // /zone[ _-]?not[ _-]?found/, written to catch `zone_not_found`. The two
  // patterns covering the zone-STATE wordings were not, because they lean on \b
  // and an underscore is a word character — so `zone_suspended` produced a plain
  // Error, the cache survived, and the process kept probing a dead zone for a
  // full TTL. That is the C4 finding, arriving through a different door.
  //
  // Verified against the shipped patterns before the fix: all four wordings
  // below fell through to a plain Error.
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "state_zone" });

  let wording = "";
  mockFetch(t, async (url) => {
    if (String(url).includes("get_all_zones")) {
      return { ok: true, status: 200, json: async () => [] };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ error: wording }) };
  });

  for (const w of ["zone_suspended", "zone_disabled", "zone_expired", "zone_deleted", "suspended_zone", "zone_not_active"]) {
    wording = w;
    await assert.rejects(
      () => brightDataSearch("best vitrified tiles", { attempts: 2, backoffMs: 1, timeout: 500 }),
      (err) => {
        assert.ok(
          isBrightDataZoneError(err),
          `"${w}" is a zone state Bright Data can return; it must type as a zone fault, got ${err?.name}: ${err?.message}`
        );
        assert.equal(err.reason, "zone_rejected", `"${w}" must carry the machine-readable reason`);
        assert.equal(err.zone, "state_zone");
        return true;
      },
      `"${w}" fell through to a generic error — the cache would survive a dead zone`
    );
  }
});

test("R1.2.10 — RECORDED ASYMMETRY: rate-limit precedence differs between the 200 and not-ok paths", async (t) => {
  // This test does not claim the current ordering is the only right one. It
  // records it, with its cost, so that changing it is a decision rather than an
  // accident — which is what the accept asks for ("or the difference is
  // documented with its reason").
  //
  // THE INPUT IS GENUINELY AMBIGUOUS: Bright Data telling you, in one string,
  // both "you are over quota" and "this zone is off". The two paths break the
  // tie in opposite directions:
  //
  //   200 path      isRateLimitResponse runs FIRST, so rate limit wins.
  //   not-ok path   zoneRejectionDetail runs FIRST, so the zone fault wins.
  //
  // Neither produces a false success — both are errors, both are counted, and
  // both name a cause. Each degrades in a bounded way, in opposite directions:
  //   - 200 path: the cache is NOT dropped, so a genuinely dead zone keeps being
  //     probed until the TTL expires (<= 5 minutes), instead of one probe.
  //   - not-ok path: an HTTP 429 is typed as a configuration fault and NOT
  //     retried, spending one recoverable throttle, and costing one extra
  //     get_all_zones when the cache is dropped for a zone that was fine.
  //
  // Making them consistent means choosing which of those costs to always pay,
  // and it changes retry semantics on the live probe path — a source decision,
  // not a test-author one. Left as-is deliberately; revisit if the fleet logs
  // show either collision actually occurring.
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key" });
  invalidateBrightDataZoneCache("test setup");

  // HALF ONE — the 200 path. Rate limit wins, and the cache survives.
  let serpCalls = 0;
  mockFetch(t, async (url) => {
    if (String(url).includes("get_all_zones")) {
      return { ok: true, status: 200, json: async () => [{ name: "zone_gamma", type: "serp", status: "active" }] };
    }
    serpCalls++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ error: "rate limit exceeded: zone_suspended until quota resets" }),
    };
  });

  assert.equal(await resolveBrightDataSerpZone("bd-key"), "zone_gamma");
  await assert.rejects(
    () => brightDataSearch("best vitrified tiles", { attempts: 2, backoffMs: 1, timeout: 500 }),
    (err) => {
      assert.equal(isBrightDataZoneError(err), false, "on the 200 path the rate-limit read wins the ambiguous body");
      assert.match(err.message, /rate limit \/ quota exhausted/);
      return true;
    }
  );
  assert.equal(serpCalls, 1, "a rate limit is not retried either");
  assert.equal(
    peekBrightDataZoneCache()?.name,
    "zone_gamma",
    "THE COST of this ordering: the zone stays cached, so a real suspension waits out the TTL"
  );

  // HALF TWO — the not-ok path, same ambiguity, opposite winner.
  process.env.BRIGHTDATA_SERP_ZONE = "quota_zone";
  let notOkCalls = 0;
  mockFetch(t, async (url) => {
    if (String(url).includes("get_all_zones")) {
      return { ok: true, status: 200, json: async () => [] };
    }
    notOkCalls++;
    return {
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: "zone temporarily disabled: rate limit exceeded" }),
    };
  });

  await assert.rejects(
    () => brightDataSearch("best vitrified tiles", { attempts: 2, backoffMs: 1, timeout: 500 }),
    (err) => {
      assert.ok(isBrightDataZoneError(err), "on the not-ok path the zone read wins — the documented asymmetry");
      assert.equal(err.reason, "zone_rejected");
      return true;
    }
  );
  assert.equal(
    notOkCalls,
    1,
    "THE COST of this ordering: an HTTP 429 typed as a zone fault is not retried, though 429 is retryable"
  );
});
