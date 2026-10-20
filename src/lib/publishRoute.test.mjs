import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { contentHash } from "./repairs/workflow.js";
for (const key of [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
])
  delete process.env[key];
register("./cronAuth.route.hooks.mjs", import.meta.url);
const { POST } = await import("../app/api/content-items/[id]/publish/route.js");
const text =
  "This source grounded approved draft describes the exact publication that was reviewed and approved. It contains enough substantive text to verify on the live page.";
const item = {
  id: "item",
  brand: "qa",
  status: "approved",
  title: "Exact draft",
  body_md: text,
  content_version: 3,
  content_hash: contentHash("Exact draft", text),
};
const url = "https://93.184.216.34/page";
async function call(payload = {}, options = {}) {
  const writes = [];
  const deps = {
    getContentItem: async () => item,
    getSupabaseAdmin: () => ({
      rpc: async (name, args) => {
        writes.push({ name, args });
        return { data: { url: args.p_url }, error: null };
      },
    }),
    ...options,
  };
  const req = new Request("http://localhost/api/content-items/item/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      content_version: 3,
      content_hash: item.content_hash,
      ...payload,
    }),
  });
  const res = await POST(req, { params: { id: "item" } }, deps);
  return { res, body: await res.json(), writes };
}
test("publication requires a live URL, current version, approved item and available transactional storage", async () => {
  for (const payload of [{ url: "" }, { url: "   " }])
    assert.equal((await call(payload)).res.status, 400);
  assert.equal((await call({ content_version: 2 })).res.status, 409);
  assert.equal((await call({ content_hash: "stale" })).res.status, 409);
  assert.equal(
    (await call({}, { getContentItem: async () => null })).res.status,
    404,
  );
  for (const status of ["draft", "awaiting_approval", "rejected"])
    assert.equal(
      (await call({}, { getContentItem: async () => ({ ...item, status }) }))
        .res.status,
      409,
    );
  assert.equal(
    (await call({}, { getSupabaseAdmin: () => null })).res.status,
    503,
  );
});
async function withPage(html, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}
test("matching title with unrelated body cannot publish or create an event", async () =>
  withPage(
    "<title>Exact draft</title><main>Unrelated content</main>",
    async () => {
      const r = await call();
      assert.equal(r.res.status, 422);
      assert.equal(r.body.error, "body_mismatch");
      assert.equal(r.writes.length, 0);
    },
  ));
test("verified approved body commits through one publication RPC and preserves indexing uncertainty", async () =>
  withPage(`<title>Edited headline</title><main>${text}</main>`, async () => {
    const r = await call();
    assert.equal(r.res.status, 200);
    assert.equal(r.writes.length, 1);
    assert.equal(r.writes[0].name, "record_verified_publication");
    assert.equal(r.writes[0].args.p_hash, item.content_hash);
    assert.equal(r.writes[0].args.p_verification.matched, true);
    assert.equal(r.body.indexing, null);
    assert.equal(r.body.observed_citation, null);
  }));
test("transaction refusal cannot report published", async () =>
  withPage(`<main>${text}</main>`, async () => {
    const r = await call(
      {},
      {
        getSupabaseAdmin: () => ({
          rpc: async () => ({ error: { message: "write failed" } }),
        }),
      },
    );
    assert.equal(r.res.status, 409);
    assert.notEqual(r.body.published, true);
  }));
test("unreachable page cannot reach the publication transaction", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error("network unavailable");
  };
  try {
    const r = await call();
    assert.equal(r.res.status, 422);
    assert.equal(r.writes.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
