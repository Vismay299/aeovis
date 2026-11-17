import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("../customerRoutes.test.hooks.mjs", import.meta.url));

const ROUTE = await import(
  new URL("../../app/api/customer/email/unsubscribe/route.ts", import.meta.url).href
);
const { generateUnsubscribeSignature } = await import(new URL("./links.ts", import.meta.url).href);
const MW = await import(new URL("../../middleware.js", import.meta.url).href);
const { NextRequest } = await import("next/server");

const SECRET = "test-secret-that-is-far-longer-than-32-chars";
const LIST_ID = "list_product_updates";
const APP_URL = "https://app.perceev.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const USER_EMAIL = "member@example.test";

function baseConfig(over = {}) {
  return {
    apiKey: "loops-key",
    productUpdatesListId: LIST_ID,
    templateIds: { scan_finished: null, schedule_skipped: null, spend_cap_reached: null },
    linkSecret: SECRET,
    appUrl: APP_URL,
    ...over,
  };
}

function createStore(initial = {}, userEmail = USER_EMAIL) {
  const rows = new Map(Object.entries(initial));
  const events = [];
  const admin = {
    auth: {
      admin: {
        async getUserById(id) {
          if (userEmail === null) return { data: { user: null }, error: new Error("gone") };
          return { data: { user: { id, email: userEmail } }, error: null };
        },
      },
    },
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

function fakeLoops({ status = 200, body = { success: true } } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      body: init?.body ? JSON.parse(init.body) : null,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch };
}

function deps(over = {}) {
  const store = over.store ?? createStore();
  const loops = over.loops ?? fakeLoops();
  return {
    getSupabaseAdmin: () => store.admin,
    config: over.config ?? baseConfig(),
    loops: { fetch: loops.fetch },
    store,
    loopsRecorder: loops,
  };
}

function tokenFor(userId = USER_ID, category = "scan_results") {
  return generateUnsubscribeSignature(SECRET, userId, category);
}

const formReq = (fields) =>
  new Request("https://app.perceev.test/api/customer/email/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

const jsonReq = (fields) =>
  new Request("https://app.perceev.test/api/customer/email/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
  });

test("valid form post → 303 with done=1 and the category false", async () => {
  const d = deps({
    store: createStore({
      [USER_ID]: {
        user_id: USER_ID,
        product_updates: false,
        product_updates_changed_at: null,
        product_updates_source: "settings",
        scan_results: true,
        schedule_alerts: true,
        spend_alerts: true,
      },
    }),
  });
  const t = tokenFor();
  const res = await ROUTE.POST(formReq({ u: USER_ID, c: "scan_results", t }), {}, d);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(
    res.headers.get("location"),
    `${APP_URL}/email/unsubscribe?u=${USER_ID}&c=scan_results&t=${t}&done=1`,
  );
  const row = d.store.rows.get(USER_ID);
  assert.equal(row.scan_results, false);
  assert.equal(row.schedule_alerts, true);
  assert.equal(row.spend_alerts, true);
  assert.equal(row.product_updates, false);
  assert.equal(row.product_updates_source, "settings");
  assert.equal(d.loopsRecorder.calls.length, 0);
});

test("JSON post → 200 { unsubscribed: true }", async () => {
  const d = deps();
  const res = await ROUTE.POST(jsonReq({ u: USER_ID, c: "schedule_alerts", t: tokenFor(USER_ID, "schedule_alerts") }), {}, d);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), {
    unsubscribed: true,
    category: "schedule_alerts",
    loopsSynced: true,
  });
  assert.equal(d.store.rows.get(USER_ID).schedule_alerts, false);
});

test("tampered token → 401 invalid_link and no write", async () => {
  const d = deps();
  const good = tokenFor();
  const bad = (good[0] === "a" ? "b" : "a") + good.slice(1);
  const res = await ROUTE.POST(formReq({ u: USER_ID, c: "scan_results", t: bad }), {}, d);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.code, "invalid_link");
  assert.equal(body.error, "This link is not valid. Sign in to change your email settings.");
  assert.equal(d.store.events.length, 0);
  assert.equal(d.store.rows.has(USER_ID), false);
});

test("short token → 400 invalid_request, not 401", async () => {
  const d = deps();
  const res = await ROUTE.POST(formReq({ u: USER_ID, c: "scan_results", t: "short" }), {}, d);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_request");
  assert.equal(d.store.events.length, 0);
});

test("cross-site Origin → 403 at the middleware, before any provider call", async () => {
  const d = deps();
  const t = tokenFor();
  const req = new NextRequest("https://app.perceev.test/api/customer/email/unsubscribe", {
    method: "POST",
    headers: {
      origin: "https://evil.test",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ u: USER_ID, c: "scan_results", t }).toString(),
  });
  const res = MW.middleware(req);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Cross-site customer requests are not allowed." });
  assert.equal(d.store.events.length, 0);
  assert.equal(d.loopsRecorder.calls.length, 0);
});

test("same-origin POST passes the middleware gate", async () => {
  const req = new NextRequest("https://app.perceev.test/api/customer/email/unsubscribe", {
    method: "POST",
    headers: { origin: "https://app.perceev.test" },
  });
  const res = MW.middleware(req);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-middleware-next"), "1");
});

test("product_updates removes the Loops list entry and saves locally", async () => {
  const d = deps({
    store: createStore({
      [USER_ID]: {
        user_id: USER_ID,
        product_updates: true,
        product_updates_changed_at: "2026-10-01T00:00:00.000Z",
        product_updates_source: "settings",
        scan_results: true,
        schedule_alerts: true,
        spend_alerts: true,
      },
    }),
  });
  const res = await ROUTE.POST(
    jsonReq({ u: USER_ID, c: "product_updates", t: tokenFor(USER_ID, "product_updates") }),
    {},
    d,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    unsubscribed: true,
    category: "product_updates",
    loopsSynced: true,
  });
  assert.equal(d.loopsRecorder.calls.length, 1);
  const call = d.loopsRecorder.calls[0];
  assert.equal(call.url, "https://app.loops.so/api/v1/contacts/update");
  assert.equal(call.body.mailingLists[LIST_ID], false);
  assert.ok(!("subscribed" in call.body));
  assert.equal(d.store.rows.get(USER_ID).product_updates, false);
  assert.equal(d.store.rows.get(USER_ID).product_updates_source, "unsubscribe_link");
});

test("a Loops failure still saves locally with loopsSynced false", async () => {
  const d = deps({ loops: fakeLoops({ status: 500, body: { success: false } }) });
  const res = await ROUTE.POST(
    jsonReq({ u: USER_ID, c: "product_updates", t: tokenFor(USER_ID, "product_updates") }),
    {},
    d,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    unsubscribed: true,
    category: "product_updates",
    loopsSynced: false,
  });
  assert.equal(d.store.rows.get(USER_ID).product_updates, false);
});

test("repeat is a no-op", async () => {
  const d = deps();
  const fields = { u: USER_ID, c: "spend_alerts", t: tokenFor(USER_ID, "spend_alerts") };
  const first = await ROUTE.POST(formReq(fields), {}, d);
  const second = await ROUTE.POST(formReq(fields), {}, d);
  assert.equal(first.status, 303);
  assert.equal(second.status, 303);
  assert.equal(d.store.rows.get(USER_ID).spend_alerts, false);
});

test("unsubscribe works with the flag off (no flag gate on this route)", async () => {
  const d = deps();
  const res = await ROUTE.POST(formReq({ u: USER_ID, c: "scan_results", t: tokenFor() }), {}, d);
  assert.equal(res.status, 303);
  assert.equal(d.store.rows.get(USER_ID).scan_results, false);
});
