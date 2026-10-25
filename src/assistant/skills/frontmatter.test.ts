import test from "node:test";
import assert from "node:assert/strict";
import { SkillFormatError, parseSkillFile } from "./frontmatter.ts";

const FILE = "test/SKILL.md";
const BODY = `# Sample Skill

## Goal

${"Explain the workflow in plain words so the assistant can follow it step by step. ".repeat(3)}
`;

function skill(overrides: Record<string, string> = {}, body: string = BODY): string {
  const fields: Record<string, string> = {
    name: "sample-skill",
    description: "A sample skill used by the frontmatter tests to check the grammar.",
    version: "1.0.0",
    source: "perceev",
    tools: "[get_project_context, update_project_context]",
    ...overrides,
  };
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return ["---", ...lines, "---", "", body].join("\n");
}

function expectFormatError(raw: string, message: RegExp): void {
  assert.throws(
    () => parseSkillFile(FILE, raw),
    (err: unknown) => err instanceof SkillFormatError && message.test(err.message)
  );
}

test("a valid skill parses into frontmatter and a trimmed body", () => {
  const parsed = parseSkillFile(FILE, skill());
  assert.equal(parsed.frontmatter.name, "sample-skill");
  assert.equal(parsed.frontmatter.version, "1.0.0");
  assert.deepEqual(parsed.frontmatter.tools, ["get_project_context", "update_project_context"]);
  assert.deepEqual(parsed.frontmatter.optionalTools, []);
  assert.equal(parsed.frontmatter.internal, false);
  assert.ok(parsed.body.startsWith("# Sample Skill"));
});

test("CRLF line endings are normalised", () => {
  const parsed = parseSkillFile(FILE, skill().replace(/\n/g, "\r\n"));
  assert.equal(parsed.frontmatter.name, "sample-skill");
});

test("a file without an opening frontmatter fence is refused at line 1", () => {
  expectFormatError(BODY, /Skill has no frontmatter/);
});

test("a file whose frontmatter never closes is refused", () => {
  expectFormatError("---\nname: sample-skill\n" + BODY, /Skill has no frontmatter/);
});

test("an unknown frontmatter key is refused by name", () => {
  expectFormatError(skill({ metadata: "x" }), /Unknown frontmatter key metadata/);
});

test("a duplicate frontmatter key is refused", () => {
  const raw = skill().replace("version: 1.0.0", "version: 1.0.0\nversion: 1.0.1");
  expectFormatError(raw, /Duplicate frontmatter key version/);
});

test("a skill name outside the pattern is refused", () => {
  expectFormatError(skill({ name: "Foo" }), /Invalid skill name/);
});

test("a description shorter than 20 characters is refused", () => {
  expectFormatError(skill({ description: "nineteen chars only" }), /description must be/);
});

test("a version that is not semver is refused", () => {
  expectFormatError(skill({ version: "1.0" }), /Invalid version/);
});

test("a source outside the allowed forms is refused", () => {
  expectFormatError(skill({ source: "openseo:foo" }), /Invalid source/);
});

test("an empty tools list is refused", () => {
  expectFormatError(skill({ tools: "[]" }), /tools must not be empty/);
});

test("internal must be true or false", () => {
  expectFormatError(skill({ internal: "yes" }), /internal must be true or false/);
});

test("a body without a # title is refused", () => {
  const body = "No heading here. ".repeat(20);
  expectFormatError(skill({}, body), /body must start with a # title/);
});

test("a body under 200 characters is refused", () => {
  expectFormatError(skill({}, "# Short\n\nToo short."), /body must be 200/);
});

test("a licence comment directly after the closing fence still leaves the # title first", () => {
  const licence = "<!-- Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):\n  .agents/skills/sample/SKILL.md\nModified for Perceev. See THIRD_PARTY_NOTICES.md. -->";
  const parsed = parseSkillFile(FILE, skill({}, `${licence}\n\n${BODY}`));
  assert.equal(parsed.body.split("\n")[0], "# Sample Skill");
});

test("the ported-skill licence comment is stripped from the served body", () => {
  const licence = "<!-- Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):\n  .agents/skills/sample/SKILL.md\nModified for Perceev. See THIRD_PARTY_NOTICES.md. -->";
  const parsed = parseSkillFile(FILE, skill({}, `${licence}\n\n${BODY}`));
  assert.ok(!parsed.body.includes("Portions ported"));
  assert.ok(parsed.body.startsWith("# Sample Skill"));
});
