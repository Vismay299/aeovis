import test from "node:test";
import assert from "node:assert/strict";
import { INVISIBLE_CONTROL_RE, markUntrusted } from "./untrusted.ts";

test("marks concrete paths inside nested arrays", () => {
  const input = {
    answer: "A\u200bB",
    rows: [{ text: "one\u202e" }, { text: "two\ufeff" }],
    untouched: "safe",
  };
  const result = markUntrusted(input, ["answer", "rows[*].text"]);
  assert.deepEqual(result.output, {
    answer: "AB",
    rows: [{ text: "one" }, { text: "two" }],
    untouched: "safe",
  });
  assert.deepEqual(result.untrusted, ["answer", "rows[0].text", "rows[1].text"]);
  assert.equal(input.answer, "A\u200bB");
});

test("supports explicit numeric path segments and reports only strings found", () => {
  const result = markUntrusted({ rows: [{ text: "x\u200f" }, { text: null }] }, ["rows[0].text", "rows[1].text"]);
  assert.deepEqual(result.untrusted, ["rows[0].text"]);
  assert.equal((result.output as any).rows[0].text, "x");
});

test("invisible control expression removes the specified ranges", () => {
  assert.equal("a\u200b\u200f\u202a\u202e\u2060\u2064\ufeffb".replace(INVISIBLE_CONTROL_RE, ""), "ab");
});
