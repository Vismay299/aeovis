import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorizeOperatorRequest,
  isPublicRoute,
  isSelfGated,
  timingSafeEquals,
  extractOperatorToken,
  resolveNodeEnv,
  warnDevPerimeterOpen,
  PERIMETER,
} from "./operatorPerimeter.js";

const TOKEN = "op-token-0123456789abcdef";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const headers = (h = {}) => {
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  return (name) => lower[String(name).toLowerCase()] ?? null;
};

const ask = (method, pathname, opts = {}) =>
  authorizeOperatorRequest({
    method,
    pathname,
    operatorToken: opts.operatorToken ?? TOKEN,
    nodeEnv: opts.nodeEnv ?? "production",
    header: headers(opts.headers),
    cookie: (n) => (opts.cookies || {})[n] ?? null,
  });

// ---------------------------------------------------------------------------
// THE FREE-SCAN FLOW. Breaking any of these breaks the product's front door.
// The sequence mirrors src/services/api.js runScan exactly.
// ---------------------------------------------------------------------------

test("FREE SCAN — the whole anonymous flow passes with no credentials at all", () => {
  const flow = [
    ["POST", "/api/scan"],                                   // start
    ["GET", "/api/scan/8b1f-4c2a-job/status"],               // poll
    ["GET", "/api/scans/by-id/3f2c-scan-id"],                // read the record
    ["GET", "/api/scans/by-id/3f2c-scan-id"],                // anonymous scan completion read
    ["GET", "/api/scan/8b1f-4c2a-job/evidence"],              // R1.5.3 "View evidence" (?result=... is the query)
    ["GET", "/api/industries"],                              // the scan form's picker
    ["GET", "/api/health"],                                  // uptime monitor
  ];
  for (const [method, pathname] of flow) {
    const out = ask(method, pathname, { headers: {} });
    assert.equal(out.allow, true, `${method} ${pathname} must stay public — this is the front door`);
    assert.equal(out.reason, PERIMETER.ALLOW_PUBLIC);
  }
});

test("FREE SCAN — a trailing slash does not change the verdict", () => {
  assert.equal(ask("POST", "/api/scan/", { headers: {} }).allow, true);
  assert.equal(ask("GET", "/api/industries/", { headers: {} }).allow, true);
});

test("FREE SCAN — the cron workers pass through to their OWN gate, not this one", () => {
  // The worker's self-continue fetch carries x-cron-secret, never an operator
  // token. Gating it here would 401 the call and stall every multi-chunk scan.
  for (const p of ["/api/scan/worker", "/api/content/worker"]) {
    const out = ask("GET", p, { headers: {} });
    assert.equal(out.allow, true, `${p} must not be double-gated`);
    assert.equal(out.reason, PERIMETER.ALLOW_SELF_GATED);
    assert.equal(isSelfGated(p), true);
  }
});

// ---------------------------------------------------------------------------
// THE PERIMETER ITSELF.
// ---------------------------------------------------------------------------

test("ACCEPT CRITERION — unauthenticated POST /api/content is refused", () => {
  const out = ask("POST", "/api/content", { headers: {} });
  assert.equal(out.allow, false);
  assert.equal(out.reason, PERIMETER.DENY_BAD_TOKEN);
});

test("every operator surface is closed to an anonymous caller", () => {
  const closed = [
    ["POST", "/api/content"],
    ["GET", "/api/content"],
    ["GET", "/api/agents"],
    ["POST", "/api/agents"],
    ["GET", "/api/knowledge"],
    ["GET", "/api/lessons"],
    ["GET", "/api/brand-briefs"],
    ["GET", "/api/brands/italicatiles.com/metrics"],
    ["GET", "/api/brands/italicatiles.com/citations"],
    ["POST", "/api/content-items/abc/decision"],
    ["GET", "/api/opportunities"],
    ["GET", "/api/history"],
    ["GET", "/api/prompts/abc"],
  ];
  for (const [method, pathname] of closed) {
    assert.equal(ask(method, pathname, { headers: {} }).allow, false, `${method} ${pathname} must be gated`);
  }
});

test("customer API reaches its own session-and-membership gate, not the operator token gate", () => {
  for (const [method, pathname] of [
    ["GET", "/api/customer/overview"],
    ["GET", "/api/customer/gsc"],
    ["POST", "/api/customer/gsc"],
  ]) {
    const out = ask(method, pathname, { headers: {} });
    assert.equal(out.allow, true, `${method} ${pathname} must reach the customer route's auth check`);
    assert.equal(out.reason, PERIMETER.ALLOW_SELF_GATED);
  }
  assert.equal(ask("POST", "/api/customers/invite", { headers: {} }).allow, false,
    "invitation admin must remain operator-only");
});

test("GET /api/scan is NOT public — only POST is part of the free-scan flow", () => {
  assert.equal(isPublicRoute("GET", "/api/scan"), false);
  assert.equal(isPublicRoute("POST", "/api/scan"), true);
});

test("brand-keyed scan history is private while the opaque free-scan result id remains public", () => {
  assert.equal(isPublicRoute("GET", "/api/scans/by-id/3f2c-scan-id"), true);
  assert.equal(isPublicRoute("GET", "/api/scans/snitch.com"), false);
  assert.equal(isPublicRoute("GET", "/api/scans/snitch.com/latest"), false);
  assert.equal(ask("GET", "/api/scans/snitch.com", { headers: {} }).allow, false);
});

test("a WRITE to a scan-read path is not public just because the prefix matches", () => {
  assert.equal(isPublicRoute("DELETE", "/api/scans/Italica"), false);
  assert.equal(isPublicRoute("POST", "/api/scans/by-id/x"), false);
  assert.equal(isPublicRoute("POST", "/api/scan/job-1/status"), false);
  // R1.5.3 — the evidence link is a read. Nothing may be written through it.
  assert.equal(isPublicRoute("POST", "/api/scan/job-1/evidence"), false);
  assert.equal(isPublicRoute("DELETE", "/api/scan/job-1/evidence"), false);
  // ...and the pattern does not open anything BELOW it.
  assert.equal(isPublicRoute("GET", "/api/scan/job-1/evidence/raw/secret"), false);
});

test("the operator token is accepted as bearer, header, or cookie", () => {
  assert.equal(ask("GET", "/api/agents", { headers: { authorization: `Bearer ${TOKEN}` } }).reason, PERIMETER.ALLOW_OPERATOR);
  assert.equal(ask("GET", "/api/agents", { headers: { "x-operator-token": TOKEN } }).reason, PERIMETER.ALLOW_OPERATOR);
  assert.equal(ask("GET", "/api/agents", { cookies: { operator_token: TOKEN } }).reason, PERIMETER.ALLOW_OPERATOR);
});

test("a wrong token is refused, including a correct PREFIX", () => {
  for (const bad of ["", "wrong", TOKEN.slice(0, -1), TOKEN + "x", TOKEN.toUpperCase()]) {
    const out = ask("GET", "/api/agents", { headers: { "x-operator-token": bad } });
    assert.equal(out.allow, false, `"${bad}" must be refused`);
  }
});

test("PRODUCTION + no OPERATOR_TOKEN — closed, not open", () => {
  const out = ask("GET", "/api/agents", { operatorToken: "", nodeEnv: "production", headers: {} });
  assert.equal(out.allow, false);
  assert.equal(out.reason, PERIMETER.DENY_NO_TOKEN_CONFIGURED);
});

test("PRODUCTION + no OPERATOR_TOKEN — the free scan STILL works", () => {
  // Fail-closed must never take the front door with it.
  const out = ask("POST", "/api/scan", { operatorToken: "", nodeEnv: "production", headers: {} });
  assert.equal(out.allow, true);
});

test("DEV + no OPERATOR_TOKEN — open, so local development is not blocked", () => {
  const out = ask("GET", "/api/agents", { operatorToken: "", nodeEnv: "development", headers: {} });
  assert.equal(out.allow, true);
  assert.equal(out.reason, PERIMETER.ALLOW_DEV_NO_TOKEN);
});

test("timingSafeEquals - correct on equality, inequality, and length mismatch", () => {
  assert.equal(timingSafeEquals("abc", "abc"), true);
  assert.equal(timingSafeEquals("abc", "abd"), false);
  assert.equal(timingSafeEquals("abc", "abcd"), false);
  assert.equal(timingSafeEquals("", ""), true);
  assert.equal(timingSafeEquals("", "a"), false);
  assert.equal(timingSafeEquals(null, undefined), true, "both empty");
  assert.equal(timingSafeEquals(null, "a"), false);
});

test("extractOperatorToken - bearer wins over header wins over cookie", () => {
  const got = extractOperatorToken({
    header: headers({ authorization: "Bearer from-bearer", "x-operator-token": "from-header" }),
    cookie: () => "from-cookie",
  });
  assert.equal(got, "from-bearer");
  assert.equal(
    extractOperatorToken({ header: headers({ "x-operator-token": "from-header" }), cookie: () => "from-cookie" }),
    "from-header"
  );
  assert.equal(extractOperatorToken({ header: headers({}), cookie: () => "from-cookie" }), "from-cookie");
});

// ---------------------------------------------------------------------------
// Guard: the allowlist must cover every route the free-scan client calls, and
// no more. A route added to src/app/api without a decision is closed by
// default — that is the point — but a NEW public one has to be deliberate.
// ---------------------------------------------------------------------------

test("GUARD — every /api route on disk gets a decision, and only the intended ones are public", async () => {
  const apiRoot = path.join(REPO, "src/app/api");
  const routes = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "route.js" || entry.name === "route.ts") {
        routes.push("/" + path.relative(REPO, path.dirname(full)).split(path.sep).slice(2).join("/"));
      }
    }
  }
  await walk(apiRoot);
  assert.ok(routes.length > 20, `the walker must find the API surface, found ${routes.length}`);

  // Turn Next's [param] segments into a concrete value so the patterns apply.
  const concrete = (r) => r.replace(/\[[^\]]+\]/g, "sample");

  const publicGet = routes.filter((r) => isPublicRoute("GET", concrete(r)));
  assert.deepEqual(
    publicGet.map(concrete).sort(),
    [
      "/api/health",
      "/api/industries",
      // R1.5.3 — deliberate: the anonymous dashboard's "View evidence" link.
      // It redirects to a signed URL for a screenshot of an answer the same
      // anonymous reader can already fetch the TEXT of from /api/scans/...
      "/api/scan/sample/evidence",
      "/api/scan/sample/status",
      "/api/scans/by-id/sample",
    ].sort(),
    "the set of publicly readable API routes changed — is that deliberate?"
  );

  const publicPost = routes.filter((r) => isPublicRoute("POST", concrete(r)));
  assert.deepEqual(publicPost.map(concrete).sort(), ["/api/demo/scan", "/api/scan"], "only a real scan and the isolated fixed simulation may be public POST routes");

  const exempt = routes.filter((r) => isSelfGated(concrete(r)));
  assert.deepEqual(
    exempt.sort(),
    [
      "/api/customer/content/[id]/check",
      "/api/customer/content/[id]/publish",
      "/api/customer/repairs/[kind]",
      "/api/customer/measurement/evidence",
      "/api/customer/measurement",
      "/api/customer/agents",
      "/api/customer/agents/[id]",
      // F18 — site audit routes. Self-gated via requireWorkspace and the site_audit flag.
      "/api/customer/audit",
      "/api/customer/audit/[auditId]",
      "/api/customer/audit/[auditId]/cancel",
      "/api/customer/audit/[auditId]/feed",
      "/api/customer/audit/[auditId]/issues",
      "/api/customer/audit/[auditId]/pages",
      "/api/customer/audit/[auditId]/performance",
      "/api/customer/audit/[auditId]/summary",
      "/api/customer/audit/[auditId]/lighthouse/[resultId]",
      "/api/customer/audit/[auditId]/lighthouse/[resultId]/export",
      "/api/customer/content",
    "/api/customer/content/[id]",
    "/api/customer/context",
    // F14 — domain research routes. Self-gated via requireWorkspace.
    "/api/customer/domain/competitors",
    "/api/customer/domain/competitors/add",
    "/api/customer/domain/competitors/declared",
    "/api/customer/domain/keywords",
    "/api/customer/domain/overview",
    "/api/customer/domain/pages",
    // F16 — backlinks research routes. Self-gated via requireWorkspace.
    "/api/customer/backlinks/overview",
    "/api/customer/backlinks/referring-domains",
    "/api/customer/backlinks/rows",
    "/api/customer/backlinks/top-pages",
    // F04 — the client-visible feature flags. Self-gated like every other
    // customer route: it answers only for a workspace the caller belongs to.
    "/api/customer/features",
    // F06 phase 3 - server-side exports. Self-gated via requireWorkspace and the
    // server_exports flag.
    "/api/customer/exports",
    "/api/customer/ga4",
    "/api/customer/ga4/accounts",
    "/api/customer/ga4/accounts/[grantId]",
    "/api/customer/ga4/callback",
    "/api/customer/ga4/connect",
    "/api/customer/ga4/properties",
    "/api/customer/ga4/property",
    "/api/customer/gsc",
      "/api/customer/gsc/callback",
      "/api/customer/gsc/connect",
      "/api/customer/gsc/data",
      "/api/customer/gsc/properties",
      "/api/customer/gsc/property",
      "/api/customer/gsc/sync",
      "/api/customer/indexnow",
      "/api/customer/indexnow/check",
      "/api/customer/indexnow/setup",
      "/api/customer/indexnow/submissions",
      "/api/customer/indexnow/submit",
      "/api/customer/jobs/[jobId]",
      "/api/customer/jobs/[jobId]/cancel",
      "/api/customer/keywords/research",
      "/api/customer/keywords/saved",
      "/api/customer/keywords/saved/export",
      "/api/customer/keywords/saved/refresh",
      "/api/customer/keywords/saved/remove",
      "/api/customer/keywords/saved/tags",
      "/api/customer/keywords/serp",
      "/api/customer/keywords/tags/[tagId]",
      "/api/customer/keywords/locations",
      "/api/customer/keywords/cluster",
      "/api/customer/keywords/cluster/apply",
      // F17 — local SEO routes. Self-gated via requireWorkspace and the local_seo flag.
      "/api/customer/local/businesses",
      "/api/customer/local/businesses/[businessId]",
      "/api/customer/local/businesses/[businessId]/profile",
      "/api/customer/local/categories",
      "/api/customer/local/fetches",
      "/api/customer/local/fetches/[fetchId]",
      "/api/customer/local/grids",
      "/api/customer/local/grids/[gridId]",
      "/api/customer/local/listings",
      "/api/customer/local/profile",
      "/api/customer/local/serp",
      "/api/customer/price/estimate",
      "/api/customer/privacy",
      "/api/customer/questions",
      "/api/customer/questions/approve",
      "/api/customer/questions/generate",
      "/api/customer/questions/research",
      "/api/customer/questions/research/keywords",
      "/api/customer/questions/setup",
      "/api/customer/questions/setup/save",
      "/api/customer/scan",
      "/api/customer/scan/mock",
      "/api/customer/scan/report/[scan_id]",
      // F06 phase 5 - server-side Scans history. Self-gated via requireWorkspace.
      "/api/customer/scans/history",
      "/api/customer/schedule",
      "/api/customer/team",
      "/api/customer/usage",
      "/api/gsc/sync-worker",
      "/api/customer/onboard",
      "/api/customer/overview",
      "/api/content/worker",
      "/api/evidence/retention",
      "/api/gsc/worker",
      "/api/jobs/tick",
      "/api/scan/worker",
      // R1.2.23 — the scan_runs retention cron. Carries its own cronAuth gate,
      // exactly like the four above.
      "/api/scan-runs/retention",
      "/api/customer/rank-tracking/configs",
      "/api/customer/rank-tracking/configs/[configId]",
      "/api/customer/rank-tracking/configs/[configId]/check",
      "/api/customer/rank-tracking/configs/[configId]/keywords",
      "/api/customer/rank-tracking/configs/[configId]/keywords/remove",
      "/api/customer/rank-tracking/configs/[configId]/keywords/pin",
      "/api/customer/rank-tracking/configs/[configId]/keywords/[keywordId]/history",
      "/api/customer/rank-tracking/configs/[configId]/metrics/refresh",
      "/api/customer/rank-tracking/configs/[configId]/runs/latest",
      "/api/customer/rank-tracking/configs/[configId]/results",
      "/api/customer/rank-tracking/configs/[configId]/trend",
      "/api/customer/rank-tracking/configs/[configId]/matrix",
      "/api/customer/rank-tracking/suggestions",
    ].sort(),
    "only cron workers and customer-authenticated routes may bypass the operator token gate"
  );
});

test("GUARD — middleware.js binds the tested decision and scopes itself to /api", async () => {
  const src = await readFile(path.join(REPO, "src/middleware.js"), "utf8");
  assert.match(src, /authorizeOperatorRequest/, "must use the tested decision, not its own");
  assert.match(src, /matcher: \["\/api\/:path\*"\]/, "must not gate page routes");
  assert.match(src, /status: 401/);
});

// ---------------------------------------------------------------------------
// RUNTIME vs BUILD-TIME NODE_ENV.
//
// R0.1.1's verifier found middleware.js passing the literal
// process.env.NODE_ENV into the decision. Next substitutes that exact
// expression at BUILD time in the Edge bundle (define-env-plugin.js), so the
// perimeter's notion of "production" was fixed by the compile and could not be
// moved by the environment the server was started with. It failed CLOSED, so
// it was not a hole — but it meant any test that flipped NODE_ENV at runtime
// to exercise the dev branch of middleware.js would have exercised nothing at
// all, and a test that passes while testing nothing is the thing this rebuild
// exists to delete. The guard below is what stops that being written again.
// ---------------------------------------------------------------------------

test("resolveNodeEnv — an environment that will not say what it is counts as production", () => {
  assert.equal(resolveNodeEnv({ NODE_ENV: "development" }), "development");
  assert.equal(resolveNodeEnv({ NODE_ENV: "test" }), "test");
  assert.equal(resolveNodeEnv({ NODE_ENV: "production" }), "production");
  // Fail closed. Making the read dynamic must not turn the perimeter fail-open
  // wherever NODE_ENV happens to be missing.
  assert.equal(resolveNodeEnv({}), "production");
  assert.equal(resolveNodeEnv({ NODE_ENV: "" }), "production");
  assert.equal(resolveNodeEnv({ NODE_ENV: "   " }), "production");
  assert.equal(resolveNodeEnv(undefined), "production");
  assert.equal(resolveNodeEnv(null), "production");
});

test("resolveNodeEnv — the resolved value still drives the real decision", () => {
  const askEnv = (env) =>
    authorizeOperatorRequest({
      method: "GET",
      pathname: "/api/agents",
      operatorToken: "",
      nodeEnv: resolveNodeEnv(env),
      header: headers({}),
    });
  assert.equal(askEnv({ NODE_ENV: "development" }).reason, PERIMETER.ALLOW_DEV_NO_TOKEN);
  assert.equal(askEnv({ NODE_ENV: "production" }).reason, PERIMETER.DENY_NO_TOKEN_CONFIGURED);
  assert.equal(
    askEnv({}).reason,
    PERIMETER.DENY_NO_TOKEN_CONFIGURED,
    "no NODE_ENV must be closed, not open"
  );
});

test("GUARD — middleware.js reads NODE_ENV at RUNTIME, not at build time", async () => {
  const src = await readFile(path.join(REPO, "src/middleware.js"), "utf8");
  // Comments may name the forbidden expression; only executable code matters,
  // because Next substitutes expressions, not prose.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    code,
    /process\.env\.NODE_ENV/,
    "middleware.js must not contain the literal process.env.NODE_ENV: Next inlines it at build " +
      "time, which makes the perimeter judge production by how it was compiled and makes any " +
      "runtime NODE_ENV test silently vacuous. Use resolveNodeEnv(process.env)."
  );
  assert.match(
    code,
    /resolveNodeEnv\(\s*process\.env\s*\)/,
    "middleware.js must resolve NODE_ENV off the runtime env object"
  );
  // OPERATOR_TOKEN is safe to read directly: Next only inlines NEXT_PUBLIC_* and
  // next.config `env` keys, so this one comes from the Edge runtime env.
  assert.match(code, /process\.env\.OPERATOR_TOKEN/);
});

// ---------------------------------------------------------------------------
// R0.1.14 — the dev-open perimeter must SAY it is open.
//
// R0.1.3 made the NODE_ENV read dynamic and resolved absent/blank to
// "production", so an undeclared environment stays closed. But a DECLARED
// non-production value (development, staging, preview...) still opens the
// perimeter when OPERATOR_TOKEN is unset: POST /api/content and
// GET /api/knowledge are served to anyone. That rule is pre-existing and
// matches cronAuth.js. What did NOT match was the disclosure: isCronAuthorized
// warns once on OK_DEV_NO_SECRET; ALLOW_DEV_NO_TOKEN logged nothing at all.
// Verified before the fix by driving the real middleware with OPERATOR_TOKEN
// unset and NODE_ENV=development — three operator routes admitted, zero lines
// on console.warn/error/log.
//
// Deleting warnDevPerimeterOpen's logger.warn call fails the first test here;
// deleting the call site in middleware.js fails the GUARD at the end.
// ---------------------------------------------------------------------------

const captureLogger = () => {
  const warnings = [];
  return { warnings, logger: { warn: (m) => warnings.push(m) } };
};

test("R0.1.14 — the dev-open branch warns, and names the resolved NODE_ENV", () => {
  for (const nodeEnv of ["development", "staging", "test", "preview"]) {
    const decision = authorizeOperatorRequest({
      method: "POST",
      pathname: "/api/content",
      operatorToken: "",
      nodeEnv: resolveNodeEnv({ NODE_ENV: nodeEnv }),
      header: headers({}),
    });
    assert.equal(decision.reason, PERIMETER.ALLOW_DEV_NO_TOKEN, `${nodeEnv} must still open`);

    const { warnings, logger } = captureLogger();
    const warned = { value: false };
    const fired = warnDevPerimeterOpen({
      reason: decision.reason,
      nodeEnv: resolveNodeEnv({ NODE_ENV: nodeEnv }),
      method: "POST",
      pathname: "/api/content",
      warned,
      logger,
    });
    assert.equal(fired, true, `taking the dev-open branch in ${nodeEnv} must disclose it`);
    assert.equal(warnings.length, 1, "exactly one line");
    assert.match(warnings[0], /UNAUTHENTICATED/, "the line must say what is wrong, not just hum");
    assert.ok(
      warnings[0].includes("NODE_ENV=" + nodeEnv + "."),
      "the warning must name the RESOLVED NODE_ENV that opened the gate, exactly: " + warnings[0]
    );
    assert.match(warnings[0], /OPERATOR_TOKEN/, "it must name the variable an operator has to set");
    assert.match(warnings[0], /POST \/api\/content/, "and where it first saw the open route");
  }
});

test("R0.1.14 — it fires exactly ONCE per flag, however many requests arrive", () => {
  const { warnings, logger } = captureLogger();
  const warned = { value: false };
  const call = (pathname) =>
    warnDevPerimeterOpen({
      reason: PERIMETER.ALLOW_DEV_NO_TOKEN,
      nodeEnv: "development",
      method: "GET",
      pathname,
      warned,
      logger,
    });
  assert.equal(call("/api/knowledge"), true);
  for (let i = 0; i < 25; i++) assert.equal(call("/api/agents"), false, "repeats stay silent");
  assert.equal(warnings.length, 1, "a line on every request is a line nobody reads");
  assert.equal(warned.value, true);
  // The return value, not just the log, separates "suppressed repeat" from
  // "never took the branch" — measured zero must not look like never ran.
  assert.match(warnings[0], /\/api\/knowledge/, "the one line names the FIRST route, not the last");
});

test("R0.1.14 — every other verdict stays silent", () => {
  const quiet = [
    PERIMETER.ALLOW_PUBLIC,
    PERIMETER.ALLOW_SELF_GATED,
    PERIMETER.ALLOW_OPERATOR,
    PERIMETER.DENY_NO_TOKEN_CONFIGURED,
    PERIMETER.DENY_BAD_TOKEN,
  ];
  for (const reason of quiet) {
    const { warnings, logger } = captureLogger();
    const warned = { value: false };
    assert.equal(
      warnDevPerimeterOpen({
        reason,
        nodeEnv: "development",
        method: "POST",
        pathname: "/api/scan",
        warned,
        logger,
      }),
      false,
      `${reason} is not the dev-open branch`
    );
    assert.equal(warnings.length, 0, `${reason} must not warn — the free scan runs on this path`);
    assert.equal(warned.value, false, `${reason} must not burn the once-flag`);
  }
});

test("R0.1.14 — a missing once-flag throws rather than silently not disclosing", () => {
  assert.throws(
    () =>
      warnDevPerimeterOpen({
        reason: PERIMETER.ALLOW_DEV_NO_TOKEN,
        nodeEnv: "development",
        method: "GET",
        pathname: "/api/agents",
        logger: { warn: () => {} },
      }),
    /once-flag/,
    "a disclosure helper that quietly declines to disclose is the bug it exists to prevent"
  );
});

test("R0.1.14 — the warning must not change who gets in", () => {
  // The disclosure is a log, not a gate. R0.1.3 admission rules stand.
  const askEnvOpen = (env) =>
    authorizeOperatorRequest({
      method: "GET",
      pathname: "/api/knowledge",
      operatorToken: "",
      nodeEnv: resolveNodeEnv(env),
      header: headers({}),
    });
  assert.equal(askEnvOpen({}).allow, false, "NODE_ENV unset must still be REFUSED (R0.1.3)");
  assert.equal(askEnvOpen({ NODE_ENV: "" }).allow, false, "NODE_ENV blank must still be REFUSED");
  assert.equal(askEnvOpen({ NODE_ENV: "  " }).allow, false, "whitespace NODE_ENV still REFUSED");
  assert.equal(askEnvOpen({ NODE_ENV: "production" }).reason, PERIMETER.DENY_NO_TOKEN_CONFIGURED);
  // And the two exemptions the perimeter depends on are untouched.
  assert.equal(ask("POST", "/api/scan", { headers: {} }).reason, PERIMETER.ALLOW_PUBLIC);
  assert.equal(ask("POST", "/api/scan/worker", { headers: {} }).reason, PERIMETER.ALLOW_SELF_GATED);
  assert.equal(
    ask("POST", "/api/content/worker", { headers: {} }).reason,
    PERIMETER.ALLOW_SELF_GATED
  );
});

/**
 * R0.1.19 / S17 — this guard used to also assert, by regex over the source,
 * that the once-flag was declared at module scope and passed as
 * `warned: <thatName>`. Both assertions were removed because they claimed
 * something text cannot establish, and R0.1.14's verifier proved it in both
 * directions:
 *
 *   - FALSE NEGATIVE. Leaving the module-level declaration in place as a DECOY
 *     and ADDING `const warnedDevOpen = { value: false };` as the first line of
 *     middleware() still matched both regexes, so the guard stayed green while
 *     the flag was reborn per request and the perimeter warned on every one.
 *     Inserting `warnedDevOpen.value = false;` above the call did the same.
 *   - FALSE POSITIVE. Renaming the flag to `warned` and using ES2015 property
 *     shorthand (`warned,`) is correct, unchanged behaviour, and the second
 *     assertion FAILED on it — a rename turned the suite red.
 *
 * Once-ness is a runtime property, not a spelling, so it is asserted where it
 * is observable: operatorPerimeter.middleware.test.mjs imports the REAL
 * middleware and counts one warning across eleven dev-open requests. That test
 * fails on both evasions above and passes on the rename.
 *
 * What survives here is the one thing a behavioural test cannot see, because a
 * middleware with the call deleted warns zero times and "zero" is not
 * distinguishable from "already disclosed once" without reading the source:
 * that the CALL still exists at all.
 */
test("GUARD — middleware.js still calls the dev-open disclosure at all", async () => {
  const src = await readFile(path.join(REPO, "src/middleware.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(
    code,
    /warnDevPerimeterOpen\(/,
    "middleware.js must disclose the dev-open perimeter (R0.1.14). The unit tests above pin the " +
      "helper and operatorPerimeter.middleware.test.mjs pins the once-ness; only this guard stops " +
      "the CALL being deleted outright and the perimeter going quiet again."
  );
  // cronAuth is the reference implementation; the two gates must stay aligned.
  const cron = await readFile(path.join(REPO, "src/lib/cronAuth.js"), "utf8");
  assert.match(cron, /ctx\.warned\.value = true;/, "cronAuth warn-once is the model for this");
});
