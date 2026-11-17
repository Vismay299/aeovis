/**
 * F22 P4 route tests: the real Next route handlers behind a fake authenticated
 * context and an in-memory PostgREST surface. No provider is ever called: the
 * only model is `ai/test`'s MockLanguageModelV3.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { createMemoryStore } from "../../shared/spend/memoryStore.ts";
import { createFakeAdmin } from "../../../tests/fixtures/f22/fakeAdmin.ts";

register("./assistantRoute.test.hooks.mjs", import.meta.url);

process.env.LLM_API_KEY = "route-test-key";
process.env.ASSISTANT_MODEL = "anthropic/claude-sonnet-4.5";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../../../tests/fixtures/f22");
const AT = Date.parse("2026-11-17T10:00:00.000Z");

const configRoute = await import("../../app/api/customer/assistant/config/route.ts");
const sessionsRoute = await import("../../app/api/customer/assistant/sessions/route.ts");
const sessionRoute = await import("../../app/api/customer/assistant/sessions/[sessionId]/route.ts");
const chatRoute = await import("../../app/api/customer/assistant/sessions/[sessionId]/chat/route.ts");
const streamRoute = await import("../../app/api/customer/assistant/sessions/[sessionId]/stream/route.ts");
const stopRoute = await import("../../app/api/customer/assistant/sessions/[sessionId]/stop/route.ts");
const rewindRoute = await import("../../app/api/customer/assistant/sessions/[sessionId]/rewind/route.ts");

const BRAND = {
  brandKey: "acme-tees",
  role: "owner",
  display_name: "Acme Tees",
  website: "https://acme.example",
  website_host: "acme.example",
  aliases: [],
  is_active: true,
};

const USER = { id: "user-1", email: "owner@acme.example" };
const flagOn = { isFeatureEnabled: async (name) => name === "assistant" };
const flagOff = { isFeatureEnabled: async () => false };
const turnFlagsOff = async () => false;

function fixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
}

function mockModel(steps) {
  return new MockLanguageModelV3({
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4.5",
    doStream: steps.map((step) => ({
      stream: simulateReadableStream({ chunks: step.chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }),
    })),
  });
}

function sessionRow(overrides = {}) {
  return {
    id: "s1",
    brand_key: "acme-tees",
    user_id: "user-1",
    title: "New chat",
    summary: null,
    compacted_through_seq: null,
    kickoff: null,
    archived_at: null,
    created_at: "2026-11-17T09:00:00.000Z",
    updated_at: "2026-11-17T09:00:00.000Z",
    ...overrides,
  };
}

function install(admin, user = USER) {
  globalThis.customerRouteFixture = {
    context: { user, brands: [BRAND], error: null, client: null },
    admin,
  };
}

function reset() {
  globalThis.customerRouteFixture = {
    context: { user: USER, brands: [BRAND], error: null, client: null },
    admin: null,
  };
}

function request(url, init = {}) {
  return new Request("https://aeovis.test" + url, init);
}

function ctx(params) {
  return { params };
}

function adminWith(extra = {}) {
  const admin = createFakeAdmin({ assistant_sessions: [sessionRow()], ...extra });
  admin.setNow(() => AT);
  return admin;
}

async function settle(store) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const holds = [...store.holds.values()];
    if (holds.length > 0 && holds.every((hold) => hold.status !== "held")) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function chatBody(overrides = {}) {
  return {
    brand_key: "acme-tees",
    message: {
      id: "u_1",
      role: "user",
      parts: [{ type: "text", text: "How did our last scan go?" }],
      metadata: { kind: "chat", source: "composer" },
      ...overrides,
    },
  };
}

test("assistant routes: the flag off is 404 feature_unavailable with no-store JSON", async () => {
  const admin = adminWith();
  install(admin);
  const res = await configRoute.GET(request("/api/customer/assistant/config?brand_key=acme-tees"), null, flagOff);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.code, "feature_unavailable");
  assert.equal(body.error, "This page is not available for your workspace yet.");

  const sessionsRes = await sessionsRoute.GET(request("/api/customer/assistant/sessions?brand_key=acme-tees"), null, flagOff);
  assert.equal(sessionsRes.status, 404);
  assert.equal((await sessionsRes.json()).code, "feature_unavailable");
});

test("assistant config: 200 with configured, the turn cap, skills and the four suggestions", async () => {
  const admin = adminWith();
  install(admin);
  const res = await configRoute.GET(request("/api/customer/assistant/config?brand_key=acme-tees"), null, flagOn);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, true);
  assert.equal(body.turnMaxUsd, 0.5);
  assert.equal(body.approvalTtlSeconds, 900);
  assert.deepEqual(body.suggestions, [
    "Where do AI answers name competitors but not us?",
    "Which questions should we add to our panel?",
    "Can AI crawlers read our website?",
    "What should we write next to get cited?",
  ]);
  assert.ok(Array.isArray(body.skills));
});

test("assistant sessions: list is the caller's own and a create returns 201 New chat", async () => {
  const admin = adminWith({
    assistant_sessions: [
      sessionRow({ id: "mine", title: "Mine" }),
      sessionRow({ id: "theirs", user_id: "user-2", title: "Theirs" }),
      sessionRow({ id: "archived", archived_at: "2026-11-18T00:00:00.000Z" }),
    ],
  });
  install(admin);
  const list = await sessionsRoute.GET(request("/api/customer/assistant/sessions?brand_key=acme-tees"), null, flagOn);
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.deepEqual(body.sessions.map((row) => row.id), ["mine"]);

  const created = await sessionsRoute.POST(
    request("/api/customer/assistant/sessions", {
      method: "POST",
      body: JSON.stringify({ brand_key: "acme-tees" }),
      headers: { "content-type": "application/json" },
    }),
    null,
    flagOn,
  );
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.title, "New chat");
  assert.ok(createdBody.id);
});

test("assistant session: detail returns messages and activeTurn; another user's session is 404", async () => {
  const admin = adminWith({
    assistant_messages: [
      {
        session_id: "s1",
        id: "u_1",
        brand_key: "acme-tees",
        seq: 1,
        role: "user",
        parts: [{ type: "text", text: "Which competitors do AI answers name?" }],
        metadata: { kind: "chat", source: "composer" },
        turn_id: null,
        created_at: "2026-11-17T09:00:00.000Z",
      },
    ],
  });
  install(admin);
  const res = await sessionRoute.GET(
    request("/api/customer/assistant/sessions/s1?brand_key=acme-tees"),
    ctx({ sessionId: "s1" }),
    flagOn,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.session.id, "s1");
  assert.equal(body.session.hasKickoff, false);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].parts[0].text, "Which competitors do AI answers name?");
  assert.equal(body.activeTurn, null);

  install(admin, { id: "user-2", email: "other@acme.example" });
  const foreign = await sessionRoute.GET(
    request("/api/customer/assistant/sessions/s1?brand_key=acme-tees"),
    ctx({ sessionId: "s1" }),
    flagOn,
  );
  assert.equal(foreign.status, 404);
  assert.equal((await foreign.json()).code, "session_not_found");
});

test("assistant session: PATCH renames and archives", async () => {
  const admin = adminWith();
  install(admin);
  const renamed = await sessionRoute.PATCH(
    request("/api/customer/assistant/sessions/s1", {
      method: "PATCH",
      body: JSON.stringify({ brand_key: "acme-tees", title: "Q4 plan" }),
      headers: { "content-type": "application/json" },
    }),
    ctx({ sessionId: "s1" }),
    flagOn,
  );
  assert.equal(renamed.status, 200);
  assert.deepEqual(await renamed.json(), { id: "s1", title: "Q4 plan", archived: false });

  const archived = await sessionRoute.PATCH(
    request("/api/customer/assistant/sessions/s1", {
      method: "PATCH",
      body: JSON.stringify({ brand_key: "acme-tees", archived: true }),
      headers: { "content-type": "application/json" },
    }),
    ctx({ sessionId: "s1" }),
    flagOn,
  );
  assert.equal(archived.status, 200);
  assert.equal((await archived.json()).archived, true);
});

test("assistant chat: a fixture turn streams SSE with the v1 header", async () => {
  const admin = adminWith();
  install(admin);
  const store = createMemoryStore({
    now: () => AT,
    controls: {
      "assistant.turn": { enabled: true, mode: "all", brandAllowlist: [], dailyCapUsd: null, maxCallUsd: null },
    },
  });
  const res = await chatRoute.POST(
    request("/api/customer/assistant/sessions/s1/chat", {
      method: "POST",
      body: JSON.stringify(chatBody()),
      headers: { "content-type": "application/json" },
    }),
    ctx({ sessionId: "s1" }),
    {
      ...flagOn,
      turnDeps: {
        model: mockModel(fixture("stream-text-no-cost.json").steps),
        spend: { store },
        env: process.env,
        now: () => AT,
        keepAlive: () => Promise.resolve(),
        heartbeatMs: 60_000,
        cancelPollMs: 60_000,
        availableTools: async () => [],
        isFeatureEnabled: turnFlagsOff,
      },
    },
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type")?.includes("text/event-stream"), true);
  assert.equal(res.headers.get("x-vercel-ai-ui-message-stream"), "v1");
  const body = await res.text();
  assert.ok(body.includes("The cost of this reply was not reported for Acme Tees."));
  await settle(store);
});

test("assistant chat: a duplicate message id is 409 before a turn starts", async () => {
  const admin = adminWith({
    assistant_messages: [
      {
        session_id: "s1",
        id: "u_1",
        brand_key: "acme-tees",
        seq: 1,
        role: "user",
        parts: [{ type: "text", text: "already sent" }],
        metadata: { kind: "chat" },
        turn_id: null,
        created_at: "2026-11-17T09:00:00.000Z",
      },
    ],
  });
  install(admin);
  const model = mockModel(fixture("stream-text-steps.json").steps);
  const res = await chatRoute.POST(
    request("/api/customer/assistant/sessions/s1/chat", {
      method: "POST",
      body: JSON.stringify(chatBody()),
      headers: { "content-type": "application/json" },
    }),
    ctx({ sessionId: "s1" }),
    {
      ...flagOn,
      turnDeps: {
        model,
        env: process.env,
        now: () => AT,
        keepAlive: () => Promise.resolve(),
        availableTools: async () => [],
        isFeatureEnabled: turnFlagsOff,
      },
    },
  );
  assert.equal(res.status, 409);
  assert.equal(res.headers.get("content-type")?.includes("application/json"), true);
  assert.equal((await res.json()).code, "duplicate_message");
  assert.equal(model.doStreamCalls.length, 0);
  assert.equal(admin.rows("assistant_turns").length, 0);
});

test("assistant chat: a spend refusal is JSON, before any stream or provider call", async () => {
  const admin = adminWith();
  install(admin);
  const store = createMemoryStore({ now: () => AT, controls: {} });
  const model = mockModel(fixture("stream-text-steps.json").steps);
  const res = await chatRoute.POST(
    request("/api/customer/assistant/sessions/s1/chat", {
      method: "POST",
      body: JSON.stringify(chatBody()),
      headers: { "content-type": "application/json" },
    }),
    ctx({ sessionId: "s1" }),
    {
      ...flagOn,
      turnDeps: {
        model,
        spend: { store },
        env: process.env,
        now: () => AT,
        keepAlive: () => Promise.resolve(),
        availableTools: async () => [],
        isFeatureEnabled: turnFlagsOff,
      },
    },
  );
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("content-type")?.includes("application/json"), true);
  assert.equal(res.headers.get("x-vercel-ai-ui-message-stream"), null);
  assert.equal((await res.json()).code, "feature_disabled");
  assert.equal(model.doStreamCalls.length, 0);
  assert.equal(admin.rows("assistant_stream_chunks").length, 0);
});

test("assistant chat: the 31st turn in the hour is 429", async () => {
  const admin = adminWith({
    assistant_turns: Array.from({ length: 30 }, (_, index) => ({
      id: "t" + index,
      session_id: "s0",
      brand_key: "acme-tees",
      user_id: "user-1",
      status: "completed",
      started_at: `2026-11-17T09:${String(index).padStart(2, "0")}:00.000Z`,
      heartbeat_at: "2026-11-17T09:59:00.000Z",
      finished_at: "2026-11-17T09:59:30.000Z",
    })),
  });
  install(admin);
  const res = await chatRoute.POST(
    request("/api/customer/assistant/sessions/s1/chat", {
      method: "POST",
      body: JSON.stringify(chatBody()),
      headers: { "content-type": "application/json" },
    }),
    ctx({ sessionId: "s1" }),
    {
      ...flagOn,
      turnDeps: {
        model: mockModel(fixture("stream-text-steps.json").steps),
        env: process.env,
        now: () => AT,
        keepAlive: () => Promise.resolve(),
        availableTools: async () => [],
        isFeatureEnabled: turnFlagsOff,
      },
    },
  );
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, "assistant_rate_limited");
});

test("assistant stream: no active streaming turn is 204", async () => {
  const admin = adminWith({
    assistant_turns: [
      {
        id: "t-done",
        session_id: "s1",
        brand_key: "acme-tees",
        user_id: "user-1",
        status: "completed",
        stop_reason: "finished",
        started_at: "2026-11-17T09:00:00.000Z",
        heartbeat_at: "2026-11-17T09:00:10.000Z",
        finished_at: "2026-11-17T09:00:10.000Z",
      },
    ],
    assistant_stream_chunks: [
      { turn_id: "t-done", seq: 0, brand_key: "acme-tees", data: "data: {}\n\n" },
    ],
  });
  install(admin);
  const res = await streamRoute.GET(
    request("/api/customer/assistant/sessions/s1/stream?brand_key=acme-tees"),
    ctx({ sessionId: "s1" }),
    flagOn,
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("assistant stop: sets cancel_requested_at, and returns stopped false when idle", async () => {
  const admin = adminWith({
    assistant_turns: [
      {
        id: "t-live",
        session_id: "s1",
        brand_key: "acme-tees",
        user_id: "user-1",
        status: "streaming",
        stop_reason: null,
        started_at: "2026-11-17T09:00:00.000Z",
        heartbeat_at: "2026-11-17T09:59:00.000Z",
        finished_at: null,
      },
    ],
  });
  install(admin);
  const res = await stopRoute.POST(
    request("/api/customer/assistant/sessions/s1/stop", {
      method: "POST",
      body: JSON.stringify({ brand_key: "acme-tees" }),
      headers: { "content-type": "application/json" },
    }),
    ctx({ sessionId: "s1" }),
    flagOn,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { stopped: true });
  assert.ok(admin.rows("assistant_turns")[0].cancel_requested_at);
  admin.rows("assistant_turns")[0].status = "stopped";

  const idle = await stopRoute.POST(
    request("/api/customer/assistant/sessions/s1/stop", {
      method: "POST",
      body: JSON.stringify({ brand_key: "acme-tees" }),
      headers: { "content-type": "application/json" },
    }),
    ctx({ sessionId: "s1" }),
    flagOn,
  );
  assert.deepEqual(await idle.json(), { stopped: false });
});

test("assistant rewind: cancels first, then deletes, then returns the remaining messages", async () => {
  const admin = adminWith({
    assistant_messages: [
      { session_id: "s1", id: "u_1", brand_key: "acme-tees", seq: 1, role: "user", parts: [{ type: "text", text: "one" }], metadata: {}, turn_id: null, created_at: "2026-11-17T09:00:00.000Z" },
      { session_id: "s1", id: "a_1", brand_key: "acme-tees", seq: 2, role: "assistant", parts: [{ type: "text", text: "two" }], metadata: {}, turn_id: null, created_at: "2026-11-17T09:00:10.000Z" },
      { session_id: "s1", id: "u_2", brand_key: "acme-tees", seq: 3, role: "user", parts: [{ type: "text", text: "three" }], metadata: {}, turn_id: null, created_at: "2026-11-17T09:00:20.000Z" },
    ],
  });
  install(admin);
  const res = await rewindRoute.POST(
    request("/api/customer/assistant/sessions/s1/rewind", {
      method: "POST",
      body: JSON.stringify({ brand_key: "acme-tees", messageId: "a_1" }),
      headers: { "content-type": "application/json" },
    }),
    ctx({ sessionId: "s1" }),
    flagOn,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.removed, 2);
  assert.deepEqual(body.messages.map((message) => message.id), ["u_1"]);
  const opNames = admin.ops.map((op) => op.rpc ?? op.table + ":" + op.action);
  const cancelAt = opNames.indexOf("assistant_turns:update");
  const rewindAt = opNames.indexOf("rewind_assistant_session");
  const readAt = opNames.lastIndexOf("assistant_messages:select");
  assert.ok(cancelAt >= 0, "the streaming turn is cancelled first");
  assert.ok(cancelAt < rewindAt, "the delete happens only after the cancel");
  assert.ok(rewindAt < readAt, "the remaining messages are read after the delete");
});

test("assistant rewind: an unknown message is 404 message_not_found", async () => {
  const admin = adminWith({
    assistant_messages: [
      { session_id: "s1", id: "u_1", brand_key: "acme-tees", seq: 1, role: "user", parts: [{ type: "text", text: "one" }], metadata: {}, turn_id: null, created_at: "2026-11-17T09:00:00.000Z" },
    ],
  });
  install(admin);
  const res = await rewindRoute.POST(
    request("/api/customer/assistant/sessions/s1/rewind", {
      method: "POST",
      body: JSON.stringify({ brand_key: "acme-tees", messageId: "nope" }),
      headers: { "content-type": "application/json" },
    }),
    ctx({ sessionId: "s1" }),
    flagOn,
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "message_not_found");
});

test.after(() => reset());
