/**
 * R2.8.12 — getScansByDomain must not fabricate "never scanned" out of a
 * missing database client.
 *
 * THE FINDING. src/lib/db.js getScansByDomain opened with
 * `const client = resolveClient(deps); if (!client) return [];`. R2.8.5 fixed
 * the error branch of the same function (a postgrest error now throws
 * ScansUnavailableError/db_read_failed) and left this one in place with a
 * comment naming it as a separate task — so on a deploy with no
 * NEXT_PUBLIC_SUPABASE_URL/ANON_KEY, every caller was told "this domain has no
 * scans". That is a factual claim about the customer's data manufactured
 * entirely from our own missing environment, and it is standing rule 1's exact
 * case: an empty state is not a clean one, and "we could not look" must not
 * arrive at the caller looking like "we looked and there was nothing".
 *
 * It was never a defensible degradation either: insertScan refuses to write
 * without a client (R2.8.6) and there is no memory fallback for scans, so a
 * process in this state could not possibly have anything to find. The []
 * carried no information at all.
 *
 * WHO READ THE LIE. Two production callers, both of which now see the throw:
 *   - src/app/api/brands/[brand]/coverage/route.js:56, whose surrounding catch
 *     turns any read failure into HTTP 500 "Failed to load coverage data."
 *     Before this change an unconfigured deploy fell through to `scans?.[0]`
 *     being undefined and returned 404 "never been scanned".
 *   - src/lib/workers/scanWorker.js:1824 (loadPreviousRoster), which runs ONLY
 *     when rival extraction is already offline and the carried-forward roster
 *     is the last honest one available. A [] there silently downgraded the scan
 *     to roster_source=unavailable — a label that claims we looked for previous
 *     rivals and found none.
 *
 * WHY THIS IS ITS OWN FILE. db.js decides `supabase` once, at import time, from
 * process.env — "no credentials" is a property of the whole process, not of one
 * test, exactly as scanByIdUnconfigured.route.test.mjs documents for R2.8.5's
 * sibling branch. dbReadOutage.route.test.mjs needs a client (it drives real
 * postgrest error envelopes through a refused socket); this file needs the
 * absence of one. `node --test` gives one process per file.
 *
 * Nothing is stubbed for the unconfigured tests: there is no client to stub and
 * no request should be made, which is asserted — a network call from this
 * process would mean the branch under test never ran. The injected-client tests
 * below use db.js's existing `deps.client` seam, the same one every other db
 * test uses, to cover the second way a caller reaches `!client`.
 */
import test from "node:test";
import assert from "node:assert/strict";

// Cleared BEFORE the import below: db.js builds `supabase` at import time.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { getScansByDomain, getScansForBrand, ScansUnavailableError, supabase } = await import(
  "./db.js"
);

function requireUnconfigured() {
  assert.equal(
    supabase,
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

test("R2.8.12 — an unconfigured process REFUSES the domain read, it never answers []", async () => {
  requireUnconfigured();

  let returned = "did not return";
  await withNoNetwork(async () => {
    await assert.rejects(
      async () => {
        returned = await getScansByDomain("italicatiles.com");
      },
      (err) => {
        assert.ok(
          err instanceof ScansUnavailableError,
          `expected ScansUnavailableError, got ${err?.name}: ${err?.message}`
        );
        assert.equal(
          err.code,
          "db_not_configured",
          "the code must say the DEPLOY is unconfigured, not that the read failed"
        );
        assert.match(
          err.message,
          /not configured/i,
          "an operator reading a failed job's error_message must see the cause"
        );
        return true;
      }
    );
  });

  assert.equal(
    returned,
    "did not return",
    "returning ANY value here — [] most of all — is the fabricated 'never scanned' this test exists to forbid"
  );
});

test("R2.8.12 — one error vocabulary: the domain read refuses exactly like getScansForBrand", async () => {
  requireUnconfigured();

  const byBrand = await getScansForBrand("Italica").then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  const byDomain = await getScansByDomain("italicatiles.com").then(
    (value) => ({ value }),
    (error) => ({ error })
  );

  assert.ok(byBrand.error, "getScansForBrand already refuses without a client (R2.8.4)");
  assert.ok(byDomain.error, "getScansByDomain must refuse the same way");
  assert.equal(byDomain.error.constructor, byBrand.error.constructor);
  assert.equal(byDomain.error.name, "ScansUnavailableError");
  assert.equal(
    byDomain.error.code,
    byBrand.error.code,
    "a caller that branches on db_not_configured must not need a second code for the domain lookup"
  );
});

test("R2.8.12 — an explicitly injected null client refuses too (the deps seam, not just the module one)", async () => {
  await withNoNetwork(async () => {
    await assert.rejects(
      () => getScansByDomain("italicatiles.com", { client: null }),
      (err) => err instanceof ScansUnavailableError && err.code === "db_not_configured"
    );
    await assert.rejects(
      () => getScansByDomain("italicatiles.com", { client: undefined }),
      (err) => err instanceof ScansUnavailableError && err.code === "db_not_configured"
    );
  });
});

/**
 * The other half of the contract. Refusing when we cannot look is only half the
 * distinction — a client that ANSWERS with no matching rows must still return a
 * plain [], or this change would have replaced one lie with a different one.
 */
test("R2.8.12 — THE OTHER HALF: a client that answers still returns a measured []", async () => {
  const SCAN = {
    id: "11111111-2222-3333-4444-555555555555",
    brand: "Italica",
    url: "https://www.italicatiles.com/tiles",
    scanned_at: "2026-09-01T00:00:00.000Z",
  };
  const clientReturning = (rows) => ({
    from: () => ({
      select: () => ({
        order: () => ({
          limit: async () => ({ data: rows, error: null }),
        }),
      }),
    }),
  });

  const measuredEmpty = await getScansByDomain("italicatiles.com", {
    client: clientReturning([]),
  });
  assert.deepEqual(measuredEmpty, [], "the DB answered and had nothing — that is a real empty");

  const noMatch = await getScansByDomain("someone-else.com", {
    client: clientReturning([SCAN]),
  });
  assert.deepEqual(noMatch, [], "rows that do not match the host are a real, measured empty");

  const found = await getScansByDomain("https://italicatiles.com/tiles", {
    client: clientReturning([SCAN]),
  });
  assert.equal(found.length, 1, "www/scheme/path variants still resolve to the brand");
  assert.equal(found[0].id, SCAN.id);
});

/**
 * A caller cannot tell "unconfigured" from "answered empty" unless the two
 * shapes differ at the call site. This is the assertion the finding is really
 * about, written the way a caller experiences it.
 */
test("R2.8.12 — 'we could not look' and 'nothing is there' are distinguishable at the call site", async () => {
  requireUnconfigured();

  const call = async (deps) => {
    try {
      return { kind: "answered", scans: await getScansByDomain("italicatiles.com", deps) };
    } catch (error) {
      return { kind: "unavailable", code: error.code };
    }
  };

  const answered = await call({
    client: {
      from: () => ({
        select: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
      }),
    },
  });
  const unavailable = await call(undefined); // the real, unconfigured module client

  assert.deepEqual(answered, { kind: "answered", scans: [] });
  assert.deepEqual(unavailable, { kind: "unavailable", code: "db_not_configured" });
  assert.notEqual(
    answered.kind,
    unavailable.kind,
    "if these collapsed, the dashboard would again invite a user to run their first scan during an outage"
  );
});
