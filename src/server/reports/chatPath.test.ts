// The "Open the chat that wrote this" link goes through getSession, so an archived
// chat (which the assistant page refuses to open) never gets a link.

import test from "node:test";
import assert from "node:assert/strict";
import { createFakeAdmin } from "../../../tests/fixtures/f22/fakeAdmin.ts";
import { reportChatPath } from "./chatPath.ts";

const BRAND = "brand-a";
const USER = "user-1";

function session(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    brand_key: BRAND,
    user_id: USER,
    title: "Chat",
    summary: null,
    compacted_through_seq: null,
    kickoff: null,
    archived_at: null,
    created_at: "2026-11-17T09:00:00.000Z",
    updated_at: "2026-11-17T09:00:00.000Z",
    ...over,
  };
}

function adminWith(...rows: Array<Record<string, unknown>>) {
  return createFakeAdmin({ assistant_sessions: rows }) as never;
}

test("a live chat of the caller gets its link", async () => {
  const admin = adminWith(session("s-live"));
  assert.equal(
    await reportChatPath(admin, { brandKey: BRAND, userId: USER, sessionId: "s-live" }),
    "/portal/assistant?s=s-live",
  );
});

test("an archived chat gets no link", async () => {
  const admin = adminWith(session("s-archived", { archived_at: "2026-11-17T10:00:00.000Z" }));
  assert.equal(await reportChatPath(admin, { brandKey: BRAND, userId: USER, sessionId: "s-archived" }), null);
});

test("someone else's chat, another workspace's chat and a pruned chat get no link", async () => {
  const admin = adminWith(session("s-theirs", { user_id: "user-2" }), session("s-other-brand", { brand_key: "brand-b" }));
  assert.equal(await reportChatPath(admin, { brandKey: BRAND, userId: USER, sessionId: "s-theirs" }), null);
  assert.equal(await reportChatPath(admin, { brandKey: BRAND, userId: USER, sessionId: "s-other-brand" }), null);
  assert.equal(await reportChatPath(admin, { brandKey: BRAND, userId: USER, sessionId: "s-pruned" }), null);
});

test("no session id means no link and no query", async () => {
  let called = 0;
  const path = await reportChatPath(
    adminWith(),
    { brandKey: BRAND, userId: USER, sessionId: null },
    { getSession: (async () => { called += 1; return null; }) as never },
  );
  assert.equal(path, null);
  assert.equal(called, 0);
});

test("a lookup failure is no link, not a failed read", async () => {
  const path = await reportChatPath(
    adminWith(),
    { brandKey: BRAND, userId: USER, sessionId: "s-1" },
    { getSession: (async () => { throw new Error("storage down"); }) as never },
  );
  assert.equal(path, null);
});
