import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateWorkOrder,
  validateResearchPack,
  validateBenchmarkNotes,
  validateDraft,
  validateReview,
  validateLessons,
  PASS_THRESHOLD,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// work_order
// ---------------------------------------------------------------------------

const GEO_WORK_ORDER = {
  angle: "CFO-grade cost breakdown of corporate checkups",
  title_hint: "Corporate Health Checkup Costs in India",
  target_queries: ["cost of corporate checkup"],
  fan_out: ["what does it include", "average cost per employee", "metro vs tier-2"],
  sections: [{ h2: "How much does it cost?", sub_query: "average cost per employee", evidence_note: "price table" }],
  notes: "",
};

test("validateWorkOrder accepts a valid geo_article work order", () => {
  const r = validateWorkOrder("geo_article", GEO_WORK_ORDER);
  assert.equal(r.ok, true);
  assert.equal(r.value.angle, GEO_WORK_ORDER.angle);
});

test("validateWorkOrder rejects geo_article without fan_out", () => {
  const r = validateWorkOrder("geo_article", { ...GEO_WORK_ORDER, fan_out: [] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("fan_out")));
});

test("validateWorkOrder rejects geo_article without target_queries", () => {
  const r = validateWorkOrder("geo_article", { ...GEO_WORK_ORDER, target_queries: [] });
  assert.equal(r.ok, false);
});

test("validateWorkOrder caps target_queries at 5", () => {
  const r = validateWorkOrder("geo_article", {
    ...GEO_WORK_ORDER,
    target_queries: ["a", "b", "c", "d", "e", "f", "g"],
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.target_queries.length, 5);
});

test("validateWorkOrder linkedin requires hook_thesis and valid post_shape", () => {
  const bad = validateWorkOrder("linkedin_post", {
    angle: "a",
    title_hint: "t",
    hook_thesis: "",
    post_shape: "sonnet",
  });
  assert.equal(bad.ok, false);

  const good = validateWorkOrder("linkedin_post", {
    angle: "a",
    title_hint: "t",
    hook_thesis: "Home collection inverts unit economics",
    post_shape: "data_point",
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.value.target_queries, []);
});

// ---------------------------------------------------------------------------
// research_pack — the anti-slop hard rule
// ---------------------------------------------------------------------------

test("validateResearchPack drops stats without a source_url (hard rule in code)", () => {
  const r = validateResearchPack({
    sources: [{ url: "https://example.com", title: "t", type: "cited_page", key_points: [] }],
    stats: [
      { stat: "18% of orders", source_url: "https://example.com" },
      { stat: "fabricated 99%", source_url: "" },
      { stat: "another orphan" },
    ],
    quotes: [{ quote: "q", attribution: "a" }], // no source_url → dropped
    paa: [],
    angles: [],
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.stats.length, 1);
  assert.equal(r.value.quotes.length, 0);
  assert.deepEqual(r.value.dropped_unsourced_stats, ["fabricated 99%", "another orphan"]);
});

test("validateResearchPack requires at least one source", () => {
  const r = validateResearchPack({ sources: [], stats: [], quotes: [] });
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// benchmark_notes
// ---------------------------------------------------------------------------

test("validateBenchmarkNotes geo requires distribution + directive", () => {
  const bad = validateBenchmarkNotes("geo_article", { dominant_format: "comparison" });
  assert.equal(bad.ok, false);

  const good = validateBenchmarkNotes("geo_article", {
    format_distribution: { comparison: 60, listicle: 40 },
    dominant_format: "comparison",
    directive: "Build a comparison table page.",
  });
  assert.equal(good.ok, true);
  assert.equal(good.value.engine_divergence, "none observed");
});

test("validateBenchmarkNotes linkedin requires the static pack", () => {
  assert.equal(validateBenchmarkNotes("linkedin_post", {}).ok, false);
  assert.equal(validateBenchmarkNotes("linkedin_post", { pack: { hook_patterns: [] } }).ok, true);
});

// ---------------------------------------------------------------------------
// draft
// ---------------------------------------------------------------------------

test("validateDraft enforces per-playbook length bounds", () => {
  const short = validateDraft("geo_article", { title: "t", body_md: "too short" });
  assert.equal(short.ok, false);

  const liOk = validateDraft("linkedin_post", {
    title: "t",
    body_md: "x".repeat(400),
  });
  assert.equal(liOk.ok, true);

  const liTooLong = validateDraft("linkedin_post", {
    title: "t",
    body_md: "x".repeat(3000),
  });
  assert.equal(liTooLong.ok, false);
});

// ---------------------------------------------------------------------------
// review — code owns the arithmetic and the verdict
// ---------------------------------------------------------------------------

const LI_PASS_SCORES = {
  facts_vs_research: 0.9,
  hook_strength: 0.8,
  persona_fit: 0.8,
  format_checklist: 0.9,
  ymyl_compliance: 1.0,
};

test("validateReview recomputes weighted_total and verdict in code", () => {
  const r = validateReview("linkedin_post", {
    scores: LI_PASS_SCORES,
    weighted_total: 0.1, // model lied — code must override
    verdict: "fail", // model lied — code must override
    violations: [],
    critique: "",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.weighted_total, 0.87);
  assert.ok(r.value.weighted_total >= PASS_THRESHOLD);
  assert.equal(r.value.verdict, "pass");
});

test("validateReview fails verdict on a floor breach even with a high total", () => {
  const r = validateReview("linkedin_post", {
    scores: { ...LI_PASS_SCORES, facts_vs_research: 0.6 }, // floor is 0.70
    verdict: "pass",
    violations: [],
    critique: "1. Trace the 18% claim to the pack or cut it.",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.verdict, "fail");
  assert.ok(r.value.floor_breaches.length > 0);
});

test("validateReview: a YMYL violation always fails and zeroes ymyl_compliance", () => {
  const r = validateReview("geo_article", {
    scores: {
      facts_vs_research: 1,
      citation_validity: 1,
      authority_specificity: 1,
      brand_voice: 1,
      channel_checklist: 1,
      ymyl_compliance: 1,
    },
    verdict: "pass",
    ymyl_violation: true,
    violations: [{ rule: "ymyl", detail: "clinical claim without source", ymyl: true }],
    critique: "",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.verdict, "fail");
  assert.equal(r.value.scores.ymyl_compliance, 0);
  assert.equal(r.value.ymyl_violation, true);
});

test("validateReview requires a critique on a non-YMYL fail", () => {
  const r = validateReview("linkedin_post", {
    scores: { ...LI_PASS_SCORES, hook_strength: 0.2 },
    verdict: "fail",
    violations: [],
    critique: "",
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("critique")));
});

// ---------------------------------------------------------------------------
// lessons
// ---------------------------------------------------------------------------

test("validateLessons normalizes strings and objects, caps at 3, drops >220 chars", () => {
  const r = validateLessons({
    lessons: [
      "Keep it short.",
      { lesson: "Never pitch the brand.", supersedes: "Always pitch." },
      { lesson: "x".repeat(300) },
      "Fourth lesson gets cut.",
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.lessons.length, 3);
  assert.equal(r.value.lessons[1].supersedes, "Always pitch.");
});

test("validateLessons accepts an empty lessons array", () => {
  const r = validateLessons({ lessons: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.lessons, []);
});
