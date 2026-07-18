import test from "node:test";
import assert from "node:assert/strict";
import { robustJsonParse } from "./openrouter.js";

test("robustJsonParse - clean JSON array", () => {
  const result = robustJsonParse('[{"text":"a"},{"text":"b"}]');
  assert.deepEqual(result, [{ text: "a" }, { text: "b" }]);
});

test("robustJsonParse - clean JSON object", () => {
  const result = robustJsonParse('{"name":"Acme","domain":"acme.io"}');
  assert.deepEqual(result, { name: "Acme", domain: "acme.io" });
});

test("robustJsonParse - code-fenced JSON", () => {
  const result = robustJsonParse('```json\n[{"text":"a"}]\n```');
  assert.deepEqual(result, [{ text: "a" }]);
});

test("robustJsonParse - JSON embedded in prose", () => {
  const result = robustJsonParse(
    'Sure, here are the results:\n[{"text":"best crm"},{"text":"top tools"}]\nHope that helps!'
  );
  assert.deepEqual(result, [{ text: "best crm" }, { text: "top tools" }]);
});

test("robustJsonParse - prose-wrapped object with nested braces", () => {
  const result = robustJsonParse(
    'Here you go: {"name":"Acme","meta":{"score":1}} — let me know if you need more.'
  );
  assert.deepEqual(result, { name: "Acme", meta: { score: 1 } });
});

test("robustJsonParse - truncated JSON with no balanced structure returns null", () => {
  const result = robustJsonParse('[{"text":"a"');
  assert.equal(result, null);
});

test("robustJsonParse - garbage / non-JSON returns null", () => {
  assert.equal(robustJsonParse("not json at all"), null);
  assert.equal(robustJsonParse(""), null);
  assert.equal(robustJsonParse(null), null);
  assert.equal(robustJsonParse(undefined), null);
});
