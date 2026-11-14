import test from "node:test";
import assert from "node:assert/strict";
import { summarizeBrands, type ExecutionFacts } from "./summary.ts";

function row(partial: Partial<ExecutionFacts>): ExecutionFacts {
  return {
    status: "answered",
    source: "scan",
    brands: [],
    ownMentioned: null,
    ownCited: null,
    competitorsCited: null,
    selfName: "Offcult",
    ...partial,
  };
}

test("parity with the upstream summarize shape on an equivalent fixture", () => {
  const rows = [
    row({
      brands: [
        { name: "Offcult", isSelf: true, mentioned: true },
        { name: "Bewakoof", isSelf: false, mentioned: true },
      ],
      ownCited: true,
      competitorsCited: ["Bewakoof"],
      mentionState: "observed",
    }),
    row({
      brands: [
        { name: "Offcult", isSelf: true, mentioned: false },
        { name: "Bewakoof", isSelf: false, mentioned: true },
      ],
      ownCited: false,
      competitorsCited: [],
      mentionState: "observed",
    }),
  ];
  const summary = summarizeBrands(rows);
  assert.equal(summary[0].isSelf, true);
  assert.equal(summary[0].name, "Offcult");
  assert.deepEqual(
    { answers: summary[0].answers, mentions: summary[0].mentions, citations: summary[0].citations },
    { answers: 2, mentions: 1, citations: 1 },
  );
  const rival = summary.find((entry) => entry.name === "Bewakoof");
  assert.ok(rival);
  assert.deepEqual(
    { answers: rival.answers, mentions: rival.mentions, citations: rival.citations },
    { answers: 2, mentions: 2, citations: 1 },
  );
});

test("unknown mention states are excluded from the denominator", () => {
  const summary = summarizeBrands([
    row({
      brands: [
        { name: "Offcult", isSelf: true, mentioned: null },
        { name: "Bewakoof", isSelf: false, mentioned: null },
      ],
      mentionState: "unobserved",
    }),
  ]);
  assert.equal(summary[0].unknown, 1);
  assert.equal(summary[0].answers, 0);
  const rival = summary.find((entry) => entry.name === "Bewakoof");
  assert.ok(rival);
  assert.equal(rival.unknown, 1);
  assert.equal(rival.answers, 0);
});

test("self without a roster falls back to the workspace display name", () => {
  const summary = summarizeBrands([
    row({ brands: [], ownMentioned: true, ownCited: false, mentionState: "observed", selfName: "Offcult" }),
  ]);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].name, "Offcult");
  assert.equal(summary[0].answers, 1);
  assert.equal(summary[0].mentions, 1);
});

test("explore answers are listed elsewhere and never counted", () => {
  const summary = summarizeBrands([
    row({
      source: "explore",
      brands: [
        { name: "Offcult", isSelf: true, mentioned: true },
        { name: "Bewakoof", isSelf: false, mentioned: true },
      ],
      ownCited: true,
      competitorsCited: ["Bewakoof"],
      mentionState: "observed",
    }),
  ]);
  assert.deepEqual(summary, []);
});

test("rival citations match case-insensitively and ordering is self then mentions", () => {
  const summary = summarizeBrands([
    row({
      brands: [
        { name: "Offcult", isSelf: true, mentioned: false },
        { name: "Zara", isSelf: false, mentioned: true },
        { name: "bewakoof", isSelf: false, mentioned: false },
      ],
      ownCited: false,
      competitorsCited: ["BEWAKOOF"],
      mentionState: "observed",
    }),
  ]);
  assert.equal(summary[0].isSelf, true);
  assert.equal(summary[1].name, "Zara");
  assert.equal(summary[2].name, "bewakoof");
  assert.equal(summary[2].citations, 1);
});
