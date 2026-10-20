/**
 * R5.2.1 / finding B13 — APPROVAL IS NOT PUBLICATION.
 *
 * `POST /api/content-items/[id]/decision` used to synthesize
 * `https://studio.perceev.app/content/<slug>` for an approved geo_article and
 * persist it as a `content_events` row. Nothing was published at that host;
 * the row nonetheless fed the lift computation, so the product reported
 * engagement against a page that does not exist. This suite pins the deletion:
 * approval produces NO url, writes NO content event, and says on the wire that
 * the item is not published — an absence a caller can read, not one it has to
 * infer from a missing field.
 *
 * WHAT IS REAL HERE. The real POST handler runs, with the real stage machine
 * and the real db helpers. The only substitution is the ABSENCE of Supabase
 * credentials (cleared before the imports, because db.js builds its client at
 * import time), which puts the db helpers on their in-memory maps — and it is
 * exactly those maps the first test inspects to prove no event was written.
 * `globalThis.fetch` is made to throw so that any network attempt fails the
 * test rather than escaping silently.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

register("./cronAuth.route.hooks.mjs", import.meta.url);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DECISION_ROUTE = "src/app/api/content-items/[id]/decision/route.js";

const { POST: decide } = await import("../app/api/content-items/[id]/decision/route.js");
const {
  POST: postContentEvent,
  isFabricatedEventUrl,
  withFabricatedUrlsQuarantined,
  FABRICATED_EVENT_HOST,
} = await import("../app/api/content-events/route.js");
const { supabase } = await import("./db.js");

global.memoryContentItems = global.memoryContentItems || new Map();
global.memoryContentEvents = global.memoryContentEvents || new Map();

function seedItem(id, overrides = {}) {
  const item = {
    id,
    brand: "Acme Analytics",
    playbook: "geo_article",
    status: "awaiting_approval",
    title: "Best analytics tool for startups",
    target_queries: ["best analytics tool for startups"],
    body_md: "# draft",
    content_version:1,content_hash:"a".repeat(64),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  global.memoryContentItems.set(id, item);
  return item;
}

async function postDecision(id, body) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (target) => {
    throw new Error(`nothing here may reach the network, but something fetched ${String(target?.url || target)}`);
  };
  try {
    const request = new Request(`http://localhost/api/content-items/${id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({content_version:1,content_hash:"a".repeat(64),...body}),
    });
    const res = await decide(request, { params: { id } }, {getSupabaseAdmin:()=>({rpc:async(name,args)=>{assert.equal(name,"decide_checked_content");assert.equal(args.p_hash,"a".repeat(64));return {data:{status:args.p_status},error:null};}})});
    return { res, body: await res.json() };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("the suite really runs with no Supabase client, so the memory maps are the write log", () => {
  assert.equal(
    supabase,
    null,
    "this suite only proves something with NO client — the env above must really have been cleared"
  );
});

test("R5.2.1: approving a geo_article writes NO content_events row", async () => {
  const before = global.memoryContentEvents.size;
  const id = "r521-approve-geo";
  seedItem(id);

  const { res, body } = await postDecision(id, { verdict: "approved", comment: "" });

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.status, "approved");
  assert.equal(
    global.memoryContentEvents.size,
    before,
    "approval must not write a content event: approval is not publication, and the URL such a " +
      "row would carry does not exist"
  );
});

test("R5.2.1: no URL is synthesized anywhere in the approval response", async () => {
  const id = "r521-no-url";
  seedItem(id, { target_queries: ["ai visibility tracking"] });

  const { body } = await postDecision(id, { verdict: "approved", comment: "" });
  const wire = JSON.stringify(body);

  assert.ok(
    !wire.includes(FABRICATED_EVENT_HOST),
    `the approval response must not carry ${FABRICATED_EVENT_HOST}: ${wire}`
  );
  assert.ok(
    !/https?:\/\/[a-z0-9.-]+\/content\//i.test(wire),
    `the approval response must not carry a synthesized content URL: ${wire}`
  );
  assert.equal(body.publication.url, null, "an approved-but-unpublished item has no url");
});

test("R5.2.1: approval states 'not published' explicitly rather than leaving it to be inferred", async () => {
  const id = "r521-says-so";
  seedItem(id);

  const { body } = await postDecision(id, { verdict: "approved", comment: "" });

  assert.deepEqual(
    { published: body.publication.published, url: body.publication.url, reason: body.publication.reason },
    { published: false, url: null, reason: "approved_not_published" },
    "a caller must be able to tell 'approved, not published' from 'published at <url>'"
  );
  assert.match(
    body.publication.detail,
    /not published/i,
    "the reason must be readable, not just a code"
  );
});

test("R5.2.1: a non-approving verdict also reports an explicit, distinguishable publication state", async () => {
  const id = "r521-reject";
  seedItem(id);

  const { body } = await postDecision(id, { verdict: "rejected", comment: "off-brief" });

  assert.equal(body.status, "rejected");
  assert.equal(body.publication.published, false);
  assert.equal(body.publication.url, null);
  assert.equal(
    body.publication.reason,
    "not_approved",
    "'not approved' and 'approved but unpublished' are different facts and must not collapse"
  );
});

/**
 * The guard below reads the RAW source with no comment stripping, so the host
 * must not appear in the decision route at all — not in code, not in a comment
 * that a later edit could uncomment. The route's own comment therefore records
 * the history by pointing at finding B13 rather than by repeating the host.
 * (A comment-stripping helper here would also have to be registered in the
 * R6.4.14 enumeration, which lives in a file this task must not touch.)
 */
test("R5.2.1 GUARD: the URL-synthesizing path is gone from the decision route source", async () => {
  const src = await readFile(path.join(REPO, DECISION_ROUTE), "utf8");

  assert.ok(
    !src.includes(FABRICATED_EVENT_HOST),
    `${DECISION_ROUTE} must not name or build a ${FABRICATED_EVENT_HOST} URL`
  );
  assert.ok(
    !/\bfunction contentEventUrl\b/.test(src),
    `${DECISION_ROUTE} must not carry a URL synthesizer`
  );
  assert.ok(
    !/\binsertContentEvent\s*\(/.test(src),
    `${DECISION_ROUTE} must not write a content event: the human gate approves, it does not publish`
  );
});

// --- the legacy rows the deleted path already wrote ------------------------
// Deleting the synthesizer does not delete the rows it wrote. The reader must
// refuse to serve a lift figure derived from one of them.

test("R5.2.1: isFabricatedEventUrl recognises the synthesized host and nothing else", () => {
  assert.equal(isFabricatedEventUrl(`https://${FABRICATED_EVENT_HOST}/content/best-crm`), true);
  assert.equal(isFabricatedEventUrl(`http://${FABRICATED_EVENT_HOST}/content/x`), true);
  assert.equal(isFabricatedEventUrl("https://acme.com/blog/best-crm"), false);
  assert.equal(isFabricatedEventUrl("https://perceev.app/blog/real-post"), false);
  assert.equal(isFabricatedEventUrl("not a url"), false);
  assert.equal(isFabricatedEventUrl(null), false);
});

test("R5.2.1: a fabricated-URL row is served with NO lift and a stated reason, not a zero", () => {
  const reports = withFabricatedUrlsQuarantined([
    {
      id: "legacy",
      url: `https://${FABRICATED_EVENT_HOST}/content/best-analytics-tool`,
      related_prompts: ["best analytics tool"],
      current_score: 42,
      previous_score: 30,
      lift: 12,
    },
    {
      id: "real",
      url: "https://acme.com/blog/best-analytics-tool",
      related_prompts: ["best analytics tool"],
      current_score: 42,
      previous_score: 30,
      lift: 12,
    },
  ]);

  const [legacy, real] = reports;
  assert.equal(legacy.lift, null, "a lift computed against a page that never existed is not a number to serve");
  assert.equal(legacy.current_score, null);
  assert.equal(legacy.previous_score, null);
  assert.deepEqual(legacy.related_prompts, []);
  assert.equal(legacy.fabricated_url, true);
  assert.equal(legacy.lift_unavailable_reason, "fabricated_url");
  assert.match(legacy.detail, /not a measured zero/i);
  assert.notEqual(legacy.lift, 0, "unmeasured must never render as a measured zero");

  assert.deepEqual(real, reports[1], "a real row passes through untouched");
  assert.equal(real.lift, 12);
  assert.equal(real.fabricated_url, undefined);
});

test("R5.2.1: the manual content-event door refuses the fabricated host", async () => {
  const before = global.memoryContentEvents.size;
  const request = new Request("http://localhost/api/content-events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brand: "Acme Analytics", url: `https://${FABRICATED_EVENT_HOST}/content/x` }),
  });

  const res = await postContentEvent(request);
  const body = await res.json();

  assert.equal(res.status, 400, JSON.stringify(body));
  assert.match(body.detail, /not a real publication target/i);
  assert.equal(global.memoryContentEvents.size, before, "the refused write must not land");
});
