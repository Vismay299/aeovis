import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveEnabledEngines,
  runMultiEngineScan,
  summarizeEngineSlice,
  summarizeEngineResults,
} from "./enginePipeline.js";
import { hasUnverifiedCitations, CITATIONS_STATE } from "../engines/perplexity.js";
import { summaryToMetricsRow, buildMetricsRows } from "../analytics/rollup.js";

/**
 * R2.2.2 (finding B2) — at the ROW, on the production path.
 *
 * Perplexity answers with two independent calls: /chat/completions for the
 * answer and /search for the citation list. When /search dies and the answer
 * survives, the row used to carry `citations: []` and `error: null` — the exact
 * bytes a healthy /search that genuinely found nothing to cite produces. Every
 * citation-share denominator downstream therefore counted a vendor outage as a
 * confirmed "this answer did not cite the brand".
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM perplexity.test.mjs. The first cut of
 * this task set citations_state inside probePerplexity and tested it by
 * filtering a hand-built array of row literals. Both halves passed while the
 * feature was 100% inert: probeTextEngine (this file's subject) copies fields
 * onto a fixed result literal, so all three citation-state fields were dropped
 * one hop after being set and never reached a row, a denominator or the
 * database. A fresh verifier drove the real registry and dumped
 * `citations_state: undefined`.
 *
 * So nothing here builds a perplexity row. Every one below comes out of
 * resolveEnabledEngines -> the registry's own probe -> probeTextEngine ->
 * probePerplexity, with only `fetch` mocked. If any hop in that chain stops
 * carrying the state, these go red.
 *
 * The probes are slow ON PURPOSE and cannot be made fast: probeSearch backs off
 * 1s then 2s before giving up, which is the behaviour under a real outage. Each
 * scenario therefore runs ONE scan and asserts over it in subtests rather than
 * paying that backoff once per assertion.
 */

const ENV = ["ENGINES", "PERPLEXITY_API_KEY", "PERPLEXITY_MODEL"];

function useEnv(t, env) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  t.after(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

const okResponse = (payload) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(payload),
  json: async () => payload,
});

const failResponse = (status) => ({
  ok: false,
  status,
  text: async () => `upstream ${status}`,
  json: async () => ({}),
});

const chatPayload = (text) => ({
  choices: [{ message: { role: "assistant", content: text } }],
  usage: { cost: { total_cost: 0.004 }, prompt_tokens: 10, completion_tokens: 5 },
});

const searchPayload = () => ({
  results: [
    { url: "https://acme.io/tile-guide", title: "Acme tile guide" },
    { url: "https://elsewhere.example/roundup", title: "A roundup" },
  ],
});

/**
 * Mocks BOTH Perplexity legs, routed per query so one scan can carry healthy
 * rows and outage rows at the same time — which is the only way to assert that
 * a denominator SHRANK rather than that it happens to equal a constant.
 *
 * @param {(query: string) => "ok"|"dead_search"|"both_dead"|"empty_answer"} routeOf
 */
function mockPerplexity(t, routeOf) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const isSearch = String(url).includes("/search");
    const query = isSearch ? body.query : body.messages[0].content;
    const route = routeOf(query);

    if (isSearch) {
      return route === "ok" || route === "answer_fails_search_ok"
        ? okResponse(searchPayload())
        : failResponse(503);
    }
    if (route === "both_dead" || route === "answer_fails_search_ok") return failResponse(503);
    if (route === "empty_answer") return okResponse(chatPayload("   "));
    return okResponse(chatPayload("For this, Acme is a common pick; Rival is another."));
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

const BRAND = "Acme";
const SITE = "https://acme.io";
const COMPETITORS = ["Rival"];

const asQuery = (text) => ({ text, topic: "General", source: "test" });

const HEALTHY = ["best crm for small teams", "top project tools for agencies"];
const DEAD_SEARCH = ["cheapest invoicing software", "which helpdesk to pick"];

const rowFor = (results, prompt) => results.find((r) => r.prompt === prompt);

/**
 * One real multi-engine scan over 4 non-branded prompts: 2 whose citation leg
 * answered, 2 whose citation leg is 503 through every retry. Concurrency is 4,
 * so all four probes overlap and the retry backoff is paid once for the file.
 */
test("R2.2.2 — a dead /search leg reaches the row, and leaves the citation denominator", async (t) => {
  useEnv(t, { ENGINES: "perplexity", PERPLEXITY_API_KEY: "EXAMPLE-NOT-A-REAL-KEY" });
  mockPerplexity(t, (q) => (DEAD_SEARCH.includes(q) ? "dead_search" : "ok"));

  const scan = await runMultiEngineScan({
    brand: BRAND,
    url: SITE,
    competitors: COMPETITORS,
    queries: [...HEALTHY, ...DEAD_SEARCH].map(asQuery),
  });
  const slice = scan.engines.perplexity;

  await t.test("the answer-ok/search-failed row carries citations_state unverified", () => {
    const row = rowFor(scan.results, DEAD_SEARCH[0]);
    assert.ok(row, "the probe must produce a row for the dead-search prompt");

    // This is the exact envelope the verifier dumped when this task was
    // rejected: citations_state undefined, citations [], error null, predicate
    // false.
    assert.equal(
      row.citations_state,
      CITATIONS_STATE.UNVERIFIED,
      "an undefined here is the pre-fix envelope — it means probeTextEngine dropped the field again"
    );
    assert.equal(row.citations_state_reason, "search_leg_failed");
    assert.ok(
      row.citations_state_detail && row.citations_state_detail.length > 0,
      "the reason must carry the vendor's own words, not just a token"
    );
    assert.equal(hasUnverifiedCitations(row), true, "the denominator predicate must see it");

    // The answer leg survived, so the row is still scored for mentions. That is
    // the whole point: a dead citation leg must not throw away a real mention.
    assert.equal(row.error, null, "a dead /search does not invalidate a live answer");
    assert.equal(row.answer_present, true);
    assert.equal(row.brand_mentioned_in_text, true);
    assert.deepEqual(row.citations, [], "there is nothing to put in the list");
    assert.equal(row.brand_cited, false);
  });

  await t.test("a healthy row is verified, so 'we looked and found none' stays sayable", () => {
    const row = rowFor(scan.results, HEALTHY[0]);
    assert.equal(row.citations_state, CITATIONS_STATE.VERIFIED);
    assert.equal(row.citations_state_reason, null);
    assert.equal(hasUnverifiedCitations(row), false, "a real measurement is never excluded");
    assert.equal(row.brand_cited, true, "acme.io came back in the citation list");
  });

  await t.test("the unverified rows are ABSENT from the citation-share denominator", () => {
    assert.equal(slice.non_branded_with_answer, 4, "all four answers survived");
    assert.equal(slice.citations_unverified_count, 2);
    assert.equal(
      slice.citation_denominator,
      2,
      "only the two rows whose citation list was OBSERVED may be divided by"
    );
    assert.notEqual(
      slice.citation_denominator,
      slice.non_branded_with_answer,
      "dividing by every answered row is the bug: it counts the outage as 'not cited'"
    );
    assert.equal(slice.cited_non_branded, 2, "both observed rows cited acme.io");

    // Derived from the rows, not from a constant — the denominator must equal
    // the pool the predicate actually admits.
    const admitted = scan.results.filter(
      (r) => !r.is_branded_query && r.answer_present && !hasUnverifiedCitations(r)
    );
    assert.equal(slice.citation_denominator, admitted.length);
  });

  await t.test("citation share is 100% of what was observed, not 50% of what was answered", () => {
    const row = summaryToMetricsRow({
      brand: "acme",
      date: "2026-09-05",
      engine: "perplexity",
      scanId: "scan-1",
      promptSetId: null,
      summary: slice,
      answeredKey: "non_branded_with_answer",
    });

    assert.equal(row.citation_share_pct, 100, "2 cited of the 2 rows we could check");
    assert.notEqual(
      row.citation_share_pct,
      50,
      "50 is 2/4 — the outage laundered back in by rollup's own independent division"
    );
  });

  await t.test("the blended 'all' metrics row divides by the observed pool too", () => {
    const rows = buildMetricsRows({
      isMultiEngine: true,
      brandKey: "acme",
      dateOnly: "2026-09-05",
      scanId: "scan-1",
      promptSetId: null,
      engineSummaries: scan.engines,
      headline: scan.headline,
      promptResultRows: null,
    });
    const all = rows.find((r) => r.engine === "all");
    assert.equal(all.citation_share_pct, 100, "summing the answered counts would have made this 50");
  });

  await t.test("the scan-level backward-compat mirror divides by it as well", () => {
    // aioSummary falls back to the first engine, so a perplexity-only scan
    // computes its scan-level citation_share_pct off this slice.
    const { summary } = summarizeEngineResults(scan);
    assert.equal(summary.citation_share_pct, 100);
    assert.equal(summary.citation_denominator, 2);
    assert.equal(summary.citations_unverified_count, 2);
  });
});

test("R2.2.2 — the two return paths that are not the happy one keep the state too", async (t) => {
  useEnv(t, { ENGINES: "perplexity", PERPLEXITY_API_KEY: "EXAMPLE-NOT-A-REAL-KEY" });

  const BOTH_DEAD = "both legs are down";
  const EMPTY = "the answer comes back blank";
  mockPerplexity(t, (q) => (q.includes(BOTH_DEAD) || q === BOTH_DEAD ? "both_dead" : "empty_answer"));

  const perplexity = resolveEnabledEngines().find((e) => e.name === "perplexity");
  assert.ok(perplexity, "the perplexity engine def must resolve — this is the live registry");

  // Probed together so the retry backoff overlaps.
  const [bothDead, empty] = await Promise.all(
    [BOTH_DEAD, EMPTY].map((q) => perplexity.probe(asQuery(q), BRAND, [BRAND], "acme.io", COMPETITORS, null))
  );

  await t.test("both legs dead is unverified, not an empty citation list", () => {
    assert.ok(bothDead.error, "the answer leg failed, so this is an error row");
    assert.equal(
      bothDead.citations_state,
      CITATIONS_STATE.UNVERIFIED,
      "the early error return must carry the state — it used to drop it"
    );
    assert.equal(bothDead.citations_state_reason, "search_leg_failed");
  });

  await t.test("an EMPTY_ANSWER row with a dead citation leg keeps the state", () => {
    assert.equal(empty.error, "empty_answer", "R2.2.1 — a 200 with no body is an error row");
    assert.equal(empty.answer_present, false);
    assert.equal(
      empty.citations_state,
      CITATIONS_STATE.UNVERIFIED,
      "the EMPTY_ANSWER return must carry the state too"
    );
  });
});

test("R2.2.9 — probeTextEngine preserves measured citations when the answer leg fails", async (t) => {
  useEnv(t, { ENGINES: "perplexity", PERPLEXITY_API_KEY: "EXAMPLE-NOT-A-REAL-KEY" });

  const ANSWER_FAILS_SEARCH_OK = "answer leg fails but citations succeed";
  mockPerplexity(t, (q) => (q === ANSWER_FAILS_SEARCH_OK ? "answer_fails_search_ok" : "ok"));

  const perplexity = resolveEnabledEngines().find((e) => e.name === "perplexity");
  assert.ok(perplexity, "the perplexity engine def must resolve — this is the live registry");

  const row = await perplexity.probe(asQuery(ANSWER_FAILS_SEARCH_OK), BRAND, [BRAND], "acme.io", COMPETITORS, null);

  assert.ok(row.error, "the answer leg failed, so row.error must be set");
  assert.equal(row.answer_present, false, "an answer-leg failure does not count as answered");
  assert.equal(row.citations_state, CITATIONS_STATE.VERIFIED, "search leg succeeded, so citations_state is verified");
  assert.equal(row.citations_state_reason, null);
  assert.equal(row.citations.length, 2, "measured citations must not be silently emptied");
  assert.deepEqual(row.citations, [
    "https://acme.io/tile-guide",
    "https://elsewhere.example/roundup",
  ]);
  assert.equal(row.references.length, 2);
  assert.equal(row.references[0].domain, "acme.io");
  assert.equal(row.brand_cited, true, "acme.io in references must mark brand_cited true");
  assert.equal(row.visible, true, "brand_cited true marks visible true");
});

test("R2.2.2 — a perplexity slice with no citation_denominator FAILS LOUD, it does not default", () => {
  assert.throws(
    () =>
      summaryToMetricsRow({
        brand: "acme",
        date: "2026-09-05",
        engine: "perplexity",
        scanId: "scan-1",
        promptSetId: null,
        summary: { non_branded_queries: 6, non_branded_with_answer: 4, cited_non_branded: 2 },
        answeredKey: "non_branded_with_answer",
      }),
    /citation_denominator/,
    "silently dividing by non_branded_with_answer is the finding; refusing is the fix"
  );
});

test("R2.2.2 — single-leg engines are untouched: no throw, and their own denominator stands", () => {
  for (const engine of ["aio", "chatgpt"]) {
    const row = summaryToMetricsRow({
      brand: "acme",
      date: "2026-09-05",
      engine,
      scanId: "scan-1",
      promptSetId: null,
      summary: { non_branded_queries: 10, non_branded_with_answer: 8, cited_non_branded: 2 },
      answeredKey: "non_branded_with_answer",
    });
    assert.equal(row.citation_share_pct, 25, `${engine}: 2/8, unchanged`);
  }

  // And a slice built by summarizeEngineSlice for a single-leg engine reports a
  // denominator equal to its answered count, with an explicit zero exclusions —
  // "nothing was excluded" must look different from "never checked".
  const rows = Array.from({ length: 3 }, (_, i) => ({
    engine: "chatgpt",
    prompt: `q${i}`,
    is_branded_query: false,
    answer_present: true,
    text: "Some answer naming Acme and Rival.",
    citations: [],
    references: [],
    brand_cited: false,
    brand_mentioned_in_text: true,
    visible: true,
    citations_state: null,
    brands: [
      { name: "Acme", is_self: true, mentioned: true },
      { name: "Rival", is_self: false, mentioned: true },
    ],
    error: null,
  }));
  const slice = summarizeEngineSlice(rows, "chatgpt");
  assert.equal(slice.citation_denominator, 3);
  assert.equal(slice.citations_unverified_count, 0, "0 is a measurement here, not an absence");
});
