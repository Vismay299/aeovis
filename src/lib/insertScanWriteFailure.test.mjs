import test from "node:test";
import assert from "node:assert/strict";
import { insertScan, ScanWriteError } from "./db.js";

/**
 * R2.8.6 / finding A1 — insertScan is a CREATE. It may not fail soft.
 *
 * The behaviour under test, and what it looked like before:
 *
 *   export async function insertScan(scanRecord) {
 *     if (!supabase) {
 *       console.warn("Supabase credentials missing. Skipping database insert.");
 *       return;                      // <- undefined, to a caller reading [0].id
 *     }
 *
 * Every assertion in this file is written so that it FAILS against that code:
 * `assert.rejects` on a function that resolves `undefined` fails, and the
 * `code` assertions fail because there was no discriminator to read at all.
 *
 * NO DATABASE IS TOUCHED. `deps.client` is injected on every call — `null` for
 * the not-configured cases, a hand-rolled recorder for the write-failure ones.
 * The module-level `supabase` binding is never consulted and never reached, so
 * this suite is inert whether or not credentials happen to be in the shell.
 * (src/lib/liveWriteGuardAuto.mjs is preloaded by `npm run test:scoring` and
 * would refuse a real write anyway; this file does not rely on that.)
 */

const RECORD = Object.freeze({
  brand: "Acme",
  url: "acme.com",
  results: [],
  competitors: [],
});

/**
 * Minimal PostgREST-shaped builder. `.insert(...).select()` awaits to whatever
 * `resolve` returns, so a test can make insertScan's write answer with an error
 * the way a live client does — postgrest-js does not reject on a failed
 * statement, it resolves `{ data: null, error }`. `calls` also counts the
 * ATTEMPTS, which R2.2.4 pinned at exactly one.
 */
function clientThatAnswers(resolve) {
  const calls = [];
  return {
    calls,
    from(table) {
      const builder = {
        insert(rows) {
          calls.push({ table, rows });
          return builder;
        },
        select() {
          return builder;
        },
        then(ok) {
          ok(resolve(calls.length));
        },
      };
      return builder;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. No client: a refusal, never a quiet undefined.
// ---------------------------------------------------------------------------

test("insertScan — with no client it REJECTS; it never resolves undefined", async () => {
  let resolvedWith;
  let threw = null;
  try {
    resolvedWith = await insertScan(RECORD, { client: null });
  } catch (err) {
    threw = err;
  }

  // The exact regression. Pre-R2.8.6 this line is what fires: the call
  // resolved, and it resolved with nothing.
  assert.ok(
    threw,
    "insertScan must refuse when there is no client. It resolved instead, with " +
      `${resolvedWith === undefined ? "undefined" : JSON.stringify(resolvedWith)} — ` +
      "a caller reading savedScan?.[0]?.id cannot tell that from an insert that " +
      "returned no rows, and nothing was written."
  );
  assert.equal(resolvedWith, undefined, "nothing should have been returned at all");
});

test("insertScan — the no-client refusal is a typed, discriminable failure", async () => {
  await assert.rejects(
    () => insertScan(RECORD, { client: null }),
    (err) => {
      assert.ok(
        err instanceof ScanWriteError,
        `expected a ScanWriteError, got ${err?.name}: ${err?.message}`
      );
      assert.equal(
        err.code,
        "db_not_configured",
        "a missing client and a rejected insert are different facts and must " +
          "carry different codes — an operator fixes one with env vars and the " +
          "other with the database"
      );
      // Same code vocabulary R2.8.4 established for the read side.
      assert.match(err.message, /not configured/i);
      return true;
    }
  );
});

test("insertScan — an undefined deps.client is still a refusal, not the ambient one", async () => {
  // `resolveClient` uses hasOwnProperty, so an explicit `undefined` is an
  // explicit "no client" and must not silently fall back to module-level
  // `supabase`. If it did, this test could reach a real database.
  await assert.rejects(
    () => insertScan(RECORD, { client: undefined }),
    (err) => err instanceof ScanWriteError && err.code === "db_not_configured"
  );
});

// ---------------------------------------------------------------------------
// 2. The client is there but the write fails: a different code, same contract.
// ---------------------------------------------------------------------------

test("insertScan — a failed write throws db_write_failed and preserves the error envelope", async () => {
  const pgError = {
    message: 'null value in column "brand" violates not-null constraint',
    code: "23502",
    details: "Failing row contains (…)",
  };
  const client = clientThatAnswers(() => ({ data: null, error: pgError }));

  await assert.rejects(
    () => insertScan(RECORD, { client }),
    (err) => {
      assert.ok(err instanceof ScanWriteError, `expected ScanWriteError, got ${err?.name}`);
      assert.equal(err.code, "db_write_failed", "a live client that refused the row is not a config problem");
      assert.notEqual(err.code, "db_not_configured");
      // Standing rule 2: preserve the error envelope. The PostgREST object
      // (code/details/hint) must survive, not be flattened to a string.
      assert.equal(err.cause?.code, "23502", "the original PostgREST error must be reachable via cause");
      assert.equal(err.cause?.details, pgError.details);
      assert.match(err.message, /Acme/, "the message should name the scan that was lost");
      assert.match(err.message, /not-null constraint/, "and why the database refused it");
      return true;
    }
  );

  // R2.2.4: one attempt, not three. A refused insert used to be answered with
  // two progressively thinner rows, the last of which could SUCCEED and be
  // reported as an unqualified write.
  assert.equal(
    client.calls.length,
    1,
    "a refused insert must not be retried with fewer columns — that is the column-drop cascade"
  );
});

test("insertScan — a successful write returns the inserted rows, unchanged", async () => {
  // The success path must not have been collateral damage: a normal answer
  // still resolves with the rows PostgREST returned.
  const client = clientThatAnswers(() => ({ data: [{ id: "scan-1" }], error: null }));
  const rows = await insertScan(RECORD, { client });
  assert.deepEqual(rows, [{ id: "scan-1" }]);
  assert.equal(client.calls.length, 1, "the write succeeded; nothing should have run twice");
});

// ---------------------------------------------------------------------------
// 3. The caller. A throw that some caller wraps in a bare catch is no better
//    than the undefined it replaced, so assert the one production caller's
//    contract directly rather than stopping at the function boundary.
// ---------------------------------------------------------------------------

test("runFinalizePhase — a real insertScan refusal propagates; the job is never completed", async () => {
  const { runFinalizePhase } = await import("./workers/scanWorker.js");

  const JOB_ID = "job-r286";
  const queries = Array.from({ length: 3 }, (_, i) => ({
    text: `query ${i}`,
    source: "llm_generated",
    topic: "General",
    intent_tier: "informational",
  }));
  const promptRows = queries.map((q, i) => ({
    id: `pr-${i}`,
    job_id: JOB_ID,
    engine: "aio",
    query: q.text,
    scan_id: null,
    created_at: new Date(Date.UTC(2026, 7, 30, 9, i)).toISOString(),
    raw: {
      engine: "aio",
      prompt: q.text,
      topic: "General",
      intent_tier: "informational",
      answer_present: true,
      aio_present: true,
      text: `Answer about ${q.text}`,
      citations: [],
      references: [],
      brand_mentioned_in_text: true,
      brand_cited: false,
      visible: true,
      competitors_found_in_text: [],
      competitors_cited: [],
      brands: [],
      error: null,
      cost: 0.001,
    },
  }));

  const jobUpdates = [];
  const checkpoint = {
    brand: "Acme",
    url: "acme.com",
    industry: "saas",
    competitors: [],
    competitors_raw: "",
    prompt_key: "acme.com",
    queries,
    unbranded_texts: queries.map((q) => q.text),
    engines: ["aio"],
    stats: { cost: 0, tokens: 0 },
    sourced_at: new Date().toISOString(),
  };

  // Everything is injected. The ONLY real function in this call is
  // insertScan — driven with an explicitly null client, which is the exact
  // production shape of "credentials are missing", not a hand-written
  // throwing stub. No network, no database.
  const deps = {
    getPromptResultsForJob: async () => promptRows,
    claimJobStatus: async (jobId, from, to) => ({ id: jobId, status: to }),
    updateScanJob: async (jobId, updates) => {
      jobUpdates.push(updates);
      return { id: jobId, ...updates };
    },
    insertScan: (record) => insertScan(record, { client: null }),
    stampScanIdForJob: async () => assert.fail("must not stamp a scan_id for a scan that was never written"),
    deleteCitationsForJob: async () => 0,
    insertCitations: async () => [],
    deleteResultBrandsForJob: async () => 0,
    insertResultBrands: async () => [],
    upsertBrandMetricsDaily: async () => [],
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => [],
    getScansByDomain: async () => [],
    getResultBrandsForScan: async () => [],
    enrichCitations: async (rows) => rows,
    judgeBrandsSymmetric: async () => [],
  };

  let failure = null;
  try {
    await runFinalizePhase(JOB_ID, checkpoint, deps);
  } catch (err) {
    failure = err;
  }

  assert.ok(
    failure,
    "finalize must not resolve when the scan could not be written — a job that " +
      "reports done with nothing in `scans` is the 201-with-nothing-persisted " +
      "shape R0.1.4 was saved from by luck"
  );
  assert.match(
    failure.message,
    /Failed to save scan results/,
    `finalize should surface the write failure; got: ${failure.message}`
  );
  // The improvement over pre-R2.8.6. The old code resolved `undefined`, the
  // caller could only say "insertScan did not return a saved record id", and
  // an operator reading the failed job had no way to know the deployment had
  // no credentials. Now the cause rides the message all the way out.
  assert.match(
    failure.message,
    /not configured/i,
    "the failure must name WHY the write did not happen, not just that no id " +
      `came back. Got: ${failure.message}`
  );

  assert.equal(
    jobUpdates.some((u) => u.status === "complete"),
    false,
    "the job must never be marked complete when nothing was persisted"
  );
  assert.equal(
    jobUpdates.some((u) => Object.prototype.hasOwnProperty.call(u, "result_id")),
    false,
    "and must never be stamped with a result_id"
  );
});
