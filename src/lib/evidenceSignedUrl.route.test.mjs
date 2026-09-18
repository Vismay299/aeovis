/**
 * R1.5.3 — GET /api/scan/[job_id]/evidence, observed at the REAL handler.
 *
 * Every assertion below drives a real `Request` through the real exported route
 * and reads the real `Response`. Nothing about the route, the signing module or
 * NextResponse is stubbed; `cronAuth.route.hooks.mjs` only answers "which file
 * is this specifier" for `@/...`, which is the one thing Next's bundler would
 * otherwise have answered.
 *
 * TWO SEAMS ARE INJECTED, both through the handler's third argument, and both
 * are things this environment genuinely does not have:
 *   * `getScanJob` — there is no database here.
 *   * `client` / `storage` — there is no Supabase project and no bucket. The
 *     fake storage RECORDS the arguments it was handed, which is how the
 *     expiry and the object key are proved: not "the route probably passes the
 *     TTL", but "createSignedUrl was called with exactly ('<stored id>', 120)".
 *
 * The NULL case is the one that matters most today, because it is the only case
 * production can currently produce: no probe adapter writes evidence yet (R1.3
 * is unbuilt), so every real `evidence_screenshot_id` is NULL. A route that
 * fabricated a key from the job id would look perfectly healthy on this branch
 * and 404 from Storage a month from now.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

process.env.NODE_ENV = "development";
delete process.env.VERCEL_ENV;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

register("./cronAuth.route.hooks.mjs", import.meta.url);

const { GET } = await import("../app/api/scan/[job_id]/evidence/route.js");
const { EVIDENCE_SIGNED_URL_TTL_SECONDS, EVIDENCE_KIND_COLUMNS, signEvidenceForResult } = await import(
  "./evidenceSignedUrl.js"
);

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const RESULT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_RESULT_ID = "33333333-3333-4333-8333-333333333333";
/** The stored object key, exactly as §3.7 says an evidence id looks. */
const STORED_KEY = `${JOB_ID}/perplexity/${RESULT_ID}.png`;

/**
 * A minimal PostgREST-shaped client over one array of rows. Only the calls the
 * module actually makes are implemented, so a change in HOW it queries breaks
 * this file loudly instead of passing on a mock that answers anything.
 */
function fakeClient(rows, { error = null } = {}) {
  const calls = [];
  const builder = (table) => {
    const filters = {};
    const chain = {
      select(columns) {
        calls.push({ table, columns, filters });
        return chain;
      },
      eq(column, value) {
        filters[column] = value;
        return chain;
      },
      limit() {
        if (error) return Promise.resolve({ data: null, error });
        const matched = rows.filter((row) => Object.entries(filters).every(([k, v]) => row[k] === v));
        return Promise.resolve({ data: matched.slice(0, 1), error: null });
      },
    };
    return chain;
  };
  return { from: builder, calls };
}

/** Records every createSignedUrl(key, expiresIn) it is handed. */
function fakeStorage({ error = null, url = "https://storage.example.test/signed?token=EXAMPLE" } = {}) {
  const signed = [];
  return {
    signed,
    async createSignedUrl(key, expiresIn) {
      signed.push({ key, expiresIn });
      if (error) return { data: null, error };
      return { data: { signedUrl: url }, error: null };
    },
  };
}

const row = (overrides = {}) => ({
  id: RESULT_ID,
  job_id: JOB_ID,
  evidence_screenshot_id: STORED_KEY,
  evidence_dom_id: null,
  evidence_har_id: null,
  evidence_raw_id: null,
  evidence_captured_at: "2026-09-19T10:00:00.000Z",
  ...overrides,
});

const jobFound = async () => ({ id: JOB_ID, status: "complete" });
const jobMissing = async () => null;

function call({ job = jobFound, rows = [row()], storage = fakeStorage(), query = `result=${RESULT_ID}`, clientError = null } = {}) {
  const client = fakeClient(rows, { error: clientError });
  const request = new Request(`https://example.test/api/scan/${JOB_ID}/evidence?${query}`);
  return GET(request, { params: { job_id: JOB_ID } }, { getScanJob: job, client, storage }).then((response) => ({
    response,
    storage,
    client,
  }));
}

test("R1.5.3 — a stored screenshot answers 302 to a signed URL", async () => {
  const { response, storage } = await call();
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://storage.example.test/signed?token=EXAMPLE");
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  assert.equal(storage.signed.length, 1, "exactly one object was signed");
});

test("R1.5.3 — the expiry handed to createSignedUrl is the short TTL constant", async () => {
  const { response, storage } = await call();
  assert.equal(response.status, 302);
  assert.equal(
    storage.signed[0].expiresIn,
    EVIDENCE_SIGNED_URL_TTL_SECONDS,
    "the signed URL must carry the module's TTL, not an unbounded or defaulted one"
  );
  // The band the task fixes, asserted on the constant itself so raising it to a
  // share link is a test failure and not a silent policy change.
  assert.ok(
    EVIDENCE_SIGNED_URL_TTL_SECONDS >= 60 && EVIDENCE_SIGNED_URL_TTL_SECONDS <= 300,
    `TTL must stay inside 60–300 s; it is ${EVIDENCE_SIGNED_URL_TTL_SECONDS}`
  );
  assert.equal(response.headers.get("x-evidence-expires-in"), String(EVIDENCE_SIGNED_URL_TTL_SECONDS));
});

test("R1.5.3 — the object key signed is EXACTLY the stored id, not a path built here", async () => {
  const { storage } = await call();
  assert.equal(storage.signed[0].key, STORED_KEY);
});

test("R1.5.3 — the lookup is scoped by job_id AND result id", async () => {
  const { client } = await call();
  const lookup = client.calls.find((c) => c.table === "prompt_results");
  assert.ok(lookup, "the route must read prompt_results");
  assert.equal(lookup.filters.id, RESULT_ID);
  assert.equal(lookup.filters.job_id, JOB_ID);
  for (const column of Object.values(EVIDENCE_KIND_COLUMNS)) {
    assert.match(lookup.columns, new RegExp(`\\b${column}\\b`), `the select must name ${column}`);
  }
});

test("R1.5.3 — NULL evidence answers 404 with a plain sentence and signs nothing", async () => {
  const { response, storage } = await call({ rows: [row({ evidence_screenshot_id: null })] });
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") || "", /text\/plain/);
  const body = await response.text();
  assert.match(body, /no stored screenshot/i);
  assert.doesNotMatch(body, /http/i, "a refusal must not contain a URL");
  assert.equal(storage.signed.length, 0, "nothing may be signed when no capture was stored");
});

test("R1.5.3 — an empty-string evidence id is treated as absent, never signed", async () => {
  const { response, storage } = await call({ rows: [row({ evidence_screenshot_id: "   " })] });
  assert.equal(response.status, 404);
  assert.equal(storage.signed.length, 0);
});

test("R1.5.3 — an unknown result id answers 404", async () => {
  const { response, storage } = await call({ query: `result=${OTHER_RESULT_ID}` });
  assert.equal(response.status, 404);
  assert.match(await response.text(), /No such result/i);
  assert.equal(storage.signed.length, 0);
});

test("R1.5.3 — a result belonging to ANOTHER job is not reachable through this job", async () => {
  const foreign = row({ id: OTHER_RESULT_ID, job_id: "44444444-4444-4444-8444-444444444444" });
  const { response, storage } = await call({ rows: [foreign], query: `result=${OTHER_RESULT_ID}` });
  assert.equal(response.status, 404);
  assert.equal(storage.signed.length, 0);
});

test("R1.5.3 — a malformed result id is a 404, not a database cast error", async () => {
  const { response, storage } = await call({ query: "result=not-a-uuid" });
  assert.equal(response.status, 404);
  assert.equal(storage.signed.length, 0);
});

test("R1.5.3 — a missing ?result is a 400", async () => {
  const { response } = await call({ query: "" });
  assert.equal(response.status, 400);
});

test("R1.5.3 — an unknown kind is a 400 and no column is guessed", async () => {
  const { response, storage } = await call({ query: `result=${RESULT_ID}&kind=video` });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Unknown evidence kind/i);
  assert.equal(storage.signed.length, 0);
});

test("R1.5.3 — the perimeter is the scan status route's: an unknown job is a 404", async () => {
  const { response, storage } = await call({ job: jobMissing });
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Job not found/i);
  assert.equal(storage.signed.length, 0, "an unknown job must not reach the lookup");
});

test("R1.5.3 — an unreadable row is 502 'unknown', never 'no evidence'", async () => {
  const { response, storage } = await call({ clientError: { message: "connection reset" } });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /unknown whether evidence exists/i);
  assert.equal(storage.signed.length, 0);
});

test("R1.5.3 — a Storage failure to sign is 502, never a redirect to nothing", async () => {
  const { response } = await call({ storage: fakeStorage({ error: { message: "bucket unavailable" } }) });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("location"), null);
});

test("R1.5.3 — with no Supabase configured the answer is 503, not 'no evidence'", async () => {
  const outcome = await signEvidenceForResult(
    { jobId: JOB_ID, resultId: RESULT_ID, kind: "screenshot" },
    { client: null, storage: null }
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 503);
  assert.match(outcome.detail, /not configured/i);
});

test("R1.5.3 — each kind signs its own column's stored id", async () => {
  const rows = [
    row({ evidence_dom_id: "dom-object-key", evidence_har_id: "har-object-key", evidence_raw_id: "raw-object-key" }),
  ];
  for (const [kind, expected] of [
    ["screenshot", STORED_KEY],
    ["dom", "dom-object-key"],
    ["har", "har-object-key"],
    ["raw", "raw-object-key"],
  ]) {
    const { response, storage } = await call({ rows, query: `result=${RESULT_ID}&kind=${kind}` });
    assert.equal(response.status, 302, `${kind} should resolve`);
    assert.equal(storage.signed[0].key, expected, `${kind} must sign its own column`);
  }
});
