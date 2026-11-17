import test from "node:test";
import assert from "node:assert/strict";

const ROUTE = await import(new URL("../../app/api/customer/privacy/route.ts", import.meta.url).href);

const USER = { id: "user-1", email: "owner@example.test" };

function baseDeps(over = {}) {
  return {
    createClient: () => ({
      auth: {
        async getUser() {
          return { data: { user: USER }, error: null };
        },
      },
    }),
    getSupabaseAdmin: () => ({}),
    isFeatureEnabled: async () => true,
    serverTelemetryEnabled: () => true,
    readPrivacyChoice: async () => null,
    savePrivacyChoice: async (_a, _u, analytics, source) => ({
      analytics,
      decidedAt: "2026-10-22T10:00:00.000Z",
      source,
      policyVersion: "2026-10-22",
    }),
    ...over,
  };
}

async function read(res) {
  return { status: res.status, cacheControl: res.headers.get("cache-control"), body: await res.json() };
}

test("GET undecided returns analytics null", async () => {
  const { status, cacheControl, body } = await read(await ROUTE.GET(new Request("https://app.test/api/customer/privacy"), {}, baseDeps()));
  assert.equal(status, 200);
  assert.equal(cacheControl, "no-store");
  assert.equal(body.analytics, null);
  assert.equal(body.decidedAt, null);
  assert.equal(body.source, null);
  assert.equal(body.policyVersion, "2026-10-22");
  assert.equal(body.telemetryAvailable, true);
});

test("PUT true upserts and returns choice", async () => {
  const saves = [];
  const deps = baseDeps({
    savePrivacyChoice: async (_a, userId, analytics, source) => {
      saves.push({ userId, analytics, source });
      return {
        analytics,
        decidedAt: "2026-10-22T10:00:00.000Z",
        source,
        policyVersion: "2026-10-22",
      };
    },
  });
  const { status, body } = await read(
    await ROUTE.PUT(
      new Request("https://app.test/api/customer/privacy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ analytics: true, source: "banner" }),
      }),
      {},
      deps,
    ),
  );
  assert.equal(status, 200);
  assert.equal(body.analytics, true);
  assert.equal(body.source, "banner");
  assert.equal(body.policyVersion, "2026-10-22");
  assert.equal(saves[0].userId, USER.id);
});

test("PUT repeat is idempotent", async () => {
  let n = 0;
  const deps = baseDeps({
    savePrivacyChoice: async (_a, _u, analytics, source) => {
      n += 1;
      return { analytics, decidedAt: "2026-10-22T10:00:00.000Z", source, policyVersion: "2026-10-22" };
    },
  });
  for (let i = 0; i < 2; i += 1) {
    const { status } = await read(
      await ROUTE.PUT(
        new Request("https://app.test/api/customer/privacy", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ analytics: true, source: "settings" }),
        }),
        {},
        deps,
      ),
    );
    assert.equal(status, 200);
  }
  assert.equal(n, 2);
});

test("PUT unknown field → 400", async () => {
  const { status, body } = await read(
    await ROUTE.PUT(
      new Request("https://app.test/api/customer/privacy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ analytics: true, source: "banner", surprise: 1 }),
      }),
      {},
      baseDeps(),
    ),
  );
  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
});

test("no session → 401", async () => {
  const deps = baseDeps({
    createClient: () => ({
      auth: {
        async getUser() {
          return { data: { user: null }, error: null };
        },
      },
    }),
  });
  const { status, body } = await read(await ROUTE.GET(new Request("https://app.test/api/customer/privacy"), {}, deps));
  assert.equal(status, 401);
  assert.equal(body.code, "unauthenticated");
});

test("DB error → 503 privacy_unavailable", async () => {
  const deps = baseDeps({
    savePrivacyChoice: async () => {
      throw new Error("db down");
    },
  });
  const { status, body } = await read(
    await ROUTE.PUT(
      new Request("https://app.test/api/customer/privacy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ analytics: false, source: "settings" }),
      }),
      {},
      deps,
    ),
  );
  assert.equal(status, 503);
  assert.equal(body.code, "privacy_unavailable");
  assert.match(body.error, /couldn't be saved/i);
});
