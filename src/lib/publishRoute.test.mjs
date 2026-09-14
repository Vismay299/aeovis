/**
 * R5.2.2 — route-level tests for POST /api/content-items/[id]/publish.
 *
 * Drives the REAL POST handler with the real stage machine and the real db
 * helpers. Supabase credentials are cleared so the helpers fall back to their
 * in-memory maps. globalThis.fetch is mocked so the SSRF-guarded verification
 * receives controlled responses without any network call.
 *
 * ACCEPTANCE CRITERION:
 *   PUBLISHED is reachable only through a verified live URL;
 *   a mismatched page is rejected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// ---------------------------------------------------------------------------
// Environment: no Supabase client so all DB helpers use memory maps
// ---------------------------------------------------------------------------

delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

register("./cronAuth.route.hooks.mjs", import.meta.url);

const { POST: publish } = await import(
  "../app/api/content-items/[id]/publish/route.js"
);
const { supabase } = await import("./db.js");
const { isLegalTransition } = await import("./content/stages.js");

// ---------------------------------------------------------------------------
// Memory maps — the write log
// ---------------------------------------------------------------------------

global.memoryContentItems = global.memoryContentItems || new Map();
global.memoryContentEvents = global.memoryContentEvents || new Map();
global.memoryContentJobs = global.memoryContentJobs || new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A public literal IP — passes SSRF without DNS lookup. */
const PUBLIC_IP_URL = "https://93.184.216.34/page";

function seedItem(id, overrides = {}) {
  const item = {
    id,
    brand: "Acme Analytics",
    playbook: "geo_article",
    status: "approved",
    title: "Best analytics tool for startups",
    target_queries: ["best analytics tool"],
    body_md: "# draft",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  global.memoryContentItems.set(id, item);
  return item;
}

function seedJob(jobId, overrides = {}) {
  const job = {
    id: jobId,
    brand: "Acme Analytics",
    status: "awaiting_approval",
    created_at: new Date().toISOString(),
    ...overrides,
  };
  global.memoryContentJobs.set(jobId, job);
  return job;
}

/**
 * Replace globalThis.fetch with a handler for the duration of `fn`.
 * Restores the original in the finally block so a test failure cannot leak.
 */
function withMockFetch(handler, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(url, init);
  const restore = () => { globalThis.fetch = realFetch; };
  return fn().finally(restore);
}

async function postPublish(id, body) {
  const request = new Request(
    `http://localhost/api/content-items/${id}/publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const res = await publish(request, { params: { id } });
  return { res, body: await res.json() };
}

/** Handler that returns 200 with a matching title. */
function okHandler(_url, _init) {
  return {
    ok: true,
    status: 200,
    headers: new Map([["content-type", "text/html"]]),
    text: async () =>
      `<html><head><title>Best analytics tool for startups - Acme Blog</title></head><body>content</body></html>`,
  };
}

/** Handler that returns 200 with a WRONG title. */
function mismatchHandler(_url, _init) {
  return {
    ok: true,
    status: 200,
    headers: new Map([["content-type", "text/html"]]),
    text: async () =>
      `<html><head><title>Completely Unrelated Page</title></head></html>`,
  };
}

/** Handler that returns 200 with NO title tag. */
function noTitleHandler(_url, _init) {
  return {
    ok: true,
    status: 200,
    headers: new Map([["content-type", "text/html"]]),
    text: async () => `<html><body>No title here</body></html>`,
  };
}

/** Handler that returns 404. */
function notFoundHandler(_url, _init) {
  return { ok: false, status: 404 };
}

/** Handler that throws (network failure). */
function fetchFailHandler(_url, _init) {
  throw new Error("connection refused");
}

// ---------------------------------------------------------------------------
// Guard: the suite runs without Supabase
// ---------------------------------------------------------------------------

test("suite precondition: no Supabase client, memory maps are the write log", () => {
  assert.equal(
    supabase,
    null,
    "env vars must be cleared so resolveClient returns null"
  );
});

// ---------------------------------------------------------------------------
// 1. Missing / empty URL
// ---------------------------------------------------------------------------

test("POST with no URL body returns 400", async () => {
  const id = "pub-no-url";
  seedItem(id);
  const { res, body } = await postPublish(id, {});
  assert.equal(res.status, 400);
  assert.match(body.detail, /url/i);
});

test("POST with blank URL returns 400", async () => {
  const id = "pub-blank-url";
  seedItem(id);
  const { res, body } = await postPublish(id, { url: "   " });
  assert.equal(res.status, 400);
  assert.match(body.detail, /url/i);
});

// ---------------------------------------------------------------------------
// 2. Item not found
// ---------------------------------------------------------------------------

test("POST for a nonexistent item returns 404", async () => {
  const { res, body } = await postPublish("nonexistent-id", {
    url: PUBLIC_IP_URL,
  });
  assert.equal(res.status, 404);
  assert.match(body.detail, /not found/i);
});

// ---------------------------------------------------------------------------
// 3. Status gate — only "approved" items can be published
// ---------------------------------------------------------------------------

test("draft item returns 409", async () => {
  const id = "pub-draft";
  seedItem(id, { status: "draft" });
  const { res, body } = await postPublish(id, { url: PUBLIC_IP_URL });
  assert.equal(res.status, 409);
  assert.match(body.detail, /draft/i);
  assert.equal(body.current_status, "draft");
});

test("awaiting_approval item returns 409", async () => {
  const id = "pub-awaiting";
  seedItem(id, { status: "awaiting_approval" });
  const { res, body } = await postPublish(id, { url: PUBLIC_IP_URL });
  assert.equal(res.status, 409);
  assert.match(body.detail, /awaiting_approval/i);
});

test("rejected item returns 409", async () => {
  const id = "pub-rejected";
  seedItem(id, { status: "rejected" });
  const { res, body } = await postPublish(id, { url: PUBLIC_IP_URL });
  assert.equal(res.status, 409);
  assert.match(body.detail, /rejected/i);
});

test("already-published item returns 409", async () => {
  const id = "pub-already";
  seedItem(id, { status: "published" });
  const { res, body } = await postPublish(id, { url: PUBLIC_IP_URL });
  assert.equal(res.status, 409);
  assert.match(body.detail, /published/i);
});

// ---------------------------------------------------------------------------
// 4. Verification failures
// ---------------------------------------------------------------------------

test("URL that returns 404 is rejected with 422", async () => {
  const id = "pub-404";
  seedItem(id);
  await withMockFetch(notFoundHandler, async () => {
    const { res, body } = await postPublish(id, { url: PUBLIC_IP_URL });
    assert.equal(res.status, 422);
    assert.equal(body.error, "not_ok");
    assert.equal(body.status_code, 404);
  });
});

test("URL that throws is rejected with 422", async () => {
  const id = "pub-fetch-fail";
  seedItem(id);
  await withMockFetch(fetchFailHandler, async () => {
    const { res, body } = await postPublish(id, { url: PUBLIC_IP_URL });
    assert.equal(res.status, 422);
    assert.equal(body.error, "fetch_failed");
  });
});

test("page with mismatched title is rejected with 422", async () => {
  const id = "pub-mismatch";
  seedItem(id);
  await withMockFetch(mismatchHandler, async () => {
    const { res, body } = await postPublish(id, { url: PUBLIC_IP_URL });
    assert.equal(res.status, 422);
    assert.equal(body.error, "title_mismatch");
    assert.equal(body.title_found, "Completely Unrelated Page");
  });
});

test("page with no <title> tag is rejected with 422", async () => {
  const id = "pub-no-title";
  seedItem(id);
  await withMockFetch(noTitleHandler, async () => {
    const { res, body } = await postPublish(id, { url: PUBLIC_IP_URL });
    assert.equal(res.status, 422);
    assert.equal(body.error, "no_title");
  });
});

// ---------------------------------------------------------------------------
// 5. Happy path — verified URL transitions to PUBLISHED
// ---------------------------------------------------------------------------

test("approved item with verified URL transitions to published", async () => {
  const id = "pub-happy";
  seedItem(id);
  const eventsBefore = global.memoryContentEvents.size;

  await withMockFetch(okHandler, async () => {
    const { res, body } = await postPublish(id, { url: PUBLIC_IP_URL });
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.published, true);
    assert.equal(body.status, "published");
    assert.equal(body.url, PUBLIC_IP_URL);
    assert.ok(body.verification.status >= 200);
    assert.ok(body.verification.title_found);
  });

  // Item status actually changed in the memory map
  const item = global.memoryContentItems.get(id);
  assert.equal(item.status, "published", "item must be persisted as published");

  // A content event was written
  assert.equal(
    global.memoryContentEvents.size,
    eventsBefore + 1,
    "a real content event must be recorded"
  );

  // The event carries the verified URL, not a fabricated one
  const events = Array.from(global.memoryContentEvents.values());
  const publishEvent = events.find((e) => e.url === PUBLIC_IP_URL);
  assert.ok(publishEvent, "the event must carry the verified URL");
  assert.equal(publishEvent.brand, "Acme Analytics");
});

// ---------------------------------------------------------------------------
// 6. Job status mirroring
// ---------------------------------------------------------------------------

test("publish mirrors status to the content job when job_id is present", async () => {
  const id = "pub-job-mirror";
  const jobId = "job-pub-mirror";
  seedJob(jobId, { status: "awaiting_approval" });
  seedItem(id, { job_id: jobId });

  await withMockFetch(okHandler, async () => {
    const { res, body } = await postPublish(id, { url: PUBLIC_IP_URL });
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.published, true);
  });

  const job = global.memoryContentJobs.get(jobId);
  assert.equal(job.status, "published", "job status must be mirrored");
});

// ---------------------------------------------------------------------------
// 7. The stage machine allows the transition
// ---------------------------------------------------------------------------

test("approved -> published is a legal transition in ITEM_STAGES", () => {
  assert.ok(
    isLegalTransition("approved", "published"),
    "the stage machine must permit approved -> published"
  );
});

test("draft -> published is NOT a legal transition", () => {
  assert.ok(
    !isLegalTransition("draft", "published"),
    "the stage machine must block draft -> published"
  );
});

// ---------------------------------------------------------------------------
// 8. Acceptance-criterion guard — PUBLISHED requires a verified URL
// ---------------------------------------------------------------------------

test("GUARD: no code path sets status to published without calling verifyPublishUrl", async () => {
  // Drive the handler with a fetch that throws — if the route were to
  // skip verification, the item would end up published anyway.
  const id = "pub-guard";
  seedItem(id);

  await withMockFetch(fetchFailHandler, async () => {
    const { res } = await postPublish(id, { url: PUBLIC_IP_URL });
    assert.notEqual(res.status, 200, "a failed verification must not 200");
  });

  const item = global.memoryContentItems.get(id);
  assert.notEqual(
    item.status,
    "published",
    "item must NOT be published when verification failed"
  );
});

test("GUARD: a title-mismatched page is rejected, not published", async () => {
  const id = "pub-guard-mismatch";
  seedItem(id);

  await withMockFetch(mismatchHandler, async () => {
    const { res, body } = await postPublish(id, { url: PUBLIC_IP_URL });
    assert.equal(res.status, 422);
    assert.equal(body.error, "title_mismatch");
  });

  const item = global.memoryContentItems.get(id);
  assert.equal(item.status, "approved", "item must stay approved on mismatch");
});
