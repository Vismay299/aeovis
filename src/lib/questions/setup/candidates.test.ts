import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assembleCandidates } from "./candidates.ts";
import { CONTROL_PROMPTS } from "../../scoring/controlPrompts.js";

describe("candidates assembly (F08-AC-15)", () => {
  it("deduplicates, marks branded and eliciting, and selects defaults", () => {
    const controlText = CONTROL_PROMPTS[0]?.text ?? "What is the capital of France?";

    const input = {
      researchTopics: [
        {
          name: "Email Security",
          questions: [
            "How does Acme protect against phishing?",
            "What are the best email security practices?",
            controlText, // control prompt to be filtered out
          ],
        },
        {
          name: "Pricing & Plans",
          questions: [
            "How much does email protection cost?",
            "How much does email protection cost?", // exact duplicate
            "How much does email protection cost?!", // near-duplicate
          ],
        },
        {
          name: "Integrations",
          questions: ["Does Acme integrate with Slack?"],
        },
        {
          name: "Topic Four",
          questions: ["Question in topic 4?"],
        },
      ],
      promptgenItems: [
        {
          text: "What is the best alternative to Microsoft Defender?",
          topic: "Email Security",
          source: "promptgen",
        },
      ],
      existingQuestions: [
        {
          id: "q-existing-1",
          text: "Does Acme integrate with Slack?",
          textNormalized: "does acme integrate with slack?",
          status: "active" as const,
        },
      ],
      aliases: ["Acme", "Acme Corp"],
      unarchivedRoom: 10,
    };

    const candidates = assembleCandidates(input);

    // Control prompt dropped
    assert.strictEqual(
      candidates.some((c) => c.text.toLowerCase().includes(controlText.toLowerCase())),
      false,
    );

    // Duplicates dropped
    const pricingQuestions = candidates.filter((c) =>
      c.text.toLowerCase().includes("how much does email protection cost"),
    );
    assert.strictEqual(pricingQuestions.length, 1);

    // Branded detection
    const acmeQ = candidates.find((c) => c.text.includes("protect against phishing"));
    assert.ok(acmeQ);
    assert.strictEqual(acmeQ.branded, true);

    // Existing active question is marked and not selected
    const slackQ = candidates.find((c) => c.text.includes("Slack"));
    assert.ok(slackQ);
    assert.deepStrictEqual(slackQ.existing, { questionId: "q-existing-1", status: "active" });
    assert.strictEqual(slackQ.selected, false);

    // Topic 1 question in first 3 topics should be selected
    assert.strictEqual(acmeQ.selected, true);

    // Topic 4 question is NOT in first 3 topics -> not selected by default unless promptgen+eliciting
    const t4Q = candidates.find((c) => c.text.includes("topic 4"));
    assert.ok(t4Q);
    assert.strictEqual(t4Q.selected, false);
  });

  it("respects unarchivedRoom budget limit for default selection", () => {
    const input = {
      researchTopics: [
        {
          name: "Features",
          questions: ["Question 1?", "Question 2?", "Question 3?", "Question 4?"],
        },
      ],
      promptgenItems: [],
      existingQuestions: [],
      aliases: [],
      unarchivedRoom: 2, // only 2 can be selected
    };

    const candidates = assembleCandidates(input);
    const selected = candidates.filter((c) => c.selected);
    assert.strictEqual(selected.length, 2);
  });
});
