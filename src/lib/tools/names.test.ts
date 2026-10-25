import test from "node:test";
import assert from "node:assert/strict";
import {
  EXTERNAL_TOOL_NAMES,
  PAID_TOOL_NAMES,
  PLANNED_TOOL_NAMES,
  SKILL_TERMS,
  TOOL_NAMES,
  isDeclaredToolName,
} from "./names.ts";

test("declared tool names are unique across TOOL_NAMES and PLANNED_TOOL_NAMES", () => {
  const all = [...TOOL_NAMES, ...PLANNED_TOOL_NAMES];
  assert.equal(new Set(all).size, all.length);
});

test("every declared tool name matches the snake_case pattern", () => {
  for (const name of [...TOOL_NAMES, ...PLANNED_TOOL_NAMES]) {
    assert.match(name, /^[a-z][a-z0-9_]{2,63}$/, name);
  }
});

test("every paid tool is a declared tool", () => {
  const declared = new Set<string>([...TOOL_NAMES]);
  for (const name of PAID_TOOL_NAMES) assert.ok(declared.has(name), name);
});

test("every external tool is a declared tool, and no tool is both paid and external", () => {
  const declared = new Set<string>([...TOOL_NAMES]);
  for (const name of EXTERNAL_TOOL_NAMES) assert.ok(declared.has(name), name);
  const paid = new Set<string>([...PAID_TOOL_NAMES]);
  for (const name of EXTERNAL_TOOL_NAMES) {
    assert.ok(!paid.has(name), `${name} cannot carry both a price card and a confirm card`);
  }
});

test("no skill term is a tool name, so the reference guard cannot be silenced by a term", () => {
  // Risk 3: a term that shadows a tool name would hide a typo from checkSkillToolReferences.
  const names = new Set<string>([...TOOL_NAMES, ...PLANNED_TOOL_NAMES]);
  for (const term of SKILL_TERMS) {
    assert.ok(!names.has(term), `${term} is a declared tool name and must not be a skill term`);
  }
});

test("isDeclaredToolName accepts declared names and refuses everything else", () => {
  assert.equal(isDeclaredToolName("save_report"), true);
  assert.equal(isDeclaredToolName("get_scan_report"), true);
  assert.equal(isDeclaredToolName("activate_skill"), false);
  assert.equal(isDeclaredToolName("get_scan_reprot"), false);
});
