/**
 * R2.8.15 item (1) — the history assertion, made executable.
 *
 * WHY THIS FILE EXISTS. scansByDomainUnconfigured.test.mjs shipped with a
 * permanent comment stating that BEFORE R2.8.12 an unconfigured deploy made
 * GET /api/brands/[brand]/coverage fall through to `scans?.[0]` being undefined
 * and return 404 "never been scanned". That is false, and the R2.8.12 submit
 * note said the opposite (500) — so the shipped file contradicted the shipped
 * note, and the file is what a later reader would have trusted.
 *
 * WHAT WAS ACTUALLY MEASURED (R2.8.15, not reasoned from the source): the
 * pre-fix tree was checked out into a detached worktree at commit 220d93d, the
 * last commit BEFORE 0c505a5 (the commit that landed R2.8.12) to touch src/.
 * 0c505a5's actual parent is ea165ed, which is ledger-only — it changes just
 * .claude/orchestration/tasks.json and docs/plans/ — so `git diff 220d93d
 * 0c505a5^ -- src/` is empty and 220d93d carries the identical pre-fix source
 * tree. (`git rev-list --parents -n 1 0c505a5` and `git rev-list -n 1 0c505a5^
 * -- src/` are the two commands that establish this; an earlier version of this
 * paragraph called 220d93d the parent, which it is not — it is the
 * grandparent.) GET was then driven there with
 * NEXT_PUBLIC_SUPABASE_URL/ANON_KEY/SUPABASE_SERVICE_ROLE_KEY deleted.
 * Observed there:
 *
 *   getScansForBrand("italicatiles.com")  -> threw ScansUnavailableError,
 *                                            code db_not_configured
 *   getScansByDomain("italicatiles.com")  -> returned []   (the fail-quiet)
 *   GET /api/brands/italicatiles.com/coverage
 *                                         -> 500 {"error":"Failed to load
 *                                            coverage data."}
 *   network requests made                 -> none
 *
 * The stack showed the throw leaving db.js from route.js:52, i.e. the FIRST
 * call. route.js:56 (getScansByDomain) was never reached, so the coverage route
 * never read the [] at all: its behaviour on an unconfigured deploy was 500
 * before R2.8.12 and is 500 after. The one caller that really read the lie was
 * scanWorker's loadPreviousRoster, which calls getScansByDomain directly.
 *
 * WHAT THIS FILE PINS. The structural reason the 404 story cannot be true, so
 * the corrected comment cannot silently rot back: both reads gate on the SAME
 * module-level `supabase` (getScansByDomain reaches it through resolveClient's
 * fallback), getScansForBrand runs first, and the route's own catch turns that
 * into a 500. If anyone ever makes the coverage route 404 on an unconfigured
 * deploy, this goes red and the comment must be rewritten with it.
 *
 * WHY ITS OWN FILE. db.js decides `supabase` once, at import time, from
 * process.env — "no credentials" is a property of the whole process, not of one
 * test. Same reasoning as scanByIdUnconfigured.route.test.mjs. `node --test`
 * gives one process per file.
 *
 * Nothing is stubbed: there is no client to stub and no request should be made,
 * which is asserted — a network call from this process would mean the branch
 * under test never ran.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// Cleared BEFORE the imports below: db.js decides `supabase` at import time.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

register("./cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
let GET = null;
let db = null;
try {
  const [route, dbModule] = await Promise.all([
    import("../app/api/brands/[brand]/coverage/route.js"),
    import("./db.js"),
  ]);
  GET = route.GET;
  db = dbModule;
} catch (error) {
  importError = error;
}

function requireUnconfigured() {
  assert.equal(
    importError,
    null,
    'Could not import the coverage route. If this says "Cannot find package", run `npm install` — ' +
      `otherwise the import itself is the failure: ${importError?.message}`
  );
  assert.equal(
    db.supabase,
    null,
    "this suite is only meaningful with NO client — the env above must really have been cleared"
  );
}

/** Runs `fn` with any network call turned into a test failure. */
async function withNoNetwork(fn) {
  const realFetch = globalThis.fetch;
  let reached = false;
  globalThis.fetch = async (url) => {
    reached = true;
    throw new Error(`the unconfigured path must not reach the network: ${String(url?.url || url)}`);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    assert.equal(reached, false, "no request may be made from a process with no client");
  }
}

async function callCoverage(brand) {
  const request = new Request(
    `http://localhost/api/brands/${encodeURIComponent(brand)}/coverage`
  );
  const response = await GET(request, { params: { brand: encodeURIComponent(brand) } });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

test("R2.8.15 — an unconfigured coverage read is 500, and was NEVER the 404 the old comment claimed", async () => {
  requireUnconfigured();

  const { status, body } = await withNoNetwork(() => callCoverage("italicatiles.com"));

  assert.equal(
    status,
    500,
    "an unconfigured deploy must answer 'we could not load this', not a verdict about the brand"
  );
  assert.notEqual(
    status,
    404,
    "404 is the claim the false comment in scansByDomainUnconfigured.test.mjs made about the " +
      "PRE-R2.8.12 route. It was not true then (measured at commit 220d93d: 500) and must not " +
      "become true now — a 404 here tells a customer with 38 scans they have never been scanned."
  );
  assert.deepEqual(
    body,
    { error: "Failed to load coverage data." },
    "the 500 body is the route's db-failure envelope, so the 500 came from the read and not from " +
      "some unrelated crash later in the handler"
  );
});

test("R2.8.15 — route.js:56 is unreachable unconfigured: BOTH reads gate on the same module client", async () => {
  requireUnconfigured();

  const forBrand = await db.getScansForBrand("italicatiles.com").then(
    () => ({ returned: true }),
    (error) => ({ code: error.code, name: error.name })
  );
  const byDomain = await db.getScansByDomain("italicatiles.com").then(
    () => ({ returned: true }),
    (error) => ({ code: error.code, name: error.name })
  );

  assert.deepEqual(
    forBrand,
    { code: "db_not_configured", name: "ScansUnavailableError" },
    "getScansForBrand is the FIRST call in the route's try block (route.js:52). It throwing is " +
      "why the second call never happens, which is why the 404 fall-through never happened."
  );
  assert.deepEqual(
    byDomain,
    { code: "db_not_configured", name: "ScansUnavailableError" },
    "and since R2.8.12 the second call refuses identically — resolveClient falls back to the " +
      "same module-level `supabase`, so there is no state in which one succeeds and the other does not"
  );
});
