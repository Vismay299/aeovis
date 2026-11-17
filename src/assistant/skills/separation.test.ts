import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const ASSISTANT_DIR = path.join(ROOT, "src", "assistant");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

function findSkillFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return findSkillFiles(full);
    return entry === "SKILL.md" ? [full] : [];
  });
}

test("nothing under src/assistant reads the content prompt folder", () => {
  for (const file of filesUnder(ASSISTANT_DIR).filter((candidate) => !candidate.endsWith(".test.ts"))) {
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes("content/skills"), `${path.relative(ROOT, file)} must not read src/shared/content/skills`);
  }
});

test("the content loader still reads only its own folder", () => {
  const loader = readFileSync(path.join(ROOT, "src", "shared", "content", "skills", "loader.js"), "utf8");
  assert.ok(loader.includes(`"src", "shared", "content", "skills"`));
  assert.ok(!loader.includes("assistant"));
});

test("no SKILL.md exists under src/shared/content", () => {
  assert.deepEqual(findSkillFiles(path.join(ROOT, "src", "shared", "content")), []);
});
