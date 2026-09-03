import test from "node:test";
import assert from "node:assert/strict";
import { VENDORS } from "../../scripts/check-secrets.mjs";

/**
 * R0.1.10 — the resolver-throws branch of the Bright Data check, alone in its
 * own file because it needs a COLD ZONE CACHE.
 *
 * `resolveBrightDataSerpZone` throws when an account has no active serp zone,
 * and check() catches that into a FAIL naming the reason. That branch was
 * previously asserted in a close note ("so that branch gets stronger") and
 * never run, which standing rule 11 does not accept.
 *
 * It cannot live in checkSecretsBrightdata.test.mjs. `cachedZoneName` at
 * src/lib/engines/brightdata.js:4 is module-level and has no invalidator, so
 * once that file's unset-path test auto-discovers a zone the resolver returns
 * it forever and never reaches the throw. `node --test` runs each file in its
 * own process, so a separate file is the only reliable way to get a cold cache
 * — this must stay the ONLY unset-path test in THIS file too.
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

test("UNSET zone on an account with NO active serp zone FAILS, naming why", async (t) => {
  // Unreachable against the live account, which has one healthy serp zone.
  // A suspended serp zone and an active zone of the wrong type: auto-discovery
  // has nothing to find, so the resolver throws.
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key" });
  const calls = mockZones(t, [
    { name: "serp_dead", type: "serp", status: "suspended" },
    { name: "my_unblocker", type: "unblocker", status: "active" },
  ]);

  const { verdict, detail } = await vendor.check();

  // A skip is not a success and neither is a shrug: there is no zone, so every
  // AIO probe on this deployment would fail, and the check must say FAIL.
  assert.equal(verdict, "FAIL");
  assert.match(
    detail,
    /No active Bright Data SERP zone found on this account\./,
    "the resolver's own reason must reach the operator, not be flattened into a generic failure"
  );
  assert.match(detail, /Every AIO probe will fail\./);
  assert.equal(calls.count, 2, "the vendor entry lists zones, and the resolver then makes its own lookup");
});
