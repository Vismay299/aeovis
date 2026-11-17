// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/providers/dataforseoEvidence.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDataforseoAnswer, parseLlmResponseAnswer } from "./dataforseoEvidence.ts";

test("keeps safe citations, removes tracking parameters, and drops citation pills", () => {
  const result = parseDataforseoAnswer({
    datetime: "2026-09-30 18:41:09 +00:00",
    markdown: "- **AcmeSEO** is open source. [acmeseo.example](https://acmeseo.example/blog?utm_source=chatgpt.com) See [SerpBear on GitHub](https://github.com/towfiqi/serpbear).",
    sources: [
      { url: "https://acmeseo.example/blog?utm_source=chatgpt.com", title: "Blog" },
      { url: "javascript:alert(1)" },
    ],
  }, "chatgpt");
  assert.equal(result?.answerText, "AcmeSEO is open source.  See SerpBear on GitHub.");
  assert.deepEqual(result?.citations, [{ url: "https://acmeseo.example/blog", domain: "acmeseo.example", title: "Blog", position: 1 }]);
  assert.equal(result?.collectedAt, "2026-09-30T18:41:09.000Z");
});

test("collects all Google AI Overview references and treats organic-only pages as no answer", () => {
  const result = parseDataforseoAnswer({ items: [{
    type: "ai_overview",
    markdown: "Use SerpBear.[[1]](https://ccbd.dev/blog)",
    references: [{ url: "https://ccbd.dev/blog" }],
    items: [{ references: [{ url: "https://matomo.org/" }] }],
  }] }, "google_ai_overview");
  assert.equal(result?.answerText, "Use SerpBear.");
  assert.deepEqual(result?.citations.map((citation) => citation.domain), ["ccbd.dev", "matomo.org"]);
  assert.deepEqual(parseDataforseoAnswer({ items: [{ type: "organic" }] }, "google_ai_overview")?.citations, []);
});

test("LLM response metadata is capped and preserved without making network calls", () => {
  const parsed = parseLlmResponseAnswer({
    model_name: "gpt-test",
    output_tokens: 64,
    web_search: true,
    fan_out_queries: Array.from({ length: 25 }, (_, index) => `q${index}`),
    items: [{ type: "message", sections: [{ text: "Answer", annotations: [{ url: "https://example.com/a?gclid=x", title: "Example" }] }] }],
  });
  assert.equal(parsed.answerText, "Answer");
  assert.equal(parsed.fanOutQueries.length, 20);
  assert.equal(parsed.outputTokens, 64);
  assert.equal(parsed.webSearch, true);
  assert.equal(parsed.modelName, "gpt-test");
  assert.equal(parsed.citations[0].url, "https://example.com/a");
});