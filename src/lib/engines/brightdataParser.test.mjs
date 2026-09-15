import test from "node:test";
import assert from "node:assert/strict";
import {
  extractBrightDataAiOverview,
  extractBrightDataPaa,
  extractBrightDataOrganic,
} from "./brightdata.js";

/**
 * R6.5.1 — the live AIO transport had zero direct coverage.
 *
 * Bright Data is the only paid engine on the live scan path: every AI Overview
 * probe goes through these three parsers, and a shape change would degrade
 * silently to empty text — which, before R2.2.1, scored as an answered
 * non-mention. The parser is where a vendor change first shows up, so it is the
 * place a fixture earns the most.
 *
 * These fixtures follow the real response shape the integration documents:
 * an outer envelope whose `body` is the SERP payload, `ai_overview.texts` as
 * the primary block array with `text_blocks` / `paragraphs` as observed
 * fallbacks, and references under any of `references` / `sources` / `citations`.
 */

/** The primary shape: ai_overview.texts, references with href/title/source. */
const AIO_PRIMARY = {
  ai_overview: {
    texts: [
      { snippet: "Italica is among the larger vitrified tile manufacturers in Morbi." },
      { snippet: "Kajaria and Somany are also frequently recommended." },
    ],
    references: [
      { href: "https://italicatiles.com/collections", title: "Collections", source: "italicatiles.com" },
      { href: "https://www.kajariaceramics.com/", title: "Kajaria", source: "kajariaceramics.com" },
    ],
  },
};

test("AIO — the primary texts shape, with references and de-duplicated citations", () => {
  const out = extractBrightDataAiOverview(AIO_PRIMARY);

  assert.equal(
    out.text,
    "Italica is among the larger vitrified tile manufacturers in Morbi.\n" +
      "Kajaria and Somany are also frequently recommended."
  );
  assert.equal(out.references.length, 2);
  assert.equal(out.references[0].href, "https://italicatiles.com/collections");
  assert.equal(out.references[0].source, "italicatiles.com");
  assert.equal(out.citations.length, 2);
});

test("AIO — text_blocks and paragraphs are fallbacks, used only when texts is absent", () => {
  const viaBlocks = extractBrightDataAiOverview({
    ai_overview: { text_blocks: [{ snippet: "From text_blocks." }] },
  });
  assert.equal(viaBlocks.text, "From text_blocks.");

  const viaParagraphs = extractBrightDataAiOverview({
    ai_overview: { paragraphs: [{ snippet: "From paragraphs." }] },
  });
  assert.equal(viaParagraphs.text, "From paragraphs.");

  // texts wins when both are present — otherwise a vendor shipping both would
  // silently change which one the score is computed from.
  const both = extractBrightDataAiOverview({
    ai_overview: {
      texts: [{ snippet: "From texts." }],
      text_blocks: [{ snippet: "From text_blocks." }],
    },
  });
  assert.equal(both.text, "From texts.");
});

test("AIO — a bare string overview still yields text", () => {
  const out = extractBrightDataAiOverview({ ai_overview: "Just a sentence." });
  assert.equal(out.text, "Just a sentence.");
});

test("AIO — no overview is empty, and empty is not an error", () => {
  // The distinction R2.2.1 rests on: this parser reports absence; it is the
  // pipeline's job to decide that absence is not a non-mention.
  for (const input of [{}, null, undefined, { ai_overview: null }]) {
    const out = extractBrightDataAiOverview(input);
    assert.deepEqual(out, { text: "", citations: [], references: [] });
  }
});

test("AIO — references arrive under three different keys, and all count", () => {
  const out = extractBrightDataAiOverview({
    ai_overview: {
      texts: [{ snippet: "x" }],
      references: [{ href: "https://a.com/1" }],
      sources: [{ link: "https://b.com/2" }],
      citations: ["https://c.com/3"],
    },
  });
  const hrefs = out.references.map((r) => r.href).sort();
  assert.deepEqual(hrefs, ["https://a.com/1", "https://b.com/2", "https://c.com/3"]);
});

test("AIO — a reference with no usable href is dropped, not rendered as a blank link", () => {
  const out = extractBrightDataAiOverview({
    ai_overview: {
      texts: [{ snippet: "x" }],
      references: [{ title: "No link here" }, { href: "https://real.com/" }],
    },
  });
  assert.equal(out.references.length, 1);
  assert.equal(out.references[0].href, "https://real.com/");
});

test("PAA — question and text keys both read; blanks dropped", () => {
  const out = extractBrightDataPaa({
    people_also_ask: [
      { question: "Which tiles are best for a bathroom?" },
      { text: "How much do vitrified tiles cost?" },
      { question: "" },
      {},
    ],
  });
  assert.deepEqual(out, [
    "Which tiles are best for a bathroom?",
    "How much do vitrified tiles cost?",
  ]);
  assert.deepEqual(extractBrightDataPaa({}), []);
});

test("organic — capped at ten, www stripped, position preserved", () => {
  const organic = Array.from({ length: 14 }, (_, i) => ({
    position: i + 1,
    link: `https://www.site${i}.com/page`,
    domain: `www.site${i}.com`,
    title: `Result ${i}`,
  }));

  const out = extractBrightDataOrganic({ organic });
  assert.equal(out.length, 10, "the AIO surface only ever shows the first ten");
  assert.equal(out[0].domain, "site0.com", "www must be stripped or domain matching fails");
  assert.equal(out[0].position, 1);
  assert.equal(out[0].href, "https://www.site0.com/page");
});

test("organic — position falls back to index when the vendor omits it", () => {
  const out = extractBrightDataOrganic({
    organic: [{ link: "https://a.com" }, { rank: 7, link: "https://b.com" }],
  });
  assert.equal(out[0].position, 1, "an absent position must not become undefined");
  assert.equal(out[1].position, 7, "an explicit rank is honoured");
});

test("organic — a non-array is empty, never a throw", () => {
  // The live path calls this on every AIO probe; a vendor shape change must
  // degrade to "no organic results", not take the scan down.
  assert.deepEqual(extractBrightDataOrganic({}), []);
  assert.deepEqual(extractBrightDataOrganic({ organic: null }), []);
  assert.deepEqual(extractBrightDataOrganic(null), []);
});
