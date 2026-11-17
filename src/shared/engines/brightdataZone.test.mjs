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

/* ===========================================================================
 * R1.2.16 — THE CORPUS GUARD, because a loop over an empty list asserts nothing.
 *
 * FOUR tests in this file are `for (const row of CORPUS)` loops whose every
 * assertion lives inside the loop body: the three R1.2.11 corpora
 * (NOT_A_ZONE_REJECTION, IS_A_ZONE_REJECTION, TOLERATED_OVER_MATCHES) and
 * R1.2.10's ZONE_STATE_WORDINGS. Delete the rows and the body never runs, so the
 * test reports PASS having exercised nothing. The one assertion that LOOKS like a
 * count guard -- `zc.calls() === NOT_A_ZONE_REJECTION.length` -- is satisfied by
 * `0 === 0`, which is why it never caught this.
 *
 * MEASURED, not assumed. THIRTEEN mutations of the pre-fix file (HEAD 786cb4e)
 * were run one at a time and EVERY ONE left it at 18 tests / 18 pass / 0 fail:
 * emptying any one of the four corpora; cutting any one of them to a single
 * trivially-clean row; deleting one row; replacing all 55 negatives with 55
 * copies of one clean row; swapping a load-bearing row for an unrelated one;
 * blanking a row's reason; and running a loop over only its first row. The only
 * mutations CI could see were the two that plant a genuinely WRONG row -- a real
 * permanent rejection in the negatives, a transport reset in the positives -- and
 * those were 17 pass / 1 fail before this guard and still are, on the original
 * assertion rather than on the floor. All thirteen are now red, each naming the
 * corpus and the claim it broke.
 *
 * WHY A FLOOR PLUS A MEMBER LIST, and not an exact count. An exact count is a
 * chore: every row added makes an unrelated number go red, so it gets bumped
 * reflexively and stops meaning anything. But a floor alone is gameable in the
 * direction that matters -- swap rows out for junk and the count holds while
 * coverage collapses (the pad-with-duplicates mutation above). So three
 * independent claims are made, each catching a different way a corpus rots:
 *   1. FLOOR       - rows removed. Fires on empty and on shrinkage.
 *   2. UNIQUENESS  - rows replaced by copies of a survivor to hold the count.
 *   3. REQUIRED    - the specific rows whose absence would let a known-degenerate
 *      classifier pass. These are not a sample of the corpus; each one is a row
 *      that a recorded mutation actually fired on (provenance at each list).
 * Rows are also required to carry their reason, because a corpus of bare strings
 * is a list the next editor cannot judge and therefore deletes.
 *
 * IF YOU ARE REMOVING A ROW ON PURPOSE: lower the floor, and drop it from the
 * required list, in the SAME commit. That edit is meant to be visible in review;
 * a silent deletion is exactly what this exists to make noisy.
 *
 * THE NUMBERS (55 / 22 / 13 / 6) were re-derived from the array literals, not
 * copied. They are NOT the figure in R1.2.11's submit note, which says 57
 * negatives against a committed 55 -- the code was right, the note was wrong,
 * and the ledger record has been amended rather than left as the artifact.
 *
 * Called as the FIRST line of each corpus test rather than at module scope: a
 * module-scope throw aborts the file load and shows up as a crash with no test
 * name, while this way the red names the corpus that shrank.
 * ======================================================================== */
import { assertCorpusIntact } from "../../server/testCorpus.mjs";

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
  assert.equal(row.cost, null, "a failed external request has unmeasured billing");
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
  assert.equal(row.cost, null, "a refused external request has unmeasured billing");

  const summary = summarizeEngineSlice([row], "aio");
  assert.equal(summary.errored_queries, 1, "counted, never skipped");
  assert.equal(summary.error_rate_pct, 100);
});

/**
 * The wordings R1.2.10 was filed about, lifted out of the loop below by R1.2.16
 * so the corpus guard can see them. Same six strings, same order.
 *
 * REQUIRED, not a floor with slack: this corpus IS the finding's enumeration, so
 * every member is load-bearing and the floor and the member list coincide. A
 * seventh wording is welcome; losing one of these six means R1.2.10's fix is no
 * longer pinned in the direction it was filed for.
 */
const ZONE_STATE_WORDINGS = [
  ["zone_suspended", "the wording in the C4 report; \\b treats '_' as a word char, so the pre-fix pattern missed it"],
  ["zone_disabled", "same shape, second state word"],
  ["zone_expired", "same shape, third"],
  ["zone_deleted", "same shape, fourth"],
  ["suspended_zone", "state word FIRST, underscored -- the other half of the widening"],
  ["zone_not_active", "the not-active alternative, fully underscored"],
];

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
  //
  // R1.2.16: six committed wordings, all of them required. Emptying this list
  // used to leave this test green while asserting nothing about the widening it
  // exists to pin.
  assertCorpusIntact(ZONE_STATE_WORDINGS, "ZONE_STATE_WORDINGS", {
    floor: 6,
    required: ["zone_suspended", "zone_disabled", "zone_expired", "zone_deleted", "suspended_zone", "zone_not_active"],
    isTuple: true,
    rowLength: 2,
  });
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "state_zone" });

  let wording = "";
  let serpCalls = 0;
  mockFetch(t, async (url) => {
    if (String(url).includes("get_all_zones")) {
      return { ok: true, status: 200, json: async () => [] };
    }
    serpCalls++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ error: wording }) };
  });

  for (const [w, why] of ZONE_STATE_WORDINGS) {
    wording = w;
    await assert.rejects(
      () => brightDataSearch("best vitrified tiles", { attempts: 2, backoffMs: 1, timeout: 500 }),
      (err) => {
        assert.ok(
          isBrightDataZoneError(err),
          `"${w}" is a zone state Bright Data can return; it must type as a zone fault (${why}), got ${err?.name}: ${err?.message}`
        );
        assert.equal(err.reason, "zone_rejected", `"${w}" must carry the machine-readable reason`);
        assert.equal(err.zone, "state_zone");
        return true;
      },
      `"${w}" fell through to a generic error — the cache would survive a dead zone`
    );
  }

  // R1.2.16: the loop above is the only place these wordings are exercised, so
  // the count of real HTTP attempts is what proves each row reached the
  // classifier rather than being skipped. One call per wording: a typed zone
  // error is not retried, which is itself asserted at :302.
  assert.equal(
    serpCalls,
    ZONE_STATE_WORDINGS.length,
    "one probe per wording — a row that made no call would prove nothing about it"
  );
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

/* ===========================================================================
 * R1.2.11 — THE NEGATIVE SIDE OF THE ZONE-REJECTION BOUNDARY.
 *
 * WHY THIS BLOCK EXISTS. R1.2.10 widened the last two patterns in
 * `zoneRejectionDetail` (brightdata.js) so snake_case forms classify. Every
 * test it left behind asserts that something DOES classify. A classifier with
 * only positive-case tests is a guard that cannot fail: replace the whole list
 * with `[/zone/i]` and the suite above this line stays green, because nothing
 * committed says what must be REFUSED. Both the R1.2.10 implementer and its
 * verifier checked negatives by hand and neither check left an artifact, so the
 * boundary was pinned in exactly one direction.
 *
 * WHAT A WRONG CLASSIFICATION COSTS, in both directions:
 *   - FALSE NEGATIVE (a real zone fault read as generic): the cache survives, so
 *     the process keeps probing a dead zone for up to a full TTL. That is the C4
 *     finding, and it is what R1.2.10 fixed. Pinned by the positive test below.
 *   - FALSE POSITIVE (a transient failure read as a permanent zone rejection):
 *     the attempt budget is cut short -- `brightDataSearch`'s catch refuses to
 *     retry a typed zone error -- and on the auto-discovery path a healthy
 *     cached zone is dropped, costing one extra `get_all_zones`. Bounded at one
 *     lost retry per probe. Not free, and nothing but this block detects it.
 *
 * Neither direction can produce a false SUCCESS: every case below still throws,
 * is still counted as an errored probe, and never becomes a cost-0.0 skip. What
 * is at stake here is the error's TYPE and the process's next move.
 *
 * THE TRANSPORT IS CHOSEN, NOT INCIDENTAL. These tests answer the probe with
 * `ok: false`, because on the not-ok path `zoneRejectionDetail` runs FIRST --
 * before the 429/5xx retry branch (brightdata.js, the `httpZoneErr` check ahead
 * of `isRetryableHttpStatus`) -- so that is the path on which an over-wide
 * pattern has the most reach. The response text is returned VERBATIM rather than
 * wrapped in an envelope, so the string asserted here is exactly the string the
 * classifier sees; no JSON punctuation sneaks into the corpus.
 *
 * CACHE HYGIENE. All three tests pin BRIGHTDATA_SERP_ZONE, which short-circuits
 * the resolver, so they neither read nor write the module cache this file
 * shares. Each asserts that at the end rather than trusting it.
 * ======================================================================== */

/**
 * Run one body string through the REAL classifier and report which way it went.
 *
 * `attempts: 1` on purpose: a body such as "Bright Data HTTP 502: bad gateway"
 * trips the retry classifier in the catch block, and a retry would make the call
 * count depend on the corpus entry rather than on the classification. One
 * attempt makes every row cost exactly one call, which is also what lets the
 * call count be asserted at all.
 */
function makeZoneClassifier(t) {
  let body = "";
  let serpCalls = 0;
  mockFetch(t, async (url) => {
    if (String(url).includes("get_all_zones")) {
      return { ok: true, status: 200, json: async () => [] };
    }
    serpCalls++;
    return { ok: false, status: 400, text: async () => body };
  });
  return {
    calls: () => serpCalls,
    async classify(text) {
      body = text;
      try {
        await brightDataSearch("best vitrified tiles", { attempts: 1, timeout: 500 });
      } catch (err) {
        return {
          kind: isBrightDataZoneError(err) ? "zone_rejected" : "generic",
          err,
        };
      }
      throw new Error(
        `${JSON.stringify(text)} produced a RESOLVED response from an HTTP 400 -- ` +
          `the fixture is broken, and a broken fixture proves nothing in either direction`
      );
    },
  };
}

/**
 * Strings that mention a zone, or a zone state word, and are NOT a permanent
 * zone rejection. Each carries the reason it belongs here, because a corpus
 * without reasons is a list the next editor deletes.
 */
const NOT_A_ZONE_REJECTION = [
  // --- the empty and blank boundary. An error body that says nothing is not
  // evidence the zone is gone; it is evidence of nothing (standing rule 1).
  ["", "an empty error body carries no evidence about the zone"],
  ["   ", "whitespace-only is the empty case wearing a costume"],
  ["\n\t ", "so is a body of newlines"],

  // --- documented transient Bright Data failures, from docs/vendors/brightdata.md.
  ["no_ready_cookies", "proxy session-pool exhaustion; the vendor note calls it retryable"],
  ["Bright Data proxy session error: no_ready_cookies", "the same fault as this client words it"],
  ["no ready cookies for zone serp_api1", "session-pool exhaustion that happens to name the zone"],
  ["x-brd-error: no_peer_available for zone serp_api1", "no free peer right now, not a dead zone"],
  ["proxy status 502", "an upstream hiccup"],
  ["Bright Data HTTP 502: bad gateway", "a 5xx is retryable and must stay retryable"],
  ["Bright Data returned a truncated/empty AIO response", "a cut stream, retried by design"],
  ["target_blocked: google.com blocked the peer used by zone serp_api1", "the TARGET blocked a peer"],
  ["connection reset by peer (zone serp_api1)", "a transport reset"],
  ["socket hang up", "a transport reset with no zone in it at all"],
  ["request to zone serp_api1 timed out after 60000ms", "a timeout is the retry loop's business"],
  ["the request through zone serp_api1 was aborted after 60s", "an abort, likewise"],
  ["zone serp_api1 is busy, try again", "the vendor is explicitly asking for a retry"],
  ["zone serp_api1 temporarily unavailable, retry in 5s", "'temporarily' is the opposite of permanent"],
  ["all peers for zone serp_api1 are exhausted", "peer supply, not zone status"],
  ["zone serp_api1 has no available peers right now", "same, and 'right now' says so"],

  // --- throttling and money. Real problems, but not "this zone does not exist",
  // and typing them as zone rejections burns a recoverable retry (see :577).
  ["rate limit exceeded for zone serp_api1", "throttling recovers on its own; a dead zone does not"],
  ["quota exceeded on zone serp_api1", "same"],
  ["Bright Data HTTP 429: too many requests for zone serp_api1", "same, in HTTP clothes"],
  ["zone bandwidth limit reached", "a limit, not a state change"],
  ["insufficient funds on zone serp_api1", "a billing problem the operator fixes without touching the zone"],

  // --- results-shaped failures that mention a zone.
  ["zone serp_api1 returned 0 organic results", "an empty SERP is a scoring problem, not a config one"],
  ["zone serp_api1: page not found (404)", "the TARGET page is missing; 'not found' is about google.com"],
  ["search results not found for the query", "no zone in it at all"],
  ["unknown parameter brd_ai_overview", "'unknown' about a query parameter, not a zone"],
  ["invalid country code", "'invalid' about the geo, not a zone"],

  // --- state words about something that is not the zone.
  ["account suspended", "the ACCOUNT, and no zone is named"],
  ["user account is disabled", "same"],
  ["customer account deactivated", "same"],
  ["auth token expired", "the credential, not the zone"],
  ["session expired; re-authenticate", "the session, and the ';' closes the proximity window"],
  ["your subscription has expired", "the subscription"],
  ["billing expired for the account behind zone serp_api1", "the state word precedes the zone by more than a separator"],
  ["cache entry deleted for zone serp_api1", "a local cache entry"],
  ["browser session deleted before the page loaded", "a browser session"],

  // --- near-misses: one character away from a real rejection on either side.
  ["zonesuspended", "no separator at all: the state word must start a token"],
  ["suspendedzone", "the mirror case"],
  ["notactive zone", "'not active' before 'zone' is not one of the two shapes matched"],
  ["not_active zone", "same, underscored"],
  ["deleted zones", "plural: 'zone\\b' must not match inside 'zones'"],
  ["expired_zones table row", "an internal table name, plural again"],
  ["suspend_zone_request queued", "a REQUEST to suspend, not a suspension"],
  ["user_disabled_zone_map", "an identifier that happens to contain both words"],
  ["suspended zoneinfo", "'zoneinfo' is not a zone"],
  ["zoneless", "'zone' as a prefix of an unrelated word"],
  ["zone", "the bare word is not a verdict"],
  ["zones", "nor its plural"],
  ["zone_", "nor a dangling separator"],
  ["Ozone layer report unavailable", "'zone' inside 'Ozone'"],
  ["horizon deleted", "'zon' is not 'zone'"],
  ["amazon events", "nor is 'zon' followed by 'e' in another word"],
  ["The timezone was not found for this locale", "'was' is wider than the one-character separator the pattern allows"],
];

test("R1.2.11 — transient and unrelated zone-mentioning failures are NOT permanent zone rejections", async (t) => {
  // R1.2.16: 55 committed rows, re-counted from the literal above. The four
  // required rows are the ones the R1.2.11 verifier's degenerate-classifier
  // mutations actually fired on (recorded in that task's verification note):
  // prepending /zone/i fires on the no_ready_cookies row, collapsing
  // /invalid zone/ to /invalid/ fires on the country-code row, and widening the
  // not-found pattern to a proximity match fires on the 404 row. The empty body
  // is required because "no evidence" must never read as evidence (rule 1).
  assertCorpusIntact(NOT_A_ZONE_REJECTION, "NOT_A_ZONE_REJECTION", {
    floor: 55,
    required: [
      "",
      "no ready cookies for zone serp_api1",
      "invalid country code",
      "zone serp_api1: page not found (404)",
    ],
    isTuple: true,
    rowLength: 2,
  });
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "pinned_zone" });
  const cacheBefore = peekBrightDataZoneCache()?.name ?? null;
  const zc = makeZoneClassifier(t);

  for (const [text, why] of NOT_A_ZONE_REJECTION) {
    const { kind, err } = await zc.classify(text);
    assert.equal(
      kind,
      "generic",
      `${JSON.stringify(text)} was typed as a PERMANENT zone rejection -- ${why}. ` +
        `Cost: the retry is refused and, on the auto-discovery path, a healthy cached zone is dropped.`
    );
    // Not classifying must never mean not failing. A body this client could not
    // make sense of is still a failed probe with a message an operator can read.
    assert.ok(
      err instanceof Error && !isBrightDataZoneError(err),
      `${JSON.stringify(text)} must still produce a plain Error, got ${err?.name}`
    );
    assert.match(
      err.message,
      /^Bright Data HTTP 400/,
      `${JSON.stringify(text)} must still surface the transport failure verbatim, got ${JSON.stringify(err.message)}`
    );
  }

  assert.equal(
    zc.calls(),
    NOT_A_ZONE_REJECTION.length,
    "one probe per corpus entry -- a row that silently made no call would prove nothing"
  );
  assert.equal(
    peekBrightDataZoneCache()?.name ?? null,
    cacheBefore,
    "with the zone pinned this test must not touch the shared module cache"
  );
});

/**
 * The other side of the same boundary: strings that MUST classify.
 *
 * Without this, the negative corpus above could be satisfied by deleting the
 * patterns entirely. The six wordings R1.2.10 set out to fix are already pinned
 * at :538 through the 200-envelope path; what is added here is the shapes the
 * widening reaches BEYOND those six -- separator, case and whitespace variants
 * that a narrowing would quietly drop.
 */
const IS_A_ZONE_REJECTION = [
  ["zone not found: pinned_zone", "the canonical prose form"],
  ["zone_not_found", "and its machine-readable code"],
  ["zone-not-found", "hyphenated codes exist too"],
  ["ZONE NOT FOUND", "the classifier is case-insensitive and must stay so"],
  ["no such zone: pinned_zone", "second prose form"],
  ["unknown zone: pinned_zone", "third"],
  ["invalid zone: pinned_zone", "fourth"],
  ["Zone \"pinned_zone\" has been suspended", "prose state form, quoted zone name"],
  ["zone is deactivated", "prose state form"],
  ["disabled zone", "state word first"],
  ["deleted zone pinned_zone", "state word first, zone named"],
  // The R1.2.10 widening, in the forms the six named cases do not cover.
  ["Zone_Suspended", "snake_case is not always lower case"],
  ["ZONE_DISABLED", "nor always mixed"],
  ["  zone_expired  ", "the classifier trims before it decides"],
  ["zone__suspended", "a doubled separator is still a separator"],
  ["zone_suspend", "the stem matches; vendors truncate"],
  ["deleted-zone", "hyphen before 'zone' -- the [\\s_-]+ half of the widening"],
  ["suspend_zone", "underscore before 'zone' -- same half"],
  ["suspended  zone", "and plain whitespace still works"],
  ["zone-not-active", "the not[ _-]?active alternative, hyphenated"],
  ["zone not_active", "and mixed"],
  ["zone_notactive", "and run together"],
];

test("R1.2.11 — the positive side, so a NARROWING is caught here and not in production", async (t) => {
  // R1.2.16: 22 committed rows. Emptying this one would let a total narrowing of
  // the classifier pass, which is the failure this corpus exists to catch. The
  // required rows are the two halves of the R1.2.10 widening (`deleted-zone` and
  // `suspend_zone`, the rows the verifier's narrowing mutations fired on), the
  // canonical prose form, and the case-insensitivity row.
  assertCorpusIntact(IS_A_ZONE_REJECTION, "IS_A_ZONE_REJECTION", {
    floor: 22,
    required: ["zone not found: pinned_zone", "ZONE NOT FOUND", "deleted-zone", "suspend_zone"],
    isTuple: true,
    rowLength: 2,
  });
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "pinned_zone" });
  const cacheBefore = peekBrightDataZoneCache()?.name ?? null;
  const zc = makeZoneClassifier(t);

  for (const [text, why] of IS_A_ZONE_REJECTION) {
    const { kind, err } = await zc.classify(text);
    assert.equal(
      kind,
      "zone_rejected",
      `${JSON.stringify(text)} fell through to a generic error -- ${why}. ` +
        `Cost: the cache survives and the process keeps probing a dead zone for a full TTL (the C4 finding).`
    );
    assert.equal(err.reason, "zone_rejected", "machine-readable, so callers never parse the message");
    assert.equal(err.zone, "pinned_zone", "and it names the zone the operator has to fix");
  }

  // R1.2.16: the negative test asserted its call count and these two did not.
  // The count is the other half of the corpus guard: the floor proves the rows
  // are still listed, this proves every listed row reached the real classifier
  // over the mocked transport rather than short-circuiting before the call.
  assert.equal(
    zc.calls(),
    IS_A_ZONE_REJECTION.length,
    "one probe per corpus entry -- a row that silently made no call would prove nothing"
  );
  assert.equal(
    peekBrightDataZoneCache()?.name ?? null,
    cacheBefore,
    "with the zone pinned this test must not touch the shared module cache"
  );
});

/**
 * KNOWN OVER-MATCHES — recorded, not fixed.
 *
 * PROVENANCE, stated plainly: R1.2.10's verifier reported three pre-existing
 * over-matches and did not record WHICH, which is the whole reason this task
 * exists. The list below was re-derived from scratch against the shipped
 * patterns, so it is not necessarily byte-identical to theirs. It is organised
 * by MECHANISM, and there are exactly three mechanisms; every over-match found
 * is an instance of one of them.
 *
 * All three predate R1.2.10: they live in patterns that diff produced no change
 * to. Confirmed by running the pre-R1.2.10 patterns (40d203f) over the same
 * corpus -- identical verdicts on every string here.
 *
 * They are NOT fixed here because tightening them is a source decision with a
 * failure mode in the expensive direction. `zone[^.,;]{0,40}` is deliberately
 * loose so that vendor prose nobody has read yet still classifies; narrowing it
 * to buy back these strings trades a bounded cost (one lost retry) for the
 * unbounded one (a dead zone probed for a full TTL, which is the finding this
 * whole chain descends from). None of the strings below is a wording Bright Data
 * has been observed to emit. If the fleet logs ever show one, that is the
 * evidence to reopen it with -- and this block is where the next editor will
 * find out the trade was made on purpose.
 */
const TOLERATED_OVER_MATCHES = [
  // MECHANISM 1 — `zone` has no LEFT boundary, so it matches inside a longer
  // word. Cost if it ever fires: a timezone lookup failure kills one retry.
  ["timezone not found", "M1: matches inside 'timezone' via /zone[ _-]?not[ _-]?found/"],
  ["timezone_not_found", "M1: same, snake_case"],

  // MECHANISM 2 — `zone` has no RIGHT boundary in the three literal prose
  // patterns, so it matches the head of a longer word.
  ["invalid zonefile", "M2: /invalid zone/ has no trailing \\b"],
  ["unknown zonefile format", "M2: /unknown zone/, same gap"],
  ["no such zonefile", "M2: /no such zone/, same gap"],

  // MECHANISM 3 — the 40-character proximity window attributes ANY state word
  // near the token 'zone' to the zone itself. This is the widest of the three
  // and the only one that catches plausible English.
  ["your session for zone serp_api1 has expired, please retry", "M3: the SESSION expired, and the text even asks for the retry this refuses"],
  ["the zone's proxy peer connection expired", "M3: a peer connection expired"],
  ["the cached DNS entry for the zone endpoint expired", "M3: a DNS entry expired"],
  ["certificate for the zone gateway expired", "M3: a TLS certificate expired"],
  ["the cookie jar for zone serp_api1 expired", "M3: a cookie jar expired"],
  ["the temporary file for the zone response was deleted", "M3: a temp file was deleted"],
  ["zone serp_api1 quota will be deleted at end of billing cycle", "M3: a FUTURE deletion of a quota, not a current zone state"],
  // Judged correct rather than tolerated, and kept here because it reads like an
  // over-match and is not: a suspended owning account makes the zone genuinely
  // unusable, so refusing the retry and dropping the cache is the right move.
  ["the account that owns this zone was suspended", "M3 mechanically, but the classification is CORRECT: the zone really is unusable"],
];

test("R1.2.11 — the three over-match MECHANISMS, pinned as tolerated exceptions with their reason", async (t) => {
  // R1.2.16: 13 committed rows across the three mechanisms. This is the corpus
  // most likely to be trimmed -- a future editor who tightens a pattern is meant
  // to MOVE rows into NOT_A_ZONE_REJECTION, and the floor makes a quiet delete
  // look different from that move. One row per MECHANISM is required, because
  // the block above claims all three are still tolerated and each of those rows
  // is the one that goes red when its mechanism is tightened.
  assertCorpusIntact(TOLERATED_OVER_MATCHES, "TOLERATED_OVER_MATCHES", {
    floor: 13,
    required: [
      "timezone not found",
      "invalid zonefile",
      "your session for zone serp_api1 has expired, please retry",
    ],
    isTuple: true,
    rowLength: 2,
  });
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "pinned_zone" });
  const cacheBefore = peekBrightDataZoneCache()?.name ?? null;
  const zc = makeZoneClassifier(t);

  for (const [text, why] of TOLERATED_OVER_MATCHES) {
    const { kind } = await zc.classify(text);
    assert.equal(
      kind,
      "zone_rejected",
      `${JSON.stringify(text)} no longer classifies. ${why}. ` +
        `This assertion pins CURRENT behaviour, not desired behaviour: if you tightened the patterns ` +
        `on purpose, move this row into NOT_A_ZONE_REJECTION and say so in the block comment above. ` +
        `If you did not, you have narrowed the classifier by accident and a real zone fault may now ` +
        `survive as a plain Error.`
    );
  }

  // R1.2.16, as above: the floor proves the rows are listed, the count proves
  // each one was actually put through the classifier.
  assert.equal(
    zc.calls(),
    TOLERATED_OVER_MATCHES.length,
    "one probe per corpus entry -- a row that silently made no call would prove nothing"
  );
  assert.equal(
    peekBrightDataZoneCache()?.name ?? null,
    cacheBefore,
    "with the zone pinned this test must not touch the shared module cache"
  );
});
