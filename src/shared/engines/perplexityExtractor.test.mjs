/**
 * R1.3.2 — Perplexity extractor as a pure function + fixture tests.
 *
 * The extractor is pure: it takes raw JSON, returns structured output, and
 * never fetches. Parse failures yield parse_error, never empty-answered.
 *
 * Every fixture from R1.3.1 is exercised. A corrupted fixture yields parse_error.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractPerplexityAnswer,
  extractPerplexitySources,
  extractPerplexity,
} from "./perplexityExtractor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../../server/fixtures/perplexity");

async function loadFixture(name) {
  const raw = await readFile(path.join(FIXTURES, `${name}.json`), "utf8");
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// extractPerplexityAnswer
// ---------------------------------------------------------------------------

test("extractPerplexityAnswer — healthy response yields text and answered outcome", async () => {
  const fixture = await loadFixture("answered");
  const result = extractPerplexityAnswer(fixture.answer);

  assert.equal(result.outcome, "answered");
  assert.ok(result.text.length > 0);
  assert.match(result.text, /HubSpot/);
  assert.match(result.text, /Zoho/);
  assert.equal(result.error, undefined);
});

test("extractPerplexityAnswer — empty content yields answered with empty text (not parse_error)", async () => {
  const fixture = await loadFixture("no-answer");
  const result = extractPerplexityAnswer(fixture.answer);

  assert.equal(result.outcome, "answered", "empty content is a legitimate empty answer, not a parse failure");
  assert.equal(result.text, "");
  assert.equal(result.error, undefined);
});

test("extractPerplexityAnswer — block page with no choices yields parse_error", async () => {
  const fixture = await loadFixture("blocked");
  const result = extractPerplexityAnswer(fixture.answer);

  assert.equal(result.outcome, "parse_error");
  assert.equal(result.text, "");
  assert.ok(result.error, "parse_error must carry an error message");
});

test("extractPerplexityAnswer — CAPTCHA with empty choices array yields parse_error", async () => {
  const fixture = await loadFixture("captcha");
  const result = extractPerplexityAnswer(fixture.answer);

  assert.equal(result.outcome, "parse_error");
  assert.equal(result.text, "");
  assert.ok(result.error);
});

test("extractPerplexityAnswer — corrupted fixture yields parse_error", async () => {
  const fixture = await loadFixture("corrupted");
  const result = extractPerplexityAnswer(fixture.answer);

  assert.equal(result.outcome, "parse_error");
  assert.equal(result.text, "");
  assert.ok(result.error);
});

test("extractPerplexityAnswer — null input yields parse_error", () => {
  const result = extractPerplexityAnswer(null);
  assert.equal(result.outcome, "parse_error");
  assert.equal(result.text, "");
  assert.ok(result.error);
});

test("extractPerplexityAnswer — undefined input yields parse_error", () => {
  const result = extractPerplexityAnswer(undefined);
  assert.equal(result.outcome, "parse_error");
  assert.equal(result.text, "");
  assert.ok(result.error);
});

test("extractPerplexityAnswer — response with no message yields parse_error", () => {
  const result = extractPerplexityAnswer({ choices: [{ role: "assistant" }] });
  assert.equal(result.outcome, "parse_error");
  assert.ok(result.error);
});

// ---------------------------------------------------------------------------
// extractPerplexitySources
// ---------------------------------------------------------------------------

test("extractPerplexitySources — healthy search response yields sources with domains", async () => {
  const fixture = await loadFixture("answered");
  const result = extractPerplexitySources(fixture.search);

  assert.equal(result.outcome, "answered");
  assert.equal(result.sources.length, 3);
  assert.equal(result.sources[0].url, "https://www.hubspot.com/products/crm");
  assert.equal(result.sources[0].domain, "hubspot.com");
  assert.equal(result.sources[0].title, "Free CRM Software - HubSpot");
  assert.equal(result.sources[1].domain, "zoho.com");
  assert.equal(result.sources[2].domain, "salesforce.com");
  assert.equal(result.error, undefined);
});

test("extractPerplexitySources — empty results array yields answered with zero sources", async () => {
  const fixture = await loadFixture("blocked");
  const result = extractPerplexitySources(fixture.search);

  assert.equal(result.outcome, "answered", "empty results is a legitimate measured zero");
  assert.equal(result.sources.length, 0);
  assert.equal(result.error, undefined);
});

test("extractPerplexitySources — corrupted fixture yields parse_error", async () => {
  const fixture = await loadFixture("corrupted");
  const result = extractPerplexitySources(fixture.search);

  assert.equal(result.outcome, "parse_error");
  assert.equal(result.sources.length, 0);
  assert.ok(result.error);
});

test("extractPerplexitySources — null input yields parse_error", () => {
  const result = extractPerplexitySources(null);
  assert.equal(result.outcome, "parse_error");
  assert.ok(result.error);
});

test("extractPerplexitySources — deduplicates URLs", () => {
  const json = {
    results: [
      { url: "https://example.com/a", title: "A" },
      { url: "https://example.com/a", title: "A dup" },
      { url: "https://example.com/b", title: "B" },
    ],
  };
  const result = extractPerplexitySources(json);
  assert.equal(result.outcome, "answered");
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].url, "https://example.com/a");
  assert.equal(result.sources[1].url, "https://example.com/b");
});

test("extractPerplexitySources — items with no URL are skipped", () => {
  const json = {
    results: [
      { url: "", title: "No URL" },
      { url: "https://real.com", title: "Real" },
      { title: "Missing URL field" },
    ],
  };
  const result = extractPerplexitySources(json);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, "https://real.com");
});

// ---------------------------------------------------------------------------
// extractPerplexity (combined)
// ---------------------------------------------------------------------------

test("extractPerplexity — both legs healthy yields text + sources + answered", async () => {
  const fixture = await loadFixture("answered");
  const result = extractPerplexity({
    answerJson: fixture.answer,
    searchJson: fixture.search,
  });

  assert.equal(result.outcome, "answered");
  assert.ok(result.text.includes("HubSpot"));
  assert.equal(result.sources.length, 3);
  assert.equal(result.errors.length, 0);
});

test("extractPerplexity — only answer leg provided yields text but no sources", async () => {
  const fixture = await loadFixture("answered");
  const result = extractPerplexity({ answerJson: fixture.answer });

  assert.equal(result.outcome, "answered");
  assert.ok(result.text.length > 0);
  assert.equal(result.sources.length, 0);
  assert.equal(result.errors.length, 0);
});

test("extractPerplexity — only search leg provided yields sources but no text", async () => {
  const fixture = await loadFixture("answered");
  const result = extractPerplexity({ searchJson: fixture.search });

  assert.equal(result.outcome, "answered");
  assert.equal(result.text, "");
  assert.equal(result.sources.length, 3);
  assert.equal(result.errors.length, 0);
});

test("extractPerplexity — blocked answer + healthy search yields partial extraction with parse_error", async () => {
  const blocked = await loadFixture("blocked");
  const answered = await loadFixture("answered");
  const result = extractPerplexity({
    answerJson: blocked.answer,
    searchJson: answered.search,
  });

  assert.equal(result.outcome, "parse_error", "the answer leg's failure makes the whole extraction a parse_error");
  assert.equal(result.text, "");
  assert.equal(result.sources.length, 3, "search leg data is still returned");
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors[0].includes("answer"));
});

test("extractPerplexity — corrupted both legs yields parse_error with empty results", async () => {
  const fixture = await loadFixture("corrupted");
  const result = extractPerplexity({
    answerJson: fixture.answer,
    searchJson: fixture.search,
  });

  assert.equal(result.outcome, "parse_error");
  assert.equal(result.text, "");
  assert.equal(result.sources.length, 0);
  assert.ok(result.errors.length >= 2);
});

test("extractPerplexity — no arguments yields parse_error", () => {
  const result = extractPerplexity();
  assert.equal(result.outcome, "parse_error");
});

// ---------------------------------------------------------------------------
// Corrupted fixture yields parse_error (acceptance criterion)
// ---------------------------------------------------------------------------

test("corrupted fixture — the combined extractor never returns empty-answered", async () => {
  const fixture = await loadFixture("corrupted");
  const result = extractPerplexity({
    answerJson: fixture.answer,
    searchJson: fixture.search,
  });

  // The acceptance criterion: parse failure yields parse_error, never
  // empty-answered. An empty-answered would be { outcome: "answered", text: "" }.
  assert.notEqual(result.outcome, "answered",
    "a corrupted fixture must never produce outcome 'answered'");
  assert.equal(result.outcome, "parse_error");
});
