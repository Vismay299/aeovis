import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  extractText,
  extractCitations,
  matchesBrand,
  mentionRegex,
  computeBrandMentioned,
  computeWorkspaceBrandMentioned,
  shapeExploreSuccess,
  shapeExploreError,
} from "./shape.ts";

describe("src/lib/explore/shape.ts", () => {
  it("extracts text from message sections", () => {
    const raw = {
      items: [
        {
          type: "message",
          sections: [
            { text: "Paragraph 1." },
            { text: "" },
            { text: "Paragraph 2." },
          ],
        },
        {
          type: "other",
          sections: [{ text: "Ignored." }],
        },
      ],
    };
    assert.equal(extractText(raw), "Paragraph 1.\n\nParagraph 2.");
  });

  it("extractCitations: keeps untyped annotations, dedupes repeated URLs, and drops unsafe schemes", () => {
    const fixturePath = path.resolve(process.cwd(), "tests/fixtures/f11/annotations-dupes-unsafe.json");
    const raw = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

    const citations = extractCitations(raw);
    assert.equal(citations.length, 3);
    assert.equal(citations[0].url, "https://example.com/a");
    assert.equal(citations[0].domain, "example.com");
    assert.equal(citations[0].title, "A");

    assert.equal(citations[1].url, "https://www.townandcountrymag.com/x");
    assert.equal(citations[1].domain, "townandcountrymag.com");
    assert.equal(citations[1].title, "Town & Country");

    assert.equal(citations[2].url, "https://www.stylevana.com/y");
    assert.equal(citations[2].domain, "stylevana.com");
    assert.equal(citations[2].title, "Stylevana");
  });

  it("limits citations to at most 25", () => {
    const raw = {
      items: [
        {
          type: "message",
          sections: [
            {
              annotations: Array.from({ length: 30 }, (_, i) => ({
                title: `Source ${i}`,
                url: `https://example.com/source-${i}`,
              })),
            },
          ],
        },
      ],
    };
    const citations = extractCitations(raw);
    assert.equal(citations.length, 25);
  });

  it("matches brand in url or title case-insensitively", () => {
    assert.equal(matchesBrand("https://nike.com/shoes", "Store", "Nike"), true);
    assert.equal(matchesBrand("https://shoes.com", "Nike Air Max", "nike"), true);
    assert.equal(matchesBrand("https://adidas.com", "Shoes", "Nike"), false);
    assert.equal(matchesBrand("https://example.com", "Title", null), false);
  });

  it("mentionRegex handles brands ending with non-word chars (C++, AT&T, .NET)", () => {
    const cppRegex = mentionRegex("C++");
    assert.equal(cppRegex.test("I love C++ programming"), true);
    assert.equal(cppRegex.test("C++ is fast"), true);
    assert.equal(cppRegex.test("I wrote C+++ yesterday"), false);

    const attRegex = mentionRegex("AT&T");
    assert.equal(attRegex.test("Network by AT&T"), true);
    assert.equal(attRegex.test("AT&Tent is a typo"), false);

    const netRegex = mentionRegex(".NET");
    assert.equal(netRegex.test("Built on .NET core"), true);
    assert.equal(netRegex.test("Some.NETwork"), false);

    const standardRegex = mentionRegex("Nike");
    assert.equal(standardRegex.test("Buy Nike shoes"), true);
    assert.equal(standardRegex.test("Nikeness"), false);
  });

  it("computeBrandMentioned returns true on citation match or text regex", () => {
    const citations = [
      {
        url: "https://example.com/nike-review",
        domain: "example.com",
        title: "Best running shoes",
        matchedBrand: false,
      },
    ];

    assert.equal(computeBrandMentioned("No brand in text.", citations, "Nike"), true);
    assert.equal(computeBrandMentioned("We recommend Nike shoes.", [], "Nike"), true);
    assert.equal(computeBrandMentioned("No brand anywhere.", [], "Nike"), false);
    assert.equal(computeBrandMentioned("Text", citations, null), null);
    assert.equal(computeBrandMentioned("Text", citations, ""), null);
  });

  it("computeWorkspaceBrandMentioned checks against workspace aliases", () => {
    const aliases = ["Acme", "Acme Corp", "acme.com"];
    assert.equal(
      computeWorkspaceBrandMentioned("Acme Corp is great", [], aliases),
      true,
    );
    assert.equal(
      computeWorkspaceBrandMentioned("Other brand is great", [], aliases),
      false,
    );
  });

  it("shapes successful explore response from DataForSEO fixture", () => {
    const fixturePath = path.resolve(process.cwd(), "tests/fixtures/f11/llm-responses-chatgpt.json");
    const raw = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

    const result = shapeExploreSuccess({
      model: "chatgpt",
      route: "dataforseo",
      modelName: "gpt-5.6-luna",
      response: raw,
      highlightBrand: "Offcult",
      workspaceAliases: ["Perceev"],
      countryHint: "IN",
      costUsd: 0.0611,
      costState: "measured",
      observationId: "obs-123",
      observedAt: "2026-10-22T09:30:29.000Z",
    });

    assert.equal(result.status, "success");
    assert.equal(result.model, "chatgpt");
    assert.equal(result.label, "ChatGPT");
    assert.equal(result.route, "dataforseo");
    assert.equal(result.modelName, "gpt-5.6-luna");
    assert.equal(result.webSearch, true);
    assert.equal(result.countryHint, "IN");
    assert.equal(result.outputTokens, 812); // rounded from 812.4
    assert.equal(result.costUsd, 0.0611);
    assert.equal(result.costState, "measured");
    assert.equal(result.fanOutQueries.length, 2);
    assert.equal(result.fanOutReported, true);
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].url, "https://www.example.in/oversized");
    assert.equal(result.brandMentioned, false);
    assert.equal(result.workspaceBrandMentioned, false);
  });

  it("shapes explore error response with preserved cost and code", () => {
    const err = shapeExploreError({
      model: "gemini",
      errorCode: "UNSUPPORTED_COUNTRY",
      message: "Gemini doesn't support country selection.",
      costUsd: 0,
    });

    assert.equal(err.status, "error");
    assert.equal(err.model, "gemini");
    assert.equal(err.label, "Gemini");
    assert.equal(err.errorCode, "UNSUPPORTED_COUNTRY");
    assert.equal(err.costUsd, 0);
  });
});
