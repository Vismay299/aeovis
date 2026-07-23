import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAgent, builtinAgents, defaultAgentForBase } from "./agents/model.js";
import { getFormat, baseForFormat, FORMAT_KEYS } from "./agents/formats.js";
import { formatAgentOverlay } from "./steps/shared.js";
import { applyRubricEmphasis, RUBRIC_WEIGHTS } from "./schemas.js";
import {
  initTrace,
  markWorking,
  markDone,
  markFailed,
  summarizeDraft,
  summarizeReview,
} from "./agents/trace.js";

// --- agent model -----------------------------------------------------------

test("normalizeAgent requires a name and defaults base from format", () => {
  const bad = normalizeAgent({ format: "listicle" }, "Acme");
  assert.equal(bad.ok, false);

  const good = normalizeAgent({ name: "Listicle Writer", format: "listicle" }, "Acme");
  assert.equal(good.ok, true);
  assert.equal(good.agent.format, "listicle");
  assert.equal(good.agent.base, "geo_article"); // listicle defaults to geo base
  assert.equal(good.agent.slug, "listicle-writer");
  assert.equal(good.agent.channel, "website");
});

test("normalizeAgent falls back to article for an unknown format", () => {
  const r = normalizeAgent({ name: "X", format: "haiku" }, "Acme");
  assert.equal(r.agent.format, "article");
});

test("normalizeAgent clamps rubric emphasis to valid dims and range", () => {
  const r = normalizeAgent(
    {
      name: "X",
      format: "listicle",
      rubric_emphasis: { authority_specificity: 2, bogus_dim: 5, facts_vs_research: 99 },
    },
    "Acme"
  );
  assert.equal(r.agent.rubric_emphasis.authority_specificity, 2);
  assert.ok(!("bogus_dim" in r.agent.rubric_emphasis));
  assert.ok(!("facts_vs_research" in r.agent.rubric_emphasis)); // 99 > 3 → dropped
});

test("builtinAgents returns two built-ins marked is_builtin", () => {
  const b = builtinAgents();
  assert.equal(b.length, 2);
  assert.ok(b.every((a) => a.is_builtin));
  assert.deepEqual(
    b.map((a) => a.format).sort(),
    ["article", "linkedin_post"]
  );
});

test("defaultAgentForBase pairs base with a sensible format", () => {
  assert.equal(defaultAgentForBase("geo_article").format, "article");
  assert.equal(defaultAgentForBase("linkedin_post").format, "linkedin_post");
});

// --- formats ---------------------------------------------------------------

test("every format has a structure directive and a base", () => {
  for (const key of FORMAT_KEYS) {
    const f = getFormat(key);
    assert.ok(f.structure && f.structure.length > 40, `${key} structure`);
    assert.ok(["geo_article", "linkedin_post"].includes(f.base), `${key} base`);
  }
});

test("baseForFormat maps format → pipeline base", () => {
  assert.equal(baseForFormat("comparison"), "geo_article");
  assert.equal(baseForFormat("thread"), "linkedin_post");
});

// --- agent overlay ---------------------------------------------------------

test("formatAgentOverlay renders the format directive, length, and custom instructions", () => {
  const agent = normalizeAgent(
    {
      name: "Listicle Writer",
      format: "listicle",
      length_hint: "800 words",
      format_config: { items: 7, ranked: true },
      design_rules: ["Number every item", "No fluff intros"],
      custom_instructions: "Always end with a caveat about pricing changing.",
    },
    "Acme"
  ).agent;

  const overlay = formatAgentOverlay(agent);
  assert.ok(overlay.includes("Listicle"));
  assert.ok(overlay.includes("ranked listicle"), "format structure injected");
  assert.ok(overlay.includes("800 words"));
  assert.ok(overlay.includes("items=7"));
  assert.ok(overlay.includes("Number every item"));
  assert.ok(overlay.includes("caveat about pricing"));
});

test("formatAgentOverlay handles a missing agent gracefully", () => {
  assert.ok(formatAgentOverlay(null).includes("no custom agent"));
});

// --- rubric emphasis -------------------------------------------------------

test("applyRubricEmphasis renormalizes to sum 1 and shifts weight", () => {
  const base = RUBRIC_WEIGHTS.geo_article;
  const out = applyRubricEmphasis(base, { citation_validity: 2 });
  const sum = Object.values(out).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.02, `sum ~1, got ${sum}`);
  // citation_validity should now carry more relative weight than in the base.
  assert.ok(out.citation_validity > base.citation_validity);
  assert.ok(out.facts_vs_research < base.facts_vs_research);
});

test("applyRubricEmphasis is a no-op with no emphasis", () => {
  const base = RUBRIC_WEIGHTS.linkedin_post;
  assert.equal(applyRubricEmphasis(base, {}), base);
  assert.equal(applyRubricEmphasis(base, undefined), base);
});

// --- trace -----------------------------------------------------------------

test("initTrace produces the five specialists, all pending, in order", () => {
  const t = initTrace();
  assert.deepEqual(
    t.map((x) => x.step),
    ["coordinate", "research", "benchmark", "draft", "review"]
  );
  assert.ok(t.every((x) => x.status === "pending"));
});

test("trace transitions: working → done, and failed", () => {
  const t = initTrace();
  markWorking(t, "coordinate", "Planning", "2026-07-23T00:00:00Z");
  assert.equal(t[0].status, "working");
  assert.equal(t[0].activity, "Planning");
  assert.equal(t[0].started_at, "2026-07-23T00:00:00Z");

  markDone(t, "coordinate", "Angle chosen", "2026-07-23T00:01:00Z");
  assert.equal(t[0].status, "done");
  assert.equal(t[0].summary, "Angle chosen");

  markFailed(t, "research", "scrape exploded", "2026-07-23T00:02:00Z");
  assert.equal(t[1].status, "failed");
  assert.equal(t[1].summary, "scrape exploded");
});

test("summarizeDraft reports word count and redraft cycle", () => {
  const s = summarizeDraft({ title: "T", body_md: "one two three four five" }, 2);
  assert.ok(s.includes("5 words"));
  assert.ok(s.includes("redraft 2"));
});

test("summarizeReview surfaces verdict and YMYL flag", () => {
  const s = summarizeReview({ weighted_total: 0.73, verdict: "fail", ymyl_violation: true });
  assert.ok(s.includes("0.73"));
  assert.ok(s.includes("fail"));
  assert.ok(s.includes("YMYL"));
});
