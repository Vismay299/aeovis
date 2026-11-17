import test from "node:test";
import assert from "node:assert/strict";

import {
  NO_CONTENT_SENTINEL,
  SCRAPE_REASON,
  SCRAPE_STATE,
  scrapeSite,
  summarizeScrape,
} from "./firecrawl.js";
import { generateUnbrandedPrompts, sanitizeWebsiteSnippet } from "../shared/scoring/promptGen.js";

/**
 * R3.7.2, finding B7 — a Firecrawl degrade becomes a recorded state.
 *
 * THE BUG, as it reproduced on this branch before the fix: scrapeForSummary
 * returned the literal string "No website content available." for a missing
 * URL, an unresolvable host, a Firecrawl outage, a dead socket, a 404, and an
 * empty page alike. generateUnbrandedPrompts assigned it to `websiteSnippet`
 * and buildGenPrompt interpolated it under the heading "Website summary:", so
 * the prompt-generation model was told in plain English that the brand's
 * website reads "No website content available." The same string was then mined
 * for SERP seed terms, seeding real Google queries with "website", "content"
 * and "available". Nothing downstream could tell a read site from an unread one.
 *
 * Every fetch here is stubbed and every DNS lookup is injected. Nothing in this
 * file reaches the network.
 */

const PUBLIC = async () => ["93.184.216.34"];
const FIRECRAWL = "https://api.firecrawl.dev/v1/scrape";
const KEY = "fc_test_key_not_a_real_credential";

function htmlResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() {
      return body;
    },
  };
}

function firecrawlOk(markdown, metadata = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    async json() {
      return { data: { markdown, metadata } };
    },
  };
}

/**
 * A stubbed world: `vendor` answers the Firecrawl call, `site` answers the
 * fallback fetch of the customer URL. Both record what they were asked.
 */
function world({ vendor, site }) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(String(url));
    if (String(url).startsWith("https://api.firecrawl.dev/")) {
      if (!vendor) throw new Error("the vendor path was taken when it should not have been");
      return vendor(url, init);
    }
    if (!site) throw new Error("the fallback fetch was taken when it should not have been");
    return site(url, init);
  };
  return { impl, calls };
}

const GOOD_PAGE = () =>
  htmlResponse("<html><body><h1>Acme Analytics</h1><p>Dashboards for ops teams.</p></body></html>");

// ---------------------------------------------------------------------------
// The healthy path
// ---------------------------------------------------------------------------

test("healthy: Firecrawl returns usable content -> state ok, source firecrawl, no fallback", async () => {
  const { impl, calls } = world({
    vendor: () =>
      firecrawlOk("Acme Analytics is a dashboard product for operations teams in India.", {
        title: "Acme Analytics",
        description: "Dashboards for ops teams",
      }),
  });

  const out = await scrapeSite("https://acme-analytics.co.in", {
    fetchImpl: impl,
    lookup: PUBLIC,
    apiKey: KEY,
  });

  assert.equal(out.state, SCRAPE_STATE.OK);
  assert.equal(out.state_reason, null);
  assert.deepEqual(out.reasons, []);
  assert.equal(out.degraded, false);
  assert.equal(out.source, "firecrawl");
  assert.match(out.content, /Acme Analytics is a dashboard product/);
  assert.equal(out.content_chars, out.content.length);
  assert.deepEqual(calls, [FIRECRAWL], "a healthy vendor scrape must not also hit the site");
});

// ---------------------------------------------------------------------------
// Each degrade path, named
// ---------------------------------------------------------------------------

const DEGRADE_CASES = [
  {
    name: "no API key configured",
    deps: { apiKey: null },
    vendor: null, // taking the vendor path at all would throw
    reason: SCRAPE_REASON.FIRECRAWL_NOT_CONFIGURED,
  },
  {
    name: "Firecrawl answers 402 (no balance)",
    deps: { apiKey: KEY },
    vendor: () => ({ ok: false, status: 402, async json() { return {}; } }),
    reason: SCRAPE_REASON.FIRECRAWL_HTTP_ERROR,
  },
  {
    name: "Firecrawl answers 500",
    deps: { apiKey: KEY },
    vendor: () => ({ ok: false, status: 500, async json() { return {}; } }),
    reason: SCRAPE_REASON.FIRECRAWL_HTTP_ERROR,
  },
  {
    name: "the Firecrawl call throws or times out",
    deps: { apiKey: KEY },
    vendor: () => {
      throw new Error("The operation was aborted due to timeout");
    },
    reason: SCRAPE_REASON.FIRECRAWL_REQUEST_FAILED,
  },
  {
    name: "Firecrawl answers 200 with an extraction too thin to use",
    deps: { apiKey: KEY },
    vendor: () => firecrawlOk("tiny"),
    reason: SCRAPE_REASON.FIRECRAWL_THIN_CONTENT,
  },
];

for (const c of DEGRADE_CASES) {
  test(`degrade: ${c.name} -> state degraded, reason ${c.reason}, content from the fallback`, async () => {
    const { impl } = world({ vendor: c.vendor, site: GOOD_PAGE });
    const out = await scrapeSite("https://acme-analytics.co.in", {
      fetchImpl: impl,
      lookup: PUBLIC,
      ...c.deps,
    });

    assert.equal(out.state, SCRAPE_STATE.DEGRADED, "a fallback result is not an ok result");
    assert.equal(out.state_reason, c.reason);
    assert.deepEqual(out.reasons, [c.reason]);
    assert.equal(out.degraded, true);
    assert.equal(out.source, "fallback_fetch");
    assert.equal(out.content, "Acme Analytics Dashboards for ops teams.");
    assert.ok(out.detail, "a degrade must carry a human-readable detail, not just a token");
  });
}

// ---------------------------------------------------------------------------
// Both paths gone: unavailable, and the reason chain shows BOTH failures
// ---------------------------------------------------------------------------

test("unavailable: Firecrawl 402 then the site refuses the connection -> both reasons kept", async () => {
  const { impl } = world({
    vendor: () => ({ ok: false, status: 402, async json() { return {}; } }),
    site: () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const out = await scrapeSite("https://dead.example", {
    fetchImpl: impl,
    lookup: PUBLIC,
    apiKey: KEY,
  });

  assert.equal(out.state, SCRAPE_STATE.UNAVAILABLE);
  assert.equal(out.content, null);
  assert.equal(out.content_chars, 0);
  assert.equal(out.source, null);
  assert.equal(out.state_reason, SCRAPE_REASON.FALLBACK_REQUEST_FAILED);
  assert.deepEqual(
    out.reasons,
    [SCRAPE_REASON.FIRECRAWL_HTTP_ERROR, SCRAPE_REASON.FALLBACK_REQUEST_FAILED],
    "the vendor failure must not be erased by the fallback failure that followed it"
  );
});

test("unavailable: a 200 page with no extractable text is a MEASURED empty, not a dead fetch", async () => {
  const { impl } = world({
    vendor: () => ({ ok: false, status: 402, async json() { return {}; } }),
    site: () => htmlResponse("<html><body>   <br/>  </body></html>"),
  });
  const out = await scrapeSite("https://blank.example", {
    fetchImpl: impl,
    lookup: PUBLIC,
    apiKey: KEY,
  });

  assert.equal(out.state, SCRAPE_STATE.UNAVAILABLE);
  assert.equal(out.content, null);
  // The distinction rule 1 asks for: we looked and there was nothing, which is
  // a different token from never having got a response.
  assert.equal(out.state_reason, SCRAPE_REASON.FALLBACK_EMPTY_BODY);
  assert.notEqual(out.state_reason, SCRAPE_REASON.FALLBACK_REQUEST_FAILED);
});

test("no outcome of scrapeSite ever carries the legacy sentinel as content", async () => {
  const cases = [
    () => scrapeSite(""),
    () =>
      scrapeSite("https://dead.example", {
        fetchImpl: world({
          vendor: () => ({ ok: false, status: 402, async json() { return {}; } }),
          site: () => {
            throw new Error("ECONNREFUSED");
          },
        }).impl,
        lookup: PUBLIC,
        apiKey: KEY,
      }),
    () =>
      scrapeSite("https://blank.example", {
        fetchImpl: world({
          vendor: () => ({ ok: false, status: 402, async json() { return {}; } }),
          site: () => htmlResponse("<html><body></body></html>"),
        }).impl,
        lookup: PUBLIC,
        apiKey: KEY,
      }),
    () =>
      scrapeSite("https://acme-analytics.co.in", {
        fetchImpl: world({ vendor: null, site: GOOD_PAGE }).impl,
        lookup: PUBLIC,
        apiKey: null,
      }),
  ];
  for (const run of cases) {
    const out = await run();
    assert.notEqual(out.content, NO_CONTENT_SENTINEL);
  }
});

// ---------------------------------------------------------------------------
// summarizeScrape: what travels to the ledger carries no page body
// ---------------------------------------------------------------------------

test("summarizeScrape drops the content but keeps the state, the reason and the size", () => {
  const summary = summarizeScrape({
    content: "a whole page of customer copy",
    content_chars: 29,
    state: SCRAPE_STATE.DEGRADED,
    state_reason: SCRAPE_REASON.FIRECRAWL_HTTP_ERROR,
    reasons: [SCRAPE_REASON.FIRECRAWL_HTTP_ERROR],
    detail: "HTTP 402 from Firecrawl",
    source: "fallback_fetch",
  });
  assert.equal(summary.content, undefined, "a page body has no business in a run record");
  assert.equal(summary.state, SCRAPE_STATE.DEGRADED);
  assert.equal(summary.state_reason, SCRAPE_REASON.FIRECRAWL_HTTP_ERROR);
  assert.equal(summary.content_chars, 29);
});

test("summarizeScrape refuses to invent an ok state from nothing", () => {
  for (const nothing of [null, undefined, "", 7]) {
    const summary = summarizeScrape(nothing);
    assert.equal(summary.state, SCRAPE_STATE.UNAVAILABLE);
    assert.equal(summary.state_reason, "no_scrape_result");
    // Null, not 0: standing rule 5. Zero would say we measured the content and
    // found none, when in fact there was nothing handed to us to measure.
    assert.equal(summary.content_chars, null);
  }
});

test("a real unavailable scrape reports a MEASURED zero, not the unmeasured null", async () => {
  const { impl } = world({
    vendor: () => ({ ok: false, status: 402, async json() { return {}; } }),
    site: () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const summary = summarizeScrape(
    await scrapeSite("https://dead.example", { fetchImpl: impl, lookup: PUBLIC, apiKey: KEY })
  );
  // We ran, we got nothing: 0. The pair with the test above is the whole point —
  // measured zero and never-measured must not look the same.
  assert.equal(summary.content_chars, 0);
  assert.equal(summary.state, SCRAPE_STATE.UNAVAILABLE);
});

// ---------------------------------------------------------------------------
// The accept criterion: the sentence never reaches prompt generation
// ---------------------------------------------------------------------------

test("sanitizeWebsiteSnippet collapses the sentinel, blanks and non-strings to empty", () => {
  assert.equal(sanitizeWebsiteSnippet(NO_CONTENT_SENTINEL), "");
  assert.equal(sanitizeWebsiteSnippet(`  ${NO_CONTENT_SENTINEL}  `), "");
  assert.equal(sanitizeWebsiteSnippet(null), "");
  assert.equal(sanitizeWebsiteSnippet(undefined), "");
  assert.equal(sanitizeWebsiteSnippet("   "), "");
  assert.equal(sanitizeWebsiteSnippet(42), "");
  assert.equal(sanitizeWebsiteSnippet(" real copy "), "real copy");
});

function thirtyQueries() {
  return Array.from({ length: 35 }, (_, i) => ({
    text: `best analytics tool option ${i}`,
    topic: "General",
    intent_tier: "commercial",
  }));
}

const noSerp = {
  fetchPeopleAlsoAsk: async () => {
    throw new Error("PAA should not be called in this test");
  },
  fetchAutocomplete: async () => {
    throw new Error("Autocomplete should not be called in this test");
  },
};

/** Runs prompt generation and hands back every prompt string sent to the LLM. */
async function capturePrompts(scrapeDep, stats = {}) {
  const sent = [];
  const prompts = await generateUnbrandedPrompts("Acme", "https://acme.io", "", stats, 30, {
    ...noSerp,
    ...scrapeDep,
    llmJson: async (prompt) => {
      sent.push(prompt);
      return thirtyQueries();
    },
  });
  return { sent, prompts };
}

test("an unavailable scrape never puts the sentinel into an LLM prompt", async () => {
  const stats = {};
  const { sent, prompts } = await capturePrompts(
    {
      scrapeSite: async () => ({
        content: null,
        content_chars: 0,
        state: SCRAPE_STATE.UNAVAILABLE,
        state_reason: SCRAPE_REASON.FALLBACK_REQUEST_FAILED,
        reasons: [SCRAPE_REASON.FIRECRAWL_HTTP_ERROR, SCRAPE_REASON.FALLBACK_REQUEST_FAILED],
        detail: "ECONNREFUSED",
        source: null,
        degraded: true,
      }),
    },
    stats
  );

  assert.ok(sent.length > 0, "precondition: the LLM was actually called");
  for (const prompt of sent) {
    assert.ok(
      !prompt.includes(NO_CONTENT_SENTINEL),
      `the sentinel reached prompt generation:\n${prompt.slice(0, 400)}`
    );
    assert.ok(
      !/Website summary:/.test(prompt),
      "with nothing scraped there must be no 'Website summary:' heading claiming otherwise"
    );
  }
  assert.equal(prompts.length, 30, "a dead website must still not fail the run");
});

test("a LEGACY string scraper that returns the sentinel still cannot smuggle it in", async () => {
  // The exact shape ssrfRefusalSurfacing.test.mjs injects, and the exact shape
  // any un-migrated caller would use. The adapter recognises the sentence as
  // "there was nothing" rather than passing it through as page copy.
  const stats = {};
  const { sent, prompts } = await capturePrompts(
    { scrapeForSummary: async () => NO_CONTENT_SENTINEL },
    stats
  );

  for (const prompt of sent) {
    assert.ok(!prompt.includes(NO_CONTENT_SENTINEL), "the legacy sentinel reached the LLM prompt");
    assert.ok(!prompt.includes("No website content"), "a truncated sentinel is still the sentinel");
  }
  assert.equal(prompts.length, 30);
  assert.equal(stats.website_scrape.state, SCRAPE_STATE.UNAVAILABLE);
});

test("the sentinel is not mined for SERP seed terms either", async () => {
  // The second, quieter half of B7: promptGen derived seed terms from the first
  // line of the snippet, so the sentence seeded real Google queries with
  // "website", "content" and "available".
  const asked = [];
  await generateUnbrandedPrompts("Acme", "https://acme.io", "", {}, 30, {
    scrapeForSummary: async () => NO_CONTENT_SENTINEL,
    fetchPeopleAlsoAsk: async (term) => {
      asked.push(term);
      return [];
    },
    fetchAutocomplete: async (term) => {
      asked.push(term);
      return [];
    },
    llmJson: async () => thirtyQueries(),
  });
  assert.deepEqual(
    asked.filter((t) => /website|content|available/i.test(t)),
    [],
    `seed terms were derived from the no-content sentence: ${JSON.stringify(asked)}`
  );
});

test("a healthy scrape DOES reach the prompt — the fix must not blind the generator", async () => {
  const stats = {};
  const { sent } = await capturePrompts(
    {
      scrapeSite: async () => ({
        content: "Acme Analytics builds dashboards for Indian operations teams.",
        content_chars: 60,
        state: SCRAPE_STATE.OK,
        state_reason: null,
        reasons: [],
        detail: null,
        source: "firecrawl",
        degraded: false,
      }),
    },
    stats
  );
  assert.ok(sent[0].includes("Website summary:"));
  assert.ok(sent[0].includes("Acme Analytics builds dashboards"));
  assert.equal(stats.website_scrape.state, SCRAPE_STATE.OK);
});

// ---------------------------------------------------------------------------
// The caller must not read a degrade as a success
// ---------------------------------------------------------------------------

test("the caller records the degrade on the run stats rather than discarding it", async () => {
  const stats = { cost: 0, tokens: 0 };
  await capturePrompts(
    {
      scrapeSite: async () => ({
        content: "Some crudely stripped HTML text from the fallback path.",
        content_chars: 54,
        state: SCRAPE_STATE.DEGRADED,
        state_reason: SCRAPE_REASON.FIRECRAWL_HTTP_ERROR,
        reasons: [SCRAPE_REASON.FIRECRAWL_HTTP_ERROR],
        detail: "HTTP 402 from Firecrawl",
        source: "fallback_fetch",
        degraded: true,
      }),
    },
    stats
  );

  assert.ok(stats.website_scrape, "the degrade must be recorded, not merely logged");
  assert.equal(stats.website_scrape.state, SCRAPE_STATE.DEGRADED);
  assert.notEqual(stats.website_scrape.state, SCRAPE_STATE.OK);
  assert.equal(stats.website_scrape.state_reason, SCRAPE_REASON.FIRECRAWL_HTTP_ERROR);
  assert.equal(stats.website_scrape.source, "fallback_fetch");
  assert.equal(stats.website_scrape.content_chars, 54);
  assert.equal(stats.website_scrape.content, undefined, "no page body on the run record");
  // The cost/token accumulation it shares the object with is untouched.
  assert.equal(stats.cost, 0);
});

test("a scrape that throws is recorded as unavailable, not left as an unset state", async () => {
  const stats = {};
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    await capturePrompts(
      {
        scrapeSite: async () => {
          throw new Error("socket hang up");
        },
      },
      stats
    );
  } finally {
    console.warn = realWarn;
  }
  assert.equal(stats.website_scrape.state, SCRAPE_STATE.UNAVAILABLE);
  assert.equal(stats.website_scrape.state_reason, "scrape_threw");
  assert.match(stats.website_scrape.detail, /socket hang up/);
  assert.ok(
    warnings.some((w) => /is unavailable \(scrape_threw/.test(w)),
    `the degrade must be said out loud — saw ${JSON.stringify(warnings)}`
  );
});

test("a degraded scrape is announced as degraded, never logged as a clean read", async () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    await capturePrompts({
      scrapeSite: async () => ({
        content: "fallback text",
        content_chars: 13,
        state: SCRAPE_STATE.DEGRADED,
        state_reason: SCRAPE_REASON.FIRECRAWL_REQUEST_FAILED,
        reasons: [SCRAPE_REASON.FIRECRAWL_REQUEST_FAILED],
        detail: "timeout",
        source: "fallback_fetch",
        degraded: true,
      }),
    });
  } finally {
    console.warn = realWarn;
  }
  assert.ok(
    warnings.some((w) => /is degraded \(firecrawl_request_failed/.test(w)),
    `expected a named degrade warning, saw ${JSON.stringify(warnings)}`
  );
});

test("a healthy scrape emits no degrade warning — a clean read must stay quiet", async () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    await capturePrompts({
      scrapeSite: async () => ({
        content: "Acme Analytics builds dashboards for Indian operations teams.",
        content_chars: 60,
        state: SCRAPE_STATE.OK,
        state_reason: null,
        reasons: [],
        detail: null,
        source: "firecrawl",
        degraded: false,
      }),
    });
  } finally {
    console.warn = realWarn;
  }
  assert.deepEqual(
    warnings.filter((w) => /website scrape for/.test(w)),
    []
  );
});
