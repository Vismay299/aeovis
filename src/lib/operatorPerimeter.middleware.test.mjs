/**
 * R0.1.19 / S17 — the dev-open disclosure warns ONCE, observed at the real
 * middleware rather than inferred from the shape of its source.
 *
 * WHY THIS FILE EXISTS
 * operatorPerimeter.test.mjs pins `warnDevPerimeterOpen` as a unit (given a
 * once-flag, the second call is silent) and then carried a SOURCE guard over
 * src/middleware.js asserting "the once-flag must live at MODULE scope, or the
 * warning fires on every request". That guard read the file as text, and text
 * is not once-ness. R0.1.14's verifier evaded it three ways:
 *
 *   A. Leave the module-level `const warnedDevOpen = { value: false };` in
 *      place as a DECOY and ADD the same declaration as the first line of
 *      `middleware()`. The guard's regex still finds a module-level match and
 *      still finds `warned: warnedDevOpen` at the call site, so it passed 25 of
 *      25 runs — while the flag was reborn per request and the perimeter
 *      warning fired on every one of them.
 *   B. Insert one line, `warnedDevOpen.value = false;`, above the call. Same
 *      regression, same green guard.
 *   C. Rename the flag to `warned` and use ES2015 property shorthand
 *      (`warned,`). The behaviour is unchanged and CORRECT, and the guard
 *      FAILED on "the call site must pass the module-level flag".
 *
 * Two false negatives and one false positive, so the guard's own assertion
 * message asserted something it did not establish.
 *
 * WHAT THIS SUITE DOES INSTEAD
 * It imports the REAL `middleware` from src/middleware.js, drives eleven
 * distinct operator requests through it with NODE_ENV declared non-production
 * and OPERATOR_TOKEN unset — the dev-open configuration — and counts the
 * warnings that reach console.warn. Eleven requests, one warning. Nothing
 * about the flag's NAME, scope keyword or call-site spelling is read; only the
 * behaviour those are supposed to produce. So A and B fail here (eleven
 * warnings), and C passes here (still one), which is correct in all three
 * cases where the source guard was wrong in two.
 *
 * There is no "no Edge runtime in node:test" obstacle to this. Once-ness is a
 * module-scope property of a plain ES module and is observable in plain Node;
 * what the Edge runtime changes is only how many isolates exist, i.e. how
 * often the module is re-evaluated — not whether a second call within one
 * evaluation stays silent. This suite proves the per-isolate half, which is
 * the half the code claims and the half the evasions broke. It does NOT prove
 * anything about isolate lifetime, isolate count, or how Next's Edge bundler
 * compiles this file; a deploy fanned across ten isolates will emit up to ten
 * warnings by design, and that is outside any test's reach here.
 *
 * HOW THE IMPORT WORKS (see cronAuth.route.hooks.mjs, used unmodified)
 * middleware.js speaks two specifiers Next's bundler resolves and Node does
 * not: the `@/` path alias and the extensionless `next/server`. The hooks only
 * answer "which file is this specifier". Nothing is stubbed, mocked or
 * shadowed: NextResponse and NextRequest below are Next's own, and the
 * middleware body runs unmodified.
 *
 * DEPENDENCY NOTE: like cronAuth.route.test.mjs this suite needs node_modules
 * (`next`, a declared dependency). If it is absent the first test FAILS LOUDLY
 * with instructions. It does not skip — a skip would re-open the gap.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// ---------------------------------------------------------------------------
// The dev-open configuration, fixed BEFORE middleware.js is imported.
//
// OPERATOR_TOKEN unset + a declared non-production NODE_ENV is the exact state
// authorizeOperatorRequest answers with ALLOW_DEV_NO_TOKEN, which is the only
// reason warnDevPerimeterOpen speaks for. Names only are handled here; no
// credential value is read or written by this file.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "development";
delete process.env.OPERATOR_TOKEN;

register("./cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
/** @type {((request: unknown) => unknown) | null} */
let middleware = null;
/** @type {any} */
let NextRequest = null;
try {
  const [mw, server] = await Promise.all([import("../middleware.js"), import("next/server")]);
  middleware = mw.middleware;
  NextRequest = server.NextRequest;
} catch (error) {
  importError = error;
}

/** An operator route: not public, not self-gated, so it reaches the dev-open branch. */
const operatorRequest = (n) =>
  new NextRequest(`https://aeovis.test/api/knowledge?probe=${n}`, { method: "GET" });

/**
 * Run `fn` with console.warn captured, and hand back every warning it emitted.
 * warnDevPerimeterOpen resolves its logger at call time (`(logger || console)`),
 * so swapping the method here is enough — no module is replaced.
 */
function warningsDuring(fn) {
  const real = console.warn;
  const seen = [];
  console.warn = (...args) => seen.push(args.join(" "));
  try {
    fn();
  } finally {
    console.warn = real;
  }
  return seen;
}

function realMiddleware() {
  assert.equal(importError, null, `middleware failed to import: ${importError?.message}`);
  assert.equal(typeof middleware, "function", "middleware must be under test, not a placeholder");
  return middleware;
}

test("middleware.js imports and exports a middleware function", () => {
  assert.equal(
    importError,
    null,
    'Could not import src/middleware.js. If this says "Cannot find package \'next\'", run ' +
      "`npm install` — this suite exercises the real middleware on purpose. " +
      `Underlying error: ${importError?.message}`
  );
  assert.equal(typeof middleware, "function", "src/middleware.js must export `middleware`");
  assert.equal(typeof NextRequest, "function", "NextRequest must be Next's own, from next/server");
});

// ---------------------------------------------------------------------------
// THE CRITERION. Eleven requests through the real middleware, one warning.
// ---------------------------------------------------------------------------

test("R0.1.19 — eleven dev-open requests through the REAL middleware warn exactly ONCE", () => {
  const run = realMiddleware();
  const responses = [];
  const warnings = warningsDuring(() => {
    for (let n = 1; n <= 11; n += 1) responses.push(run(operatorRequest(n)));
  });

  assert.equal(
    warnings.length,
    1,
    `the dev-open disclosure fired ${warnings.length} times across 11 requests. If this is 11, ` +
      "the once-flag is no longer surviving between requests — it is being re-created inside " +
      "middleware() (a declaration ADDED there shadows the module-level one even if that one is " +
      "still present) or reset before the call. Module scope is not a spelling; it is this count."
  );
  assert.match(
    warnings[0],
    /\[perimeter\] OPERATOR_TOKEN is not set/,
    "the one warning must be the perimeter disclosure, not some unrelated console.warn"
  );
  assert.match(
    warnings[0],
    /NODE_ENV=development/,
    "the disclosure must name the NODE_ENV that actually opened the gate"
  );

  // Not vacuous: all eleven must genuinely have taken the dev-open ALLOW path.
  // Without this, a middleware that refused every request would also warn once
  // (never) and satisfy the count above by emitting nothing at all.
  assert.equal(responses.length, 11, "all eleven requests must have been handled");
  for (const [i, response] of responses.entries()) {
    assert.equal(response?.status, 200, `request ${i + 1} was not allowed through the perimeter`);
    assert.equal(
      response.headers.get("x-middleware-next"),
      "1",
      `request ${i + 1} did not take NextResponse.next() — it was not the dev-open ALLOW branch`
    );
  }
});

test("R0.1.19 — the very FIRST request is the one that warns, and the second is silent", () => {
  // Ordering, separately from the total: a "once" that fires on request 7
  // would leave requests 1-6 undisclosed. The module is imported once per
  // process, so this shares the flag with the test above; run in isolation the
  // first probe below is request 12, and by then the flag is already burnt.
  // That is exactly the claim — silence AFTER the first disclosure — so this
  // asserts the tail here and the head is proved by warnings[0] above.
  const run = realMiddleware();
  const later = warningsDuring(() => {
    run(operatorRequest("tail-a"));
    run(operatorRequest("tail-b"));
  });
  assert.deepEqual(
    later,
    [],
    "the perimeter kept talking after it had already disclosed once; the flag is not sticking"
  );
});

test("R0.1.19 — a public route never reaches the disclosure at all", () => {
  // Control on the other side: the free-scan front door must stay quiet even
  // before the flag is burnt, because it is ALLOW_PUBLIC and not dev-open.
  const run = realMiddleware();
  const warnings = warningsDuring(() => {
    const response = run(
      new NextRequest("https://aeovis.test/api/scan", { method: "POST" })
    );
    assert.equal(response?.status, 200, "POST /api/scan must stay public");
  });
  assert.deepEqual(warnings, [], "a public route must not emit the operator-perimeter disclosure");
});
