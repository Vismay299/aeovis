import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("../customerRoutes.test.hooks.mjs", import.meta.url));

const ROUTE = await import(
  new URL("../../app/api/customer/email/preferences/route.ts", import.meta.url).href
);

const USER = { id: "user-1", email: "owner@example.test" };
const LIST_ID = "list_product_updates";
const APP_URL = "https://app.perceev.test";

function baseConfig(over = {}) {
  return {
    apiKey: "loops-key",
    productUpdatesListId: LIST_ID,
    templateIds: { scan_finished: null, schedule_skipped: null, spend_cap_reached: null },
    linkSecret: null,
    appUrl: APP_URL,
    ...over,
  };
}

function createStore(initial = {}) {
  const rows = new Map(Object.entries(initial));
  const events = [];
  const admin = {
    from: (table) => {
      assert.equal(table, "user_email_preferences");
      const builder = {
        _col: null,
        _val: null,
        _upsert: null,
        select() {
          return builder;
        },
        eq(col, val) {
          builder._col = col;
          builder._val = val;
          return builder;
        },
        async maybeSingle() {
          const row = [...rows.values()].find((r) => r[builder._col] === builder._val) ?? null;
          return { data: row, error: null };
        },
        upsert(row) {
          builder._upsert = row;
          return builder;
        },
        async single() {
          events.push({ kind: "write", row: { ...builder._upsert } });
          const next = { ...builder._upsert };
          rows.set(next.user_id, next);
          return { data: next, error: null };
        },
      };
      return builder;
    },
  };
  return { admin, rows, events };
}

function failingStore() {
  const admin = {
    from: () => {
      const builder = {
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        upsert() {
          return builder;
        },
        async maybeSingle() {
          return { data: null, error: new Error("db down") };
        },
        async single() {
          return { data: null, error: new Error("db down") };
        },
      };
      return builder;
    },
  };
  return { admin };
}

function fakeLoops({ status = 200, body = { success: true } } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body ? JSON.parse(init.body) : null,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch };
}

function baseDeps(over = {}) {
  const store = over.store ?? createStore();
  const loops = over.loops ?? fakeLoops();
  return {
    createClient: over.createClient ?? (() => ({
      auth: {
        async getUser() {
          return { data: { user: { ...USER } }, error: null };
        },
      },
    })),
    getSupabaseAdmin: () => store.admin,
    isFeatureEnabled: async () => (over.flagOn === false ? false : true),
    config: over.config ?? baseConfig(),
    loops: { fetch: loops.fetch },
    store,
    loopsRecorder: loops,
  };
}

async function read(res) {
  return {
    status: res.status,
    cacheControl: res.headers.get("cache-control"),
    body: await res.json(),
  };
}

const getReq = (query = "") =>
  new Request(`https://app.perceev.test/api/customer/email/preferences${query}`, {
    method: "GET",
  });

const putReq = (body) =>
  new Request("https://app.perceev.test/api/customer/email/preferences", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("GET defaults without a row", async () => {
  const deps = baseDeps();
  const { status, cacheControl, body } = await read(await ROUTE.GET(getReq(), {}, deps));
  assert.equal(status, 200);
  assert.equal(cacheControl, "no-store");
  assert.deepEqual(body, {
    productUpdates: false,
    scanResults: true,
    scheduleAlerts: true,
    spendAlerts: true,
    productUpdatesChangedAt: null,
    loopsConfigured: true,
  });
});

test("GET unknown query field → 400", async () => {
  const deps = baseDeps();
  const { status, body } = await read(await ROUTE.GET(getReq("?surprise=1"), {}, deps));
  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
});

test("PUT scanResults false is saved without a Loops call", async () => {
  const deps = baseDeps();
  const { status, body } = await read(
    await ROUTE.PUT(putReq({ scanResults: false }), {}, deps),
  );
  assert.equal(status, 200);
  assert.equal(body.scanResults, false);
  assert.equal(body.scheduleAlerts, true);
  assert.equal(body.loopsSynced, true);
  assert.equal(deps.loopsRecorder.calls.length, 0);
  assert.equal(deps.store.events.length, 1);
  assert.equal(deps.store.rows.get(USER.id).scan_results, false);
});

test("PUT productUpdates true calls Loops first with list on + subscribed, then saves", async () => {
  const deps = baseDeps();
  const order = [];
  const origPush = deps.store.events.push.bind(deps.store.events);
  deps.store.events.push = (e) => {
    order.push("write");
    return origPush(e);
  };
  const origFetch = deps.loopsRecorder.fetch;
  deps.loopsRecorder.fetch = async (...args) => {
    order.push("loops");
    return origFetch(...args);
  };
  deps.loops = { fetch: deps.loopsRecorder.fetch };
  const { status, body } = await read(
    await ROUTE.PUT(putReq({ productUpdates: true, source: "onboarding" }), {}, deps),
  );
  assert.equal(status, 200);
  assert.equal(body.productUpdates, true);
  assert.equal(body.loopsSynced, true);
  assert.deepEqual(order, ["loops", "write"]);
  assert.equal(deps.loopsRecorder.calls.length, 1);
  const call = deps.loopsRecorder.calls[0];
  assert.equal(call.url, "https://app.loops.so/api/v1/contacts/update");
  assert.equal(call.method, "PUT");
  assert.equal(call.body.mailingLists[LIST_ID], true);
  assert.equal(call.body.subscribed, true);
  assert.equal(call.body.email, USER.email);
  assert.equal(call.body.userId, USER.id);
  assert.equal(deps.store.rows.get(USER.id).product_updates, true);
  assert.equal(deps.store.rows.get(USER.id).product_updates_source, "onboarding");
});

test("PUT productUpdates off calls Loops with list off only", async () => {
  const store = createStore({
    [USER.id]: {
      user_id: USER.id,
      product_updates: true,
      product_updates_changed_at: "2026-10-01T00:00:00.000Z",
      product_updates_source: "settings",
      scan_results: true,
      schedule_alerts: true,
      spend_alerts: true,
    },
  });
  const deps = baseDeps({ store });
  const { status, body } = await read(
    await ROUTE.PUT(putReq({ productUpdates: false }), {}, deps),
  );
  assert.equal(status, 200);
  assert.equal(body.productUpdates, false);
  assert.equal(deps.loopsRecorder.calls.length, 1);
  assert.equal(deps.loopsRecorder.calls[0].body.mailingLists[LIST_ID], false);
  assert.ok(!("subscribed" in deps.loopsRecorder.calls[0].body));
});

test("Loops 500 → 502 and DB unchanged", async () => {
  const store = createStore();
  const deps = baseDeps({ store, loops: fakeLoops({ status: 500, body: { success: false } }) });
  const { status, body } = await read(
    await ROUTE.PUT(putReq({ productUpdates: true }), {}, deps),
  );
  assert.equal(status, 502);
  assert.equal(body.code, "email_provider_unavailable");
  assert.equal(store.events.length, 0);
  assert.equal(store.rows.has(USER.id), false);
});

test("Loops unconfigured → saved with loopsSynced false and no Loops call", async () => {
  const deps = baseDeps({ config: baseConfig({ apiKey: null, productUpdatesListId: null }) });
  const { status, body } = await read(
    await ROUTE.PUT(putReq({ productUpdates: true }), {}, deps),
  );
  assert.equal(status, 200);
  assert.equal(body.productUpdates, true);
  assert.equal(body.loopsConfigured, false);
  assert.equal(body.loopsSynced, false);
  assert.equal(deps.loopsRecorder.calls.length, 0);
  assert.equal(deps.store.rows.get(USER.id).product_updates, true);
});

test("{} and source-only → 400", async () => {
  const deps = baseDeps();
  for (const payload of [{}, { source: "settings" }]) {
    const { status, body } = await read(await ROUTE.PUT(putReq(payload), {}, deps));
    assert.equal(status, 400);
    assert.equal(body.code, "invalid_request");
  }
  assert.equal(deps.store.events.length, 0);
});

test("unknown field → 400", async () => {
  const deps = baseDeps();
  const { status, body } = await read(
    await ROUTE.PUT(putReq({ scanResults: false, surprise: 1 }), {}, deps),
  );
  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
  assert.equal(deps.store.events.length, 0);
});

test("no session → 401 with the real requireUser message", async () => {
  const deps = baseDeps({
    createClient: () => ({
      auth: {
        async getUser() {
          return { data: { user: null }, error: null };
        },
      },
    }),
  });
  const { status, body } = await read(await ROUTE.GET(getReq(), {}, deps));
  assert.equal(status, 401);
  assert.equal(body.code, "unauthenticated");
  assert.equal(body.error, "Sign in to continue.");
});

test("flag off → 404 feature_unavailable", async () => {
  const deps = baseDeps({ flagOn: false });
  const { status, body } = await read(
    await ROUTE.PUT(putReq({ scanResults: false }), {}, deps),
  );
  assert.equal(status, 404);
  assert.equal(body.code, "feature_unavailable");
  assert.equal(body.error, "This page is not available yet.");
  assert.equal(deps.store.events.length, 0);
});

test("DB error → 503 preferences_unavailable", async () => {
  const store = failingStore();
  const deps = { ...baseDeps(), getSupabaseAdmin: () => store.admin };
  const { status, body } = await read(await ROUTE.GET(getReq(), {}, deps));
  assert.equal(status, 503);
  assert.equal(body.code, "preferences_unavailable");
});
