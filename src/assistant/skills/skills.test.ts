import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_NAMES } from "../../lib/tools/names.ts";
import { PERCEEV_SURFACE_NOTE, getSkillVersion, listSkills, loadSkill, skillCatalogFingerprint } from "./index.ts";
import { SKILL_MANIFEST_FINGERPRINT } from "./manifest.generated.ts";
import type { SkillManifestEntry } from "./types.ts";

function entry(overrides: Partial<SkillManifestEntry> & { name: string }): SkillManifestEntry {
  const { name } = overrides;
  return {
    description: "A fixture skill used to test the loader filters and load behaviour.",
    version: "1.0.0",
    source: "perceev",
    tools: ["get_project_context"],
    optionalTools: [],
    requiresFlags: [],
    internal: false,
    sha256: "0".repeat(64),
    title: `Title ${name}`,
    body: `# Title\n\nBody for ${name}.`,
    ...overrides,
    name,
  };
}

const ALL = new Set(["get_project_context", "list_scans", "run_scan"]);
const ON = { availableTools: ALL, enabled: true };

test("internal skills are never listed", () => {
  const manifest = [entry({ name: "hidden-one", internal: true }), entry({ name: "visible-one" })];
  assert.deepEqual(listSkills(ON, { manifest }).map((s) => s.name), ["visible-one"]);
});

test("a skill is hidden when a required tool is unavailable", () => {
  const manifest = [entry({ name: "needs-scan", tools: ["get_project_context", "run_scan", "missing_tool"] })];
  assert.deepEqual(listSkills(ON, { manifest }), []);
});

test("an unavailable optional tool does not hide a skill", () => {
  const manifest = [entry({ name: "has-optional", optionalTools: ["missing_tool"] })];
  assert.deepEqual(listSkills(ON, { manifest }).map((s) => s.name), ["has-optional"]);
});

test("a required flag that is false hides the skill", () => {
  const manifest = [entry({ name: "flagged", requiresFlags: ["report_export"] })];
  assert.deepEqual(listSkills({ ...ON, flags: { report_export: false } }, { manifest }), []);
  assert.deepEqual(
    listSkills({ ...ON, flags: { report_export: true } }, { manifest }).map((s) => s.name),
    ["flagged"]
  );
});

test("enabled false returns no skills and no skill", () => {
  const manifest = [entry({ name: "visible-one" })];
  assert.deepEqual(listSkills({ ...ON, enabled: false }, { manifest }), []);
  assert.equal(loadSkill("visible-one", { ...ON, enabled: false }, { manifest }), null);
});

test("listed skills are sorted by name", () => {
  const manifest = [entry({ name: "zeta-skill" }), entry({ name: "alpha-skill" }), entry({ name: "mid-skill" })];
  assert.deepEqual(
    listSkills(ON, { manifest }).map((s) => s.name),
    ["alpha-skill", "mid-skill", "zeta-skill"]
  );
});

// F21-AC-07: with every declared tool available the served catalog is exactly the 14 names of
// §6.2.5, in the order the loader's plain string sort produces.
test("with every declared tool available the served list is exactly the 14 names of §6.2.5", () => {
  const names = listSkills({ availableTools: new Set<string>(TOOL_NAMES), enabled: true }).map((s) => s.name);
  assert.deepEqual(names, [
    "ai-crawler-fix",
    "ai-prompt-research",
    "ai-visibility-audit",
    "competitive-landscape",
    "competitor-analysis",
    "content-brief",
    "keyword-clustering",
    "keyword-research",
    "link-prospecting",
    "local-seo",
    "question-panel-review",
    "seo-audit",
    "seo-coach",
    "seo-project-setup",
  ]);
  assert.ok(!names.includes("seo-report"), "seo-report is absent until F23 adds it");
});

test("loadSkill prepends the surface note to the body and keeps the version", () => {
  const manifest = [entry({ name: "visible-one", version: "2.1.0" })];
  const loaded = loadSkill("visible-one", ON, { manifest });
  assert.ok(loaded);
  assert.equal(loaded.version, "2.1.0");
  assert.ok(loaded.body.startsWith(PERCEEV_SURFACE_NOTE));
  assert.ok(loaded.body.endsWith("Body for visible-one."));
});

test("loadSkill returns null for an unknown name or a hidden one", () => {
  const manifest = [entry({ name: "hidden-one", internal: true }), entry({ name: "needs-scan", tools: ["missing_tool"] })];
  assert.equal(loadSkill("no-such-skill", ON, { manifest }), null);
  assert.equal(loadSkill("hidden-one", ON, { manifest }), null);
  assert.equal(loadSkill("needs-scan", ON, { manifest }), null);
});

test("the catalog fingerprint changes when a version changes", () => {
  const a = skillCatalogFingerprint([{ name: "x-skill", title: "X", description: "d", version: "1.0.0" }]);
  const b = skillCatalogFingerprint([{ name: "x-skill", title: "X", description: "d", version: "1.0.1" }]);
  assert.notEqual(a, b);
});

test("a flagged skill stays hidden when the caller passes no flags object", () => {
  const manifest = [entry({ name: "flagged", requiresFlags: ["report_export"] })];
  assert.deepEqual(listSkills(ON, { manifest }), []);
  assert.equal(loadSkill("flagged", ON, { manifest }), null);
});

test("getSkillVersion reports the version of a hidden skill, and null for an unknown name", () => {
  const manifest = [entry({ name: "hidden-one", internal: true, version: "3.2.1" })];
  assert.equal(getSkillVersion("hidden-one", { manifest }), "3.2.1");
  assert.equal(getSkillVersion("no-such-skill", { manifest }), null);
});

test("the manifest fingerprint is a stable sha256 digest of the entries", () => {
  assert.match(SKILL_MANIFEST_FINGERPRINT, /^[0-9a-f]{64}$/);
});
