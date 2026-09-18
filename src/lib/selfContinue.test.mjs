/**
 * R3.1.10 — the self-continue mechanism, exercised with NO network.
 *
 * Every test here injects `fetchImpl`, `keepAliveImpl`, `env` and `logger`, so
 * nothing leaves the process and no environment variable is read from the real
 * one. The header tests are the same shape as
 * src/lib/workers/finalizeReclaim.test.mjs's scan-side equivalents, because
 * the two mechanisms must not drift.
 *
 * No value in this file is a real credential; the strings are literals chosen
 * to be obviously fake.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  SELF_CONTINUE_HOLD_MS,
  resolveSelfContinueUrl,
  buildSelfContinueInit,
  makeSelfContinue,
} from "./selfContinue.js";

// ---------------------------------------------------------------------------
// 1. URL resolution — the same precedence as the scan worker's copy.
// ---------------------------------------------------------------------------

test("URL — NEXT_PUBLIC_APP_URL wins, and the route path is what the caller asked for", () => {
  const url = resolveSelfContinueUrl("/api/content/worker", "job-1", {
    NEXT_PUBLIC_APP_URL: "https://app.example.com/",
    VERCEL_URL: "deployment.vercel.app",
  });
  assert.equal(url, "https://app.example.com/api/content/worker?job_id=job-1");
});

test("URL — falls back to the Vercel deployment URL, then to localhost", () => {
  assert.equal(
    resolveSelfContinueUrl("/api/content/worker", "job-2", { VERCEL_URL: "dep.vercel.app" }),
    "https://dep.vercel.app/api/content/worker?job_id=job-2"
  );
  assert.equal(
    resolveSelfContinueUrl("/api/content/worker", "job-3", { PORT: "4000" }),
    "http://localhost:4000/api/content/worker?job_id=job-3"
  );
});

test("URL — a job id is encoded, so it cannot forge extra query parameters", () => {
  const url = resolveSelfContinueUrl("/api/content/worker", "a b&batch=1", {
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
  });
  assert.equal(url, "https://app.example.com/api/content/worker?job_id=a%20b%26batch%3D1");
});

test("URL — the route path is a parameter, so scan and content resolve differently", () => {
  const env = { NEXT_PUBLIC_APP_URL: "https://app.example.com" };
  assert.match(resolveSelfContinueUrl("/api/scan/worker", "j", env), /\/api\/scan\/worker\?job_id=j$/);
  assert.match(resolveSelfContinueUrl("/api/content/worker", "j", env), /\/api\/content\/worker\?job_id=j$/);
});

// ---------------------------------------------------------------------------
// 2. The request's headers — two different gates, only one of them ours.
// ---------------------------------------------------------------------------

test("HEADERS — the self-continue carries the cron secret AND the protection bypass", () => {
  const { init, missingBypass } = buildSelfContinueInit({
    CRON_SECRET: "not-a-real-cron-secret",
    VERCEL_AUTOMATION_BYPASS_SECRET: "not-a-real-bypass-secret",
    VERCEL: "1",
  });
  assert.deepEqual(init.headers, {
    "x-cron-secret": "not-a-real-cron-secret",
    "x-vercel-protection-bypass": "not-a-real-bypass-secret",
  });
  assert.equal(missingBypass, false);
});

test("HEADERS — on Vercel with no bypass secret the risk is disclosed, not assumed away", () => {
  const { init, missingBypass } = buildSelfContinueInit({ CRON_SECRET: "c", VERCEL: "1" });
  assert.deepEqual(init.headers, { "x-cron-secret": "c" });
  assert.equal(
    missingBypass,
    true,
    "this is the 2026-09-15 production failure — Deployment Protection answers the self-fetch " +
      "with an SSO redirect and the job never advances. It must be visible."
  );
});

test("HEADERS — off Vercel there is no protection in front of the function, so no warning", () => {
  assert.equal(buildSelfContinueInit({ CRON_SECRET: "c" }).missingBypass, false);
});

test("HEADERS — with nothing configured the request goes out bare rather than not at all", () => {
  assert.equal(buildSelfContinueInit({}).init, undefined);
});

// ---------------------------------------------------------------------------
// 3. makeSelfContinue — fires once, through keepAlive, with a cap.
// ---------------------------------------------------------------------------

function harness(env, { fetchImpl } = {}) {
  const calls = [];
  const holds = [];
  const warnings = [];
  const selfContinue = makeSelfContinue({
    routePath: "/api/content/worker",
    label: "content-worker",
    env,
    fetchImpl:
      fetchImpl ||
      (async (url, init) => {
        calls.push({ url, init });
        return { ok: true };
      }),
    keepAliveImpl: (work, opts) => {
      holds.push(opts);
      return Promise.resolve(work).catch(() => {});
    },
    logger: { warn: (m) => warnings.push(String(m)) },
  });
  return { selfContinue, calls, holds, warnings };
}

test("FIRE — one request, to the content worker route, with both headers", async () => {
  const { selfContinue, calls } = harness({
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    CRON_SECRET: "not-a-real-cron-secret",
    VERCEL_AUTOMATION_BYPASS_SECRET: "not-a-real-bypass-secret",
    VERCEL: "1",
  });

  const verdict = selfContinue("job-9");
  assert.deepEqual(verdict, { fired: true, reason: null });
  assert.equal(calls.length, 1, "exactly one self-continue request");
  assert.equal(calls[0].url, "https://app.example.com/api/content/worker?job_id=job-9");
  assert.deepEqual(calls[0].init.headers, {
    "x-cron-secret": "not-a-real-cron-secret",
    "x-vercel-protection-bypass": "not-a-real-bypass-secret",
  });
});

test("FIRE — the outgoing request is held by keepAlive with a cap, never awaited", async () => {
  const { selfContinue, holds } = harness({ NEXT_PUBLIC_APP_URL: "https://app.example.com" });
  selfContinue("job-10");

  assert.equal(holds.length, 1, "the request is registered with keepAlive");
  assert.equal(
    holds[0].maxMs,
    SELF_CONTINUE_HOLD_MS,
    "without a cap this invocation would be billed for the whole next chunk"
  );
  assert.match(holds[0].label, /self-continue for job job-10/);
});

test("FIRE — a rejected fetch is a warning, never a throw: the cron sweep is the backstop", async () => {
  const { selfContinue, warnings } = harness(
    { NEXT_PUBLIC_APP_URL: "https://app.example.com" },
    { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }
  );

  const verdict = selfContinue("job-11");
  assert.equal(verdict.fired, true, "the request was started; whether it lands is not ours to know");
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(
    warnings.some((w) => /ECONNREFUSED/.test(w) && /cron sweep/.test(w)),
    "a self-continue that failed must say so, and say what still rescues the job"
  );
});

test("FIRE — a fetch that cannot even start is reported as not fired, not as success", () => {
  const { selfContinue, warnings } = harness(
    { NEXT_PUBLIC_APP_URL: "https://app.example.com" },
    { fetchImpl: () => { throw new TypeError("fetch is not a function"); } }
  );

  const verdict = selfContinue("job-12");
  assert.deepEqual(verdict, { fired: false, reason: "fetch_start_failed" });
  assert.ok(warnings.some((w) => /could not be started/.test(w)), "a skip is not a success");
});

test("FIRE — a missing bypass secret on Vercel is warned about at the call site too", () => {
  const { selfContinue, warnings } = harness({
    VERCEL: "1",
    VERCEL_URL: "dep.vercel.app",
    CRON_SECRET: "not-a-real-cron-secret",
  });
  selfContinue("job-13");
  assert.ok(
    warnings.some((w) => /WITHOUT a protection bypass/.test(w)),
    "the operator must be told why the job is about to advance only on cron"
  );
});
