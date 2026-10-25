import test from "node:test";
import assert from "node:assert/strict";
import { PLANNED_TOOL_NAMES, SKILL_TERMS, TOOL_NAMES } from "../../lib/tools/names.ts";
import { checkSkillToolReferences } from "./references.ts";
import type { ReferenceEntry, ReferenceVocabulary } from "./references.ts";
import { SKILL_MANIFEST } from "./manifest.generated.ts";

const vocab: ReferenceVocabulary = {
  declared: new Set<string>(TOOL_NAMES),
  planned: new Set<string>(PLANNED_TOOL_NAMES),
  terms: SKILL_TERMS,
};

function fixture(overrides: Partial<ReferenceEntry>): ReferenceEntry {
  return {
    name: "fixture-skill",
    tools: ["get_scan_report"],
    optionalTools: [],
    body: "# Fixture\n\nCall `get_scan_report` for the gaps.",
    bodyStartLine: 10,
    ...overrides,
  };
}

test("a tool named in frontmatter and in the body passes", () => {
  assert.deepEqual(checkSkillToolReferences([fixture({})], vocab), []);
});

test("a body token missing from the frontmatter is not_in_frontmatter, with its line", () => {
  const problems = checkSkillToolReferences(
    [fixture({ body: "# Fixture\n\nThen `list_scans` shows history." })],
    vocab
  );
  assert.deepEqual(problems, [
    { skill: "fixture-skill", token: "list_scans", line: 12, reason: "not_in_frontmatter" },
  ]);
});

test("a typo in a backticked tool name is unknown_tool, with its line", () => {
  const problems = checkSkillToolReferences(
    [fixture({ body: "# Fixture\n\nCall `get_scan_reprot` now." })],
    vocab
  );
  assert.deepEqual(problems, [
    { skill: "fixture-skill", token: "get_scan_reprot", line: 12, reason: "unknown_tool" },
  ]);
});

test("a declared term such as business_overview passes", () => {
  assert.deepEqual(
    checkSkillToolReferences([fixture({ body: "# Fixture\n\nRead `business_overview` first, `get_scan_report` next." })], vocab),
    []
  );
});

test("a planned tool passes only when it is in optional_tools", () => {
  const asOptional = fixture({
    optionalTools: ["save_report"],
    body: "# Fixture\n\nDeliver with `save_report` if available. `get_scan_report`.",
  });
  assert.deepEqual(checkSkillToolReferences([asOptional], vocab), []);

  const notDeclared = fixture({ body: "# Fixture\n\nDeliver with `save_report`. `get_scan_report`." });
  assert.deepEqual(checkSkillToolReferences([notDeclared], vocab), [
    { skill: "fixture-skill", token: "save_report", line: 12, reason: "not_in_frontmatter" },
  ]);
});

test("a required tool that does not exist is unknown_tool in frontmatter", () => {
  const problems = checkSkillToolReferences([fixture({ tools: ["no_such_tool"], body: "# Fixture\n\nBody." })], vocab);
  assert.deepEqual(problems, [{ skill: "fixture-skill", token: "no_such_tool", line: 1, reason: "unknown_tool" }]);
});

test("an optional tool that is neither declared nor planned is optional_not_declared", () => {
  const problems = checkSkillToolReferences(
    [fixture({ optionalTools: ["made_up_tool"], body: "# Fixture\n\n`get_scan_report`." })],
    vocab
  );
  assert.deepEqual(problems, [{ skill: "fixture-skill", token: "made_up_tool", line: 1, reason: "optional_not_declared" }]);
});

test("the shipped skill manifest references no unknown tool", () => {
  const entries = SKILL_MANIFEST.map((skill) => ({
    name: skill.name,
    tools: skill.tools,
    optionalTools: skill.optionalTools,
    body: skill.body,
    bodyStartLine: 1,
  }));
  assert.deepEqual(checkSkillToolReferences(entries, vocab), []);
});

test("SKILL_TERMS never shadows a real tool name", () => {
  for (const term of SKILL_TERMS) {
    assert.ok(!vocab.declared.has(term) && !vocab.planned.has(term), term);
  }
});
