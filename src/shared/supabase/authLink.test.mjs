import test from "node:test";
import assert from "node:assert/strict";
import { consumeCustomerAuthFragment } from "./authLink.js";

function fakeWindow(t, hash) {
  const previous = globalThis.window;
  const changes = [];
  globalThis.window = {
    location: { hash, pathname: "/auth/accept", search: "" },
    history: { replaceState: (_state, _title, url) => { changes.push(url); } },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
  return changes;
}

test("implicit invite fragments are removed before the PKCE client receives the session", async (t) => {
  const changes = fakeWindow(t, "#access_token=TEST_AUTH_TOKEN&refresh_token=TEST_REFRESH_TOKEN");
  const client = { auth: { setSession: async (session) => {
    assert.deepEqual(changes, ["/auth/accept"]);
    assert.deepEqual(session, { access_token: "TEST_AUTH_TOKEN", refresh_token: "TEST_REFRESH_TOKEN" });
    return { error: null };
  } } };
  await consumeCustomerAuthFragment({ client });
});

test("incomplete or expired invite fragments are cleared and rejected", async (t) => {
  const changes = fakeWindow(t, "#access_token=TEST_AUTH_TOKEN");
  await assert.rejects(consumeCustomerAuthFragment(), /invalid or expired/);
  assert.deepEqual(changes, ["/auth/accept"]);
});

test("server-exchanged links use their existing cookie session", async (t) => {
  fakeWindow(t, "");
  await consumeCustomerAuthFragment({ client: { auth: { setSession() { throw new Error("Existing session must not be replaced"); } } } });
});
