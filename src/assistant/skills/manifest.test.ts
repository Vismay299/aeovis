import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_MANIFEST, SKILL_MANIFEST_FINGERPRINT } from "./manifest.generated.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SKILLS_DIR = HERE;

test("every skill folder equals its frontmatter name, and names are unique", () => {
  const folders = readdirSync(SKILLS_DIR).filter((entry) => existsSync(path.join(SKILLS_DIR, entry, "SKILL.md")));
  const names = SKILL_MANIFEST.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, "names are unique");
  assert.deepEqual([...folders].sort(), [...names].sort());
  for (const name of names) assert.match(name, /^[a-z][a-z0-9-]{2,40}$/, name);
});

test("descriptions stay within 1,024 characters and bodies within 24,000", () => {
  for (const entry of SKILL_MANIFEST) {
    assert.ok(entry.description.length <= 1024, entry.name);
    assert.ok(entry.body.length <= 24000, entry.name);
  }
});

test("the committed manifest equals a fresh build of the folder", () => {
  const output = execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-assistant-skills.mjs"), "--check"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(typeof output, "string");
});

test("the fingerprint is a sha256 hex digest", () => {
  assert.match(SKILL_MANIFEST_FINGERPRINT, /^[0-9a-f]{64}$/);
});

test("the lock covers every skill at its current version", () => {
  const lock = JSON.parse(readFileSync(path.join(SKILLS_DIR, "versions.lock.json"), "utf8")) as Record<string, { version: string }>;
  assert.deepEqual(Object.keys(lock).sort(), SKILL_MANIFEST.map((entry) => entry.name).sort());
  for (const entry of SKILL_MANIFEST) assert.equal(lock[entry.name].version, entry.version, entry.name);
});
