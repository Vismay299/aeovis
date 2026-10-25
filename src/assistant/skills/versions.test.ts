import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK = JSON.parse(readFileSync(path.join(HERE, "versions.lock.json"), "utf8")) as Record<
  string,
  { version: string; sha256: string }
>;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function skillFiles(): Array<{ name: string; text: string }> {
  return readdirSync(HERE)
    .filter((entry) => existsSync(path.join(HERE, entry, "SKILL.md")))
    .sort()
    .map((entry) => ({
      name: entry,
      text: readFileSync(path.join(HERE, entry, "SKILL.md"), "utf8").replace(/\r\n/g, "\n"),
    }));
}

/** Reads the version from the frontmatter with a plain regex, independent of the parser. */
const versionOf = (text: string) => /^version: (\S+)$/m.exec(text)?.[1];

test("the lock records a hash for every skill, matching its current file", () => {
  for (const { name, text } of skillFiles()) {
    assert.ok(LOCK[name], `${name} has a lock entry`);
    assert.equal(LOCK[name].sha256, sha256(text), `bump the version of ${name} if its body changed`);
  }
});

test("the lock version matches the frontmatter version", () => {
  for (const { name, text } of skillFiles()) {
    assert.equal(LOCK[name].version, versionOf(text), name);
  }
});

// Semver compare by numeric part, so 10.0.0 sorts above 9.0.0 (a string compare would not).
const compare = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

test("semver compare is numeric: 10.0.0 is above 9.0.0", () => {
  assert.ok(compare("10.0.0", "9.0.0") > 0);
  assert.ok(compare("1.10.0", "1.9.0") > 0);
  assert.equal(compare("1.2.3", "1.2.3"), 0);
});

test("a lowered version is refused: the lock never moves backwards", () => {
  for (const { name, text } of skillFiles()) {
    assert.ok(compare(versionOf(text) ?? "", LOCK[name].version) >= 0, `${name} version must not go below the lock`);
  }
});
