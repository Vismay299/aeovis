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
 * WHO READ THE LIE. Exactly ONE production caller did — corrected under R2.8.15,
 * because the first version of this comment claimed a second one that provably
 * did not, and a false history in a permanent artifact is the very thing this
 * rebuild exists to remove.
 *
 *   - src/lib/workers/scanWorker.js:1827 (loadPreviousRoster) is the real
 *     reader. It runs ONLY when rival extraction is already offline and the
 *     carried-forward roster is the last honest one available, and it calls
 *     getScansByDomain directly. A [] there silently downgraded the scan to
 *     roster_source=unavailable — a label that claims we looked for previous
 *     rivals and found none.
 *
 *   - src/app/api/brands/[brand]/coverage/route.js:56 did NOT, and the original
 *     version of this comment was wrong to say it "fell through to `scans?.[0]`
 *     being undefined and returned 404 never been scanned". MEASURED, not
 *     reasoned: the pre-fix tree was checked out at commit 220d93d — the last
 *     commit before the R2.8.12 commit 0c505a5 to touch src/. 0c505a5's actual
 *     parent is ea165ed, which is ledger-only (tasks.json and docs/plans/), so
 *     `git diff 220d93d 0c505a5^ -- src/` is empty and 220d93d is the same
 *     source tree R2.8.12 was applied to. (220d93d is the GRANDparent, not the
 *     parent; the first correction of this paragraph said "parent" and was
 *     itself wrong. `git rev-list --parents -n 1 0c505a5` shows the one parent
 *     ea165ed.) GET was driven there with the Supabase env cleared.
 *     getScansForBrand at route.js:52 threw ScansUnavailableError/
 *     db_not_configured FIRST — both functions gate on the same module-level
 *     `supabase` (getScansByDomain via resolveClient, which falls back to it) —
 *     so the route's own catch returned HTTP 500 "Failed to load coverage data."
 *     and line 56 never executed. Observed: getScansForBrand threw
 *     db_not_configured, getScansByDomain returned [] when called on its own,
 *     route status 500, no network request made. The coverage route's behaviour
 *     on an unconfigured deploy is therefore UNCHANGED by R2.8.12: 500 before,
 *     500 after. The 404 story never happened. (The R2.8.12 submit note said
 *     500; the file said 404; the file was the one that shipped, which is why
 *     this correction matters more than the two db.js guards filed with it.)
 *
 *     WHERE THE 404 STORY CAME FROM, since a wrong claim usually has a true
 *     ancestor: it describes the pre-R2.8.4 world, one fix earlier. Restoring
 *     BOTH fail-quiets by mutation — getScansForBrand's `if (!supabase) return
 *     []` (R2.8.4's) as well as getScansByDomain's (R2.8.12's) — does make the
 *     route 404. Restoring only R2.8.12's leaves it at 500. So the comment was
 *     true of a tree that stopped existing before the change it was written to
 *     describe. coverageUnconfigured.route.test.mjs pins both halves.
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

const { getScansByDomain, getScansForBrand, listRecentScans, ScansUnavailableError, supabase } =
  await import("./db.js");

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

/* -------------------------------------------------------------------------
 * R2.8.15 — the two fail-quiet reads R2.8.12 left in db.js.
 *
 * (a) getScansByDomain's blank-`domain` guard. It returned [] and its own
 *     comment conceded it was "arguably too quiet". It is reachable ONLY with a
 *     live client (the !client refusal runs first), so it can never mask an
 *     unreachable database — which is exactly why it is an ARGUMENT error and
 *     needs its own code rather than db_not_configured. scanWorker's
 *     loadPreviousRoster passes `url || promptKey`; a checkpoint carrying
 *     neither reached it and got a silent no-history.
 *
 * (b) listRecentScans, which opened `if (!supabase) return []` — the homepage
 *     workspace rendered an unconfigured deploy as "no brands yet". Same family
 *     as R2.8.4/R2.8.5/R2.8.12 and the last one in db.js's `!client` line.
 * ---------------------------------------------------------------------- */

/** A client that answers, so the blank-domain branch is actually reachable. */
const answeringClient = (rows = []) => ({
  from: () => ({
    select: () => ({ order: () => ({ limit: async () => ({ data: rows, error: null }) }) }),
  }),
});

test("R2.8.15 — a blank domain is REFUSED as an argument error, not answered with []", async () => {
  for (const blank of [undefined, null, "", "   ", "https://", "www.", "/"]) {
    let returned = "did not return";
    await assert.rejects(
      async () => {
        returned = await getScansByDomain(blank, { client: answeringClient([]) });
      },
      (err) => {
        assert.ok(
          err instanceof ScansUnavailableError,
          `expected ScansUnavailableError for ${JSON.stringify(blank)}, got ${err?.name}`
        );
        assert.equal(
          err.code,
          "domain_required",
          `a blank domain (${JSON.stringify(blank)}) is a bad ARGUMENT — it must not be reported ` +
            "as db_not_configured (which blames the deploy) nor as a measured empty"
        );
        assert.match(
          err.message,
          /no domain was supplied/i,
          "an operator reading a failed job's error_message must see WHICH argument was missing"
        );
        return true;
      },
      `getScansByDomain(${JSON.stringify(blank)}) must refuse, it must not answer "never scanned"`
    );
    assert.equal(
      returned,
      "did not return",
      `returning ${JSON.stringify(returned)} for ${JSON.stringify(blank)} is the silent ` +
        "no-history this test exists to forbid"
    );
  }
});

test("R2.8.15 — THREE outcomes stay distinguishable: bad argument / measured empty / no database", async () => {
  requireUnconfigured();

  const call = async (domain, deps) => {
    try {
      return { kind: "answered", scans: await getScansByDomain(domain, deps) };
    } catch (error) {
      return { kind: "refused", type: error.constructor.name, code: error.code };
    }
  };

  const badArgument = await call("", { client: answeringClient([]) });
  const measuredEmpty = await call("italicatiles.com", { client: answeringClient([]) });
  const noDatabase = await call("italicatiles.com", undefined); // real unconfigured client

  assert.deepEqual(badArgument, {
    kind: "refused",
    type: "ScansUnavailableError",
    code: "domain_required",
  });
  assert.deepEqual(measuredEmpty, { kind: "answered", scans: [] });
  assert.deepEqual(noDatabase, {
    kind: "refused",
    type: "ScansUnavailableError",
    code: "db_not_configured",
  });

  // ONE vocabulary: both refusals are the same class, so a caller branches once
  // on `instanceof` and only then reads `code`. No third error type was added.
  assert.equal(
    badArgument.type,
    noDatabase.type,
    "adding a second error class here would force every caller to grow a second catch arm"
  );
  assert.notEqual(
    badArgument.code,
    noDatabase.code,
    "'you asked about no domain' and 'the deploy has no database' must not share a code — " +
      "an operator would go and check the environment for a bug in the caller"
  );
  assert.notEqual(
    badArgument.kind,
    measuredEmpty.kind,
    "a bad argument must not arrive looking like a domain that has genuinely never been scanned"
  );
});

test("R2.8.15 — the blank-domain refusal happens BEFORE any query is issued", async () => {
  let queried = false;
  const spyClient = {
    from: () => {
      queried = true;
      return {
        select: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
      };
    },
  };
  await assert.rejects(
    () => getScansByDomain("   ", { client: spyClient }),
    (err) => err.code === "domain_required"
  );
  assert.equal(
    queried,
    false,
    "refusing after spending a 200-row read would make the guard a lie about cost, not just about shape"
  );
});

test("R2.8.15 — listRecentScans REFUSES on an unconfigured process, it never answers []", async () => {
  requireUnconfigured();

  let returned = "did not return";
  await withNoNetwork(async () => {
    await assert.rejects(
      async () => {
        returned = await listRecentScans(12);
      },
      (err) => {
        assert.ok(
          err instanceof ScansUnavailableError,
          `expected ScansUnavailableError, got ${err?.name}: ${err?.message}`
        );
        assert.equal(
          err.code,
          "db_not_configured",
          "the homepage workspace must be told the DEPLOY is unconfigured, not that it has no brands"
        );
        assert.match(err.message, /not configured/i);
        return true;
      },
      "listRecentScans answering [] renders an unconfigured deploy as an empty workspace"
    );
  });

  assert.equal(
    returned,
    "did not return",
    "an empty array here is indistinguishable on screen from a real first-run workspace"
  );
});

test("R2.8.15 — one vocabulary: listRecentScans refuses exactly like getScansForBrand", async () => {
  requireUnconfigured();

  const byBrand = await getScansForBrand("Italica").then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  const recent = await listRecentScans(12).then(
    (value) => ({ value }),
    (error) => ({ error })
  );

  assert.ok(byBrand.error, "getScansForBrand already refuses without a client (R2.8.4)");
  assert.ok(recent.error, "listRecentScans must refuse the same way (R2.8.15)");
  assert.equal(recent.error.constructor, byBrand.error.constructor);
  assert.equal(recent.error.name, "ScansUnavailableError");
  assert.equal(
    recent.error.code,
    byBrand.error.code,
    "a caller that already branches on db_not_configured must not need a third code for the homepage"
  );
});
