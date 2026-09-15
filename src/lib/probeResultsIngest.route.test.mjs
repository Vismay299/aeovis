/**
 * R1.2.4 — POST /api/internal/probe-results, observed at the REAL handler.
 *
 * `api/internal/` is a directory name. A directory name is not an access
 * control, so the whole question this suite answers is whether the gate is in
 * the CODE: every assertion below drives a real `Request` through the real
 * exported handler and reads `Response.status`. Nothing is stubbed. The route,
 * the validator, the auth gate, `upsertPromptResults` and `NextResponse` are all
 * the real modules; the hooks file (`cronAuth.route.hooks.mjs`) only answers
 * "which file is this specifier" for `@/...` and `next/server`, which is the one
 * thing Next's bundler would otherwise have answered.
 *
 * THE ENUMERATION IS THE ANTI-VACUITY DEVICE. The auth tests do not name
 * `probe-results`; they walk `src/app/api/internal/` for every `route.js`, refuse
 * to run on an empty walk, and assert the discovered set matches an expected
 * member list. A route added under `api/internal/` tomorrow therefore either
 * fails the member-list assertion (so its author has to come here) or is
 * immediately covered by the anonymous-reachability loop. Verified by sabotage:
 * pointing the walk at a directory that does not exist fails the suite instead
 * of passing it silently.
 *
 * NO DATABASE IS TOUCHED. `NEXT_PUBLIC_SUPABASE_*` are deleted BEFORE the route
 * module is imported, so `db.js`'s module-level client is null and
 * `upsertPromptResults` takes its in-memory path — the same conflict key
 * (`job_id|engine|query`) the live `ON CONFLICT` uses, which is what makes the
 * idempotency assertion meaningful without a live table. The live path's
 * `onConflict` string is pinned separately by reading the source, because a
 * memory Map cannot prove what PostgREST was asked for.
 *
 * A NOTE ON THE TOKEN VALUE BELOW. It is a literal that says what it is. No
 * assertion in this file reads `process.env.PROBE_INGEST_TOKEN` into an
 * assertion's `actual` — `credentialAssertionGuard.test.mjs` forbids exactly
 * that, and a suite about credential handling is the worst possible place to
 * leak one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

/** Not a real credential, and long enough to clear MIN_TOKEN_LENGTH (24). */
const TOKEN = "probe-ingest-EXAMPLE-NOT-A-REAL-TOKEN";
/** Shorter than MIN_TOKEN_LENGTH: a configured value that is still a misconfiguration. */
const SHORT_TOKEN = "too-short";

// ---------------------------------------------------------------------------
// Environment, fixed BEFORE the route module is imported.
//
// NODE_ENV is declared as development so the route's "production with no
// database" refusal (503) is not the branch under test in most of the file; the
// one test that wants that branch sets it and puts it back. VERCEL_ENV is
// deleted because resolveNodeEnv treats VERCEL_ENV=production as production
// whatever NODE_ENV claims (R0.1.17), and an inherited value would silently
// change which branch every test below took.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "development";
delete process.env.VERCEL_ENV;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.PROBE_INGEST_TOKEN;

register("./cronAuth.route.hooks.mjs", import.meta.url);

// ---------------------------------------------------------------------------
// Walk api/internal/ for routes. This runs at module scope so a failure to
// enumerate is a failure of the whole file rather than of one test.
// ---------------------------------------------------------------------------
const INTERNAL_DIR = path.join(REPO, "src/app/api/internal");

/** Every `route.js` under a directory, as a route path relative to that root. */
function findRoutes(root) {
  const found = [];
  const walk = (dir, relative) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, relative ? `${relative}/${entry}` : entry);
      } else if (entry === "route.js") {
        found.push(relative);
      }
    }
  };
  walk(root, "");
  return found;
}

/**
 * The member list. A route added under api/internal/ without being added here
 * fails the assertion below — which is the point: the author of the next
 * internal route has to come to this file and say what guards it.
 */
const EXPECTED_INTERNAL_ROUTES = ["probe-results"];

const discoveredRoutes = findRoutes(INTERNAL_DIR);

/** Every HTTP verb Next will route, so an added verb cannot escape the loop. */
const HTTP_VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

let importError = null;
/** @type {Array<{route: string, url: string, handlers: Array<[string, Function]>}>} */
const loaded = [];
try {
  for (const route of discoveredRoutes) {
    const mod = await import(`../app/api/internal/${route}/route.js`);
    loaded.push({
      route,
      url: `https://aeovis.test/api/internal/${route}`,
      handlers: HTTP_VERBS.filter((v) => typeof mod[v] === "function").map((v) => [v, mod[v]]),
    });
  }
} catch (error) {
  importError = error;
}

const ingest = await import("../app/api/internal/probe-results/route.js").catch(() => ({}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A distinct job per test, so one test's rows cannot satisfy another's count. */
let jobCounter = 0;
function nextJobId() {
  jobCounter += 1;
  return `0000${String(jobCounter).padStart(4, "0")}-0000-4000-8000-000000000000`.slice(-36);
}

/** §6.1's shape: an answered UI row, measured, brand named. */
function answeredUiRow(overrides = {}) {
  return {
    contract_version: 2,
    engine: "perplexity",
    engine_surface: "ui",
    query: "best vitrified tile brands in india",
    geo: "in",
    state: "answered",
    state_reason: null,
    probed_at: "2026-09-05T06:31:12.004Z",
    attempt: 1,
    text: "For large-format vitrified tiles, Kajaria, Somany and Italica are widely stocked.",
    citations: ["https://kajariaceramics.com/vitrified", "https://italicatiles.com/products"],
    references: [
      {
        href: "https://italicatiles.com/products",
        title: "Products",
        source: "Italica",
        domain: "italicatiles.com",
      },
    ],
    citations_state: "measured",
    brand_mentioned_in_text: true,
    brand_cited: true,
    visible: true,
    competitors_found_in_text: ["Kajaria", "Somany"],
    competitors_cited: ["Kajaria"],
    brands: [
      { name: "Italica", is_self: true, mentioned: true, position: 3, sentiment: 72 },
      { name: "Kajaria", is_self: false, mentioned: true, position: 1, sentiment: 80 },
    ],
    timings: { total_ms: 18422, navigation_ms: 4110, extract_ms: 96 },
    evidence: {
      screenshot_id: "ev/2026-09-05/pplx/0a1b.png",
      dom_id: "ev/2026-09-05/pplx/0a1b.html",
      har_id: null,
      raw_id: null,
    },
    cost: { amount_usd: 0, basis: "no_charge", reason: "ui_surface_no_metered_call" },
    ...overrides,
  };
}

/** §6.4's shape: nothing measured, every measurement field null. */
function blockedUiRow(overrides = {}) {
  return {
    contract_version: 2,
    engine: "chatgpt",
    engine_surface: "ui",
    query: "best vitrified tile brands in india",
    geo: "in",
    state: "login_wall",
    state_reason: "auth_required_before_answer",
    probed_at: "2026-09-05T06:35:02.113Z",
    attempt: 2,
    text: null,
    citations: null,
    references: null,
    citations_state: "not_applicable",
    brand_mentioned_in_text: null,
    brand_cited: null,
    visible: null,
    competitors_found_in_text: null,
    competitors_cited: null,
    brands: null,
    timings: { total_ms: 7311, navigation_ms: 6980, extract_ms: null },
    evidence: {
      screenshot_id: "ev/2026-09-05/cgpt/3f9a.png",
      dom_id: "ev/2026-09-05/cgpt/3f9a.html",
      har_id: null,
      raw_id: null,
    },
    cost: { amount_usd: 0, basis: "no_charge", reason: "ui_surface_no_metered_call" },
    error_detail: "redirected to /auth/login before any assistant turn rendered",
    ...overrides,
  };
}

function envelope(jobId, results) {
  return { job_id: jobId, brand: "italicatiles.com", results };
}

function post(url, { body, headers } = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers || {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Authenticated POST of one envelope through the real handler. */
async function ingestPost(jobId, results, headers) {
  return ingest.POST(
    post("https://aeovis.test/api/internal/probe-results", {
      body: envelope(jobId, results),
      headers: headers || { authorization: `Bearer ${TOKEN}` },
    })
  );
}

function codesOf(body) {
  return (body.violations || []).map((v) => v.code);
}

// ---------------------------------------------------------------------------
// 0. The suite is not vacuous
// ---------------------------------------------------------------------------

test("ENUMERATION — every route under api/internal/ is discovered and expected", () => {
  assert.ok(
    discoveredRoutes.length > 0,
    `no route.js found under ${INTERNAL_DIR}. This suite's auth coverage is derived from that ` +
      "walk, so an empty walk is a suite that proves nothing — it fails instead of passing."
  );
  assert.deepEqual(
    discoveredRoutes,
    EXPECTED_INTERNAL_ROUTES,
    "a route was added or removed under src/app/api/internal/. Add it to " +
      "EXPECTED_INTERNAL_ROUTES in this file and say what guards it — a directory called " +
      "'internal' that nothing in code gates is an auth bypass."
  );
});

test("ENUMERATION — every discovered route module imported and exports at least one verb", () => {
  assert.equal(
    importError,
    null,
    "Could not import an api/internal route. If this says \"Cannot find package 'next'\", run " +
      `npm install — this suite exercises the real handlers on purpose. Underlying error: ${importError?.message}`
  );
  assert.equal(loaded.length, discoveredRoutes.length);
  for (const entry of loaded) {
    assert.ok(
      entry.handlers.length > 0,
      `${entry.route}/route.js exports no HTTP handler, so nothing below tested it`
    );
  }
});

test("FIXTURE — the valid rows really are valid, or every 422 below passes vacuously", async () => {
  const { validateProbeResult } = await import("../app/api/internal/_lib/probeResultContract.js");
  for (const [name, row] of [
    ["answered ui (§6.1)", answeredUiRow()],
    ["login_wall ui (§6.4)", blockedUiRow()],
  ]) {
    const { ok, violations } = validateProbeResult(row);
    assert.ok(ok, `${name} should be contract-valid: ${JSON.stringify(violations)}`);
  }
});

// ---------------------------------------------------------------------------
// 1. Anonymous reachability — the finding this task exists to close
//
// Driven over the ENUMERATION, not over a hand-written list, and with a VALID
// body so a 401 cannot be a body-parse failure wearing an auth badge.
// ---------------------------------------------------------------------------

test("401 — with a token configured, EVERY internal route refuses a request with no credential", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  let checked = 0;
  for (const { route, url, handlers } of loaded) {
    for (const [verb, handler] of handlers) {
      const response = await handler(
        post(url, { body: envelope(nextJobId(), [answeredUiRow()]) })
      );
      assert.equal(
        response.status,
        401,
        `${verb} /api/internal/${route} answered ${response.status} to an anonymous caller`
      );
      assert.deepEqual(await response.json(), { detail: "Unauthorized." });
      checked += 1;
    }
  }
  assert.ok(checked > 0, "no handler was exercised");
});

test("401 — a WRONG credential is refused, in both carriers", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  const wrong = [
    { authorization: `Bearer ${TOKEN}-not-quite` },
    { authorization: "Bearer " },
    { authorization: TOKEN }, // right value, no Bearer scheme
    { "x-probe-ingest-token": `${TOKEN}x` },
    { "x-probe-ingest-token": "" },
    // The two headers the neighbouring gates accept. This route speaks neither.
    { "x-cron-secret": TOKEN },
    { "x-operator-token": TOKEN },
  ];
  for (const headers of wrong) {
    const response = await ingestPost(nextJobId(), [answeredUiRow()], headers);
    assert.equal(
      response.status,
      401,
      `a wrong credential (${Object.keys(headers).join(",")}) was accepted with ${response.status}`
    );
  }
});

test("401 — a ?secret= query parameter is NOT a carrier here", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  const response = await ingest.POST(
    post(
      `https://aeovis.test/api/internal/probe-results?secret=${encodeURIComponent(TOKEN)}`,
      { body: envelope(nextJobId(), [answeredUiRow()]) }
    )
  );
  assert.equal(response.status, 401, "a token in the query string must not authenticate");
});

test("401 FAIL CLOSED — with PROBE_INGEST_TOKEN absent from the environment, nothing gets in", async () => {
  // THE CLASSIC BUG: an auth check that passes when process.env.X is undefined
  // on both sides. Every shape of "I also have nothing" is tried.
  delete process.env.PROBE_INGEST_TOKEN;
  const attempts = [
    undefined,
    { authorization: "Bearer undefined" },
    { authorization: "Bearer " },
    { authorization: "Bearer null" },
    { authorization: `Bearer ${TOKEN}` },
    { "x-probe-ingest-token": "undefined" },
  ];
  for (const headers of attempts) {
    const response = await ingestPost(nextJobId(), [answeredUiRow()], headers || {});
    assert.equal(
      response.status,
      401,
      `with no token configured, ${JSON.stringify(headers || {})} got ${response.status}`
    );
  }
  process.env.PROBE_INGEST_TOKEN = TOKEN;
});

test("401 FAIL CLOSED — a blank or whitespace-only PROBE_INGEST_TOKEN is not a token", async () => {
  for (const value of ["", "   ", "\t\n"]) {
    process.env.PROBE_INGEST_TOKEN = value;
    const presented = await ingestPost(nextJobId(), [answeredUiRow()], {
      authorization: `Bearer ${value}`,
    });
    assert.equal(presented.status, 401, `a blank configured token accepted a blank credential`);
    const none = await ingestPost(nextJobId(), [answeredUiRow()], {});
    assert.equal(none.status, 401);
  }
  process.env.PROBE_INGEST_TOKEN = TOKEN;
});

test("401 FAIL CLOSED — a configured token below the length floor refuses even the exact value", async () => {
  process.env.PROBE_INGEST_TOKEN = SHORT_TOKEN;
  const response = await ingestPost(nextJobId(), [answeredUiRow()], {
    authorization: `Bearer ${SHORT_TOKEN}`,
  });
  assert.equal(
    response.status,
    401,
    "a 9-character token is a misconfiguration, not a credential — it must not open the route"
  );
  process.env.PROBE_INGEST_TOKEN = TOKEN;
});

test("the gate is CONSTANT-TIME and length-blind, and the predicate's reasons are distinct", async () => {
  const { authorizeIngestRequest, INGEST_AUTH, timingSafeMatch } = await import(
    "../app/api/internal/_lib/ingestAuth.js"
  );
  const header = (values) => (name) => values[name.toLowerCase()] ?? null;

  // timingSafeEqual throws on unequal lengths; hashing first is what makes a
  // wrong-length guess a plain false instead of a 500 that leaks the length.
  assert.equal(timingSafeMatch("a", "a-much-longer-value"), false);
  assert.equal(timingSafeMatch(TOKEN, TOKEN), true);
  assert.equal(timingSafeMatch("", ""), false, "empty must never match empty");
  assert.equal(timingSafeMatch(undefined, undefined), false, "undefined must never match undefined");

  assert.deepEqual(authorizeIngestRequest({ token: undefined, header: header({}) }), {
    authorized: false,
    reason: INGEST_AUTH.DENY_NO_TOKEN_CONFIGURED,
  });
  assert.deepEqual(authorizeIngestRequest({ token: SHORT_TOKEN, header: header({}) }), {
    authorized: false,
    reason: INGEST_AUTH.DENY_TOKEN_TOO_SHORT,
  });
  assert.deepEqual(authorizeIngestRequest({ token: TOKEN, header: header({}) }), {
    authorized: false,
    reason: INGEST_AUTH.DENY_NO_CREDENTIAL,
  });
  assert.deepEqual(
    authorizeIngestRequest({ token: TOKEN, header: header({ authorization: "Bearer nope" }) }),
    { authorized: false, reason: INGEST_AUTH.DENY_BAD_CREDENTIAL }
  );
  assert.deepEqual(
    authorizeIngestRequest({
      token: TOKEN,
      header: header({ authorization: `Bearer ${TOKEN}` }),
    }),
    { authorized: true, reason: INGEST_AUTH.OK }
  );

  // The comparison must not be a loose or truthy one.
  const source = readFileSync(
    path.join(REPO, "src/app/api/internal/_lib/ingestAuth.js"),
    "utf8"
  );
  assert.match(source, /crypto\.timingSafeEqual/, "the comparison must be crypto.timingSafeEqual");
  assert.match(
    source,
    /if \(timingSafeMatch\(presented, configured\)\) \{/,
    "the DECISION must call timingSafeMatch — a constant-time helper the gate no longer uses is " +
      "decoration, and the export alone would keep this test green while the gate compared " +
      "some other way"
  );
  assert.ok(
    !/presented\s*===?\s*configured/.test(source),
    "a direct string comparison of the two secrets is not constant time"
  );
});

// ---------------------------------------------------------------------------
// 2. The positive control. Without it, "return 401 always" passes section 1.
// ---------------------------------------------------------------------------

test("200 — the correct token in either header reaches the handler and stores the batch", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  for (const headers of [
    { authorization: `Bearer ${TOKEN}` },
    { "X-Probe-Ingest-Token": TOKEN }, // mixed case: real traffic is not pre-lowercased
  ]) {
    const jobId = nextJobId();
    const response = await ingestPost(jobId, [answeredUiRow()], headers);
    assert.equal(response.status, 200, `a correct credential was refused with ${response.status}`);
    const body = await response.json();
    assert.equal(body.stored, 1);
    assert.equal(body.job_id, jobId);
    // Standing rule 1: a memory write and a database write are not the same
    // event, and the response says which one happened.
    assert.equal(body.storage, "process_memory");
    assert.equal(body.conflict_key, "job_id,engine,query");
  }
});

// ---------------------------------------------------------------------------
// 3. 422 — contract-validated, never repaired (§5)
// ---------------------------------------------------------------------------

test("422 — a body that is not JSON at all", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  const response = await ingest.POST(
    post("https://aeovis.test/api/internal/probe-results", {
      body: "not json {",
      headers: { authorization: `Bearer ${TOKEN}` },
    })
  );
  assert.equal(response.status, 422);
  assert.deepEqual(codesOf(await response.json()), ["body_not_json"]);
});

test("422 — envelope failures: job_id, brand, results", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  const cases = [
    [{}, ["job_id_missing", "brand_missing", "results_not_an_array"]],
    [{ job_id: "not-a-uuid", brand: "b", results: [] }, ["job_id_not_a_uuid", "results_empty"]],
    [{ job_id: nextJobId(), brand: "   ", results: [answeredUiRow()] }, ["brand_missing"]],
    [{ job_id: nextJobId(), brand: "b", results: {} }, ["results_not_an_array"]],
    [[], ["not_an_object"]],
  ];
  for (const [body, expected] of cases) {
    const response = await ingest.POST(
      post("https://aeovis.test/api/internal/probe-results", {
        body,
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    );
    assert.equal(response.status, 422, `${JSON.stringify(body)} was not refused`);
    assert.deepEqual(codesOf(await response.json()), expected, JSON.stringify(body));
  }
});

test("422 — an empty results array is refused, because a 200 over zero rows is a false success", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  const response = await ingestPost(nextJobId(), []);
  assert.equal(response.status, 422);
  assert.ok(codesOf(await response.json()).includes("results_empty"));
});

test("422 — §6.5's four independent rejections, each on its own and all together", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  // The contract's own rejected example, verbatim in shape.
  const rejected = {
    contract_version: 2,
    engine: "chatgpt",
    engine_surface: "ui",
    query: "best vitrified tile brands in india",
    geo: "in",
    state: "blocked",
    state_reason: "cloudflare_challenge",
    probed_at: "2026-09-05T06:36:44.002Z",
    attempt: 1,
    text: "",
    citations: [],
    visible: false,
    citations_state: "measured",
    timings: { total_ms: 5002, navigation_ms: 4900, extract_ms: null },
    evidence: { screenshot_id: null, dom_id: null, har_id: null, raw_id: null },
    cost: { amount_usd: 0, basis: "unpriced" },
  };
  const response = await ingestPost(nextJobId(), [rejected]);
  assert.equal(response.status, 422);
  const found = codesOf(await response.json());
  for (const code of [
    "measurement_on_unmeasured_row", // 1: measurement fields on a blocked row
    "citations_state_claims_measurement", // 2: "measured" on a row that measured nothing
    "ui_row_without_evidence", // 3: ui with neither screenshot nor dom
    "unpriced_with_amount", // 4: basis unpriced with amount_usd 0
  ]) {
    assert.ok(found.includes(code), `§6.5 rejection missing: ${code} (got ${found.join(", ")})`);
  }
});

test("422 — one clause at a time, so no rejection rides on another", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  /** @type {Array<[string, object, string]>} each mutation must produce that code */
  const mutations = [
    ["contract_version 1", answeredUiRow({ contract_version: 1 }), "contract_version"],
    ['contract_version "2"', answeredUiRow({ contract_version: "2" }), "contract_version"],
    ["unknown engine", answeredUiRow({ engine: "gemini" }), "unknown_engine"],
    ["missing engine_surface", answeredUiRow({ engine_surface: undefined }), "unknown_engine_surface"],
    ["empty query", answeredUiRow({ query: "  " }), "query_empty"],
    ["uppercase geo", answeredUiRow({ geo: "IN" }), "geo_invalid"],
    ["local-time probed_at", answeredUiRow({ probed_at: "2026-09-05T06:31:12" }), "probed_at_invalid"],
    ["attempt 0", answeredUiRow({ attempt: 0 }), "attempt_invalid"],
    ["a ninth state", answeredUiRow({ state: "retracted" }), "unknown_state"],
    [
      "state_reason on an answered row",
      answeredUiRow({ state_reason: "why" }),
      "state_reason_on_answered",
    ],
    [
      "no_answer with no reason",
      blockedUiRow({ state: "no_answer", state_reason: null }),
      "state_reason_missing",
    ],
    [
      "free-text state_reason",
      blockedUiRow({ state_reason: "Login wall hit!" }),
      "state_reason_not_snake_case",
    ],
    [
      "not_applicable on an answered row",
      answeredUiRow({ citations_state: "not_applicable" }),
      "citations_state_not_applicable_on_answered",
    ],
    [
      "a measured non-mention on a row that measured nothing",
      blockedUiRow({ visible: false }),
      "measurement_on_unmeasured_row",
    ],
    [
      "an empty array is a measurement too",
      blockedUiRow({ citations: [] }),
      "measurement_on_unmeasured_row",
    ],
    [
      "a null measurement on an answered row",
      answeredUiRow({ competitors_found_in_text: null }),
      "measurement_missing_on_answered",
    ],
    [
      "visible disagreeing with its components",
      answeredUiRow({ brand_mentioned_in_text: false, brand_cited: false, visible: true }),
      "visible_disagrees_with_components",
    ],
    [
      'empty text with no citations is parse_error, not "answered"',
      answeredUiRow({ text: "", citations: [], brand_mentioned_in_text: false, brand_cited: false, visible: false }),
      "empty_text_without_citations",
    ],
    ["missing timings", answeredUiRow({ timings: undefined }), "timings_missing"],
    [
      "no total_ms on a timeout",
      blockedUiRow({ state: "timeout", state_reason: "budget_exceeded", timings: { navigation_ms: 1, extract_ms: null } }),
      "total_ms_missing",
    ],
    [
      "a ui row with no navigation_ms",
      answeredUiRow({ timings: { total_ms: 10, extract_ms: 1 } }),
      "navigation_ms_missing",
    ],
    ["missing evidence object", blockedUiRow({ evidence: undefined }), "evidence_missing"],
    [
      "a ui failure with no evidence at all",
      blockedUiRow({ evidence: { screenshot_id: null, dom_id: null, har_id: null, raw_id: null } }),
      "ui_row_without_evidence",
    ],
    ["missing cost", answeredUiRow({ cost: undefined }), "cost_missing"],
    ["unknown basis", answeredUiRow({ cost: { amount_usd: 0, basis: "free" } }), "unknown_cost_basis"],
    [
      "no_charge without a reason",
      answeredUiRow({ cost: { amount_usd: 0, basis: "no_charge", reason: "" } }),
      "no_charge_without_reason",
    ],
    [
      "no_charge with a non-zero amount",
      answeredUiRow({ cost: { amount_usd: 0.5, basis: "no_charge", reason: "ui_surface_no_metered_call" } }),
      "no_charge_with_nonzero_amount",
    ],
    [
      "unpriced priced at $0 (standing rule 3)",
      answeredUiRow({ cost: { amount_usd: 0, basis: "unpriced", reason: null } }),
      "unpriced_with_amount",
    ],
    [
      "a UI row claiming a vendor-reported price",
      answeredUiRow({ cost: { amount_usd: 0.004, basis: "vendor_reported", reason: null } }),
      "priced_basis_on_ui_surface",
    ],
    [
      "estimated with no amount",
      answeredUiRow({
        engine_surface: "api",
        timings: { total_ms: 1, navigation_ms: null, extract_ms: 1 },
        evidence: { screenshot_id: null, dom_id: null, har_id: null, raw_id: "ev/raw.json" },
        cost: { amount_usd: null, basis: "estimated", reason: null },
      }),
      "priced_basis_without_amount",
    ],
    [
      "an api row with navigation_ms",
      answeredUiRow({
        engine_surface: "api",
        timings: { total_ms: 1, navigation_ms: 5, extract_ms: 1 },
        evidence: { screenshot_id: null, dom_id: null, har_id: null, raw_id: "ev/raw.json" },
        cost: { amount_usd: 0.004, basis: "vendor_reported", reason: null },
      }),
      "navigation_ms_on_api",
    ],
    [
      "an api row with no raw_id",
      answeredUiRow({
        engine_surface: "api",
        timings: { total_ms: 1, navigation_ms: null, extract_ms: 1 },
        evidence: { screenshot_id: null, dom_id: null, har_id: null, raw_id: null },
        cost: { amount_usd: 0.004, basis: "vendor_reported", reason: null },
      }),
      "api_row_without_raw_id",
    ],
  ];

  for (const [name, row, code] of mutations) {
    const response = await ingestPost(nextJobId(), [row]);
    assert.equal(response.status, 422, `${name} was not refused (${response.status})`);
    const found = codesOf(await response.json());
    assert.ok(found.includes(code), `${name}: expected ${code}, got ${found.join(", ") || "none"}`);
  }
  assert.ok(mutations.length >= 30, "the clause table must not shrink silently");
});

test("422 — two rows with the same (engine, query) would silently overwrite each other", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  const response = await ingestPost(nextJobId(), [answeredUiRow(), answeredUiRow({ attempt: 2 })]);
  assert.equal(response.status, 422);
  assert.ok(codesOf(await response.json()).includes("duplicate_conflict_key"));
});

test("422 — a rejected body writes NOTHING (§5: not written, left for retry)", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  const { getPromptResultsForJob } = await import("./db/analytics.js");
  const jobId = nextJobId();
  const response = await ingestPost(jobId, [answeredUiRow(), blockedUiRow({ citations_state: "measured" })]);
  assert.equal(response.status, 422);
  const stored = await getPromptResultsForJob(jobId);
  assert.equal(
    stored.length,
    0,
    "a 422 must not have written the valid rows of a batch — a partly-stored batch is a batch " +
      "nobody can retry safely"
  );
});

test("422 — the response names every violation, not just the first", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  const response = await ingestPost(nextJobId(), [
    answeredUiRow({ geo: "IND", attempt: 0, contract_version: 9 }),
  ]);
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.ok(body.violations.length >= 3, "an operator with three wrong fields must see three");
  assert.equal(body.violations[0].index, 0, "each violation names which result it came from");
});

// ---------------------------------------------------------------------------
// 4. §3.10's narrowing — the one place §3.4 and §6.3 disagree
// ---------------------------------------------------------------------------

test("ACCEPTED — §6.3: answered with an unverified citation channel and null brand_cited", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  const degraded = answeredUiRow({
    engine_surface: "api",
    citations_state: "unverified",
    citations: [],
    references: [],
    brand_cited: null,
    competitors_cited: null,
    visible: true,
    timings: { total_ms: 9004, navigation_ms: null, extract_ms: 41 },
    evidence: { screenshot_id: null, dom_id: null, har_id: null, raw_id: "ev/pplx-api/7c2d.json" },
    cost: { amount_usd: null, basis: "unpriced", reason: "vendor_returned_no_price" },
    error_detail: "search leg: HTTP 403 after 3 attempts",
  });
  const response = await ingestPost(nextJobId(), [degraded]);
  assert.equal(
    response.status,
    200,
    "§3.10 exists so this row is representable; rejecting it would re-erase the difference " +
      "between 'cited nothing' and 'citations unverifiable'"
  );
});

test("422 — unverified does NOT license a null anywhere else, nor an unestablishable visible", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  const base = {
    engine_surface: "api",
    citations_state: "unverified",
    timings: { total_ms: 9004, navigation_ms: null, extract_ms: 41 },
    evidence: { screenshot_id: null, dom_id: null, har_id: null, raw_id: "ev/raw.json" },
    cost: { amount_usd: null, basis: "unpriced", reason: "vendor_returned_no_price" },
  };
  const widened = answeredUiRow({ ...base, brand_cited: null, competitors_cited: null, text: null });
  const r1 = await ingestPost(nextJobId(), [widened]);
  assert.equal(r1.status, 422);
  assert.ok(codesOf(await r1.json()).includes("measurement_missing_on_answered"));

  // No mention observed AND the citation channel failed: visibility is not a
  // fact this row established, and `false` would be a measured non-mention.
  const unestablished = answeredUiRow({
    ...base,
    brand_mentioned_in_text: false,
    brand_cited: null,
    competitors_cited: null,
    visible: false,
  });
  const r2 = await ingestPost(nextJobId(), [unestablished]);
  assert.equal(r2.status, 422);
  assert.ok(codesOf(await r2.json()).includes("visibility_unestablished"));
});

// ---------------------------------------------------------------------------
// 5. Idempotency — the third acceptance clause
// ---------------------------------------------------------------------------

test("IDEMPOTENT — a repeated valid body produces ONE row", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  const { getPromptResultsForJob } = await import("./db/analytics.js");
  const jobId = nextJobId();
  const row = answeredUiRow();

  const first = await ingestPost(jobId, [row]);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).stored, 1);

  const afterFirst = await getPromptResultsForJob(jobId);
  assert.equal(afterFirst.length, 1);
  const idFirst = afterFirst[0].id;

  // The same batch again, byte for byte — a retried report, a redelivered
  // message, a worker that lost the response.
  const second = await ingestPost(jobId, [row]);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).stored, 1);

  const afterSecond = await getPromptResultsForJob(jobId);
  assert.equal(
    afterSecond.length,
    1,
    "the second POST duplicated the measurement; the upsert conflict key is not being used"
  );
  assert.equal(afterSecond[0].id, idFirst, "the retry replaced the row rather than adding one");

  // A DIFFERENT engine on the same query is a different measurement and must
  // NOT be deduped away — otherwise "one row" would be satisfied by a route
  // that drops everything after the first.
  const third = await ingestPost(jobId, [answeredUiRow({ engine: "chatgpt" })]);
  assert.equal(third.status, 200);
  assert.equal((await getPromptResultsForJob(jobId)).length, 2);
});

test("IDEMPOTENT — the live path asks PostgREST for the same conflict key", () => {
  // The memory path above cannot prove what the database was asked for, so the
  // one string that carries it is read from source.
  const analytics = readFileSync(path.join(REPO, "src/lib/db/analytics.js"), "utf8");
  assert.match(
    analytics,
    /onConflict:\s*"job_id,engine,query"/,
    "upsertPromptResults must upsert on the UNIQUE (job_id, engine, query) of migration 005"
  );
  const migration = readFileSync(
    path.join(REPO, "supabase/migrations/005_analytics_platform.sql"),
    "utf8"
  );
  assert.match(
    migration,
    /UNIQUE \(job_id, engine, query\)/,
    "the constraint the route relies on must exist in a migration, not only in the client call"
  );
});

// ---------------------------------------------------------------------------
// 6. The stored row must not fabricate a measurement (standing rule 1)
// ---------------------------------------------------------------------------

test("STORED SHAPE — a not-measured state stores answered NULL, never false", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  const { getPromptResultsForJob } = await import("./db/analytics.js");
  const jobId = nextJobId();

  await ingestPost(jobId, [blockedUiRow()]);
  const [blocked] = await getPromptResultsForJob(jobId);
  assert.equal(
    blocked.answered,
    null,
    "a login_wall row stored as answered=false is a measured absence that never happened — " +
      "the failure §1 of the contract exists to make unrepresentable"
  );
  assert.equal(blocked.mentioned, null);
  assert.equal(blocked.brand_cited, null);
  assert.equal(blocked.answer_text, null);
  assert.equal(blocked.raw.state, "login_wall");
  assert.equal(blocked.raw.state_reason, "auth_required_before_answer");
  // v2 has no promoted columns until R1.5.2, so `raw` is where the contract lives.
  assert.equal(blocked.raw.citations_state, "not_applicable");
  assert.equal(blocked.raw.engine_surface, "ui");
  assert.equal(blocked.raw.cost.basis, "no_charge");

  // no_answer is the ONE absence that was observed, so it is a real false.
  const jobId2 = nextJobId();
  await ingestPost(jobId2, [
    blockedUiRow({ engine: "aio", state: "no_answer", state_reason: "no_ai_overview" }),
  ]);
  const [noAnswer] = await getPromptResultsForJob(jobId2);
  assert.equal(
    noAnswer.answered,
    false,
    "no_answer is a measured absence and belongs in the coverage denominator (§3.11)"
  );
});

test("STORED SHAPE — an absent is_branded_query stores null, not the column's DEFAULT false", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  const { getPromptResultsForJob } = await import("./db/analytics.js");
  const jobId = nextJobId();
  await ingestPost(jobId, [answeredUiRow()]);
  const [row] = await getPromptResultsForJob(jobId);
  assert.equal(
    row.is_branded_query,
    null,
    '"we were not told whether this query was branded" must not read as "it was not"'
  );

  const jobId2 = nextJobId();
  await ingestPost(jobId2, [answeredUiRow({ is_branded_query: false })]);
  assert.equal((await getPromptResultsForJob(jobId2))[0].is_branded_query, false);
});

// ---------------------------------------------------------------------------
// 7. The write is never faked
// ---------------------------------------------------------------------------

test("503 — in production with no database, the batch is refused rather than kept in a Map", async () => {
  process.env.PROBE_INGEST_TOKEN = TOKEN;
  const { getPromptResultsForJob } = await import("./db/analytics.js");
  const jobId = nextJobId();
  process.env.NODE_ENV = "production";
  try {
    const response = await ingestPost(jobId, [answeredUiRow()]);
    assert.equal(
      response.status,
      503,
      "a 200 over a per-instance Map would report a successful ingest for rows nothing can read " +
        "back from another instance"
    );
    const body = await response.json();
    assert.equal(body.storage, "unavailable");
    assert.equal((await getPromptResultsForJob(jobId)).length, 0);
  } finally {
    process.env.NODE_ENV = "development";
  }
});

test("502 — a failing store is never a 200, and the error envelope survives", async () => {
  // upsertPromptResults throws on a database error (it is fail-loud by design).
  // The route must turn that into a non-2xx that says the batch was NOT stored,
  // because a caller that cannot tell refused from stored retries nothing.
  const routeSource = readFileSync(
    path.join(REPO, "src/app/api/internal/probe-results/route.js"),
    "utf8"
  );
  assert.match(routeSource, /status:\s*502/, "a store failure must answer 502, not 200");
  assert.match(
    routeSource,
    /error:\s*String\(error\?\.message \|\| error\)/,
    "the error envelope must reach the caller rather than being flattened away"
  );
  assert.ok(
    !/catch[\s\S]{0,200}NextResponse\.json\(\s*\{\s*stored:/.test(routeSource),
    "no catch block may answer with a stored count"
  );
});

test("the route spends no money and builds no URL from the request body", () => {
  const routeSource = readFileSync(
    path.join(REPO, "src/app/api/internal/probe-results/route.js"),
    "utf8"
  );
  for (const forbidden of ["fetch(", "redirect(", "openrouter", "brightdata", "callLLM"]) {
    assert.ok(
      !routeSource.toLowerCase().includes(forbidden.toLowerCase()),
      `the ingest route must not contain ${forbidden}: it stores rows, it does not call anything`
    );
  }
});
