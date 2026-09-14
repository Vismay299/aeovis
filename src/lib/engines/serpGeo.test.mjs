/**
 * R1.7.3 — SerpAPI path removed; these tests cover Bright Data geo only.
 *
 * The SerpAPI-specific geo tests have been removed with the dead code they
 * exercised. The Bright Data geo tests remain because they verify that the
 * shared SERP_GEO default propagates correctly through the live path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SERP_GEO, resolveSerpGeo } from "./serpGeo.js";
import { fetchPeopleAlsoAsk, probeGoogleAiOverview } from "./serp.js";
import { brightDataSearch } from "./brightdata.js";

const SERP_ENV = [
  "SERP_PROVIDER",
  "SERPAPI_KEY",
  "BRIGHTDATA_API_KEY",
  "BRIGHTDATA_SERP_ZONE",
  "SERP_GEO",
];

function useEnv(t, env) {
  const saved = Object.fromEntries(SERP_ENV.map((k) => [k, process.env[k]]));
  for (const k of SERP_ENV) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  t.after(() => {
    for (const k of SERP_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

/**
 * Swap in a fetch that records the request and returns `payload`.
 *
 * `text()` must return the serialized payload, not "": the Bright Data client
 * reads res.text() and JSON.parses it, so an empty string sends it down its
 * truncated-JSON retry path and costs the test its 6s backoff before failing
 * for a reason that has nothing to do with geo.
 */
function captureFetch(t, payload) {
  const calls = [];
  const original = globalThis.fetch;
  const serialized = JSON.stringify(payload);
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, text: async () => serialized, json: async () => payload };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/** A Bright Data envelope that does not look truncated, so no retry fires. */
const BD_OK = {
  body: JSON.stringify({
    ai_overview: { text_blocks: [{ snippet: "Acme is well regarded." }] },
    organic: [{ title: "Acme", link: "https://acme.io" }],
  }),
};

/** A Bright Data envelope carrying PAA, with AIO not requested. */
const BD_PAA = {
  body: JSON.stringify({
    people_also_ask: [{ question: "Is Acme any good?" }],
    organic: [{ title: "Acme", link: "https://acme.io" }],
  }),
};

test("resolveSerpGeo — one default, and it is the India-first product default", () => {
  assert.equal(DEFAULT_SERP_GEO, "in");
  assert.equal(resolveSerpGeo({}), "in");
  assert.equal(resolveSerpGeo({ SERP_GEO: "us" }), "us");
  // Blank must not become `gl=`, which is an unqualified search, not a targeted one.
  assert.equal(resolveSerpGeo({ SERP_GEO: "   " }), "in");
  assert.equal(resolveSerpGeo({ SERP_GEO: "GB" }), "gb");
});

test("the Bright Data client reads the shared default — gl=in when SERP_GEO is unset", async (t) => {
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "serp_zone" });
  const calls = captureFetch(t, BD_OK);

  await brightDataSearch("best crm");

  assert.ok(calls.length, "the client must have issued a request");
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.url, /[?&]gl=in(&|$)/, `Bright Data sent ${body.url}`);
  assert.equal(body.country, "in", "the proxy country must match the gl it searched with");
});

test("the Bright Data client follows SERP_GEO — gl=gb, not the default", async (t) => {
  useEnv(t, {
    BRIGHTDATA_API_KEY: "bd-key",
    BRIGHTDATA_SERP_ZONE: "serp_zone",
    SERP_GEO: "gb",
  });
  const calls = captureFetch(t, BD_OK);

  await brightDataSearch("best crm");

  assert.ok(calls.length, "the client must have issued a request");
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.url, /[?&]gl=gb(&|$)/, `Bright Data sent ${body.url}`);
  assert.equal(body.country, "gb");
});

test("PAA via Bright Data reads the shared default — gl=in when SERP_GEO is unset", async (t) => {
  useEnv(t, {
    SERP_PROVIDER: "brightdata",
    BRIGHTDATA_API_KEY: "bd-key",
    BRIGHTDATA_SERP_ZONE: "serp_zone",
  });
  const calls = captureFetch(t, BD_PAA);

  const questions = await fetchPeopleAlsoAsk("best crm");

  assert.ok(calls.length, "the client must have issued a request");
  assert.deepEqual(questions, ["Is Acme any good?"], "the PAA response must have been consumed");
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.url, /[?&]gl=in(&|$)/, `Bright Data PAA sent ${body.url}`);
  assert.equal(body.country, "in", "the proxy country must match the gl it searched with");
});

test("PAA via Bright Data follows SERP_GEO — gl=gb, not the default", async (t) => {
  useEnv(t, {
    SERP_PROVIDER: "brightdata",
    BRIGHTDATA_API_KEY: "bd-key",
    BRIGHTDATA_SERP_ZONE: "serp_zone",
    SERP_GEO: "gb",
  });
  const calls = captureFetch(t, BD_PAA);

  await fetchPeopleAlsoAsk("best crm");

  assert.ok(calls.length, "the client must have issued a request");
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.url, /[?&]gl=gb(&|$)/, `Bright Data PAA sent ${body.url}`);
  assert.equal(body.country, "gb");
});
