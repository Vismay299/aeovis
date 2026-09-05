/**
 * R2.2.3 — the two API callers of the prompt WRITE helpers, observed at the
 * REAL route handlers rather than inferred from the helper's return value.
 *
 * Neither route file is changed by this task, and that is the claim under test:
 * making upsertPrompts and updatePromptStatus throw must land somewhere that
 * reports the failure, or the fix has only moved the silence.
 *
 *   POST /api/brands/[brand]/prompts — did `const { error } = await upsertPrompts(...)`
 *     and 500'd on a truthy `error`. It now throws past that destructure into
 *     the handler's own catch. Still a 500; the point is that it is still a 500
 *     with no route edit, so nothing was quietly downgraded to a 200.
 *
 *   PATCH /api/prompts/[id] — mapped updatePromptStatus's `false` to
 *     404 "Prompt not found or update failed". That `false` used to mean three
 *     things, so a misconfigured or broken database told the user their prompt
 *     did not exist. It is now a 500. A genuinely absent row is still `false`
 *     and still a 404 — pinned at the helper level in promptWriteFailure.test.mjs,
 *     because these handlers take no injectable client.
 *
 * NO DATABASE IS TOUCHED. The Supabase env vars are deleted BEFORE the route
 * modules are imported, so `db.js`'s module-level client is null and the
 * db_not_configured branch is the one under test. Nothing is stubbed: the
 * handlers, the helpers and NextResponse are all the real ones. The hooks file
 * only answers "which file is this specifier" for `@/...` and `next/server`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

register("../cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
let postPrompt = null;
let patchPrompt = null;
try {
  ({ POST: postPrompt } = await import("../../app/api/brands/[brand]/prompts/route.js"));
  ({ PATCH: patchPrompt } = await import("../../app/api/prompts/[id]/route.js"));
} catch (error) {
  importError = error;
}

test("the real route handlers loaded — a suite that could not import them proves nothing", () => {
  assert.equal(importError, null, importError ? `import failed: ${importError.message}` : "");
  assert.equal(typeof postPrompt, "function");
  assert.equal(typeof patchPrompt, "function");
});

test("POST /api/brands/[brand]/prompts — a write that cannot happen is a 5xx, never a success", async () => {
  const errs = [];
  const error = console.error;
  console.error = (...a) => errs.push(a.map(String).join(" "));
  let res;
  try {
    res = await postPrompt(
      new Request("https://aeovis.test/api/brands/acme.com/prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "best crm for startups", intent_tier: "informational" }),
      }),
      { params: { brand: "acme.com" } }
    );
  } finally {
    console.error = error;
  }

  const body = await res.json();
  assert.ok(res.status >= 500, `a prompt that was not saved must not report success; got ${res.status}`);
  assert.ok(!body.success, `the response claimed success: ${JSON.stringify(body)}`);
  // The classification does not reach the user's screen, but it must reach the
  // log — "no credentials" and "the database refused" are different call-outs.
  assert.match(errs.join("\n"), /PromptWriteError|Supabase client/i);
});

test("PATCH /api/prompts/[id] — a broken write no longer tells the user the prompt does not exist", async () => {
  const errs = [];
  const error = console.error;
  console.error = (...a) => errs.push(a.map(String).join(" "));
  let res;
  try {
    res = await patchPrompt(
      new Request("https://aeovis.test/api/prompts/11111111-1111-4111-8111-111111111111", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      { params: { id: "11111111-1111-4111-8111-111111111111" } }
    );
  } finally {
    console.error = error;
  }

  const body = await res.json();
  // THE BUG, at the surface. Pre-R2.2.3 this is a 404 whose body reads
  // "Prompt not found or update failed" for a prompt that exists.
  assert.notEqual(res.status, 404, "an unwritable database is not a missing prompt");
  assert.ok(res.status >= 500, `expected a 5xx, got ${res.status}`);
  assert.doesNotMatch(
    JSON.stringify(body),
    /not found/i,
    `the response still blames the user's data: ${JSON.stringify(body)}`
  );
  assert.match(errs.join("\n"), /PromptWriteError|Supabase client/i);
});
