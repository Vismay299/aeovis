import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMention } from './judge.js';
import { getBrandAliases } from './aliases.js';
import { computeProbeFailureRate, evaluateControlPassed } from './qualityGate.js';

test('detectMention - control prompt matching correctness', () => {
  // iPhone expected mention "Apple"
  assert.ok(detectMention("This is made by Apple in California.", ["Apple"]));
  assert.ok(detectMention("Apple's new device is here.", ["Apple"]));
  
  // Word boundary checks: Pineapple contains Apple but should not match!
  assert.ok(!detectMention("I ate a pineapple.", ["Apple"]));
});

test('brand-in-prompt detection logic simulation', () => {
  const brand = "Acme";
  const website = "acme.io";
  const aliases = getBrandAliases(brand, website); // ['acme', 'acme.io']

  const promptText1 = "What is the best CRM tool for startups?";
  const promptText2 = "Why is Acme CRM so popular?";

  const hasBrandAlias1 = aliases.some(alias => {
    const escaped = alias.toLowerCase().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`(?:^|[^a-zA-Z0-9_])${escaped}(?:$|[^a-zA-Z0-9_])`, "i");
    return regex.test(promptText1.toLowerCase());
  });

  const hasBrandAlias2 = aliases.some(alias => {
    const escaped = alias.toLowerCase().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`(?:^|[^a-zA-Z0-9_])${escaped}(?:$|[^a-zA-Z0-9_])`, "i");
    return regex.test(promptText2.toLowerCase());
  });

  assert.equal(hasBrandAlias1, false);
  assert.equal(hasBrandAlias2, true);
});

test('evaluateControlPassed - passes when a successful engine run detects expected mention', () => {
  const controlResult = {
    run_details: [
      { engine: "google_ai_overview", model_used: "google_ai_overview-failed", raw_response: "", mentioned: false },
      { engine: "gemini", model_used: "gemini-flash-lite-latest", raw_response: "Apple manufactures the iPhone.", mentioned: true },
    ],
  };

  assert.equal(evaluateControlPassed(controlResult), true);
});

test('computeProbeFailureRate - ignores optional google_ai_overview failures', () => {
  const brandRuns = [
    { engine: "gemini", model_used: "gemini", raw_response: "Acme is a great tool." },
    { engine: "gemini", model_used: "gemini", raw_response: "Acme is mentioned here." },
    { engine: "google_ai_overview", model_used: "google_ai_overview-failed", raw_response: "" },
    { engine: "google_ai_overview", model_used: "google_ai_overview-failed", raw_response: "" },
    { engine: "google_ai_overview", model_used: "google_ai_overview-skipped", raw_response: "" },
  ];

  assert.equal(computeProbeFailureRate(brandRuns), 0);
});

test('computeProbeFailureRate - counts required engine failures', () => {
  const brandRuns = [
    { engine: "gemini", model_used: "gemini", raw_response: "Acme is a great tool." },
    { engine: "gemini", model_used: "perplexity-failed", raw_response: "" },
    { engine: "openai", model_used: "openai", raw_response: "" },
    { engine: "gemini", model_used: "gemini-skipped", raw_response: "" },
  ];

  assert.equal(computeProbeFailureRate(brandRuns), 0.5);
});
