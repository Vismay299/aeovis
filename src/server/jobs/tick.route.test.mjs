// §6.3.1 / §6.5 — the tick route, driven through its real GET and POST handlers.
//
// The gate, the flag and the handler body all run as written; only the three
// collaborators the route accepts as `deps` are injected (the flag read, the
// tick itself and keepAlive), so the assertions are about the response the
// route actually returns and the work it actually hands to the platform.
//
// Order matters and is asserted, not assumed (PM brief, tick validation order):
// auth → flag → uuid. An unauthenticated request must never learn whether the
// feature is on, and a disabled tick must never answer a 400.
//
// Hooks: src/server/cronAuth.route.hooks.mjs, the same resolver the other cron
// route tests use. It answers only "which file is this specifier" for the `@/`
// alias and the extensionless `next/server`; nothing under test is replaced.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../cronAuth.route.hooks.mjs", import.meta.url);

const route = await import("../../app/api/jobs/tick/route.ts");
const { GET, POST } = route;

const SECRET = "s3cr3t-jobs-tick-value";
const TICK_URL = "https://aeovis.test/api/jobs/tick";

/** §6.5's 401 body, exactly. */
const UNAUTHORIZED = { error: "Unauthorized", code: "unauthorized" };
/** §6.5's 400 body for a non-uuid `job_id`. */
const INVALID = { error: "The request was not valid.", code: "invalid_request" };

/** Runs `fn` with CRON_SECRET configured, restoring the environment afterwards. */
async function withSecret(fn) {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
}

function request(path = "/api/jobs/tick", init = {}) {
  return new Request(TICK_URL + path, init);
}

const authorized = (path) =>
  request(path, { headers: { authorization: `Bearer ${SECRET}` } });

async function read(response) {
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.json(),
  };
}

/** Records the work handed to keepAlive without registering anything anywhere. */
function recorder() {
  const calls = [];
  const keepAlive = (work, opts) => {
    calls.push({ work, opts });
  };
  return { calls, keepAlive };
}

/** A promise the test settles by hand, so "returns before the work resolves" is observable. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flagSpy(value, calls = []) {
  const isFeatureEnabled = async (name) => {
    calls.push(name);
    return value;
  };
  return { isFeatureEnabled, calls };
}

test("the tick route declares a 300 s budget, no caching and both verbs", () => {
  assert.equal(GET, POST, "§6.3.1 defines GET and POST as the same handler");
  assert.equal(typeof GET, "function");
  assert.equal(route.maxDuration, 300, "Vercel's cap is the route's declared budget");
  assert.equal(route.dynamic, "force-dynamic");
});

test("GET and POST answer 401 unauthorized without the cron secret", async () => {
  await withSecret(async () => {
    const tick = flagSpy(true);
    const { calls, keepAlive } = recorder();
    const runTick = async () => assert.fail("an unauthenticated tick must not start work");

    for (const handler of [GET, POST]) {
      const { status, cacheControl, body } = await read(
        await handler(request(), { isFeatureEnabled: tick.isFeatureEnabled, keepAlive, runTick })
      );
      assert.equal(status, 401);
      assert.equal(cacheControl, "no-store");
      assert.deepEqual(body, UNAUTHORIZED);
    }

    assert.deepEqual(tick.calls, [], "the flag is never read for an unauthenticated request");
    assert.deepEqual(calls, []);
  });
});

test("auth runs before the flag and before the uuid check", async () => {
  await withSecret(async () => {
    const tick = flagSpy(false);
    const { calls, keepAlive } = recorder();
    const { status, body } = await read(
      await GET(request("/api/jobs/tick?job_id=not-a-uuid"), {
        isFeatureEnabled: tick.isFeatureEnabled,
        keepAlive,
        runTick: async () => assert.fail("a refused tick must not start work"),
      })
    );

    // Not 400 (the uuid is invalid) and not 200 (the flag is off): auth decided first.
    assert.equal(status, 401);
    assert.deepEqual(body, UNAUTHORIZED);
    assert.deepEqual(tick.calls, [], "auth is decided before `isFeatureEnabled` is called");
    assert.deepEqual(calls, []);
  });
});

test("a disabled tick answers 200 {skipped:'disabled'} and starts no work", async () => {
  await withSecret(async () => {
    const tick = flagSpy(false);
    const { calls, keepAlive } = recorder();
    const { status, cacheControl, body } = await read(
      await GET(authorized(), {
        isFeatureEnabled: tick.isFeatureEnabled,
        keepAlive,
        runTick: async () => assert.fail("a disabled tick must not start work"),
      })
    );

    assert.equal(status, 200);
    assert.equal(cacheControl, "no-store");
    assert.deepEqual(body, { skipped: "disabled" });
    assert.deepEqual(tick.calls, ["jobs_tick"], "the flag is read by name");
    assert.deepEqual(calls, []);
  });
});

test("the flag is decided before an invalid job_id is rejected", async () => {
  await withSecret(async () => {
    const tick = flagSpy(false);
    const { status, body } = await read(
      await GET(authorized("/api/jobs/tick?job_id=not-a-uuid"), { isFeatureEnabled: tick.isFeatureEnabled })
    );

    assert.equal(status, 200, "a disabled tick answers 'disabled' even when job_id is malformed");
    assert.deepEqual(body, { skipped: "disabled" });
  });
});

test("an enabled tick answers 202 {accepted:true} and hands the runTick promise to keepAlive once", async () => {
  await withSecret(async () => {
    const work = deferred();
    const runTickCalls = [];
    const startedAt = 1_760_000_000_000;
    const { calls, keepAlive } = recorder();
    const tick = flagSpy(true);

    const { status, cacheControl, body } = await read(
      await POST(authorized(), {
        isFeatureEnabled: tick.isFeatureEnabled,
        keepAlive,
        runTick: (input) => {
          runTickCalls.push(input);
          return work.promise;
        },
        now: () => startedAt,
      })
    );

    assert.equal(status, 202);
    assert.equal(cacheControl, "no-store");
    assert.deepEqual(body, { accepted: true });
    assert.deepEqual(tick.calls, ["jobs_tick"]);
    assert.deepEqual(runTickCalls, [{ jobId: undefined, startedAt }], "no job_id means a full tick");
    assert.equal(calls.length, 1, "keepAlive is called exactly once");
    assert.equal(calls[0].work, work.promise, "keepAlive is handed the runTick promise itself");
    assert.equal(calls[0].opts.label, "jobs-tick");

    work.resolve({ claimed: 0 });
    await work.promise;
  });
});

test("the 202 is returned before the work resolves", async () => {
  await withSecret(async () => {
    const work = deferred();
    let settled = false;
    work.promise.then(() => {
      settled = true;
    });
    const { keepAlive } = recorder();

    const response = await GET(authorized(), {
      isFeatureEnabled: async () => true,
      keepAlive,
      runTick: () => work.promise,
    });

    assert.equal(response.status, 202);
    assert.equal(settled, false, "the response must not wait for the tick");

    work.resolve({ claimed: 0 });
    await work.promise;
  });
});

test("a valid job_id reaches runTick as the self-continue target", async () => {
  await withSecret(async () => {
    const jobId = "5b0d6f6e-9a8b-4a45-9a51-0e7e8f1c2d3a";
    const runTickCalls = [];
    const { keepAlive } = recorder();
    const { status, body } = await read(
      await GET(authorized(`/api/jobs/tick?job_id=${jobId}`), {
        isFeatureEnabled: async () => true,
        keepAlive,
        runTick: async (input) => {
          runTickCalls.push(input);
          return { claimed: 1 };
        },
        now: () => 0,
      })
    );

    assert.equal(status, 202);
    assert.deepEqual(body, { accepted: true });
    assert.deepEqual(runTickCalls, [{ jobId, startedAt: 0 }]);
  });
});

test("an invalid job_id is 400 invalid_request and starts no work", async () => {
  await withSecret(async () => {
    const { calls, keepAlive } = recorder();
    const { status, body } = await read(
      await GET(authorized("/api/jobs/tick?job_id=not-a-uuid"), {
        isFeatureEnabled: async () => true,
        keepAlive,
        runTick: async () => assert.fail("a malformed job_id must not start work"),
      })
    );

    assert.equal(status, 400);
    assert.deepEqual(body, INVALID);
    assert.deepEqual(calls, []);
  });
});
