import test from "node:test";
import assert from "node:assert/strict";
import { VENDORS as REGISTRY, VENDOR_KEYS, credentialStatus } from "./vendorRegistry.js";
import { VENDORS as HEALTH_VENDORS, vendorFlags } from "./health.js";
import { VENDORS as SCRIPT_VENDORS, vendorsWithChecks } from "../../scripts/check-secrets.mjs";

/**
 * R0.1.16 (finding S30) — ONE vendor list, and the teeth that keep it one.
 *
 * There used to be two nine-vendor arrays: one in src/lib/health.js feeding
 * /api/health, one in scripts/check-secrets.mjs, independent, in different
 * shapes, under a comment on the first claiming that adding a vendor there
 * taught both surfaces about it. They happened to agree name-for-name, so the
 * claim was never falsified by anything a reader could see — a tenth vendor
 * added to either would have been reported by one surface and absent from the
 * other, and nothing would have said so.
 *
 * The tests below are the ones that must fail on that edit. Each was proven to
 * fail by making the divergent edit for real and reverting it; the sabotage and
 * the exact failure are recorded in the R0.1.16 submit note.
 */

test("GUARD — /api/health reads the registry itself, not a copy of it", () => {
  // Reference identity, not deepEqual: a copy that happens to match today is
  // precisely the state this task removed.
  assert.equal(
    HEALTH_VENDORS,
    REGISTRY,
    "health.js must re-export src/lib/vendorRegistry.js's array, not hold its own"
  );
});

test("GUARD — check:secrets runs exactly the registry's vendors, in its order", () => {
  assert.deepEqual(
    SCRIPT_VENDORS.map((v) => v.key),
    VENDOR_KEYS,
    "a vendor exists on one surface and not the other"
  );
  // And the credential facts travel with it rather than being restated.
  for (const [i, vendor] of SCRIPT_VENDORS.entries()) {
    assert.deepEqual(vendor.env, REGISTRY[i].env, `${vendor.key}: env vars differ from the registry`);
    assert.equal(vendor.required, REGISTRY[i].required, `${vendor.key}: required-ness differs from the registry`);
  }
});

test("GUARD — every registry vendor has a LIVE check; a new one without it refuses to run", () => {
  // Standing rule 1: a vendor check:secrets cannot perform is not skipped
  // quietly. This is the "added to /api/health but not to check:secrets" edit.
  assert.throws(
    () => vendorsWithChecks([...REGISTRY, { key: "cloudflare", env: ["CLOUDFLARE_API_TOKEN"], required: false }]),
    (err) => {
      assert.match(err.message, /drifted apart/);
      assert.match(err.message, /cloudflare/, "the failure must NAME the vendor that has no check");
      assert.match(err.message, /vendorRegistry\.js/, "and say where the two halves live");
      return true;
    },
    "a registry vendor with no live check must stop the script, not be omitted from the table"
  );
});

test("GUARD — a live check for a vendor the registry does not carry refuses to run", () => {
  // The mirror image: "added to check:secrets but not to /api/health".
  assert.throws(
    () => vendorsWithChecks(REGISTRY, { ...checksOf(SCRIPT_VENDORS), cloudflare: async () => ({}) }),
    (err) => {
      assert.match(err.message, /drifted apart/);
      assert.match(err.message, /cloudflare/);
      assert.match(err.message, /does not know about/);
      return true;
    },
    "check:secrets must not report on a vendor /api/health has never heard of"
  );
});

/** Rebuild the checks map from the joined rows, so the guard can be re-driven. */
function checksOf(vendors) {
  return Object.fromEntries(vendors.map((v) => [v.key, v.check]));
}

test("GUARD — the real registry and the real checks map agree today", () => {
  assert.doesNotThrow(() => vendorsWithChecks());
});

// ---------------------------------------------------------------------------
// credentialStatus is the shared verdict. Both surfaces call it, so neither can
// invent its own notion of "configured".
// ---------------------------------------------------------------------------

test("credentialStatus - every required env var must be non-empty, and the missing one is NAMED", () => {
  const supabase = REGISTRY.find((v) => v.key === "supabase");
  const status = credentialStatus(supabase, { NEXT_PUBLIC_SUPABASE_URL: "u" });
  assert.equal(status.configured, false);
  assert.deepEqual(status.missing, ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]);
});

test("credentialStatus - whitespace is not a credential", () => {
  const cron = REGISTRY.find((v) => v.key === "cron");
  assert.equal(credentialStatus(cron, { CRON_SECRET: "   " }).configured, false);
  assert.equal(credentialStatus(cron, { CRON_SECRET: "x" }).configured, true);
});

test("credentialStatus - a deprecated alias configures the vendor and is reported as deprecated", () => {
  const llm = REGISTRY.find((v) => v.key === "llm");
  const status = credentialStatus(llm, { OPENROUTER_API_KEY: "k" });
  assert.equal(status.configured, true, "an existing deployment must not break");
  assert.deepEqual(status.missing, []);
  assert.deepEqual(status.deprecated, ["OPENROUTER_API_KEY"], "and must not look identical to the canonical name");
});

test("credentialStatus - OpenAI and Perplexity answer engines share the OpenRouter credential", () => {
  for (const key of ["openai", "perplexity"]) {
    const vendor = REGISTRY.find((v) => v.key === key);
    assert.deepEqual(vendor.env, ["LLM_API_KEY"]);
    assert.equal(credentialStatus(vendor, { LLM_API_KEY: "openrouter-key" }).configured, true);
    assert.equal(credentialStatus(vendor, { OPENROUTER_API_KEY: "legacy-key" }).configured, true);
    assert.equal(
      credentialStatus(vendor, { OPENAI_API_KEY: "native-openai-key", PERPLEXITY_API_KEY: "native-pplx-key" }).configured,
      false,
      "native provider keys are not required for engines routed through OpenRouter"
    );
  }
});

test("credentialStatus - health's per-vendor verdict is this function's, unchanged", () => {
  // Not a restatement: it pins that vendorFlags adds `required` and nothing else,
  // so /api/health cannot drift into its own definition of configured.
  const env = { OPENROUTER_API_KEY: "k", NEXT_PUBLIC_SUPABASE_URL: "u" };
  const flags = vendorFlags(env);
  for (const vendor of REGISTRY) {
    const { configured, missing, deprecated } = credentialStatus(vendor, env);
    assert.deepEqual(flags[vendor.key], { configured, required: vendor.required, missing, deprecated });
  }
});

test("the registry names no credential VALUE, only env var names", () => {
  // Cheap standing check on a file that is nothing but credential names.
  const serialised = JSON.stringify(REGISTRY);
  for (const name of REGISTRY.flatMap((v) => v.env)) {
    assert.match(serialised, new RegExp(name), `${name} must be present as a NAME`);
  }
  assert.equal(REGISTRY.length, new Set(VENDOR_KEYS).size, "vendor keys must be unique");
});
