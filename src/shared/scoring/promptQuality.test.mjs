import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPromptShape,
  isEliciting,
  countBrandsElicited,
  answerElicitedBrands,
  isDudPrompt,
  assessPromptSet,
  MIN_BRANDS_FOR_ELICITATION,
  DUD_MIN_OBSERVATIONS,
  MIN_ELICITING_RATIO,
} from "./promptQuality.js";

// --- shape classification --------------------------------------------------
// Cases are the REAL prompts from the Italica scan (36a91fbb), so a regression
// here means we have re-broken the thing that produced a 0 on 40 dead prompts.

test("vendor-selection shapes are eliciting", () => {
  const eliciting = [
    "best tile brands in india 2025",
    "best tiles for bathroom floor non slip",
    "italian tiles vs kajaria which is better",
    "which tiles for small bedroom make it look big",
    "where to buy designer tiles online",
    "top vitrified tile manufacturers",
    "alternatives to kajaria tiles",
    "most trusted tile companies bangalore",
    "trusted tile shop near me bangalore",
  ];
  for (const q of eliciting) {
    assert.equal(classifyPromptShape(q), "eliciting", `expected eliciting: ${q}`);
  }
});

test("informational shapes are diagnostic — they cannot name a vendor", () => {
  const diagnostic = [
    "how to calculate tiles needed for room",
    "how much do vitrified tiles cost per sqft",
    "2x4 feet tiles how many per box",
    "can i install tiles over old tiles",
    "why do glossy tiles get slippery",
    "tiles grout lines color matching tips",
  ];
  for (const q of diagnostic) {
    assert.equal(classifyPromptShape(q), "diagnostic", `expected diagnostic: ${q}`);
  }
});

test("keyword-lookalikes that produce methodology answers stay diagnostic", () => {
  // Contains "compare" but asks for a method, not a vendor list.
  assert.equal(classifyPromptShape("how to compare tile finishes"), "diagnostic");
  // Contains "many" + calculation intent.
  assert.equal(classifyPromptShape("how many tiles per box"), "diagnostic");
});

test("empty or junk input is diagnostic, never eliciting", () => {
  assert.equal(classifyPromptShape(""), "diagnostic");
  assert.equal(classifyPromptShape(null), "diagnostic");
  assert.equal(classifyPromptShape("   "), "diagnostic");
  assert.equal(isEliciting(""), false);
});

// --- roster-based elicitation ---------------------------------------------

test("countBrandsElicited counts only mentioned roster rows", () => {
  const rows = [
    { name: "Kajaria", mentioned: true },
    { name: "Somany", mentioned: true },
    { name: "Italica", mentioned: false },
    { name: "NITCO", mentioned: false },
  ];
  assert.equal(countBrandsElicited(rows), 2);
  assert.equal(countBrandsElicited([]), 0);
  assert.equal(countBrandsElicited(undefined), 0);
});

test("answerElicitedBrands: one roster hit proves the prompt elicits vendors", () => {
  assert.equal(MIN_BRANDS_FOR_ELICITATION, 1);
  assert.equal(answerElicitedBrands([{ mentioned: true }]), true);
  assert.equal(answerElicitedBrands([{ mentioned: false }]), false);
});

test("answerElicitedBrands returns null for an unanswered prompt", () => {
  // No answer is absence of evidence, NOT evidence the prompt is bad —
  // an AIO miss must never retire an otherwise good prompt.
  assert.equal(answerElicitedBrands([], false), null);
});

// --- dud retirement --------------------------------------------------------

test("isDudPrompt needs enough observations before retiring anything", () => {
  const barren = [
    { answered: true, brands_elicited: 0 },
    { answered: true, brands_elicited: 0 },
  ];
  assert.equal(barren.length < DUD_MIN_OBSERVATIONS, true);
  assert.equal(isDudPrompt(barren), false);
});

test("isDudPrompt retires a prompt that never elicits a vendor", () => {
  const dud = [
    { answered: true, brands_elicited: 0 },
    { answered: true, brands_elicited: 0 },
    { answered: true, brands_elicited: 0 },
  ];
  assert.equal(isDudPrompt(dud), true);
});

test("isDudPrompt spares a prompt that elicited even once", () => {
  const alive = [
    { answered: true, brands_elicited: 0 },
    { answered: true, brands_elicited: 3 },
    { answered: true, brands_elicited: 0 },
  ];
  assert.equal(isDudPrompt(alive), false);
});

test("isDudPrompt ignores unanswered observations", () => {
  // Three unanswered + zero answered = no evidence, not a dud.
  const noEvidence = [
    { answered: false, brands_elicited: 0 },
    { answered: false, brands_elicited: 0 },
    { answered: false, brands_elicited: 0 },
  ];
  assert.equal(isDudPrompt(noEvidence), false);
});

// --- prompt-set gate -------------------------------------------------------

test("assessPromptSet fails the real Italica set that caused the bug", () => {
  const italica = [
    "small tiles for kitchen backsplash",
    "cheapest good quality floor tiles",
    "wood look tiles realistic enough",
    "tiles laying pattern for rectangular room",
    "2x4 feet tiles how many per box",
    "tiles for outdoor balcony area",
    "what is double charge tile",
    "how to calculate tiles needed for room",
    "how much do vitrified tiles cost per sqft",
    "can i install tiles over old tiles",
    "best tile brands in india 2025",
    "best tiles for bathroom floor non slip",
  ].map((text) => ({ text, intent_tier: "exploratory" }));

  const r = assessPromptSet(italica);
  assert.equal(r.ok, false, "the set that produced a 0 must not pass the gate");
  assert.ok(r.ratio < MIN_ELICITING_RATIO);
  assert.equal(r.total, italica.length);
  assert.equal(r.eliciting + r.diagnostic, r.total);
});

test("assessPromptSet passes a vendor-selection set", () => {
  const good = [
    "best tile brands in india",
    "top vitrified tile manufacturers",
    "kajaria vs somany which is better",
    "most trusted tile companies bangalore",
    "alternatives to orientbell tiles",
    "which tile brand for indian homes",
    "best tile shops near me",
    "how to calculate tiles needed for room", // one diagnostic is fine
  ].map((text) => ({ text }));

  const r = assessPromptSet(good);
  assert.equal(r.ok, true);
  assert.equal(r.eliciting, 7);
  assert.equal(r.diagnostic, 1);
});

test("assessPromptSet excludes branded seeds from the ratio", () => {
  const withBranded = [
    { text: "Italica", intent_tier: "branded", source: "branded_seed" },
    { text: "italica reviews", intent_tier: "branded", source: "branded_seed" },
    { text: "best tile brands in india" },
    { text: "top tile manufacturers" },
  ];
  const r = assessPromptSet(withBranded);
  assert.equal(r.total, 2, "branded seeds are not part of the scored universe");
  assert.equal(r.eliciting, 2);
  assert.equal(r.ok, true);
});

test("assessPromptSet on an empty set is not ok", () => {
  const r = assessPromptSet([]);
  assert.equal(r.ok, false);
  assert.equal(r.total, 0);
  assert.equal(r.ratio, 0);
});
