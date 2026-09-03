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

test("STRUCTURAL — the check imports the client's resolver rather than mirroring it", async () => {
  // The accept says "on the same code path brightdata.js uses". That is a
  // property of the WIRING, not of any single response, and the configured case
  // above cannot observe it. So it is asserted directly: a future edit that goes
  // back to re-picking the zone inline — which is precisely how C4 arose, twice —
  // fails here even though every behavioural test above would still pass.
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
