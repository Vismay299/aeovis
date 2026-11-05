/**
 * F04 §6.5 — `GET /api/customer/features`, driven through the real route
 * handler and the real `readClientFeatures`.
 *
 * Only the authenticated request context and the flag evaluator are
 * substituted (the route's `deps`); the strict query, the workspace lookup,
 * the on/off map and the error mapping are the shipped code.
 *
 * The two names the cases evaluate are real registered feature names
 * (`product_analytics`, `price_review`) rather than placeholders: the flag
 * list is typed, so an invented name could not be injected without
 * weakening the type the module ships.
 */
import test from "node:test";
import assert from "node:assert/strict";

const ROUTE = await import(new URL("../../app/api/customer/features/route.ts", import.meta.url).href);
const { CLIENT_FEATURES } = await import(new URL("./clientFeatures.ts", import.meta.url).href);

const BRAND_A = "workspace-a";
const BRAND_B = "workspace-b";
const USER = { id: "user-a", email: "owner@example.test" };

function brand(brandKey, role = "owner") {
  return {
    brandKey,
    role,
    display_name: "Workspace",
    website: `https://${brandKey}.example`,
    website_host: `${brandKey}.example`,
    aliases: [],
    is_active: true,
  };
}

/** The route's dependencies. Only the session, the transport and the flags are substituted. */
function deps(over = {}) {
  return {
    getCustomerContext: async () => ({
      client: null,
      user: USER,
      brands: [brand(BRAND_A)],
      error: null,
    }),
    getSupabaseAdmin: () => ({ stub: "admin" }),
    ...over,
  };
}

function request(query, url = "http://localhost/api/customer/features") {
  return new Request(`${url}?${query}`);
}

test("a member reads the flags of their own workspace", async () => {
  const response = await ROUTE.GET(
    request(`brand_key=${BRAND_A}`),
    undefined,
    deps({
      clientFeatureDeps: {
        names: ["product_analytics", "price_review"],
        isEnabled: async (name) => name === "product_analytics",
      },
    })
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body, {
    brandKey: BRAND_A,
    features: { product_analytics: true, price_review: false },
  });
});

test("a flag whose evaluation rejects counts as off, and the rest still answer", async () => {
  const response = await ROUTE.GET(
    request(`brand_key=${BRAND_A}`),
    undefined,
    deps({
      clientFeatureDeps: {
        names: ["product_analytics", "price_review"],
        isEnabled: async (name) => {
          if (name === "price_review") throw new Error("the flag store is unreachable");
          return true;
        },
      },
    })
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.features, { product_analytics: true, price_review: false });
});

test("the flags are evaluated for the caller's own workspace", async () => {
  const seen = [];
  await ROUTE.GET(
    request(`brand_key=${BRAND_A}`),
    undefined,
    deps({
      clientFeatureDeps: {
        names: ["product_analytics"],
        isEnabled: async (name, brandKey) => {
          seen.push({ name, brandKey });
          return true;
        },
      },
    })
  );

  assert.deepEqual(seen, [{ name: "product_analytics", brandKey: BRAND_A }]);
});

test("no session answers 401 unauthenticated", async () => {
  const response = await ROUTE.GET(
    request(`brand_key=${BRAND_A}`),
    undefined,
    deps({
      getCustomerContext: async () => ({
        client: null,
        user: null,
        brands: [],
        error: null,
      }),
    })
  );

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.code, "unauthenticated");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("a workspace the caller is not a member of answers 404 workspace_not_found", async () => {
  const response = await ROUTE.GET(request(`brand_key=${BRAND_B}`), undefined, deps());

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.code, "workspace_not_found");
});

test("an unknown query field answers 400 invalid_request", async () => {
  const response = await ROUTE.GET(request(`brand_key=${BRAND_A}&x=1`), undefined, deps());

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "invalid_request");
});

test("a missing brand_key answers 400 invalid_request", async () => {
  const response = await ROUTE.GET(request(`x=1`), undefined, deps());

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "invalid_request");
});

test("the module's own list names every flag the browser may read", () => {
  assert.ok(Array.isArray(CLIENT_FEATURES), "CLIENT_FEATURES is a list");
  assert.ok(CLIENT_FEATURES.length > 0, "the browser reads at least one flag");
  for (const name of CLIENT_FEATURES) {
    assert.equal(typeof name, "string");
  }
});

test("the route answers with the module's own list, evaluated for the caller's workspace", async () => {
  const admin = { stub: "admin" };
  const seen = [];

  // The key is asked for in a different FORM from the canonical one, so the
  // assertions below prove the route uses the VERIFIED workspace key rather
  // than the string the caller sent.
  const response = await ROUTE.GET(
    request(`brand_key=${BRAND_A.toUpperCase()}`),
    undefined,
    deps({
      getSupabaseAdmin: () => admin,
      isFeatureEnabled: async (name, brandKey, flagDeps) => {
        seen.push({ name, brandKey, admin: flagDeps?.admin });
        return true;
      },
    })
  );

  assert.equal(response.status, 200);
  const body = await response.json();

  // No list was injected, so this is the SHIPPED list.
  assert.deepEqual(Object.keys(body.features).sort(), [...CLIENT_FEATURES].sort());
  assert.equal(body.brandKey, BRAND_A);

  // Every flag was evaluated for the verified workspace, with that
  // workspace's own admin client — never for the raw query string.
  assert.deepEqual(seen.map((entry) => entry.name).sort(), [...CLIENT_FEATURES].sort());
  for (const entry of seen) {
    assert.equal(entry.brandKey, BRAND_A);
    assert.equal(entry.admin, admin);
  }
});
