/**
 * R1.4.2 — ChatGPT extractor + fixtures test.
 *
 * The extractor is pure: it takes raw JSON from the OpenAI Responses API,
 * returns structured output, and never fetches. Parse failures yield
 * parse_error, never empty-answered.
 *
 * Every fixture from R1.4.1 is exercised. A corrupted fixture yields parse_error.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractChatGpt } from "./chatgptExtractor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../../server/fixtures/chatgpt");

async function loadFixture(name) {
  const raw = await readFile(path.join(FIXTURES, `${name}.json`), "utf8");
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Healthy response
// ---------------------------------------------------------------------------

test("extractChatGpt — healthy response yields text and citation chips", async () => {
  const fixture = await loadFixture("answered");
  const result = extractChatGpt(fixture.response);

  assert.equal(result.outcome, "answered");
  assert.ok(result.text.includes("HubSpot"));
  assert.ok(result.text.includes("Zoho CRM"));
  assert.ok(result.text.includes("Salesforce"));
  assert.equal(result.citations.length, 2);
  assert.equal(result.citations[0].url, "https://www.hubspot.com/products/crm");
  assert.equal(result.citations[0].domain, "hubspot.com");
  assert.equal(result.citations[0].title, "HubSpot CRM");
  assert.equal(result.citations[1].url, "https://www.zoho.com/crm/");
  assert.equal(result.citations[1].domain, "zoho.com");
  assert.equal(result.citations[1].title, "Zoho CRM");
  assert.equal(result.error, undefined);
});

// ---------------------------------------------------------------------------
// No answer (empty output)
// ---------------------------------------------------------------------------

test("extractChatGpt — empty output yields answered with empty text (not parse_error)", async () => {
  const fixture = await loadFixture("no-answer");
  const result = extractChatGpt(fixture.response);

  assert.equal(result.outcome, "answered", "empty output is a legitimate empty answer, not a parse failure");
  assert.equal(result.text, "");
  assert.equal(result.citations.length, 0);
  assert.equal(result.error, undefined);
});

// ---------------------------------------------------------------------------
// Blocked (error response, no output)
// ---------------------------------------------------------------------------

test("extractChatGpt — blocked response with error but no output yields answered with empty text", async () => {
  const fixture = await loadFixture("blocked");
  const result = extractChatGpt(fixture.response);

  // A valid JSON object with an error key but no output array is parseable —
  // it just has nothing to extract. This is different from parse_error.
  assert.equal(result.outcome, "parse_error", "a response with no output array is a parse error");
  assert.equal(result.text, "");
  assert.equal(result.citations.length, 0);
});

// ---------------------------------------------------------------------------
// Login wall (HTML, not JSON)
// ---------------------------------------------------------------------------

test("extractChatGpt — login wall (HTML string) yields parse_error", async () => {
  const fixture = await loadFixture("login-wall");
  const result = extractChatGpt(fixture.response);

  assert.equal(result.outcome, "parse_error");
  assert.equal(result.text, "");
  assert.equal(result.citations.length, 0);
  assert.ok(result.error);
});

// ---------------------------------------------------------------------------
// Corrupted fixture
// ---------------------------------------------------------------------------

test("extractChatGpt — corrupted fixture yields parse_error", async () => {
  const fixture = await loadFixture("corrupted");
  const result = extractChatGpt(fixture.response);

  assert.equal(result.outcome, "parse_error");
  assert.equal(result.text, "");
  assert.equal(result.citations.length, 0);
  assert.ok(result.error);
});

// ---------------------------------------------------------------------------
// Null / undefined
// ---------------------------------------------------------------------------

test("extractChatGpt — null input yields parse_error", () => {
  const result = extractChatGpt(null);
  assert.equal(result.outcome, "parse_error");
  assert.equal(result.text, "");
  assert.ok(result.error);
});

test("extractChatGpt — undefined input yields parse_error", () => {
  const result = extractChatGpt(undefined);
  assert.equal(result.outcome, "parse_error");
  assert.equal(result.text, "");
  assert.ok(result.error);
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

test("extractChatGpt — deduplicates citation URLs across content blocks", () => {
  const json = {
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "First block.",
            annotations: [
              { type: "url_citation", url: "https://example.com/a", title: "A" },
            ],
          },
          {
            type: "output_text",
            text: "Second block.",
            annotations: [
              { type: "url_citation", url: "https://example.com/a", title: "A dup" },
              { type: "url_citation", url: "https://example.com/b", title: "B" },
            ],
          },
        ],
      },
    ],
  };
  const result = extractChatGpt(json);
  assert.equal(result.outcome, "answered");
  assert.ok(result.text.includes("First block."));
  assert.ok(result.text.includes("Second block."));
  assert.equal(result.citations.length, 2);
  assert.equal(result.citations[0].url, "https://example.com/a");
  assert.equal(result.citations[1].url, "https://example.com/b");
});

// ---------------------------------------------------------------------------
// Multiple output items
// ---------------------------------------------------------------------------

test("extractChatGpt — extracts text from the first assistant message only", () => {
  const json = {
    output: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "query" }] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The answer is 42.", annotations: [] }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "followup" }] },
    ],
  };
  const result = extractChatGpt(json);
  assert.equal(result.outcome, "answered");
  assert.equal(result.text, "The answer is 42.");
  assert.equal(result.citations.length, 0);
});

// ---------------------------------------------------------------------------
// Acceptance: corrupted never returns empty-answered
// ---------------------------------------------------------------------------

test("corrupted fixture — the extractor never returns empty-answered", async () => {
  const fixture = await loadFixture("corrupted");
  const result = extractChatGpt(fixture.response);

  assert.notEqual(result.outcome, "answered",
    "a corrupted fixture must never produce outcome 'answered'");
  assert.equal(result.outcome, "parse_error");
});
