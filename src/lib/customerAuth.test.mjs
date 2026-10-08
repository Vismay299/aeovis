import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCustomerBrand, resolveCustomerContext } from "./supabase/customerContext.js";
import { hostFromUrl, rowBelongsToCustomerBrand } from "./customerData.js";
import { findCustomerBrandAliasConflict, normalizeCustomerBrand } from "./customerProvisioning.js";
import { planCustomerOnboarding } from "./customerOnboarding.js";
import { resolveCustomerGscProperty } from "./gsc/customerProperty.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function clientStub({ user = null, memberships = [], membershipError = null } = {}) {
  let queried = false;
  const query = {
    select() { return this; },
    eq() { return this; },
    order() {
      queried = true;
      return Promise.resolve({ data: memberships, error: membershipError });
    },
  };
  return {
    get queriedMemberships() { return queried; },
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from(name) {
      assert.equal(name, "customer_brand_memberships");
      return query;
    },
  };
}

test("customer context refuses unauthenticated sessions before looking up memberships", async () => {
  const client = clientStub();
  const context = await resolveCustomerContext(client);
  assert.equal(context.user, null);
  assert.equal(context.error, "unauthenticated");
  assert.equal(client.queriedMemberships, false);
});

test("customer context returns only the authenticated user's assigned brand memberships", async () => {
  const client = clientStub({
    user: { id: "user-1" },
    memberships: [{
      brand_key: "snitch.com",
      role: "owner",
      customer_brands: { brand_key: "snitch.com", display_name: "Snitch", website: "https://snitch.com", website_host: "snitch.com", aliases: ["snitch.com", "snitch"], is_active: true },
    }],
  });
  const context = await resolveCustomerContext(client);
  assert.equal(context.user.id, "user-1");
  assert.deepEqual(context.brands.map((brand) => [brand.brandKey, brand.display_name]), [["snitch.com", "Snitch"]]);
  assert.equal(findCustomerBrand(context.brands, "snitch.com").role, "owner");
  assert.equal(findCustomerBrand(context.brands, "offcult.in"), null);
});

test("legacy scan rows are matched only to the assigned brand or its site host", () => {
  const brand = { brandKey: "snitch.com", display_name: "Snitch", website_host: "snitch.com", aliases: ["snitch"] };
  assert.equal(hostFromUrl("https://www.snitch.com/products/jeans"), "snitch.com");
  assert.equal(rowBelongsToCustomerBrand({ brand: "Snitch", url: "https://snitch.com" }, brand), true);
  assert.equal(rowBelongsToCustomerBrand({ brand: "other", url: "https://www.snitch.com/blog" }, brand), true);
  assert.equal(rowBelongsToCustomerBrand({ brand: "Offcult", url: "https://offcult.in" }, brand), false);
});

test("operator provisioning generates opaque UUID keys for new workspaces", () => {
  const valid = normalizeCustomerBrand({
    brandName: "Snitch",
    website: "https://www.snitch.com/collections/denim",
  });
  assert.ok(valid.value.brand_key, "brand_key should be set");
  // New workspaces use UUID keys, not domain-based keys.
  assert.match(valid.value.brand_key, /^[0-9a-f-]{36}$/, "brand_key should be a UUID");
  assert.equal(valid.value.website_host, "snitch.com");
  assert.match(normalizeCustomerBrand({ brandName: "Snitch", website: "http://snitch.com" }).error, /HTTPS/);
});

test("operator provisioning preserves explicit brand keys when provided", () => {
  const valid = normalizeCustomerBrand({
    brandKey: "snitch.com",
    brandName: "Snitch",
    website: "https://snitch.com",
  });
  assert.equal(valid.value.brand_key, "snitch.com");
});

test("customer legacy aliases have one tenant owner", async () => {
  const rows = [{ alias: "snitch", brand_key: "snitch.com" }];
  const admin = {
    from(table) {
      assert.equal(table, "customer_brand_aliases");
      const query = {
        select() { return this; },
        in(_column, aliases) { return Promise.resolve({ data: rows.filter((row) => aliases.includes(row.alias)), error: null }); },
      };
      return query;
    },
  };
  const candidate = { brand_key: "other.com", aliases: ["other.com", "snitch"] };
  const result = await findCustomerBrandAliasConflict(admin, candidate);
  assert.equal(result.conflict.brand_key, "snitch.com");
  assert.equal(result.error, null);
});

test("customer GSC connect selects only a property the service account can access", () => {
  const resolved = resolveCustomerGscProperty("https://www.snitch.com/blog", [
    { siteUrl: "sc-domain:snitch.com", permissionLevel: "siteOwner" },
    { siteUrl: "https://other.com/", permissionLevel: "siteOwner" },
    { siteUrl: "https://unverified.com/", permissionLevel: "siteUnverifiedUser" },
  ]);
  assert.equal(resolved.siteUrl, "sc-domain:snitch.com");
  const denied = resolveCustomerGscProperty("https://snitch.com", [{ siteUrl: "https://other.com/", permissionLevel: "siteOwner" }]);
  assert.equal(denied.siteUrl, null);
});

test("self-service onboarding no longer requires GSC or email domain match", () => {
  const plan = planCustomerOnboarding({
    brandName: "Kalika Tiles",
    website: "https://kalikatiles.com/about",
  });
  assert.ok(plan.value.brand.brand_key, "should have a brand_key");
  assert.equal(plan.value.brand.website_host, "kalikatiles.com");
  // GSC is no longer part of onboarding planning.
  assert.equal(plan.value.siteUrl, undefined);
});

test("self-service onboarding cannot claim an existing customer's brand", () => {
  const plan = planCustomerOnboarding({
    brandName: "Snitch",
    website: "https://snitch.com",
    existingBrand: { brand_key: "snitch.com" },
  });
  assert.equal(plan.reason, "brand_exists");
  assert.match(plan.error, /already has a workspace/);
});

test("self-service onboarding validates input", () => {
  const invalid = planCustomerOnboarding({
    brandName: "",
    website: "https://example.com",
  });
  assert.equal(invalid.reason, "invalid_input");

  const noHttps = planCustomerOnboarding({
    brandName: "Test",
    website: "http://example.com",
  });
  assert.equal(noHttps.reason, "invalid_input");
});

test("migration removes anonymous table access and scopes customer reads to memberships", async () => {
  const sql = await readFile(path.join(REPO, "supabase/migrations/023_customer_auth_and_tenant_rls.sql"), "utf8");
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS customer_brand_aliases/);
  assert.match(sql, /alias text PRIMARY KEY/);
  assert.match(sql, /GRANT SELECT ON[\s\S]*TO authenticated/);
  assert.match(sql, /CREATE POLICY customer_brand_memberships_read_self[\s\S]*user_id = \(SELECT auth\.uid\(\)\)/);
  assert.match(sql, /customer_can_access_brand\(brand\)/);
  assert.match(sql, /customer_can_access_scan\(brand, url\)/);
  assert.doesNotMatch(sql, /CREATE POLICY[^;]+\bTO anon\b/i);
});