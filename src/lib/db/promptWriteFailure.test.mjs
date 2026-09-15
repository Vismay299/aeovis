import test from "node:test";
import assert from "node:assert/strict";
import {
  upsertPrompts,
  updatePromptStatus,
  disablePrompt,
  PromptWriteError,
} from "./prompts.js";
import {
  runSourcingPhase,
  sourceUnbrandedQueries,
  createChunkTally,
  summarizeSkips,
  CHUNK_SKIP_REASONS,
} from "../workers/scanWorker.js";

/**
 * R2.2.3 / finding B5 — upsertPrompts is a CREATE. It may not fail soft.
 *
 * What it looked like before:
 *
 *   export async function upsertPrompts(brand, prompts) {
 *     if (!supabase) return { error: new Error("Supabase client is not initialized.") };
 *     try {
 *       ...
 *       const { data, error } = await supabase.from("brand_prompts").upsert(rows, ...);
 *       return { data, error };          // <- the failure IS the return value
 *     } catch (e) {
 *       return { error: e };
 *     }
 *   }
 *
 * The cost of that was not theoretical. scanWorker.js wraps BOTH of its
 * upsertPrompts calls in try/catch — runSourcingPhase counts and names the
 * swallow, sourceUnbrandedQueries' legacy migration aborts the scan — and
 * NEITHER catch could fire, because a resolved object is not a thrown error.
 * A scan whose tracked prompt set never persisted reported a clean sourcing
 * phase with skips_total 0.
 *
 * Every assertion here is written to FAIL against that code: `assert.rejects`
 * on a function that resolves `{ error }` fails, and the tally assertions fail
 * because nothing was ever recorded.
 *
 * NO DATABASE IS TOUCHED. `deps.client` is injected on every direct call, and
 * the two worker tests bind the REAL upsertPrompts to a hand-rolled recorder
 * before injecting it — so the real helper's real failure path runs, and the
 * module-level `supabase` binding is never consulted. This suite is inert
 * whether or not credentials happen to be in the shell.
 */

// ---------------------------------------------------------------------------
// A PostgREST-shaped recorder. postgrest-js does not REJECT on a failed
// statement — it resolves `{ data: null, error }` — which is exactly why the
// old code could look like it was handling errors while handling nothing.
// ---------------------------------------------------------------------------

const OK_SELECT = { data: [], error: null };
const OK_UPSERT = { data: null, error: null };

function makeClient({ select = OK_SELECT, upsert = OK_UPSERT, update = { data: [], error: null } } = {}) {
  const calls = { select: [], upsert: [], update: [] };
  const client = {
    calls,
    from(table) {
      // One operation per builder; `.update(...).select()` must stay an update.
      let op = null;
      const claim = (name) => {
        if (op === null) op = name;
      };
      const builder = {
        select(cols) {
          claim("select");
          if (op === "select") calls.select.push({ table, cols });
          return builder;
        },
        upsert(rows, opts) {
          claim("upsert");
          calls.upsert.push({ table, rows, opts });
          return builder;
        },
        update(patch) {
          claim("update");
          calls.update.push({ table, patch });
          return builder;
        },
        eq() {
          return builder;
        },
        order() {
          return builder;
        },
        then(resolve) {
          const answer = op === "upsert" ? upsert : op === "update" ? update : select;
          resolve(typeof answer === "function" ? answer() : answer);
        },
      };
      return builder;
    },
  };
  return client;
}

const PROMPTS = Object.freeze([
  Object.freeze({ text: "best crm for startups", intent_tier: "informational", topic: "General" }),
]);

async function capture(fn) {
  try {
    return { resolved: await fn(), threw: null };
  } catch (err) {
    return { resolved: undefined, threw: err };
  }
}

// ---------------------------------------------------------------------------
// 1. No client — a refusal, never `{ error }` handed back as a value.
// ---------------------------------------------------------------------------

test("upsertPrompts — with no client it REJECTS; it never resolves an error object", async () => {
  const { resolved, threw } = await capture(() => upsertPrompts("acme.com", PROMPTS, { client: null }));

  // The exact regression. Pre-R2.2.3 this line is what fires: the call
  // resolved, and the failure was hiding inside the value.
  assert.ok(
    threw,
    "upsertPrompts must refuse when there is no client. It resolved instead, with " +
      JSON.stringify(resolved)
  );
  assert.ok(threw instanceof PromptWriteError, `expected PromptWriteError, got ${threw && threw.name}`);
  assert.equal(
    threw.code,
    "db_not_configured",
    "a deployment with no credentials is an env-var problem, not a database problem — " +
      "the operator reading this must be able to tell which"
  );
  assert.match(threw.message, /Nothing was written/);
});

// ---------------------------------------------------------------------------
// 2. The database answered, and it said no.
// ---------------------------------------------------------------------------

test("upsertPrompts — a PostgREST error becomes a throw with the envelope preserved", async () => {
  const pgError = { message: "duplicate key value violates unique constraint", code: "23505" };
  const client = makeClient({ upsert: { data: null, error: pgError } });

  const { resolved, threw } = await capture(() => upsertPrompts("acme.com", PROMPTS, { client }));

  assert.ok(
    threw,
    "a rejected write must reject. It resolved instead, with " + JSON.stringify(resolved)
  );
  assert.equal(threw.code, "db_write_failed", "a database that refused the row is not a missing env var");
  assert.match(threw.message, /duplicate key value/, "the operator needs the database's own words");
  assert.equal(threw.cause, pgError, "the error envelope must survive, not be flattened to a string");
  assert.equal(client.calls.upsert.length, 1, "the statement was genuinely attempted");
});

test("upsertPrompts — a client that THROWS (socket/DNS) is classified the same way", async () => {
  const client = {
    from() {
      throw new TypeError("fetch failed");
    },
  };
  // The preload read fails first here — that is still a write that did not
  // happen, and it must still be a throw.
  const { threw } = await capture(() => upsertPrompts("acme.com", PROMPTS, { client }));
  assert.ok(threw instanceof PromptWriteError);
  assert.equal(threw.code, "db_write_failed");
});

// ---------------------------------------------------------------------------
// 3. The read this write DEPENDS on may not fail quiet either.
// ---------------------------------------------------------------------------

test("upsertPrompts — if the existing set cannot be read, NOTHING is written", async () => {
  const client = makeClient({
    select: { data: null, error: { message: "connection terminated unexpectedly" } },
  });

  const { threw } = await capture(() => upsertPrompts("acme.com", PROMPTS, { client }));

  assert.ok(threw instanceof PromptWriteError, "a preload failure is a failed write, not a fresh brand");
  assert.equal(threw.code, "db_write_failed");
  assert.match(threw.message, /connection terminated/);
  // THE POINT. That read decides whether a conflicting row keeps its `enabled`
  // flag and custom weight. If it fail-quiets to [], the upsert still runs and
  // rewrites every row with the caller's defaults (enabled: true, weight 1.0),
  // silently re-enabling prompts the user turned off.
  assert.equal(
    client.calls.upsert.length,
    0,
    "a blind write would reset every disabled flag and hand-tuned weight with no error anywhere"
  );
});

// ---------------------------------------------------------------------------
// 4. The success path is unchanged, including for the one caller that
//    destructures the result.
// ---------------------------------------------------------------------------

test("upsertPrompts — a successful write resolves, preserves existing flags, and stays destructurable", async () => {
  const client = makeClient({
    select: {
      data: [
        {
          text: "Best CRM for startups",
          enabled: false,
          weight: 0.25,
          source: "user_added",
        },
      ],
      error: null,
    },
  });

  // POST /api/brands/[brand]/prompts does `const { error } = await upsertPrompts(...)`.
  // That destructure must keep working, and `error` must be null on success.
  const { data, error } = await upsertPrompts("acme.com", PROMPTS, { client });
  assert.equal(error, null, "on the resolved path there is no error — a real one has already been thrown");
  assert.equal(data, null, "the upsert does not .select(), so PostgREST answers data:null on SUCCESS");

  const row = client.calls.upsert[0].rows[0];
  assert.equal(row.enabled, false, "a disabled prompt stays disabled");
  assert.equal(row.weight, 0.25, "a hand-tuned weight is preserved");
  assert.equal(row.source, "user_added");
});

// ---------------------------------------------------------------------------
// 5. THE ACCEPT: the worker's catch now fires. Real runSourcingPhase, real
//    upsertPrompts — only the client is fake.
// ---------------------------------------------------------------------------

test("runSourcingPhase — a real failed prompt write is COUNTED AND NAMED, not silently absorbed", async () => {
  const client = makeClient({ upsert: { data: null, error: { message: "brand_prompts write refused" } } });
  const tally = createChunkTally();
  const pool = Array.from({ length: 4 }, (_, i) => ({
    text: `unbranded seed ${i}`,
    intent_tier: "informational",
    topic: "General",
    weight: 1,
    enabled: true,
    source: "llm_generated",
    created_at: "2026-07-01T00:00:00Z",
  }));

  const warn = console.warn;
  console.warn = () => {};
  let checkpoint;
  try {
    checkpoint = await runSourcingPhase(
      { brand: "Acme", url: "acme.com", industry: "saas", competitors: "" },
      {
        promptTarget: 4,
        getPromptsForBrand: async () => pool,
        // The REAL helper. Only the client is injected.
        upsertPrompts: (brand, rows) => upsertPrompts(brand, rows, { client }),
        generateUnbrandedPrompts: async () => {
          throw new Error("must not generate — pool is already full");
        },
        buildBrandedQueries: () => [
          { text: "acme", source: "branded_seed", topic: "Brand Presence", intent_tier: "branded" },
        ],
        resolveEnabledEngines: () => [{ name: "aio" }],
      },
      tally
    );
  } finally {
    console.warn = warn;
  }

  assert.ok(checkpoint, "the phase still completes — the prompts are usable for THIS scan");

  const skip = tally.skips.find((s) => s.reason === CHUNK_SKIP_REASONS.PROMPT_PERSIST_FAILED);
  // Pre-R2.2.3 this is the failing line: upsertPrompts resolved `{ error }`,
  // the worker's catch never ran, and the scan reported skips_total 0 while
  // the next scan's tracked prompt set quietly did not exist.
  assert.ok(
    skip,
    "the worker's catch must fire on a real write failure. It did not: skips are " +
      JSON.stringify(tally.skips)
  );
  assert.match(skip.sample[0], /brand_prompts write refused/, "the reason must carry the database's words");
  assert.ok(tally.errorsRecovered >= 1, "an absorbed error is still an error that happened");
  assert.ok(summarizeSkips(tally).skips_total >= 1, "and it must reach the scan_runs row");
});

test("sourceUnbrandedQueries — a failed legacy migration ABORTS the scan instead of rescoring on a new set", async () => {
  const client = makeClient({ upsert: { data: null, error: { message: "brand_prompts write refused" } } });
  const legacy = Array.from({ length: 3 }, (_, i) => ({
    text: `legacy seed ${i}`,
    intent_tier: "informational",
    topic: "General",
    weight: 1,
    enabled: true,
    source: "llm_generated",
    created_at: "2026-07-01T00:00:00Z",
  }));

  const { threw } = await capture(() =>
    sourceUnbrandedQueries("Acme", "acme.com", "saas", { cost: 0, tokens: 0 }, ["acme"], {
      promptTarget: 3,
      // Empty under the canonical key, populated under the legacy brand name.
      getPromptsForBrand: async (key) => (key === "acme.com" ? [] : legacy),
      upsertPrompts: (brand, rows) => upsertPrompts(brand, rows, { client }),
      generateUnbrandedPrompts: async () => {
        throw new Error("must not generate — the migration should have aborted first");
      },
    })
  );

  assert.ok(threw, "a migration that did not persist must abort the scan, not proceed on a re-generated set");
  assert.match(threw.message, /Couldn't migrate the tracked prompt set/);
  assert.match(threw.message, /brand_prompts write refused/, "and it must name what actually failed");
});

// ---------------------------------------------------------------------------
// 6. updatePromptStatus — the boolean variant of the same sin. `false` used to
//    mean three different things; its only caller maps it to a 404.
// ---------------------------------------------------------------------------

test("updatePromptStatus — no client REJECTS rather than reporting 'prompt not found'", async () => {
  const { resolved, threw } = await capture(() => updatePromptStatus("p-1", false, { client: null }));
  assert.ok(threw, "it resolved instead, with " + JSON.stringify(resolved));
  assert.equal(threw.code, "db_not_configured");
});

test("updatePromptStatus — a DB error REJECTS rather than reporting 'prompt not found'", async () => {
  const client = makeClient({ update: { data: null, error: { message: "permission denied for table" } } });
  const { resolved, threw } = await capture(() => updatePromptStatus("p-1", false, { client }));
  assert.ok(threw, "it resolved instead, with " + JSON.stringify(resolved));
  assert.equal(threw.code, "db_write_failed");
  assert.match(threw.message, /permission denied/);
});

test("updatePromptStatus — a genuinely absent row still returns false, and that is the ONLY false", async () => {
  const found = makeClient({ update: { data: [{ id: "p-1", enabled: false }], error: null } });
  const absent = makeClient({ update: { data: [], error: null } });

  assert.equal(await updatePromptStatus("p-1", false, { client: found }), true);
  assert.equal(
    await updatePromptStatus("p-404", false, { client: absent }),
    false,
    "the DB answered and no row carries this id — a real measurement, and the only thing false may mean"
  );
  // disablePrompt is a thin delegate; it inherits both halves of the contract.
  assert.equal(await disablePrompt("p-1", { client: found }), true);
  const { threw } = await capture(() => disablePrompt("p-1", { client: null }));
  assert.equal(threw && threw.code, "db_not_configured");
});
