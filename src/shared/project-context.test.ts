// Test cases ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/types/schemas/projectContext.ts
// Adapted for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import {
  customSectionSlugSchema,
  updateProjectContextBody,
} from "./project-context.ts";

test("custom section slugs accept lowercase words separated by hyphens", () => {
  assert.equal(customSectionSlugSchema.parse("launch-plan"), "launch-plan");
  assert.equal(customSectionSlugSchema.safeParse("Launch_Plan").success, false);
});

test("patch operations are strict and reject misspelled fields", () => {
  const parsed = updateProjectContextBody.safeParse({
    updates: [{ section: "current_goal", contents: "Plan" }],
  });
  assert.equal(parsed.success, false);
});

test("patch batches contain no more than fifty operations", () => {
  const parsed = updateProjectContextBody.safeParse({
    updates: Array.from({ length: 51 }, () => ({ section: "current_goal", content: "Plan" })),
  });
  assert.equal(parsed.success, false);
});

test("append research log validates the feature kind and key", () => {
  assert.equal(
    updateProjectContextBody.safeParse({
      updates: [
        {
          appendResearchLog: {
            summary: "Questions checked",
            kind: "questions.setup",
            researchKey: " offcult.in ",
          },
        },
      ],
    }).success,
    true,
  );
  assert.equal(
    updateProjectContextBody.safeParse({
      updates: [{ appendResearchLog: { summary: "Questions checked", kind: "Questions.Setup" } }],
    }).success,
    false,
  );
});
