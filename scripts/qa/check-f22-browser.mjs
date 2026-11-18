#!/usr/bin/env node
/** F22 Phase 6: in-app assistant browser scenarios, fixtures only. */
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openPortal, SUPABASE_URL } from "./portalFixtureHarness.mjs";

let chromium;
try {
  ({ chromium } = await import("../../worker/node_modules/playwright/index.mjs"));
} catch {
  ({ chromium } = await import("playwright"));
}

const SESSION_ID = "6c8f0000-0000-4000-8000-000000000001";
const APPROVAL_LABEL = "Research keywords for “oversized t shirt”";
const PLACEHOLDER_HOST = new URL(SUPABASE_URL).hostname;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", PLACEHOLDER_HOST]);

const originArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "http://127.0.0.1:3342";
const origin = new URL(originArg);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "browser checks require a disposable local app");
const port = Number(origin.port || 3342);

async function waitForServer(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(new URL("/portal/assistant", origin), { redirect: "manual" });
      if (response.status !== 404 && response.status !== 503) return true;
    } catch { /* wait */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

let serverChild = null;
if (!(await waitForServer(1000))) {
  serverChild = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", String(port)], {
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key" },
    stdio: "ignore",
  });
  if (!(await waitForServer(120000))) {
    serverChild.kill("SIGTERM");
    throw new Error(`Next.js dev server failed to start on port ${port}`);
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_FIXTURES = path.resolve(HERE, "../../tests/fixtures/f22/api");
async function apiFixture(name) {
  return readFile(path.join(API_FIXTURES, name), "utf8");
}
const FEATURES = JSON.parse(await apiFixture("features.json"));
const CONFIG = JSON.parse(await apiFixture("config.json"));
const SESSIONS = JSON.parse(await apiFixture("sessions.json"));
const SESSION_EMPTY = JSON.parse(await apiFixture("session-empty.json"));
const SESSION_TOOLS = JSON.parse(await apiFixture("session-with-tools.json"));
const CHAT_STREAM = await apiFixture("chat-stream.txt");
const CHAT_APPROVAL = await apiFixture("chat-stream-approval.txt");
const STREAM_REPLAY = await apiFixture("stream-replay.txt");
const APPROVAL_PENDING = JSON.parse(await apiFixture("approval-pending.json"));
const APPROVAL_EXECUTED = JSON.parse(await apiFixture("approval-executed.json"));
const APPROVAL_PRICE_CHANGED = JSON.parse(await apiFixture("approval-price-changed.json"));

function futureExpiry() {
  return new Date(Date.now() + 15 * 60 * 1000).toISOString();
}
function withFutureExpiry(text) {
  return text.replaceAll("2027-05-01T00:00:00.000Z", futureExpiry());
}
function jsonBody(value) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(value) };
}
function sseBody(text) {
  return {
    status: 200,
    contentType: "text/event-stream",
    headers: { "x-vercel-ai-ui-message-stream": "v1", "cache-control": "no-store" },
    body: text,
  };
}

/** Split an SSE fixture into separately-delivered segments for true streaming. */
function segmentize(text, cuts) {
  const lines = text.split("\n");
  const dataIndex = [];
  lines.forEach((line, index) => { if (line.startsWith("data:")) dataIndex.push(index); });
  const bounds = [0, ...cuts.map((n) => n), dataIndex.length];
  const segments = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const from = dataIndex[bounds[i]] ?? lines.length;
    const toLine = bounds[i + 1] >= dataIndex.length ? lines.length : dataIndex[bounds[i + 1]];
    segments.push(`${lines.slice(from, toLine).join("\n")}\n`);
  }
  return segments;
}

/** A disposable 127.0.0.1 origin that drips SSE segments with delays. */
const ssePlans = new Map();
const sseServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const plan = ssePlans.get(req.url);
    ssePlans.delete(req.url);
    if (!plan) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no plan");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-vercel-ai-ui-message-stream": "v1",
    });
    void (async () => {
      for (const [segment, delayMs] of plan) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (res.destroyed) return;
        res.write(segment);
      }
      res.end();
    })();
  });
});
await new Promise((resolve) => sseServer.listen(0, "127.0.0.1", resolve));
const ssePort = sseServer.address().port;

function parseSse(text) {
  const frames = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    frames.push(JSON.parse(payload));
  }
  return frames;
}

/** The assistant reply the server would store for this stream, for GET-after-POST. */
function replyFromStream(text) {
  const frames = parseSse(text);
  let messageId = "a_fixture_reply";
  let turnMeta = {};
  const order = [];
  const texts = new Map();
  const tools = new Map();
  for (const frame of frames) {
    if (frame.type === "start") {
      if (typeof frame.messageId === "string") messageId = frame.messageId;
    } else if (frame.type === "text-start") {
      texts.set(frame.id, "");
      order.push({ kind: "text", id: frame.id });
    } else if (frame.type === "text-delta") {
      texts.set(frame.id, (texts.get(frame.id) ?? "") + frame.delta);
    } else if (frame.type === "tool-input-available") {
      tools.set(frame.toolCallId, { toolName: frame.toolName, input: frame.input });
      order.push({ kind: "tool", id: frame.toolCallId });
    } else if (frame.type === "tool-output-available") {
      const tool = tools.get(frame.toolCallId) ?? {};
      tool.output = frame.output;
      tools.set(frame.toolCallId, tool);
    } else if (frame.type === "finish") {
      turnMeta = frame.messageMetadata ?? {};
    }
  }
  const parts = order.map((entry) => {
    if (entry.kind === "text") return { type: "text", text: texts.get(entry.id) ?? "" };
    const tool = tools.get(entry.id) ?? {};
    return {
      type: `tool-${tool.toolName ?? "unknown"}`,
      toolCallId: entry.id,
      state: "output-available",
      input: tool.input ?? {},
      output: tool.output ?? null,
    };
  });
  return { id: messageId, role: "assistant", parts, metadata: turnMeta };
}

const browser = await chromium.launch({ headless: true });
const allRequests = [];
let failures = 0;
let passed = 0;

async function record(id, expected, run) {
  try {
    const actual = await run();
    passed += 1;
    console.log(`${id}: PASS — ${actual}`);
  } catch (error) {
    failures += 1;
    console.error(`${id}: FAIL — ${error?.stack || error}`);
  }
}

/**
 * One isolated assistant page: Supabase login + memberships from the harness,
 * every /api/customer/assistant/** response from the F22 fixtures. The chat
 * POST streams through a disposable localhost SSE relay so running states can
 * be observed mid-stream; GET-after-POST serves the same reply back, like the
 * real routes do after a turn settles.
 */
async function makePage(hooks = {}, options = {}) {
  const { context, page } = await openPortal(browser, origin, {
    viewport: options.viewport ?? { width: 1280, height: 900 },
  });
  const log = { requests: [], chat: [], decide: [], rewind: [], stop: [], stream: [], approval: [] };
  const extra = [];
  const state = { replayed: false, decided: false };

  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("http")) {
      log.requests.push(url);
      allRequests.push(url);
    }
  });

  await page.route("**/api/customer/features*", (route) => route.fulfill(jsonBody(
    hooks.features ?? { brandKey: "acme", features: { assistant: true } },
  )));

  await page.route("**/api/customer/assistant/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    try {
      if (request.method() === "GET" && pathname === "/api/customer/assistant/config") {
        return route.fulfill(jsonBody(CONFIG));
      }
      if (request.method() === "GET" && pathname === "/api/customer/assistant/sessions") {
        return route.fulfill(jsonBody(SESSIONS));
      }
      if (pathname.startsWith("/api/customer/assistant/approvals/")) {
        if (pathname.endsWith("/decide") && request.method() === "POST") {
          const body = request.postDataJSON();
          log.decide.push(body);
          state.decided = true;
          if (hooks.decide) {
            const decided = hooks.decide(body);
            if (decided.status === 200 && decided.body?.approval) state.decidedView = decided.body.approval;
            return route.fulfill({ status: decided.status, contentType: "application/json", body: JSON.stringify(decided.body) });
          }
          state.decidedView = APPROVAL_EXECUTED.approval;
          return route.fulfill(jsonBody(APPROVAL_EXECUTED));
        }
        log.approval.push(pathname);
        const view = state.decidedView
          ?? (hooks.approvalView ? hooks.approvalView() : { ...APPROVAL_PENDING.approval, expiresAt: futureExpiry() });
        return route.fulfill(jsonBody({ approval: view }));
      }
      const match = pathname.match(/^\/api\/customer\/assistant\/sessions\/([^/]+)(\/(chat|stream|stop|rewind))?$/);
      if (match) {
        const action = match[3];
        if (!action && request.method() === "GET") {
          const base = JSON.parse(JSON.stringify(hooks.detail ? hooks.detail() : SESSION_EMPTY));
          let activeTurn = hooks.activeTurnOverride ?? base.activeTurn ?? null;
          if (hooks.replay && state.replayed) activeTurn = null;
          const messages = [...base.messages, ...extra];
          return route.fulfill(jsonBody({ session: base.session, messages, activeTurn }));
        }
        if (action === "chat" && request.method() === "POST") {
          const body = request.postDataJSON();
          log.chat.push(body);
          const meta = body.message?.metadata ?? {};
          if (meta.kind === "approval") {
            const text = `data: {"type":"start","messageId":"a_cont_000000000000000000000001","messageMetadata":{"turnId":"turn_cont_1","model":"synthetic-fixture"}}\n\ndata: {"type":"text-start","id":"text-1"}\n\ndata: {"type":"text-delta","id":"text-1","delta":"Ran the approved lookup and folded it into your reply."}\n\ndata: {"type":"text-end","id":"text-1"}\n\ndata: {"type":"finish","messageMetadata":{"turnId":"turn_cont_1","costUsd":0.0009,"costKnown":true}}\n\ndata: [DONE]\n`;
            extra.push({
              id: body.message.id,
              role: "user",
              parts: [{ type: "text", text: `Approved: ${APPROVAL_LABEL}` }],
              metadata: meta,
            });
            extra.push(replyFromStream(text));
            return relay(route, [[text, 100]]);
          }
          const streamText = hooks.chatStream ? hooks.chatStream(body) : withFutureExpiry(CHAT_STREAM);
          const reply = replyFromStream(streamText);
          extra.push({ id: body.message.id, role: "user", parts: body.message.parts, metadata: meta });
          extra.push(reply);
          if (hooks.chatSegments) return relay(route, hooks.chatSegments(streamText));
          return relay(route, [[streamText, 100]]);
        }
        if (action === "stream" && request.method() === "GET") {
          log.stream.push(url.search);
          // Like the real route: 204 when no turn streams. Only the reload
          // case replays bytes here.
          if (!hooks.replay) return route.fulfill({ status: 204 });
          state.replayed = true;
          const text = hooks.streamText ? hooks.streamText() : withFutureExpiry(STREAM_REPLAY);
          extra.length = 0;
          extra.push(replyFromStream(text));
          return route.fulfill(sseBody(text));
        }
        if (action === "stop" && request.method() === "POST") {
          log.stop.push(request.postDataJSON());
          return route.fulfill(jsonBody({ stopped: true }));
        }
        if (action === "rewind" && request.method() === "POST") {
          const body = request.postDataJSON();
          log.rewind.push(body);
          extra.length = 0;
          if (hooks.rewindResult) return route.fulfill(jsonBody(hooks.rewindResult(body)));
          return route.fulfill(jsonBody({ removed: 2, messages: [] }));
        }
      }
      return route.continue();
    } catch (error) {
      console.error(`assistant fixture route failed: ${error?.stack || error}`);
      return route.abort("failed");
    }
  });

  return { context, page, log };
}

async function relay(route, segments) {
  const token = `f22-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  ssePlans.set(`/f22/${token}`, segments);
  return route.continue({ url: `http://127.0.0.1:${ssePort}/f22/${token}` });
}

async function openSession(log, page, assistantPath) {
  await page.goto(new URL(assistantPath ?? `/portal/assistant?s=${SESSION_ID}`, origin).href, { waitUntil: "networkidle" });
}

const COMPOSER = "Ask about your AI visibility, keywords or site…";

try {
  await record("C1", "flag off renders F04 NotFound", async () => {
    const { context, page } = await makePage({ features: { brandKey: "acme", features: { assistant: false } } });
    try {
      await openSession(null, page);
      await page.getByText("The page you are looking for does not exist.").waitFor({ timeout: 30000 });
      assert.equal(await page.getByPlaceholder(COMPOSER).count(), 0, "no composer when the flag is off");
      return "404 copy, no composer";
    } finally { await context.close(); }
  });

  await record("C2", "empty state copy, suggestion and skill chips", async () => {
    const { context, page } = await makePage({});
    try {
      await openSession(null, page);
      await page.getByRole("heading", { name: "Assistant" }).waitFor({ timeout: 30000 });
      await page.getByText("Ask about your AI visibility, search data and site. Paid lookups always ask you first.").waitFor();
      await page.getByText("Hi, I", { exact: false }).waitFor();
      await page.getByText("Ask anything, or start with one of these:").waitFor();
      for (const suggestion of CONFIG.suggestions) {
        await page.getByRole("button", { name: suggestion }).waitFor();
      }
      await page.getByText("Workflows I can run:").waitFor();
      await page.getByRole("button", { name: "SEO Coach" }).waitFor();
      await page.getByPlaceholder(COMPOSER).waitFor();
      await page.getByRole("button", { name: "Send message" }).waitFor();
      await page.getByRole("button", { name: "New chat" }).first().waitFor();
      return "header, intro, 4 suggestions, skill chip, composer";
    } finally { await context.close(); }
  });

  // Delayed segments: text first, then the tool input, then the tool output.
  // The middle window holds the running card while the reply still streams.
  function drip(text) {
    const lines = text.split("\n");
    const dataIndex = [];
    lines.forEach((line, index) => { if (line.startsWith("data:")) dataIndex.push(index); });
    const firstDelta = dataIndex.find((i) => lines[i].includes('"type":"text-delta"'));
    const toolInput = dataIndex.find((i) => lines[i].includes('"type":"tool-input-available"'));
    const cut = (bound) => (bound === undefined ? lines.length : bound);
    const slice = (from, to) => `${lines.slice(from, cut(to)).join("\n")}\n`;
    return [
      [slice(0, firstDelta + 1), 100],
      [slice(firstDelta + 1, toolInput + 1), 1500],
      [slice(toolInput + 1, undefined), 2500],
    ];
  }

  async function sendComposer(page, text) {
    await page.getByPlaceholder(COMPOSER).fill(text);
    await page.getByRole("button", { name: "Send message" }).click();
  }

  await record("C3", "send streams text, then the get_scan_report running card", async () => {
    const { context, page } = await makePage({ chatSegments: (text) => drip(text) });
    try {
      await openSession(null, page);
      await page.getByPlaceholder(COMPOSER).waitFor({ timeout: 30000 });
      await sendComposer(page, "How did our latest scan go?");
      await page.getByText("Your latest scan answered 9 of 12 questions for Acme Tees.").waitFor({ timeout: 30000 });
      await page.getByText("Loading scan report…").waitFor({ timeout: 15000 });
      return "streamed text, then the running card";
    } finally { await context.close(); }
  });

  await record("C4", "streamed reply renders the get_scan_report table card", async () => {
    const { context, page, log } = await makePage({ chatSegments: (text) => drip(text) });
    try {
      await openSession(null, page);
      await page.getByPlaceholder(COMPOSER).waitFor({ timeout: 30000 });
      await sendComposer(page, "How did our latest scan go?");
      await page.getByText("Three of the gaps name Brand X or Brand Y.").waitFor({ timeout: 30000 });
      await page.getByText("Loaded scan report").waitFor({ timeout: 15000 });
      await page.getByText("Showing 20 of 25").waitFor({ timeout: 15000 });
      await page.getByText("Do AI answers name Acme Tees for winter tees?").first().waitFor();
      await page.getByRole("link", { name: "Scans →" }).first().waitFor();
      await page.getByText(/This reply:/).first().waitFor();
      assert.equal(log.chat.length >= 1, true, "the send POSTed to /chat");
      assert.equal(log.chat[0].message.metadata.kind, "chat");
      assert.equal(log.chat[0].brand_key, "acme");
      return "streaming text, done card, Showing 20 of 25, cost line";
    } finally { await context.close(); }
  });

  await record("C5", "approval card approves, executes, and sends the approval message", async () => {
    const { context, page, log } = await makePage({ chatStream: () => withFutureExpiry(CHAT_APPROVAL) });
    try {
      await openSession(null, page);
      await page.getByPlaceholder(COMPOSER).waitFor({ timeout: 30000 });
      await sendComposer(page, "Research keywords for oversized t shirt");
      await page.getByText("Checking the price for that lookup.").waitFor({ timeout: 30000 });
      await page.getByText("Needs your approval").waitFor({ timeout: 15000 });
      await page.getByText("Up to $0.09").waitFor();
      await page.getByText(/Expires in \d+ min/).waitFor();
      assert.ok(log.approval.length >= 1, "the card read the approval view");
      await page.getByRole("button", { name: "Approve and run" }).click();
      assert.equal(log.decide.length, 1, "decide POSTed once");
      assert.deepEqual(log.decide[0], { brand_key: "acme", decision: "approve", maxUsd: 0.09 });
      await page.getByText("Approved · ran").waitFor({ timeout: 15000 });
      await page.getByText("Researched 25 keywords for “oversized t shirt”.").waitFor();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (log.chat.some((body) => body.message?.metadata?.kind === "approval")) break;
        await page.waitForTimeout(200);
      }
      assert.ok(log.chat.some((body) => body.message?.metadata?.kind === "approval"), "an approval-kind message was POSTed to /chat");
      const approvalPost = log.chat.find((body) => body.message?.metadata?.kind === "approval");
      assert.equal(approvalPost.message.metadata.approvalId, "9a1e0000-0000-4000-8000-000000000009");
      await page.getByText("You approved Research keywords for “oversized t shirt”").waitFor({ timeout: 15000 });
      return "approve posts maxUsd, executed state, approval message sent";
    } finally { await context.close(); }
  });

  await record("C6", "a 409 price_changed shows the new price with buttons intact", async () => {
    const { context, page, log } = await makePage({
      chatStream: () => withFutureExpiry(CHAT_APPROVAL),
      decide: () => ({ status: 409, body: APPROVAL_PRICE_CHANGED }),
    });
    try {
      await openSession(null, page);
      await page.getByPlaceholder(COMPOSER).waitFor({ timeout: 30000 });
      await sendComposer(page, "Research keywords for oversized t shirt");
      await page.getByText("Needs your approval").waitFor({ timeout: 30000 });
      await page.getByRole("button", { name: "Approve and run" }).click();
      await page.getByText("The price changed").waitFor({ timeout: 15000 });
      await page.getByText("This now costs up to $0.12. You approved $0.09. Review the new price.").waitFor();
      await page.getByRole("button", { name: "Approve and run" }).waitFor();
      await page.getByRole("button", { name: "Decline" }).waitFor();
      assert.equal(log.decide.length, 1, "decide POSTed once");
      return "price-changed copy with both buttons";
    } finally { await context.close(); }
  });

  await record("C7", "an expired approval shows the expired copy with no buttons", async () => {
    const { context, page } = await makePage({
      chatStream: () => withFutureExpiry(CHAT_APPROVAL),
      approvalView: () => ({ ...APPROVAL_PENDING.approval, status: "expired", expiresAt: futureExpiry() }),
    });
    try {
      await openSession(null, page);
      await page.getByPlaceholder(COMPOSER).waitFor({ timeout: 30000 });
      await sendComposer(page, "Research keywords for oversized t shirt");
      await page.getByText("Needs your approval").waitFor({ timeout: 30000 });
      await page.getByText("This approval expired. Ask the assistant again for a fresh price.").waitFor({ timeout: 15000 });
      assert.equal(await page.getByRole("button", { name: "Approve and run" }).count(), 0, "no approve button when expired");
      assert.equal(await page.getByRole("button", { name: "Decline" }).count(), 0, "no decline button when expired");
      return "expired copy, no buttons";
    } finally { await context.close(); }
  });

  await record("C8", "Undo posts /rewind and the list shrinks", async () => {
    const { context, page, log } = await makePage({ detail: () => SESSION_TOOLS });
    try {
      await openSession(null, page);
      await page.getByText("Loaded scan report").waitFor({ timeout: 30000 });
      await page.getByRole("button", { name: "Undo from this message" }).click();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && log.rewind.length === 0) await page.waitForTimeout(200);
      assert.equal(log.rewind.length, 1, "Undo POSTed to /rewind");
      assert.deepEqual(log.rewind[0], { brand_key: "acme", messageId: "u_tools_1" });
      await page.getByText("Removed. Actions already taken are not undone.").waitFor({ timeout: 15000 });
      await page.getByText("Ask anything, or start with one of these:").waitFor({ timeout: 15000 });
      assert.equal(await page.getByText("Loaded scan report").count(), 0, "the reply is gone after rewind");
      return "rewind posted, toast shown, messages shrink";
    } finally { await context.close(); }
  });

  await record("C9", "Edit posts /rewind then resends with source edit", async () => {
    const { context, page, log } = await makePage({
      detail: () => SESSION_TOOLS,
      chatSegments: (text) => drip(text),
    });
    try {
      await openSession(null, page);
      await page.getByText("Loaded scan report").waitFor({ timeout: 30000 });
      await page.getByRole("button", { name: "Edit and resend" }).click();
      const editor = page.getByRole("log").locator("textarea");
      await editor.waitFor();
      await editor.fill("How did our latest scan go? Edited");
      await page.getByRole("button", { name: "Save & resend" }).click();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && (log.rewind.length === 0 || log.chat.length === 0)) {
        await page.waitForTimeout(200);
      }
      assert.equal(log.rewind.length, 1, "edit POSTed to /rewind");
      assert.equal(log.rewind[0].messageId, "u_tools_1");
      assert.equal(log.chat.length, 1, "edit resent to /chat");
      assert.equal(log.chat[0].message.metadata.source, "edit");
      assert.match(log.chat[0].message.parts[0].text, /Edited/);
      const resendDeadline = Date.now() + 30000;
      while (Date.now() < resendDeadline) {
        if ((await page.getByText("Showing 20 of 25").count()) >= 2) break;
        await page.waitForTimeout(200);
      }
      assert.equal(
        await page.getByText("Showing 20 of 25").count(),
        2,
        "the edited resend streams a second table card",
      );
      await page.getByText("Three of the gaps name Brand X or Brand Y.").first().waitFor({ timeout: 15000 });
      return "rewind then edit resend, reply streams again";
    } finally { await context.close(); }
  });

  await record("C10", "Stop posts /stop while the turn streams", async () => {
    const { context, page, log } = await makePage({
      chatSegments: () => [[
        'data: {"type":"start","messageId":"a_stop_000000000000000000000001","messageMetadata":{"turnId":"turn_stop_1","model":"synthetic-fixture"}}\n\ndata: {"type":"text-start","id":"text-1"}\n\n',
        0,
      ], ["", 30000]],
    });
    try {
      await openSession(null, page);
      await page.getByPlaceholder(COMPOSER).waitFor({ timeout: 30000 });
      await sendComposer(page, "How did our latest scan go?");
      await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 15000 });
      await page.getByRole("button", { name: "Stop" }).click();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && log.stop.length === 0) await page.waitForTimeout(200);
      assert.equal(log.stop.length, 1, "Stop POSTed to /stop");
      assert.deepEqual(log.stop[0], { brand_key: "acme" });
      return "/stop posted with the brand";
    } finally { await context.close(); }
  });

  await record("C11", "reload mid-stream replays GET /stream into the same reply", async () => {
    const startedAt = new Date().toISOString();
    const { context, page, log } = await makePage({
      detail: () => SESSION_EMPTY,
      replay: true,
      streamText: () => withFutureExpiry(STREAM_REPLAY),
      activeTurnOverride: { id: "turn_stream_1", startedAt },
    });
    try {
      await openSession(null, page);
      await page.getByText("Three of the gaps name Brand X or Brand Y.").waitFor({ timeout: 30000 });
      await page.getByText("Showing 20 of 25").waitFor({ timeout: 15000 });
      assert.ok(log.stream.length >= 1, "the reload resumed from GET /stream");
      assert.ok(log.stream.some((search) => search.includes("brand_key=acme")), "the resume scoped to the brand");
      return "reconnect replayed the same reply";
    } finally { await context.close(); }
  });

  await record("C12", "markdown images never load; untrusted text stays plain with its label", async () => {
    const { context, page } = await makePage({ detail: () => SESSION_TOOLS });
    try {
      await openSession(null, page);
      const logRegion = page.getByRole("log");
      await logRegion.getByText("Loaded scan report").waitFor({ timeout: 30000 });
      await logRegion.getByText("[image: x]").waitFor();
      assert.equal(await logRegion.locator("img").count(), 0, "no <img> in the conversation");
      await logRegion.getByText("Answer", { exact: true }).first().waitFor();
      await logRegion.locator("figure").getByText("See https://acme.example/winter-sale for details.").waitFor();
      assert.equal(
        await logRegion.locator('a[href="https://acme.example/winter-sale"]').count(),
        0,
        "untrusted URLs are not links",
      );
      await logRegion.getByText("I stopped after 25 steps. Ask me to continue if you want me to go on.").waitFor();
      return "image label without <img>, plain untrusted text, notice";
    } finally { await context.close(); }
  });

  await record("C13", "390x844 shows chats in a Sheet with no horizontal page scroll", async () => {
    const { context, page } = await makePage({ detail: () => SESSION_TOOLS }, { viewport: { width: 390, height: 844 } });
    try {
      await openSession(null, page);
      await page.getByText("Loaded scan report").waitFor({ timeout: 30000 });
      const chats = page.getByRole("button", { name: "Chats" });
      await chats.waitFor();
      await chats.click();
      await page.getByRole("dialog").getByText("Chats").waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(overflow, false, "390px wide page must not scroll horizontally");
      return "Sheet opens, no horizontal overflow";
    } finally { await context.close(); }
  });

  await record("C14", "every request stayed on localhost or the harness mock", async () => {
    const foreign = [];
    for (const raw of allRequests) {
      let hostname = "";
      try {
        hostname = new URL(raw).hostname;
      } catch {
        continue;
      }
      if (!LOCAL_HOSTS.has(hostname)) foreign.push(raw);
    }
    assert.deepEqual(foreign, [], `non-localhost requests: ${JSON.stringify(foreign.slice(0, 10))}`);
    const placeholder = allRequests.filter((raw) => {
      try {
        return new URL(raw).hostname === PLACEHOLDER_HOST;
      } catch {
        return false;
      }
    }).length;
    return `${allRequests.length} requests logged, ${placeholder} to the route-mocked Supabase placeholder, none elsewhere`;
  });
} finally {
  await browser.close();
  sseServer.close();
  if (serverChild) serverChild.kill("SIGTERM");
}

if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exitCode = 1;
} else {
  console.log("f22 browser: all cases passed");
}
