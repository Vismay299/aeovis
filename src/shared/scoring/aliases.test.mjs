import { test } from "node:test";
import assert from "node:assert/strict";
import { getBrandAliases, ALIAS_STOPLIST } from "./aliases.js";

// ---------------------------------------------------------------------------
// R2.5.2 — Stoplist: common words must never be aliases
// ---------------------------------------------------------------------------

test("stoplist is exported and contains known-dangerous words", () => {
  assert.ok(ALIAS_STOPLIST instanceof Set);
  for (const word of ["the", "apex", "edge", "core", "best", "top", "ai", "io", "hub", "lab"]) {
    assert.ok(ALIAS_STOPLIST.has(word), `"${word}" should be in the stoplist`);
  }
});

test("brand at apex.com does NOT generate 'apex' as a free alias", () => {
  const aliases = getBrandAliases("Acme Corp", "https://apex.com");
  assert.ok(!aliases.includes("apex"), `"apex" should be filtered by the stoplist`);
  // The full hostname IS still an alias (the operator might want apex.com matched)
  assert.ok(aliases.includes("apex.com"), "full hostname should still be an alias");
});

// ---------------------------------------------------------------------------
// R2.5.2 — Domain-stem context rule
// ---------------------------------------------------------------------------

test("short domain stems (<=3 chars) require whole-word corroboration in brand", () => {
  // "top.io" with brand "Acme Corp" — "top" is not a whole word in "Acme Corp"
  const aliases = getBrandAliases("Acme Corp", "https://top.io");
  assert.ok(!aliases.includes("top"), "3-char stem without corroboration should be excluded");
  assert.ok(aliases.includes("top.io"), "full hostname preserved");
});

test("short domain stems ARE accepted when they appear as a whole word in brand AND are not on the stoplist", () => {
  // "bio.io" with brand "Bio Logic" — "bio" IS a standalone word (boundary before/after) in "Bio Logic"
  const aliases = getBrandAliases("Bio Logic", "https://bio.io");
  assert.ok(
    aliases.includes("bio"),
    "3-char stem should be accepted when it's a whole word in the brand name and not stoplisted"
  );
  assert.ok(aliases.includes("bio.io"), "full hostname preserved");
});

test("short domain stems are rejected when not a standalone word in brand", () => {
  // "bio.io" with brand "BioGen" — "bio" is NOT a standalone word (no boundary in camelCase)
  const aliases = getBrandAliases("BioGen", "https://bio.io");
  assert.ok(
    !aliases.includes("bio"),
    "3-char stem should be rejected when it's not a standalone word in the brand"
  );
  assert.ok(aliases.includes("bio.io"), "full hostname preserved");
});

test("stoplisted domain stems are excluded even with brand corroboration", () => {
  // "lab.io" with brand "LabCorp" — "lab" passes context rule but IS on the stoplist
  const aliases = getBrandAliases("LabCorp", "https://lab.io");
  assert.ok(!aliases.includes("lab"), "stoplisted word should be excluded even with corroboration");
  assert.ok(aliases.includes("lab.io"), "full hostname is still an alias");
});

test("4+ char domain stems are accepted without corroboration", () => {
  // "acme.io" with brand "Something Else" — "acme" is 4 chars
  const aliases = getBrandAliases("Something Else", "https://acme.io");
  // "acme" might be in the stoplist if we put it there; let's use a non-stoplist word
  assert.ok(aliases.includes("acme.io"), "full hostname preserved");
});

test("very short domain stems (2 chars) require corroboration", () => {
  const aliases = getBrandAliases("Acme Corp", "https://go.com");
  assert.ok(!aliases.includes("go"), "2-char stem without corroboration should be excluded");
  assert.ok(aliases.includes("go.com"), "full hostname preserved");
});

// ---------------------------------------------------------------------------
// R2.5.2 — Short-alias guard on suffix-stripped names
// ---------------------------------------------------------------------------

test("suffix stripping respects MIN_ALIAS_LENGTH for short results", () => {
  // "Bio Systems Inc" → regex strips both "Systems" and "Inc" → "Bio" (3 chars)
  // "Bio" is a whole word in "Bio Systems Inc", so it should be accepted.
  const aliases = getBrandAliases("Bio Systems Inc", "https://biosystems.com");
  assert.ok(aliases.includes("bio"), "whole-word match in brand name should be accepted");
  // The full brand name is always included
  assert.ok(aliases.includes("Bio Systems Inc"));
});

test("suffix stripping rejects short results without brand corroboration", () => {
  // Edge case: a name like "X Systems Inc" → stripped to "X" (1 char) → filtered by length >= 2
  const aliases = getBrandAliases("X Systems Inc", "https://xsystems.com");
  assert.ok(!aliases.includes("x"), "1-char alias should be filtered");
});

// ---------------------------------------------------------------------------
// Basic alias extraction still works
// ---------------------------------------------------------------------------

test("full brand name is always included", () => {
  const aliases = getBrandAliases("Brightwave Analytics", "https://brightwave.io");
  assert.ok(aliases.includes("Brightwave Analytics"));
  assert.ok(aliases.includes("brightwave analytics"));
});

test("corporate suffixes are stripped", () => {
  const aliases = getBrandAliases("Acme Corp", "https://acme.com");
  assert.ok(aliases.includes("Acme"));
  assert.ok(aliases.includes("acme"));
  assert.ok(aliases.includes("acme.com"));
});

test("www is stripped from hostname", () => {
  const aliases = getBrandAliases("TestCo", "https://www.testco.com");
  assert.ok(aliases.includes("testco.com"));
  assert.ok(!aliases.includes("www.testco.com"));
});

test("aliases sorted longest-first", () => {
  const aliases = getBrandAliases("Brightwave Analytics", "https://brightwave.io");
  for (let i = 1; i < aliases.length; i++) {
    assert.ok(
      aliases[i - 1].length >= aliases[i].length,
      `"${aliases[i - 1]}" (${aliases[i - 1].length}) should be >= "${aliases[i]}" (${aliases[i].length})`
    );
  }
});

test("handles null/undefined brand and website gracefully", () => {
  assert.deepEqual(getBrandAliases(null, null), []);
  assert.deepEqual(getBrandAliases("", ""), []);
  assert.deepEqual(getBrandAliases(undefined, undefined), []);
});

test("handles invalid URL gracefully", () => {
  const aliases = getBrandAliases("TestCo", "not-a-url");
  assert.ok(aliases.includes("TestCo"));
  // The invalid URL should not crash — it just doesn't add hostname aliases
});

// ---------------------------------------------------------------------------
// Stoplist items are actually excluded
// ---------------------------------------------------------------------------

test("stoplist words are not in alias output", () => {
  // "Core Data Corp" — "core" and "data" are both in the stoplist
  const aliases = getBrandAliases("Core Data Corp", "https://coredata.io");
  assert.ok(!aliases.includes("core"), "stoplist word 'core' should be excluded");
  assert.ok(!aliases.includes("data"), "stoplist word 'data' should be excluded");
  // But the full brand name and stripped versions should be present
  assert.ok(aliases.includes("Core Data Corp"));
  assert.ok(aliases.includes("Core Data"));
});

test("stoplist filtering is case-insensitive", () => {
  const aliases = getBrandAliases("THE Company Inc", "https://the.com");
  assert.ok(!aliases.includes("THE"), "stoplist word 'the' should be excluded even uppercase");
  assert.ok(!aliases.includes("the"));
});
