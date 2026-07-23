import test from "node:test";
import assert from "node:assert/strict";
import { resolveBrandKey } from "./brandKey.js";

test("resolveBrandKey — domain wins over brand name", () => {
  assert.equal(resolveBrandKey("Sleepy Owl Coffee", "sleepyowl.co"), "sleepyowl.co");
  assert.equal(resolveBrandKey("sleepy owl", "sleepyowl.co"), "sleepyowl.co");
  assert.equal(resolveBrandKey("SLEEPY OWL", "https://www.sleepyowl.co/shop"), "sleepyowl.co");
});

test("resolveBrandKey — same key regardless of brand casing/spacing", () => {
  const a = resolveBrandKey("Sleepy Owl", "https://sleepyowl.co");
  const b = resolveBrandKey("  sleepy owl coffee  ", "www.sleepyowl.co");
  assert.equal(a, b);
});

test("resolveBrandKey — falls back to normalized brand name without url", () => {
  assert.equal(resolveBrandKey("Sleepy Owl Coffee", ""), "sleepy owl coffee");
  assert.equal(resolveBrandKey("  Acme  ", null), "acme");
});

test("resolveBrandKey — unparseable url falls back to brand", () => {
  assert.equal(resolveBrandKey("Acme", "not a url at all::"), "acme");
});

test("resolveBrandKey — empty inputs give empty key", () => {
  assert.equal(resolveBrandKey("", ""), "");
  assert.equal(resolveBrandKey(null, undefined), "");
});
