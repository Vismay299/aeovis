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
    ["GET", "/api/scans/Italica"],                           // brand history
    ["GET", "/api/scans/italicatiles.com/latest"],           // dashboard load
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

test("GET /api/scan is NOT public — only POST is part of the free-scan flow", () => {
  assert.equal(isPublicRoute("GET", "/api/scan"), false);
  assert.equal(isPublicRoute("POST", "/api/scan"), true);
});

test("a WRITE to a scan-read path is not public just because the prefix matches", () => {
  assert.equal(isPublicRoute("DELETE", "/api/scans/Italica"), false);
  assert.equal(isPublicRoute("POST", "/api/scans/by-id/x"), false);
  assert.equal(isPublicRoute("POST", "/api/scan/job-1/status"), false);
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
      else if (entry.name === "route.js") {
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
    ["/api/health", "/api/industries", "/api/scan/sample/status", "/api/scans/by-id/sample", "/api/scans/sample", "/api/scans/sample/latest"].sort(),
    "the set of publicly readable API routes changed — is that deliberate?"
  );

  const publicPost = routes.filter((r) => isPublicRoute("POST", concrete(r)));
  assert.deepEqual(publicPost.map(concrete), ["/api/scan"], "only POST /api/scan may be publicly writable");

  const exempt = routes.filter((r) => isSelfGated(concrete(r)));
  assert.deepEqual(
    exempt.sort(),
    ["/api/content/worker", "/api/scan/worker"],
    "only the cron workers may bypass the perimeter, and each must carry its own gate"
  );
});

test("GUARD — middleware.js binds the tested decision and scopes itself to /api", async () => {
  const src = await readFile(path.join(REPO, "src/middleware.js"), "utf8");
  assert.match(src, /authorizeOperatorRequest/, "must use the tested decision, not its own");
  assert.match(src, /matcher: \["\/api\/:path\*"\]/, "must not gate page routes");
  assert.match(src, /status: 401/);
});
