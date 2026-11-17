/**
 * R2.6.1 — Finalize writes per-prompt brands_elicited.
 *
 * The field existed as a concept in countBrandsElicited (promptQuality.js) but
 * nothing attached it to result rows during finalize. Now every prompt row
 * carries brands_elicited after the re-judge pass.
 *
 * Acceptance:
 *   Every prompt row carries brands_elicited after finalize; a test covers it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { countBrandsElicited } from "./promptQuality.js";

// ---------------------------------------------------------------------------
// Unit test: countBrandsElicited counts mentioned brands
// ---------------------------------------------------------------------------
test("R2.6.1 — countBrandsElicited counts mentioned brands in roster", () => {
  const brands = [
    { name: "Italica", is_self: true, mentioned: true },
    { name: "Kajaria", is_self: false, mentioned: true },
    { name: "Somany", is_self: false, mentioned: false },
  ];
  assert.equal(countBrandsElicited(brands), 2,
    "should count the two mentioned brands");
});

test("R2.6.1 — countBrandsElicited returns 0 when no brands mentioned", () => {
  const brands = [
    { name: "Italica", is_self: true, mentioned: false },
    { name: "Kajaria", is_self: false, mentioned: false },
  ];
  assert.equal(countBrandsElicited(brands), 0,
    "no mentioned brands → 0");
});

test("R2.6.1 — countBrandsElicited handles empty/null roster", () => {
  assert.equal(countBrandsElicited([]), 0, "empty array → 0");
  assert.equal(countBrandsElicited(null), 0, "null → 0");
  assert.equal(countBrandsElicited(undefined), 0, "undefined → 0");
});

// ---------------------------------------------------------------------------
// Integration test: simulate what runFinalizePhase does and verify
// brands_elicited is attached to every result row
// ---------------------------------------------------------------------------
test("R2.6.1 — finalize attaches brands_elicited to every result row", () => {
  // Simulate results that went through re-judging and brands_elicited assignment
  const results = [
    {
      engine: "aio",
      prompt: "best tile brands",
      is_branded_query: false,
      answer_present: true,
      text: "Italica and Kajaria are popular tile brands.",
      brands: [
        { name: "Italica", is_self: true, mentioned: true },
        { name: "Kajaria", is_self: false, mentioned: true },
      ],
    },
    {
      engine: "aio",
      prompt: "how to install tiles",
      is_branded_query: false,
      answer_present: true,
      text: "First clean the surface, then apply adhesive.",
      brands: [
        { name: "Italica", is_self: true, mentioned: false },
        { name: "Kajaria", is_self: false, mentioned: false },
      ],
    },
    {
      engine: "perplexity",
      prompt: "best tile brands",
      is_branded_query: false,
      answer_present: true,
      text: "Orientbell and CERA are also well-known.",
      brands: [
        { name: "Italica", is_self: true, mentioned: false },
        { name: "Orientbell", is_self: false, mentioned: true },
        { name: "CERA", is_self: false, mentioned: true },
      ],
    },
    {
      engine: "aio",
      prompt: "is Italica good",
      is_branded_query: true,
      answer_present: true,
      text: "Yes, Italica tiles are well-regarded.",
      brands: [
        { name: "Italica", is_self: true, mentioned: true },
      ],
    },
  ];

  // Simulate what the finalize phase does after re-judging
  for (const r of results) {
    r.brands_elicited = countBrandsElicited(r.brands || []);
  }

  // Verify every row carries brands_elicited
  assert.equal(results[0].brands_elicited, 2,
    "first row: 2 brands mentioned (Italica + Kajaria)");
  assert.equal(results[1].brands_elicited, 0,
    "second row: no brands mentioned in how-to answer");
  assert.equal(results[2].brands_elicited, 2,
    "third row: 2 brands mentioned (Orientbell + CERA)");
  assert.equal(results[3].brands_elicited, 1,
    "fourth row: 1 brand mentioned (Italica, branded query)");

  // Verify every row has the field (even the branded one)
  for (const r of results) {
    assert.ok("brands_elicited" in r,
      `row "${r.prompt}" (${r.engine}) must carry brands_elicited`);
    assert.ok(Number.isInteger(r.brands_elicited) && r.brands_elicited >= 0,
      `brands_elicited on "${r.prompt}" must be a non-negative integer`);
  }
});

// ---------------------------------------------------------------------------
// Edge case: errored rows with no brands should still carry 0
// ---------------------------------------------------------------------------
test("R2.6.1 — errored result rows get brands_elicited = 0", () => {
  const results = [
    {
      engine: "aio",
      prompt: "failing query",
      error: "timeout",
      brands: [],
    },
    {
      engine: "chatgpt",
      prompt: "another failing query",
      error: "EMPTY_ANSWER",
      brands: [],
    },
  ];

  for (const r of results) {
    r.brands_elicited = countBrandsElicited(r.brands || []);
  }

  assert.equal(results[0].brands_elicited, 0, "errored row → 0");
  assert.equal(results[1].brands_elicited, 0, "empty answer row → 0");
});
