import test from "node:test";
import assert from "node:assert/strict";
import { brightDataSearch, isBrightDataZoneError } from "./brightdata.js";

/**
 * R3.6.7 — does brightdata.js have the dead retry guard the other adapters had?
 *
 * THE ANSWER IS NO, AND THIS FILE IS THE MEASUREMENT THAT ESTABLISHES IT.
 *
 * The shape being hunted (found live in src/lib/engines/openai.js,
 * src/lib/engines/perplexity.js and src/lib/openrouter.js) is a status guard
 * sitting above a `throw` whose own enclosing `catch` backs off and loops
 * regardless of status — so the guard decides nothing and a 401 costs the full
 * retry budget. brightdata.js declares the same-looking rule at
 * `isRetryableHttpStatus` (status === 429 || status >= 500), so it had to be
 * checked rather than assumed.
 *
 * It is NOT the same shape. brightDataSearch's catch does not retry
 * unconditionally: it re-discriminates (zone fault, rate limit, abort, 5xx,
 * HTML page, bad JSON, truncation) and rethrows anything else. A 401 therefore
 * costs exactly one call already. These tests pin that, so the guard cannot
 * quietly become dead later — which is exactly what happened to the other three.
 *
 * Everything here counts calls to an injected fetch stub. No log strings, no
 * network, no real credential: BRIGHTDATA_API_KEY is a placeholder and the 401
 * is manufactured by the stub.
 */

const ENV = ["BRIGHTDATA_API_KEY", "BRIGHTDATA_SERP_ZONE", "BRIGHTDATA_ZONE_TTL_MS", "SERP_GEO"];

/**
 * A configured Bright Data with a counting fetch. BRIGHTDATA_SERP_ZONE is set
 * so zone auto-discovery never fires — every counted call is a /request probe.
 */
async function counted(t, respond, options = {}) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  let calls = 0;
  process.env.BRIGHTDATA_API_KEY = "brd-EXAMPLE-NOT-A-REAL-KEY";
  process.env.BRIGHTDATA_SERP_ZONE = "serp_test";
  globalThis.fetch = async (url) => {
    assert.match(String(url), /api\.brightdata\.com\/request/, "only the probe may be counted");
    calls++;
    return respond(calls);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const startedAt = Date.now();
  const out = await brightDataSearch("best crm", {
    attempts: 3,
    backoffMs: 0,
    ...options,
  }).catch((e) => e);
  return { out, calls, elapsedMs: Date.now() - startedAt };
}

const status = (code, body = "refused") => () => new Response(body, { status: code });

test("brightdata - a 401 costs exactly ONE call: the guard here is live, not dead", async (t) => {
  const { out, calls } = await counted(t, status(401, "Unauthorized"));
  assert.equal(calls, 1, "a revoked token does not become valid on the second try");
  assert.ok(out instanceof Error, `expected a throw, got ${JSON.stringify(out)}`);
  assert.match(out.message, /HTTP 401/);
  assert.equal(isBrightDataZoneError(out), false, "401 is a credential fault, not a zone fault");
});

test("brightdata - 403 and 400 are refusals too, one call each", async (t) => {
  const forbidden = await counted(t, status(403, "Forbidden"));
  assert.equal(forbidden.calls, 1);
  const bad = await counted(t, status(400, "Bad Request"));
  assert.equal(bad.calls, 1);
});

test("brightdata - a 429 still spends the whole attempt budget", async (t) => {
  const { out, calls } = await counted(t, status(429, "slow down"));
  assert.equal(calls, 3, "attempts: 3, and a rate limit is what backoff exists for");
  assert.match(out.message, /HTTP 429/);
});

test("brightdata - a 5xx still spends the whole attempt budget", async (t) => {
  const { calls } = await counted(t, status(503, "upstream exploded"));
  assert.equal(calls, 3);
});

test("brightdata - a timeout abort still spends the whole attempt budget", async (t) => {
  const { calls } = await counted(t, () => {
    throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  });
  assert.equal(calls, 3);
});

test("brightdata - a recovered 429 returns the answer rather than the error", async (t) => {
  // The budget is not spent for its own sake: the retry has to be able to win.
  const { out, calls } = await counted(t, (n) =>
    n < 3
      ? new Response("slow down", { status: 429 })
      : Response.json({ body: JSON.stringify({ organic: [{ link: "https://a.example" }] }) })
  );
  assert.equal(calls, 3);
  assert.ok(!(out instanceof Error), `expected a result, got ${out}`);
  assert.ok(out.organic, "the third call's SERP must come back parsed");
});

test("brightdata - MEASURED DIVERGENCE: a bare transport failure is NOT retried", async (t) => {
  // Recorded, not endorsed. brightDataSearch's catch classifies by matching
  // the error MESSAGE (/HTTP 5\d\d/, /not valid JSON/, /abort/i...), so a
  // socket-level failure — `TypeError: fetch failed`, which is what an
  // ECONNRESET or a DNS blip surfaces as — matches nothing and is rethrown
  // after one attempt. src/lib/engines/httpFailureKind.js takes the opposite
  // (and better) default: a failure it cannot classify stays TRANSIENT,
  // because discarding a recoverable measurement is the more expensive
  // mistake.
  //
  // This is a DIFFERENT defect from the dead guard R3.6.7 was filed for, it is
  // not what that task's accept describes, and fixing it here would change
  // probe behaviour under a task nobody reviewed for it. Pinned so the number
  // is on the record and a follow-up task has a starting point, NOT so that 1
  // becomes the blessed answer.
  const { calls } = await counted(t, () => {
    throw Object.assign(new Error("fetch failed"), { name: "TypeError" });
  });
  assert.equal(calls, 1, "one call — see the comment above; this is the finding, not the target");
});
