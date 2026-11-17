import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSkill, renderSkill, _clearSkillCache } from "./skills/loader.js";
import { parseStaticPack } from "./steps/benchmark.js";

// These tests run against the real skill files — they double as a lint that
// every step×playbook skill exists and has sane frontmatter.

const STEPS = ["coordinate", "research", "benchmark", "draft", "review"];
const PLAYBOOKS = ["geo_article", "linkedin_post"];

test("every step×playbook skill file loads with matching frontmatter", () => {
  _clearSkillCache();
  for (const step of STEPS) {
    for (const playbook of PLAYBOOKS) {
      const skill = loadSkill(step, playbook);
      assert.equal(skill.meta.step, step, `${step}.${playbook}: frontmatter step`);
      assert.ok(skill.body.length > 200, `${step}.${playbook}: body too small`);
    }
  }
});

test("learn falls back to the shared skill file", () => {
  const skill = loadSkill("learn", "geo_article");
  assert.equal(skill.meta.name, "learn.shared");
});

test("loadSkill throws on a missing skill", () => {
  assert.throws(() => loadSkill("nonexistent_step", "geo_article"));
});

test("renderSkill interpolates strings and objects, leaves unknowns intact", () => {
  const skill = { body: "Brand: {{brand}}\nBrief: {{brief}}\nMissing: {{nope}}" };
  const out = renderSkill(skill, { brand: "Acme", brief: { vertical: "healthcare" } });
  assert.ok(out.includes("Brand: Acme"));
  assert.ok(out.includes('"vertical": "healthcare"'));
  assert.ok(out.includes("{{nope}}"));
});

test("the linkedin benchmark skill carries a parseable static channel pack", () => {
  const skill = loadSkill("benchmark", "linkedin_post");
  const pack = parseStaticPack(skill.body);
  assert.ok(Array.isArray(pack.hook_patterns) && pack.hook_patterns.length >= 3);
  assert.ok(Array.isArray(pack.banned) && pack.banned.length > 0);
  assert.ok(typeof pack.cta_discipline === "string");
});

test("review skills carry every rubric dimension the schema expects", () => {
  const geo = loadSkill("review", "geo_article");
  for (const dim of [
    "facts_vs_research",
    "citation_validity",
    "authority_specificity",
    "brand_voice",
    "channel_checklist",
    "ymyl_compliance",
  ]) {
    assert.ok(geo.body.includes(dim), `review.geo_article missing ${dim}`);
  }
  const li = loadSkill("review", "linkedin_post");
  for (const dim of [
    "facts_vs_research",
    "hook_strength",
    "persona_fit",
    "format_checklist",
    "ymyl_compliance",
  ]) {
    assert.ok(li.body.includes(dim), `review.linkedin_post missing ${dim}`);
  }
});
