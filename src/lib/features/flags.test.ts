import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { featureEnvName, isFeatureEnabled } from "./flags.ts";
import { FEATURES } from "./names.ts";
import type { FeatureName } from "./names.ts";

// No shipped flag links a spend feature yet (jobs_tick spends nothing, and every
// later flag arrives with its own spec), so the linked-spend rule is exercised
// through a runtime-only entry that never exists in the product registry.
const SPEND_LINKED = "fixture_spend_linked" as FeatureName;
(FEATURES as unknown as Record<string, { spend: readonly string[] }>)[SPEND_LINKED] = {
  spend: ["platform.selftest"],
};

type ControlRow = { feature: string; enabled: boolean; mode: string; brand_allowlist: string[] | null };

function fakeAdmin(
  rows: ControlRow[] | null,
  opts: { error?: boolean; throws?: boolean } = {}
): { client: SupabaseClient; calls: { selects: number } } {
  const calls = { selects: 0 };
  const client = {
    from() {
      return {
        select() {
          calls.selects += 1;
          return {
            in: async () => {
              if (opts.throws) throw new Error("network down");
              return { data: rows, error: opts.error ? { message: "permission denied" } : null };
            },
          };
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const SELFTEST_ROW: ControlRow = {
  feature: "platform.selftest",
  enabled: true,
  mode: "all",
  brand_allowlist: [],
};

// The 30 s cache is keyed by (name, brandKey) and lives for the whole file, so
// every case below asks about a brand no other case has asked about.
let brandSeq = 0;
const freshBrand = (): string => `flag-brand-${(brandSeq += 1)}.example`;

test("featureEnvName maps a flag name to its FEATURE_ env var", () => {
  assert.equal(featureEnvName("jobs_tick"), "FEATURE_JOBS_TICK");
});

test("isFeatureEnabled is false in production for a flag whose env var is unset", async () => {
  assert.equal(await isFeatureEnabled("jobs_tick", freshBrand(), { env: { NODE_ENV: "production" }, admin: null }), false);
  assert.equal(await isFeatureEnabled("jobs_tick", freshBrand(), { env: {}, admin: null }), false);
});

test("isFeatureEnabled treats a declared platform production as production even when NODE_ENV disagrees", async () => {
  assert.equal(
    await isFeatureEnabled("jobs_tick", freshBrand(), {
      env: { NODE_ENV: "development", VERCEL_ENV: "production" },
      admin: null,
    }),
    false
  );
});

test("isFeatureEnabled is on by default outside production", async () => {
  assert.equal(await isFeatureEnabled("jobs_tick", freshBrand(), { env: { NODE_ENV: "development" }, admin: null }), true);
  assert.equal(await isFeatureEnabled("jobs_tick", freshBrand(), { env: { NODE_ENV: "test" }, admin: null }), true);
});

test("isFeatureEnabled honours on, off and any other value", async () => {
  const production = (value: string) => ({ env: { NODE_ENV: "production", FEATURE_JOBS_TICK: value }, admin: null });
  assert.equal(await isFeatureEnabled("jobs_tick", freshBrand(), production("on")), true);
  assert.equal(await isFeatureEnabled("jobs_tick", freshBrand(), production(" ON ")), true);
  assert.equal(await isFeatureEnabled("jobs_tick", freshBrand(), production("off")), false);
  assert.equal(await isFeatureEnabled("jobs_tick", freshBrand(), production("OFF")), false);
  assert.equal(await isFeatureEnabled("jobs_tick", freshBrand(), production("sometimes")), false);
  assert.equal(
    await isFeatureEnabled("jobs_tick", freshBrand(), { env: { NODE_ENV: "development", FEATURE_JOBS_TICK: "sometimes" }, admin: null }),
    true
  );
});

test("isFeatureEnabled allowlist mode needs the brand listed in FEATURE_<NAME>_BRANDS", async () => {
  const allowlist = (brands: string) => ({
    env: { NODE_ENV: "production", FEATURE_JOBS_TICK: "allowlist", FEATURE_JOBS_TICK_BRANDS: brands },
    admin: null,
  });
  assert.equal(await isFeatureEnabled("jobs_tick", "brand-a.example", allowlist("brand-a.example, brand-b.example")), true);
  assert.equal(await isFeatureEnabled("jobs_tick", "brand-c.example", allowlist("brand-a.example, brand-b.example")), false);
  assert.equal(await isFeatureEnabled("jobs_tick", freshBrand(), allowlist("")), false);
  assert.equal(await isFeatureEnabled("jobs_tick", undefined, allowlist("flag-brand-1.example")), false);
});

test("isFeatureEnabled fails closed when a linked paid feature is missing, disabled or does not admit the brand", async () => {
  const env = { NODE_ENV: "development" as const };

  assert.equal(await isFeatureEnabled(SPEND_LINKED, "brand-no-client", { env, admin: null }), false);

  const missing = fakeAdmin([]);
  assert.equal(await isFeatureEnabled(SPEND_LINKED, "brand-missing", { env, admin: missing.client }), false);

  const disabled = fakeAdmin([{ ...SELFTEST_ROW, enabled: false }]);
  assert.equal(await isFeatureEnabled(SPEND_LINKED, "brand-disabled", { env, admin: disabled.client }), false);

  const allowlisted = fakeAdmin([{ ...SELFTEST_ROW, mode: "allowlist", brand_allowlist: ["other.example"] }]);
  assert.equal(await isFeatureEnabled(SPEND_LINKED, "brand-not-listed", { env, admin: allowlisted.client }), false);
});

test("isFeatureEnabled is true when every linked paid feature is enabled and admits the brand", async () => {
  const env = { NODE_ENV: "development" as const };
  const all = fakeAdmin([SELFTEST_ROW]);
  assert.equal(await isFeatureEnabled(SPEND_LINKED, "brand-all", { env, admin: all.client }), true);

  const allowlisted = fakeAdmin([{ ...SELFTEST_ROW, mode: "allowlist", brand_allowlist: ["brand-listed.example"] }]);
  assert.equal(await isFeatureEnabled(SPEND_LINKED, "brand-listed.example", { env, admin: allowlisted.client }), true);
});

test("isFeatureEnabled fails closed on a paid-control read error", async () => {
  const env = { NODE_ENV: "development" as const };
  const errored = fakeAdmin(null, { error: true });
  assert.equal(await isFeatureEnabled(SPEND_LINKED, "brand-read-error", { env, admin: errored.client }), false);

  const thrown = fakeAdmin(null, { throws: true });
  assert.equal(await isFeatureEnabled(SPEND_LINKED, "brand-read-throw", { env, admin: thrown.client }), false);
});

test("isFeatureEnabled is still off in production when the linked paid feature is enabled", async () => {
  const admin = fakeAdmin([SELFTEST_ROW]);
  assert.equal(
    await isFeatureEnabled(SPEND_LINKED, "brand-prod-off", { env: { NODE_ENV: "production" }, admin: admin.client }),
    false
  );
  assert.equal(admin.calls.selects, 0, "an env-off flag must not read the controls table");
});

test("isFeatureEnabled caches a result for 30 s per (name, brandKey)", async () => {
  let nowMs = 1_000_000;
  const admin = fakeAdmin([SELFTEST_ROW]);
  const deps = { env: { NODE_ENV: "development" as const }, admin: admin.client, now: () => nowMs };

  assert.equal(await isFeatureEnabled(SPEND_LINKED, "brand-cache", deps), true);
  assert.equal(admin.calls.selects, 1);

  nowMs += 29_000;
  assert.equal(await isFeatureEnabled(SPEND_LINKED, "brand-cache", deps), true);
  assert.equal(admin.calls.selects, 1, "a read inside 30 s is served from the cache");

  assert.equal(await isFeatureEnabled(SPEND_LINKED, "brand-cache-other", deps), true);
  assert.equal(admin.calls.selects, 2, "the cache is keyed by brand");

  nowMs += 1_001;
  assert.equal(await isFeatureEnabled(SPEND_LINKED, "brand-cache", deps), true);
  assert.equal(admin.calls.selects, 3, "the entry expires after 30 s");
});
