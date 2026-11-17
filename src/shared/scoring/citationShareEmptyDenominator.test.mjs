import test from "node:test";
import assert from "node:assert/strict";
import { runMultiEngineScan, summarizeEngineResults } from "./enginePipeline.js";
import { summaryToMetricsRow, buildMetricsRows } from "../analytics/rollup.js";

/**
 * R2.2.11 — an EMPTY citation denominator must publish null, never 0.
 *
 * R2.2.2 taught the slice to exclude rows whose citation list was never
 * observed, and to emit the surviving pool as `citation_denominator`. It left
 * one branch behind: the scan-level backward-compat mirror in
 * summarizeEngineResults still ended `: 0` when that pool came out empty. So a
 * scan where EVERY citation leg died — every answered row unverified,
 * denominator 0, nothing observed either way — published
 * `citation_share_pct: 0`, and scanWorker writes that value straight onto
 * `scans.brand_citation_share_pct`. A confident "0% of the answers cite you"
 * for a scan in which nobody could look.
 *
 * The half of this that is easy to get wrong is the other direction, so it is
 * asserted just as hard: a GENUINE measured zero — citation lists read in full,
 * brand in none of them — is a real finding and must still come out as the
 * number 0. Blanking that would trade one false reading for another.
 *
 * Nothing below hand-builds a perplexity row. Every scenario runs the real
 * registry (ENGINES=perplexity) through probeTextEngine -> probePerplexity with
 * only `fetch` mocked, which is the same discipline citationDenominator.test.mjs
 * adopted after R2.2.2 was rejected for testing a feature that was inert on the
 * production path. The dead-leg scan is slow on purpose: probeSearch backs off
 * 1s then 2s before giving up, which is what a real outage costs.
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

/** A citation list that was genuinely READ and genuinely does not name us. */
const searchPayloadWithoutBrand = () => ({
  results: [
    { url: "https://elsewhere.example/roundup", title: "A roundup" },
    { url: "https://rival.example/compare", title: "Rival compare" },
  ],
});

/**
 * @param {"dead_search"|"search_without_brand"} mode how the /search leg behaves.
 */
function mockPerplexity(t, mode) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/search")) {
      return mode === "dead_search" ? failResponse(503) : okResponse(searchPayloadWithoutBrand());
    }
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
const QUERIES = ["best crm for small teams", "top project tools for agencies"].map(asQuery);

const scanFor = (mode) =>
  runMultiEngineScan({ brand: BRAND, url: SITE, competitors: COMPETITORS, queries: QUERIES });

test("R2.2.11 — every citation leg dead publishes null at the scan level, not a 0", async (t) => {
  useEnv(t, { ENGINES: "perplexity", PERPLEXITY_API_KEY: "EXAMPLE-NOT-A-REAL-KEY" });
  mockPerplexity(t, "dead_search");

  const scan = await scanFor("dead_search");
  const slice = scan.engines.perplexity;
  const { summary } = summarizeEngineResults(scan);

  await t.test("the precondition is the every-leg-dead slice, produced by the real probe", () => {
    assert.equal(slice.non_branded_with_answer, 2, "both answer legs survived — this is not a dead scan");
    assert.equal(slice.citations_unverified_count, 2, "both citation legs must be marked unverified");
    assert.equal(slice.citation_denominator, 0, "nothing was observed, so the pool is empty");
    assert.equal(slice.cited_non_branded, 0, "there is nothing in the pool to have been cited");
  });

  await t.test("the scan-level mirror refuses to name a share", () => {
    assert.equal(
      summary.citation_share_pct,
      null,
      "an empty citation pool has no share; scanWorker writes this onto scans.brand_citation_share_pct"
    );
    assert.notEqual(
      summary.citation_share_pct,
      0,
      "0 here is the finding: a confident '0% of your answers cite you' for a scan where every citation leg died"
    );
    assert.notEqual(
      typeof summary.citation_share_pct,
      "number",
      "not 0, not NaN, not -0 — the mirror must publish no number at all"
    );
  });

  await t.test("the reason travels with the refusal, so the null is not a bare blank", () => {
    assert.equal(summary.citation_denominator, 0, "the empty pool is stated, not omitted");
    assert.equal(
      summary.citations_unverified_count,
      2,
      "and WHY it is empty: two answered rows whose citation list was never observed"
    );
  });

  await t.test("the rollup row built from that mirror summary is null too", () => {
    const row = summaryToMetricsRow({
      brand: "acme",
      date: "2026-09-05",
      engine: "aio",
      scanId: "scan-r2211",
      promptSetId: null,
      summary,
      answeredKey: "non_branded_with_aio",
    });
    assert.equal(
      row.citation_share_pct,
      null,
      "brand_metrics_daily.citation_share_pct must not record a share nobody could measure"
    );
  });
});

test("R2.2.11 — a GENUINE measured zero still publishes the number 0", async (t) => {
  useEnv(t, { ENGINES: "perplexity", PERPLEXITY_API_KEY: "EXAMPLE-NOT-A-REAL-KEY" });
  mockPerplexity(t, "search_without_brand");

  const scan = await scanFor("search_without_brand");
  const slice = scan.engines.perplexity;
  const { summary } = summarizeEngineResults(scan);

  await t.test("the precondition is a fully OBSERVED pool that does not name us", () => {
    assert.equal(slice.citations_unverified_count, 0, "every citation list was read");
    assert.equal(slice.citation_denominator, 2, "so both answered rows are in the pool");
    assert.equal(slice.cited_non_branded, 0, "acme.io is in neither citation list");
  });

  await t.test("the mirror reports it as a real 0, not as an absence", () => {
    assert.equal(summary.citation_share_pct, 0, "we looked at every list and were in none — that IS 0%");
    assert.equal(
      typeof summary.citation_share_pct,
      "number",
      "blanking a measured zero would trade one false reading for another"
    );
    assert.notEqual(summary.citation_share_pct, null, "null here would hide a real, bad finding");
  });

  await t.test("and the rollup row keeps the measured 0 as well", () => {
    const row = summaryToMetricsRow({
      brand: "acme",
      date: "2026-09-05",
      engine: "aio",
      scanId: "scan-r2211-b",
      promptSetId: null,
      summary,
      answeredKey: "non_branded_with_aio",
    });
    assert.equal(row.citation_share_pct, 0);
    assert.equal(typeof row.citation_share_pct, "number");
  });
});

/**
 * The rollup half, on summary shapes rather than a live scan: summaryToMetricsRow
 * used to read `summary.citation_share_pct ?? (computed)`, and `0 ?? x` is 0, so
 * ANY upstream that published a false zero laundered through it untouched — the
 * mirror above, and scoring/aioPipeline.js:231, which still emits 0.0 for an
 * empty non_branded_with_aio and is fed here verbatim by buildMetricsRows's
 * single-engine branch and by scripts/backfill-analytics.mjs replaying a
 * historical v8.1 summary_stats.
 */
test("R2.2.11 — the rollup lets the denominator decide, not the upstream claim", async (t) => {
  await t.test("a v8.1 summary claiming 0 over an empty pool is overruled", () => {
    const row = summaryToMetricsRow({
      brand: "acme",
      date: "2026-09-05",
      engine: "aio",
      scanId: "scan-v81",
      promptSetId: null,
      summary: {
        non_branded_queries: 6,
        non_branded_with_aio: 0,
        cited_non_branded: 0,
        citation_share_pct: 0,
      },
      answeredKey: "non_branded_with_aio",
    });
    assert.equal(
      row.citation_share_pct,
      null,
      "no answered row means no denominator; the 0 the summary carries was never divided from anything"
    );
  });

  await t.test("a real share over a real pool is still preferred over recomputing", () => {
    const row = summaryToMetricsRow({
      brand: "acme",
      date: "2026-09-05",
      engine: "aio",
      scanId: "scan-v81-b",
      promptSetId: null,
      summary: {
        non_branded_queries: 6,
        non_branded_with_aio: 4,
        cited_non_branded: 1,
        // Deliberately NOT 25: proves the summary's own number wins where there
        // is a denominator, which is the behaviour that must not change.
        citation_share_pct: 33.3,
      },
      answeredKey: "non_branded_with_aio",
    });
    assert.equal(row.citation_share_pct, 33.3, "the summary's own share must survive a non-empty pool");
  });

  await t.test("a measured zero over a real pool survives the rollup", () => {
    const row = summaryToMetricsRow({
      brand: "acme",
      date: "2026-09-05",
      engine: "aio",
      scanId: "scan-v81-c",
      promptSetId: null,
      summary: {
        non_branded_queries: 6,
        non_branded_with_aio: 4,
        cited_non_branded: 0,
        citation_share_pct: 0,
      },
      answeredKey: "non_branded_with_aio",
    });
    assert.equal(row.citation_share_pct, 0, "four lists read, none cited us — a real 0");
    assert.equal(typeof row.citation_share_pct, "number");
  });

  await t.test("both single-engine rows buildMetricsRows emits are null, not 0", () => {
    const rows = buildMetricsRows({
      isMultiEngine: false,
      brandKey: "acme",
      dateOnly: "2026-09-05",
      scanId: "scan-v81-d",
      promptSetId: null,
      summary: {
        non_branded_queries: 6,
        non_branded_with_aio: 0,
        cited_non_branded: 0,
        citation_share_pct: 0,
      },
      promptResultRows: null,
    });
    assert.equal(rows.length, 2, "the single-engine branch emits an 'aio' row and an identical 'all' row");
    for (const row of rows) {
      assert.equal(
        row.citation_share_pct,
        null,
        `the '${row.engine}' row must not carry a share over an empty denominator`
      );
    }
  });
});
