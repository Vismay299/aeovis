import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SPEND_FEATURES,
  SPEND_FEATURE_LABELS,
  isSpendFeature,
  spendFeatureLabel,
} from "./spend-features.ts";

describe("spend-features", () => {
  it("includes F08 spend features", () => {
    assert.equal(isSpendFeature("questions.setup"), true);
    assert.equal(isSpendFeature("questions.generate"), true);
    assert.equal(isSpendFeature("questions.research"), true);
    assert.equal(isSpendFeature("nonexistent"), false);
  });

  it("provides customer-facing labels for F08 spend features", () => {
    assert.equal(spendFeatureLabel("questions.setup"), "Question setup research");
    assert.equal(spendFeatureLabel("questions.generate"), "Question drafting");
    assert.equal(spendFeatureLabel("questions.research"), "Question research");
    assert.equal(spendFeatureLabel("unknown.feature"), "Other");
  });
});
