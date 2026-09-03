import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SERP_GEO, resolveSerpGeo } from "./serpGeo.js";
import { fetchPeopleAlsoAsk, probeGoogleAiOverview } from "./serp.js";
import { brightDataSearch } from "./brightdata.js";

/**
 * R1.6.2 — the two SERP clients defaulted to different countries: Bright Data
 * to "in", SerpAPI to "us". Both read SERP_GEO, so the split was invisible
 * whenever it was set and showed up only on a deployment that left it unset,
 * where the two clients would probe different markets and produce numbers that
 * could not be compared.
 *
 * Asserting the constant alone would not catch a regression — a client could
 * stop consulting it and the constant would still be right. These tests drive
 * each client through a mocked fetch and read the `gl` it actually sent.
 */

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

test("resolveSerpGeo — one default, and it is the India-first product default", () => {
  assert.equal(DEFAULT_SERP_GEO, "in");
  assert.equal(resolveSerpGeo({}), "in");
  assert.equal(resolveSerpGeo({ SERP_GEO: "us" }), "us");
  // Blank must not become `gl=`, which is an unqualified search, not a targeted one.
  assert.equal(resolveSerpGeo({ SERP_GEO: "   " }), "in");
  assert.equal(resolveSerpGeo({ SERP_GEO: "GB" }), "gb");
});

test("the SerpAPI client reads the shared default — gl=in when SERP_GEO is unset", async (t) => {
  useEnv(t, { SERPAPI_KEY: "mock-key" });
  const calls = captureFetch(t, { ai_overview: { text_blocks: [{ snippet: "hi" }] } });

  await probeGoogleAiOverview("best crm");

  assert.ok(calls.length, "the client must have issued a request");
  assert.match(calls[0].url, /[?&]gl=in(&|$)/, `SerpAPI sent ${calls[0].url}`);
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

test("both clients follow SERP_GEO to the same non-default country", async (t) => {
  const sent = {};

  await t.test("serpapi", async (t2) => {
    useEnv(t2, { SERPAPI_KEY: "mock-key", SERP_GEO: "gb" });
    const calls = captureFetch(t2, { ai_overview: { text_blocks: [{ snippet: "hi" }] } });
    await probeGoogleAiOverview("best crm");
    sent.serpapi = calls[0].url;
  });

  await t.test("brightdata", async (t2) => {
    useEnv(t2, { BRIGHTDATA_API_KEY: "bd-key", BRIGHTDATA_SERP_ZONE: "serp_zone", SERP_GEO: "gb" });
    const calls = captureFetch(t2, BD_OK);
    await brightDataSearch("best crm");
    sent.brightdata = JSON.parse(calls[0].init.body).url;
  });

  assert.match(sent.serpapi, /[?&]gl=gb(&|$)/);
  assert.match(sent.brightdata, /[?&]gl=gb(&|$)/);
});

/**
 * R1.6.2 (round two) — `fetchPeopleAlsoAsk` is the second place in serp.js
 * where the two clients pick a country, and it carried its own `gl: "us"`
 * literal that never read SERP_GEO at all. The tests above structurally
 * cannot see it: they drive probeGoogleAiOverview and brightDataSearch.
 *
 * The path is live: POST /api/scan -> runScanChunk -> runSourcingPhase ->
 * sourceUnbrandedQueries -> generateUnbrandedPrompts (as paaFn) ->
 * fetchPeopleAlsoAsk. PAA questions seed the prompt set, so a split here
 * makes the India-first prompt set incomparable between providers.
 *
 * Each test also asserts the questions came back, not just that a request
 * went out — fetchPeopleAlsoAsk swallows per-term failures into a warn and
 * returns [], so an empty list would otherwise read as a pass.
 */

/** A Bright Data envelope carrying PAA, with AIO not requested. */
const BD_PAA = {
  body: JSON.stringify({
    people_also_ask: [{ question: "Is Acme any good?" }],
    organic: [{ title: "Acme", link: "https://acme.io" }],
  }),
};

const SERPAPI_PAA = { people_also_ask: [{ question: "Is Acme any good?" }] };

test("PAA via SerpAPI reads the shared default — gl=in when SERP_GEO is unset", async (t) => {
  useEnv(t, { SERP_PROVIDER: "serpapi", SERPAPI_KEY: "mock-key" });
  const calls = captureFetch(t, SERPAPI_PAA);

  const questions = await fetchPeopleAlsoAsk("best crm");

  assert.ok(calls.length, "the client must have issued a request");
  assert.deepEqual(questions, ["Is Acme any good?"], "the PAA response must have been consumed");
  assert.match(calls[0].url, /[?&]gl=in(&|$)/, `SerpAPI PAA sent ${calls[0].url}`);
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

test("PAA under both providers agrees on the same country when SERP_GEO is unset", async (t) => {
  const sent = {};

  await t.test("serpapi", async (t2) => {
    useEnv(t2, { SERP_PROVIDER: "serpapi", SERPAPI_KEY: "mock-key" });
    const calls = captureFetch(t2, SERPAPI_PAA);
    await fetchPeopleAlsoAsk("best crm");
    sent.serpapi = new URL(calls[0].url).searchParams.get("gl");
  });

  await t.test("brightdata", async (t2) => {
    useEnv(t2, {
      SERP_PROVIDER: "brightdata",
      BRIGHTDATA_API_KEY: "bd-key",
      BRIGHTDATA_SERP_ZONE: "serp_zone",
    });
    const calls = captureFetch(t2, BD_PAA);
    await fetchPeopleAlsoAsk("best crm");
    sent.brightdata = new URL(JSON.parse(calls[0].init.body).url).searchParams.get("gl");
  });

  assert.equal(sent.serpapi, DEFAULT_SERP_GEO);
  assert.equal(
    sent.brightdata,
    sent.serpapi,
    `the two providers seeded prompts from different countries: serpapi=${sent.serpapi} brightdata=${sent.brightdata}`
  );
});

test("PAA via SerpAPI follows SERP_GEO — gl=gb, not the default", async (t) => {
  useEnv(t, { SERP_PROVIDER: "serpapi", SERPAPI_KEY: "mock-key", SERP_GEO: "gb" });
  const calls = captureFetch(t, SERPAPI_PAA);

  await fetchPeopleAlsoAsk("best crm");

  assert.ok(calls.length, "the client must have issued a request");
  assert.match(calls[0].url, /[?&]gl=gb(&|$)/, `SerpAPI PAA sent ${calls[0].url}`);
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
