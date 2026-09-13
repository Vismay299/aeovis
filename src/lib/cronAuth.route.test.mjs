/**
 * R0.1.8 / C9 — the forged `x-vercel-cron` header, observed at the ROUTE.
 *
 * cronAuth.test.mjs proves the predicate: authorizeCronRequest returns
 * {authorized:false} for a request carrying only the client-settable
 * `x-vercel-cron` header. The accept criterion is stronger than that — "a
 * request ... is REFUSED in production" — and a false predicate is only a
 * refusal if the route actually turns it into a 401. That step was an
 * inference. This suite removes the inference: it imports the real GET
 * handlers from src/app/api/scan/worker/route.js and
 * src/app/api/content/worker/route.js, calls them with a real `Request`, and
 * asserts on `Response.status`. The 401s below are OBSERVED, not derived.
 *
 * How the routes are made importable (see cronAuth.route.hooks.mjs): only the
 * two specifiers Next's bundler would have resolved — the `@/` path alias and
 * the extensionless `next/server` — are mapped to their real files. Nothing is
 * stubbed. NextResponse is Next's own; the handler bodies run unmodified.
 *
 * DEPENDENCY NOTE: this is the only suite in the tree that needs node_modules
 * (`next`, a declared dependency). If it is not installed the first test FAILS
 * LOUDLY with instructions — it does not skip. A skip here would re-open
 * exactly the gap this file exists to close.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

const SECRET = "s3cr3t-cron-value";
const WORKER_URL = {
  scan: "https://aeovis.test/api/scan/worker",
  content: "https://aeovis.test/api/content/worker",
};

// ---------------------------------------------------------------------------
// Environment, fixed BEFORE the route modules are imported.
//
// NODE_ENV=production + CRON_SECRET set is the exact configuration the finding
// is about: the operator HAS configured a secret, and the question is whether a
// header anyone can type gets in anyway.
//
// The Supabase vars are cleared deliberately. db.js builds its client at import
// time, so with them unset `supabase` is null and an AUTHORIZED request takes
// the "No Supabase configured" early return: no network, no scan resumed, no
// vendor budget spent. The auth gate runs first either way, so this changes
// nothing about what is under test — it only keeps the positive control inert.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "production";
process.env.CRON_SECRET = SECRET;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

register("./cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
/** @type {Array<[string, (req: Request) => Promise<Response>]>} */
let routes = [];
try {
  const [scan, content] = await Promise.all([
    import("../app/api/scan/worker/route.js"),
    import("../app/api/content/worker/route.js"),
  ]);
  routes = [
    [WORKER_URL.scan, scan.GET],
    [WORKER_URL.content, content.GET],
  ];
} catch (error) {
  importError = error;
}

/**
 * Both routes, or a hard failure. Without this every loop below would pass
 * vacuously on an empty list — a green suite that exercised nothing.
 */
function bothRoutes() {
  assert.equal(importError, null, `route modules failed to import: ${importError?.message}`);
  assert.equal(routes.length, 2, "both worker routes must be under test, not one");
  return routes;
}

test("both worker route modules import and export GET", () => {
  assert.equal(
    importError,
    null,
    "Could not import the worker routes. If this says \"Cannot find package 'next'\", " +
      "run `npm install` — this suite exercises the real handlers on purpose. " +
      `Underlying error: ${importError?.message}`
  );
  for (const [url, GET] of routes) {
    assert.equal(typeof GET, "function", `${url} must export a GET handler`);
  }
});

// ---------------------------------------------------------------------------
// The refusal itself. This is the criterion, observed.
// ---------------------------------------------------------------------------

test("ROUTE 401 — x-vercel-cron alone is refused in production by BOTH workers", async () => {
  for (const [url, GET] of bothRoutes()) {
    const response = await GET(new Request(url, { headers: { "x-vercel-cron": "1" } }));
    assert.equal(
      response.status,
      401,
      `${url} let a forged x-vercel-cron header through — it answered ${response.status}`
    );
    assert.deepEqual(await response.json(), { detail: "Unauthorized." });
  }
});

test("ROUTE 401 — x-vercel-cron plus a WRONG secret is still refused", async () => {
  for (const [url, GET] of bothRoutes()) {
    const response = await GET(
      new Request(url, {
        headers: { "x-vercel-cron": "1", authorization: "Bearer not-the-secret" },
      })
    );
    assert.equal(response.status, 401, `${url} accepted a wrong bearer alongside the header`);
  }
});

test("ROUTE 401 — control: no credential of any kind is refused", async () => {
  for (const [url, GET] of bothRoutes()) {
    const response = await GET(new Request(url));
    assert.equal(response.status, 401, `${url} answered ${response.status} to an anonymous call`);
  }
});

// ---------------------------------------------------------------------------
// Positive controls. The three secret paths must still reach the handler, and
// must do so WITH x-vercel-cron present — the fix ignores that header, it does
// not reject on it. Without these, "return 401 always" would pass the suite.
//
// Header names are deliberately mixed-case: real traffic does not arrive
// pre-lowercased, and the gate looks headers up by lowercase literals
// ("authorization", "x-cron-secret"). Request.headers.get normalises, so these
// prove the route's getter is the case-insensitive one.
// ---------------------------------------------------------------------------

test("ROUTE — a valid bearer passes the gate on both workers, x-vercel-cron notwithstanding", async () => {
  for (const [url, GET] of bothRoutes()) {
    const response = await GET(
      new Request(url, {
        headers: { "X-Vercel-Cron": "1", Authorization: `Bearer ${SECRET}` },
      })
    );
    assert.notEqual(response.status, 401, `${url} refused a correctly authenticated cron call`);
    // R2.8.14: the content worker returns 500 when no Supabase is configured
    // (batchUnavailable), so we only check it's not 401 here.
    // The scan worker returns 200 on the no-db path.
    if (url.includes("scan")) {
      assert.equal(response.status, 200);
    } else {
      assert.ok(response.status >= 200, `${url} accepted the cron call (status ${response.status})`);
    }
  }
});

test("ROUTE — the x-cron-secret header still passes on both workers", async () => {
  for (const [url, GET] of bothRoutes()) {
    const response = await GET(new Request(url, { headers: { "X-Cron-Secret": SECRET } }));
    assert.notEqual(response.status, 401, `${url} refused a valid x-cron-secret`);
    // R2.8.14: the content worker returns 500 when no Supabase is configured.
    if (url.includes("scan")) {
      assert.equal(response.status, 200);
    } else {
      assert.ok(response.status >= 200, `${url} accepted the cron call (status ${response.status})`);
    }
  }
});

test("ROUTE — the ?secret= query parameter still passes on both workers", async () => {
  for (const [url, GET] of bothRoutes()) {
    const response = await GET(new Request(`${url}?secret=${encodeURIComponent(SECRET)}`));
    assert.notEqual(response.status, 401, `${url} refused a valid ?secret=`);
    // R2.8.14: the content worker returns 500 when no Supabase is configured.
    if (url.includes("scan")) {
      assert.equal(response.status, 200);
    } else {
      assert.ok(response.status >= 200, `${url} accepted the cron call (status ${response.status})`);
    }
  }
});
