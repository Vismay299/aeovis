import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeSavedKeywordTags,
  parseSavedKeywordTagInput,
} from "./saved-keyword-tags.ts";

describe("saved keyword tag helpers", () => {
  it("dedupes tags by normalized name", () => {
    assert.deepEqual(
      normalizeSavedKeywordTags([
        "Content",
        "content",
        "  Technical   SEO  ",
        "technical seo",
      ]),
      [
        { name: "Content", normalizedName: "content" },
        { name: "Technical SEO", normalizedName: "technical seo" },
      ],
    );
  });

  it("parses comma and newline separated tag input", () => {
    assert.deepEqual(
      parseSavedKeywordTagInput("content, technical seo\nBOFU"),
      ["content", "technical seo", "BOFU"],
    );
  });
});
