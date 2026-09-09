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
 * R6.4.13 — WHY THE ELEVEN PROBES ARE ELEVEN DIFFERENT PATHNAMES
 * The first version of this suite sent all eleven probes to ONE pathname
 * (/api/knowledge) and varied only the query string. R0.1.19's verifier found
 * the evasion that survived it: key the once-flag per PATHNAME —
 *
 *     const warnedByPath = new Map();
 *     ...
 *     if (!warnedByPath.has(pathname)) warnedByPath.set(pathname, { value: false });
 *     warnDevPerimeterOpen({ ..., warned: warnedByPath.get(pathname) });
 *
 * — and every probe below shares one map entry, so the suite counted one
 * warning and passed 4 of 4 while production emitted one warning PER OPERATOR
 * ROUTE (28 of them) instead of one per isolate. That is the "a line on every
 * call is a line nobody reads" failure the once-flag exists to prevent, wearing
 * the shape of a fix.
 *
 * So the probes now span eleven DISTINCT operator pathnames and the pathnames
 * are DERIVED from the real router — walked out of src/app/api and filtered
 * through the real authorizeOperatorRequest — rather than written down here. A
 * hand-maintained literal is how a perimeter test stops matching the perimeter:
 * it keeps passing over routes that were deleted and never sees routes that
 * were added. Each probe also carries a distinct query string and the methods
 * alternate, so a flag keyed by URL, by query or by method is caught by the
 * same count.
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
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authorizeOperatorRequest, PERIMETER } from "./operatorPerimeter.js";

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

// ---------------------------------------------------------------------------
// THE PROBE SET, DERIVED FROM THE REAL ROUTER (R6.4.13).
//
// Two independent sources, neither of them a list kept by hand:
//   1. the filesystem — every src/app/api/**/route.js is a real API route, and
//      Next's matcher ["/api/:path*"] sends all of them through middleware;
//   2. the real authorizeOperatorRequest — a route is an OPERATOR route for a
//      method exactly when, with OPERATOR_TOKEN unset and NODE_ENV declared
//      non-production, it answers ALLOW_DEV_NO_TOKEN. That is the one branch
//      warnDevPerimeterOpen speaks for, so the filter and the thing under test
//      agree by construction rather than by my say-so.
//
// If a route is deleted, it leaves the probe set. If a route flips from
// operator to public, it leaves the probe set. Neither can go stale here.
// ---------------------------------------------------------------------------

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Next's [param] segments made concrete, so the perimeter's patterns apply. */
const concrete = (route) => route.replace(/\[[^\]]+\]/g, "sample");

/** Every /api route that exists on disk, as a pathname. */
async function discoverApiRoutes() {
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "route.js") {
        found.push("/" + path.relative(REPO, path.dirname(full)).split(path.sep).slice(2).join("/"));
      }
    }
  }
  await walk(path.join(REPO, "src/app/api"));
  return found.map(concrete).sort();
}

// A walk that THROWS must not take the whole file down with an opaque ENOENT at
// module load — that reads like an infrastructure problem when it is actually
// "the router moved and this suite no longer knows where to look". Captured
// here and re-raised as a named assertion in the anti-vacuity test below.
let discoveryError = null;
/** @type {string[]} */
let DISCOVERED_ROUTES = [];
try {
  DISCOVERED_ROUTES = await discoverApiRoutes();
} catch (error) {
  discoveryError = error;
}

/** True when this method+pathname reaches the dev-open branch for real. */
const isDevOpenOperatorRoute = (method, pathname) =>
  authorizeOperatorRequest({
    method,
    pathname,
    operatorToken: "", // OPERATOR_TOKEN unset — names only, no value read
    nodeEnv: "development",
    header: () => null,
  }).reason === PERIMETER.ALLOW_DEV_NO_TOKEN;

/**
 * One probe per distinct operator PATHNAME, methods alternating.
 *
 * The method is alternated and then verified against the real decision, never
 * assumed: the public allowlist is method-sensitive (POST /api/scan is public
 * while GET /api/scan is not, and the reverse for /api/scans/*), so a blindly
 * alternated method could pick a PUBLIC pair and quietly stop exercising the
 * dev-open branch at all. A pathname with no operator method is skipped.
 */
function buildProbePathnames() {
  const probes = [];
  for (const pathname of DISCOVERED_ROUTES) {
    if (probes.some((p) => p.pathname === pathname)) continue;
    const preferred = probes.length % 2 === 0 ? ["GET", "POST"] : ["POST", "GET"];
    const method = preferred.find((m) => isDevOpenOperatorRoute(m, pathname));
    if (method) probes.push({ method, pathname });
  }
  return probes;
}

const OPERATOR_PROBES = buildProbePathnames();

/** The eleven the criterion counts, and two held back for the tail test. */
const ELEVEN = OPERATOR_PROBES.slice(0, 11);
const TAIL_PAIR = OPERATOR_PROBES.slice(11, 13);

/**
 * A request to a real operator route. `n` also varies the query string, so a
 * once-flag keyed by full URL or by query string is caught by the same count
 * that catches one keyed by pathname.
 */
const operatorRequest = ({ method, pathname }, n) =>
  new NextRequest(`https://aeovis.test${pathname}?probe=${n}`, { method });

const describe = (probes) => probes.map((p) => `${p.method} ${p.pathname}`).join(", ");

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
// ANTI-VACUITY (R6.4.13). Everything the criterion below relies on, asserted
// before it is relied on. Without this test the criterion is satisfiable by an
// EMPTY probe set — zero requests also produce "not more than one warning" —
// and by a probe set that has drifted off the real router.
// ---------------------------------------------------------------------------

test("R6.4.13 — the probe set is derived from the real router and spans distinct pathnames", () => {
  assert.equal(
    discoveryError,
    null,
    `could not walk src/app/api to derive the probe set, so this suite proved nothing about the ` +
      `real router. If the API routes moved, point discoverApiRoutes at their new home — do not ` +
      `replace it with a hand-written list. Underlying error: ${discoveryError?.message}`
  );
  assert.ok(
    DISCOVERED_ROUTES.length > 20,
    `the walker must find the real API surface under src/app/api; it found ` +
      `${DISCOVERED_ROUTES.length} route.js files. A near-empty walk makes every count below ` +
      `vacuously true.`
  );

  assert.equal(
    ELEVEN.length,
    11,
    `only ${OPERATOR_PROBES.length} distinct operator pathnames survived the derivation, so the ` +
      `criterion cannot send eleven requests to eleven different routes. Either the router lost ` +
      `routes or routes became public/self-gated. Derived: ${describe(OPERATOR_PROBES)}`
  );
  assert.ok(
    TAIL_PAIR.length === 2,
    "two further operator pathnames must be held back for the tail test, unshared with the eleven"
  );

  // THE R6.4.13 PROPERTY ITSELF. If someone collapses the probes back onto one
  // pathname and varies only the query string, this is the assertion that says
  // so by name — the count in the criterion would go quiet again.
  const pathnames = ELEVEN.map((p) => p.pathname);
  assert.equal(
    new Set(pathnames).size,
    11,
    `the eleven probes must hit ELEVEN DISTINCT PATHNAMES, not one pathname with eleven query ` +
      `strings. A once-flag keyed per pathname (a Map from pathname to a fresh { value: false }) ` +
      `passes a same-pathname suite while warning once per operator route in production. Got: ` +
      `${pathnames.join(", ")}`
  );
  assert.equal(
    new Set([...pathnames, ...TAIL_PAIR.map((p) => p.pathname)]).size,
    13,
    "the tail probes must be pathnames the eleven never touched, or a per-pathname flag would " +
      "look silent there too"
  );

  // Methods vary, so a flag keyed per METHOD is caught by the same count.
  assert.ok(
    new Set(ELEVEN.map((p) => p.method)).size >= 2,
    `the probes must span more than one HTTP method; got ${describe(ELEVEN)}`
  );

  // Every probe is a route that exists on disk AND is genuinely dev-open. A
  // fabricated pathname would still answer ALLOW_DEV_NO_TOKEN — any unknown
  // /api path does — so the disk check is the half that stops the probe set
  // drifting into fiction, and the decision check is the half that stops it
  // pointing at a public route that never reaches the disclosure.
  for (const probe of [...ELEVEN, ...TAIL_PAIR]) {
    assert.ok(
      DISCOVERED_ROUTES.includes(probe.pathname),
      `${probe.pathname} is not a route.js under src/app/api. The probe set must be derived from ` +
        `the router, never written down — a hand-maintained list is how a perimeter test stops ` +
        `matching the perimeter.`
    );
    assert.ok(
      isDevOpenOperatorRoute(probe.method, probe.pathname),
      `${probe.method} ${probe.pathname} is not an ALLOW_DEV_NO_TOKEN route, so it never reaches ` +
        `the disclosure and cannot contribute to the once-count`
    );
  }
});

// ---------------------------------------------------------------------------
// THE CONTROL, AND IT MUST RUN BEFORE THE FLAG IS BURNT.
//
// This test used to sit at the BOTTOM of the file and had no teeth there. In
// the dev-open configuration an OPERATOR route is also allowed (200, and
// NextResponse.next() sets x-middleware-next: 1 for the public branch and the
// dev-open branch alike), and by the time the last test ran the once-flag was
// already spent — so "status 200 and no warning" was true of a public route AND
// of an operator route, and deleting `{ method: "POST", path: "/api/scan" }`
// from the allowlist left the whole suite green. It asserted publicness and
// established nothing.
//
// Two changes fix that. It runs FIRST, against an UNBURNT flag, so a route that
// had stopped being public would take the dev-open branch and emit the one
// warning it is asserted not to emit. And it names POST /api/scan as a literal
// on purpose, where the operator probes above are derived: the public allowlist
// is five deliberate entries, and a control drawn from the same list it is meant
// to check would simply follow the list wherever it went.
// ---------------------------------------------------------------------------

test("R0.1.19 — a public route never reaches the disclosure at all", () => {
  const run = realMiddleware();

  // The reason, not just the outcome. ALLOW_PUBLIC and ALLOW_DEV_NO_TOKEN both
  // produce a 200 here; only one of them means the front door is still open to
  // anonymous callers on its own merits.
  assert.equal(
    authorizeOperatorRequest({
      method: "POST",
      pathname: "/api/scan",
      operatorToken: "", // OPERATOR_TOKEN unset — names only, no value read
      nodeEnv: "development",
      header: () => null,
    }).reason,
    PERIMETER.ALLOW_PUBLIC,
    "POST /api/scan is the product's anonymous front door and must be ALLOW_PUBLIC. If this is " +
      "allow_dev_no_token it only works because OPERATOR_TOKEN happens to be unset, and the same " +
      "request in production would be refused."
  );

  const warnings = warningsDuring(() => {
    const response = run(new NextRequest("https://aeovis.test/api/scan", { method: "POST" }));
    assert.equal(response?.status, 200, "POST /api/scan must stay public");
    assert.equal(
      response.headers.get("x-middleware-next"),
      "1",
      "POST /api/scan must pass through to the route, not be rewritten or refused"
    );
  });
  assert.deepEqual(
    warnings,
    [],
    "a public route must not emit the operator-perimeter disclosure. This test runs against an " +
      "UNBURNT once-flag, so a warning here means POST /api/scan is no longer taking the public " +
      "branch — it fell through to dev-open, which is a closed front door wearing an open one."
  );
});

// ---------------------------------------------------------------------------
// THE CRITERION. Eleven requests through the real middleware, one warning.
// ---------------------------------------------------------------------------

test("R0.1.19 — eleven dev-open requests through the REAL middleware warn exactly ONCE", () => {
  const run = realMiddleware();
  assert.equal(ELEVEN.length, 11, "the derivation must have produced eleven probes");
  const responses = [];
  const warnings = warningsDuring(() => {
    ELEVEN.forEach((probe, i) => responses.push(run(operatorRequest(probe, i + 1))));
  });

  assert.equal(
    warnings.length,
    1,
    `the dev-open disclosure fired ${warnings.length} times across 11 requests to 11 DISTINCT ` +
      `operator pathnames (${describe(ELEVEN)}). Expected exactly 1. If this is 11, the once-flag ` +
      "is not surviving between requests: it is re-created inside middleware() (a declaration " +
      "ADDED there shadows the module-level one even if that one is still present), reset before " +
      "the call, or KEYED — by pathname, by method or by URL — so every route gets its own fresh " +
      "flag and production gets one line per operator route. Module scope is not a spelling and " +
      "it is not a Map; it is this count."
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
    assert.equal(
      response?.status,
      200,
      `request ${i + 1} (${ELEVEN[i].method} ${ELEVEN[i].pathname}) was not allowed through the ` +
        `perimeter`
    );
    assert.equal(
      response.headers.get("x-middleware-next"),
      "1",
      `request ${i + 1} (${ELEVEN[i].method} ${ELEVEN[i].pathname}) did not take ` +
        `NextResponse.next() — it was not the dev-open ALLOW branch`
    );
  }
});

test("R0.1.19 — the very FIRST request is the one that warns, and everything after is silent", () => {
  // Ordering, separately from the total: a "once" that fires on request 7
  // would leave requests 1-6 undisclosed. The module is imported once per
  // process, so this shares the flag with the test above; run in isolation the
  // first probe below is request 12, and by then the flag is already burnt.
  // That is exactly the claim — silence AFTER the first disclosure — so this
  // asserts the tail here and the head is proved by warnings[0] above.
  //
  // R6.4.13 gives this test two distinct jobs, and it must stay silent for
  // BOTH kinds of follow-up request:
  //   - a REPEAT of a pathname already probed, which a per-REQUEST flag warns
  //     on (each request gets a fresh box);
  //   - two FRESH operator pathnames never probed above, which a per-PATHNAME
  //     flag warns on (each new route gets a fresh box) while a repeat would
  //     not have caught it.
  const run = realMiddleware();
  const later = warningsDuring(() => {
    run(operatorRequest(ELEVEN[0], "tail-repeat")); // already-probed pathname
    for (const probe of TAIL_PAIR) run(operatorRequest(probe, "tail-fresh")); // never probed
  });
  assert.deepEqual(
    later,
    [],
    `the perimeter kept talking after it had already disclosed once (${later.length} more ` +
      `warnings, from ${ELEVEN[0].pathname} repeated plus the fresh routes ` +
      `${describe(TAIL_PAIR)}). A warning on the REPEAT means the flag is per-request; a warning ` +
      `only on the FRESH pathnames means it is keyed per pathname. Either way it is not sticking.`
  );
});

// The public-route control used to live here, below the criterion. It was moved
// ABOVE it — see the comment there. Running last against a spent once-flag was
// the whole reason it could not tell a public route from an operator one.
