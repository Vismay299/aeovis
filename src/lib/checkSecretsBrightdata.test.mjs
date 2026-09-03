import test from "node:test";
import assert from "node:assert/strict";
import { VENDORS } from "../../scripts/check-secrets.mjs";

/**
 * R0.1.10 — coverage for the Bright Data zone check.
 *
 * `checkSecrets.test.mjs` runs the real script as a subprocess with a scrubbed
 * environment of PATH and HOME only. `BRIGHTDATA_API_KEY` is therefore absent,
 * the vendor short-circuits to UNCONFIGURED, and `check()` never executes — so
 * the zone logic had ZERO automated coverage. The verifier proved it: sabotaging
 * the check to fall back to the first active zone restored finding C4 in full —
 * a typo'd zone reported "is an active serp zone" and exit 0, a falsehood stated
 * in the operator's face — and the whole suite stayed green.
 *
 * These drive the real vendor entry with a mocked fetch, so the branches that
 * matter are observable. Two of them are unreachable against the live account
 * and can only ever be tested this way.
 */

const vendor = VENDORS.find((v) => v.name === "brightdata");

const ENV = ["BRIGHTDATA_API_KEY", "BRIGHTDATA_SERP_ZONE"];

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

/** Serve `zones` from get_all_zones; count the calls. */
function mockZones(t, zones) {
  const original = globalThis.fetch;
  const calls = { count: 0 };
  globalThis.fetch = async (url) => {
    calls.count++;
    if (String(url).includes("get_all_zones")) {
      return { ok: true, status: 200, json: async () => zones, text: async () => JSON.stringify(zones) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/**
 * Serve a DIFFERENT get_all_zones body per call, and count the calls.
 *
 * The two halves of this check make two separate HTTP calls: the vendor entry's
 * own listing, and the resolver's lookup inside brightdata.js. Nothing makes a
 * live account return the same order twice, so the mock does not either — that
 * divergence is the whole point of the unset-path test below.
 */
function mockZoneSequence(t, bodies) {
  const original = globalThis.fetch;
  const calls = { count: 0 };
  globalThis.fetch = async (url) => {
    const body = bodies[Math.min(calls.count, bodies.length - 1)];
    calls.count++;
    if (String(url).includes("get_all_zones")) {
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const ACTIVE = { name: "serp_live", type: "serp", status: "active" };

test("the vendor entry exists and is required", () => {
  assert.ok(vendor, "the brightdata vendor must be in VENDORS");
  assert.equal(vendor.required, true);
  assert.deepEqual(vendor.keys, ["BRIGHTDATA_API_KEY"]);
});

test("a configured zone that does not exist on the account FAILS", async (t) => {
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "typo_zone" });
  mockZones(t, [ACTIVE]);

  const { verdict, detail } = await vendor.check();

  // This is C4 itself. Before R0.1.10 this input reported PASS.
  assert.equal(verdict, "FAIL");
  assert.match(detail, /typo_zone/, "the failure must name the zone the operator set");
  assert.match(detail, /does not exist on this account/);
  assert.match(detail, /serp_live/, "and list what does exist, so the fix is obvious");
});

test("a configured zone that exists but is NOT an active serp zone FAILS", async (t) => {
  // Unreachable against the live account, which has one healthy zone. Only a
  // mocked account can put the check in this state at all.
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "serp_suspended" });
  mockZones(t, [ACTIVE, { name: "serp_suspended", type: "serp", status: "suspended" }]);

  const { verdict, detail } = await vendor.check();

  assert.equal(verdict, "FAIL");
  assert.match(detail, /status=suspended/, "the real status must be named, not just 'not active'");
  assert.match(detail, /not an active serp zone/);
});

test("a configured zone of the wrong TYPE fails on type, not silently on name", async (t) => {
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "my_unblocker" });
  mockZones(t, [ACTIVE, { name: "my_unblocker", type: "unblocker", status: "active" }]);

  const { verdict, detail } = await vendor.check();

  assert.equal(verdict, "FAIL");
  assert.match(detail, /type=unblocker/);
});

test("a correct configured zone PASSES and names it", async (t) => {
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "serp_live" });
  mockZones(t, [ACTIVE]);

  const { verdict, detail } = await vendor.check();

  assert.equal(verdict, "PASS");
  assert.match(detail, /configured zone "serp_live"/);
});

test("the verdict names the configured zone, never the first in the list", async (t) => {
  // Honest about what this proves. When BRIGHTDATA_SERP_ZONE is set, the
  // resolver short-circuits and returns it, so "ask the resolver" and "read the
  // env var locally" are genuinely EQUIVALENT here — no behavioural test can
  // separate them. An earlier version of this test claimed to, and was wrong.
  //
  // What it does prove is that the verdict describes the operator's zone rather
  // than whatever happens to sort first, which is the observable half.
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "second_zone" });
  mockZones(t, [
    { name: "first_zone", type: "serp", status: "active" },
    { name: "second_zone", type: "serp", status: "active" },
  ]);

  const { verdict, detail } = await vendor.check();

  assert.equal(verdict, "PASS");
  assert.match(detail, /second_zone/);
  assert.ok(!/first_zone/.test(detail), "naming a zone the probes will not use is the lie this check exists to stop");
});

test("UNSET zone — the reported name comes from the RESOLVER'S OWN lookup, not this file's", async (t) => {
  // THE ONLY UNSET-PATH TEST IN THIS FILE, deliberately. The resolver's zone
  // cache is module-level, so the first auto-discovery in this process wins for
  // as long as the cache lives. A second unset test here would either poison this
  // one or be poisoned by it. The resolver-throws case therefore lives in its own
  // file (checkSecretsBrightdataNoZone.test.mjs), which gets a cold cache because
  // node --test runs each file in its own process.
  //
  // R1.2.7 gave that cache a TTL (default 5 minutes) and an invalidator, so it is
  // no longer "for the life of the process" — but a test file finishes in well
  // under one TTL, so the isolation this test depends on is unchanged.
  //
  // This is the branch the live deployment actually runs: .env.local sets no
  // BRIGHTDATA_SERP_ZONE, so probes auto-discover. It is also the ONLY branch on
  // which "ask the resolver" and "pick the zone here" are distinguishable — with
  // the variable set the resolver short-circuits before fetching and the two are
  // genuinely equivalent. So the wiring the accept demands is pinned HERE, in
  // behaviour, and the structural test below is only a supplement.
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key" });

  const A = { name: "zone_A", type: "serp", status: "active" };
  const B = { name: "zone_B", type: "serp", status: "active" };
  // Call 1 is this vendor entry's listing; call 2 is the resolver's. Same two
  // zones, opposite order — exactly what a live account is free to do.
  const calls = mockZoneSequence(t, [[A, B], [B, A]]);

  const { verdict, detail } = await vendor.check();

  assert.equal(verdict, "PASS");
  assert.equal(
    calls.count,
    2,
    "the resolver must make its OWN zone lookup — one call means the zone was picked inline from this file's listing"
  );
  assert.match(detail, /AUTO-DISCOVERED "zone_B"/, "the name reported must be the one the resolver returned");
  assert.ok(
    !/zone_A/.test(detail),
    "zone_A is what this file's own listing sorts first; naming it is C4 restored — the check would tell the operator one zone while every probe uses another"
  );
});

test("STRUCTURAL — the check imports the client's resolver rather than mirroring it", async () => {
  // A SUPPLEMENT, NOT THE GUARD. This catches the import being deleted outright.
  // It does NOT catch the realistic drift, which is calling the resolver and then
  // ignoring what it returns —
  //
  //     await resolveBrightDataSerpZone(env("BRIGHTDATA_API_KEY"));
  //     zone = configured || serp[0]?.name;
  //
  // — because both strings asserted below survive that edit untouched. That form
  // restores C4 in full, and it is the UNSET-PATH TEST ABOVE that fails on it
  // (the detail names zone_A). An earlier version of this file claimed this
  // regex carried the wiring on its own; it was checked and it does not.
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const src = await readFile(path.join(repo, "scripts/check-secrets.mjs"), "utf8");

  assert.match(
    src,
    /import \{ resolveBrightDataSerpZone \} from "\.\.\/src\/lib\/engines\/brightdata\.js"/,
    "the zone must come from the client's own resolver"
  );
  assert.match(src, /await resolveBrightDataSerpZone\(/, "and it must actually be called");
});
