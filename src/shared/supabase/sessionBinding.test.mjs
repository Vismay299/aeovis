import test from "node:test";
import assert from "node:assert/strict";
import { customerSessionBinding } from "./sessionBinding.js";
const context = (sessionId, extra = {}) => ({ user: { id: "user" }, client: { auth: { getSession: async () => ({ data: { session: { access_token: `header.${Buffer.from(JSON.stringify({ sub: "user", session_id: sessionId, ...extra })).toString("base64url")}.signature` } } }) } } });
test("OAuth binding survives token refresh but distinguishes separate login sessions", async () => {
  const a = await customerSessionBinding(context("session-a"));
  assert.equal(a, await customerSessionBinding(context("session-a", { iat: 999 })));
  assert.notEqual(a, await customerSessionBinding(context("session-b")));
  assert.equal(await customerSessionBinding(context(null)), null);
  assert.equal(await customerSessionBinding(context("session-a", { sub: "other-user" })), null);
});
