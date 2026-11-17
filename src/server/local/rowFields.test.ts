// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/dataforseo-research-tools.ts, src/server/mcp/tools/local-seo-tools.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUSINESS_ANSWER_ROW_FIELDS,
  BUSINESS_QUESTION_ROW_FIELDS,
  BUSINESS_UPDATE_ROW_FIELDS,
  LOCAL_BUSINESS_ROW_FIELDS,
  LOCAL_SERP_ROW_FIELDS,
  REVIEW_ROW_FIELDS,
  formatPostLinks,
  latestAnswerText,
  trimBusinessQuestionRow,
} from "./rowFields.ts";

describe("local/rowFields", () => {
  it("keeps constant field lists well-formed", () => {
    assert.ok(LOCAL_BUSINESS_ROW_FIELDS.includes("title"));
    assert.ok(LOCAL_BUSINESS_ROW_FIELDS.includes("cid"));
    assert.ok(LOCAL_SERP_ROW_FIELDS.includes("rank_group"));
    assert.ok(LOCAL_SERP_ROW_FIELDS.includes("rank_absolute"));
    assert.ok(REVIEW_ROW_FIELDS.includes("review_text"));
    assert.ok(REVIEW_ROW_FIELDS.includes("owner_answer"));
    assert.ok(BUSINESS_UPDATE_ROW_FIELDS.includes("post_text"));
    assert.ok(BUSINESS_UPDATE_ROW_FIELDS.includes("links"));
  });

  it("trims question rows and keeps nested answers trimmed to allowlisted fields", () => {
    const rawQuestion = {
      rank_absolute: 1,
      question_id: "q_1",
      question_text: "Do you offer vegan options?",
      original_question_text: "Do you offer vegan options?",
      profile_name: "Reviewer A",
      time_ago: "2 weeks ago",
      timestamp: "2026-10-25T12:00:00Z",
      extra_unwanted_blob: "blob_data_123",
      items: [
        {
          answer_id: "a_1",
          answer_text: "Yes, we do.",
          original_answer_text: "Yes, we do.",
          profile_name: "Owner",
          time_ago: "1 week ago",
          timestamp: "2026-10-26T12:00:00Z",
          avatar_url: "https://example.com/avatar.jpg",
          xpath: "/html/body/div",
        },
      ],
    };

    const trimmed = trimBusinessQuestionRow(rawQuestion);
    assert.equal(trimmed.question_id, "q_1");
    assert.equal(trimmed.question_text, "Do you offer vegan options?");
    assert.equal((trimmed as any).extra_unwanted_blob, undefined);

    const answers = trimmed.items as Record<string, unknown>[];
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.answer_id, "a_1");
    assert.equal(answers[0]?.answer_text, "Yes, we do.");
    assert.equal(answers[0]?.avatar_url, undefined);
    assert.equal(answers[0]?.xpath, undefined);
  });

  it("finds the latest answer text sorted by timestamp desc", () => {
    const question = {
      items: [
        {
          answer_id: "a1",
          answer_text: "First older answer",
          timestamp: "2026-10-10T12:00:00Z",
        },
        {
          answer_id: "a2",
          answer_text: "Latest answer",
          timestamp: "2026-10-20T12:00:00Z",
        },
        {
          answer_id: "a3",
          answer_text: "Middle answer",
          timestamp: "2026-10-15T12:00:00Z",
        },
      ],
    };

    assert.equal(latestAnswerText(question), "Latest answer");
    assert.equal(latestAnswerText({}), undefined);
    assert.equal(latestAnswerText({ items: [] }), undefined);
  });

  it("formats post links into human-readable string and handles empty links", () => {
    assert.equal(formatPostLinks(null), "—");
    assert.equal(formatPostLinks([]), "—");

    const links = [
      { title: "Menu", url: "https://example.com/menu" },
      { type: "Order", url: "https://example.com/order" },
      { url: "https://example.com/info" },
    ];
    assert.equal(
      formatPostLinks(links),
      "Menu → https://example.com/menu; Order → https://example.com/order; https://example.com/info",
    );
  });
});
