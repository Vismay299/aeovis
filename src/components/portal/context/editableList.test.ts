import test from "node:test";
import assert from "node:assert/strict";
import { nextEditingId, listClass } from "./editableList.ts";

test("nextEditingId opens target when nothing is currently editing", () => {
  assert.equal(nextEditingId(null, "add"), "add");
  assert.equal(nextEditingId(null, "item-1"), "item-1");
});

test("nextEditingId toggles closed when target matches current", () => {
  assert.equal(nextEditingId("add", "add"), null);
  assert.equal(nextEditingId("item-1", "item-1"), null);
});

test("nextEditingId switches to new target when different item is selected", () => {
  assert.equal(nextEditingId("add", "item-1"), "item-1");
  assert.equal(nextEditingId("item-1", "item-2"), "item-2");
  assert.equal(nextEditingId("item-1", "add"), "add");
});

test("nextEditingId explicitly closes when target is null", () => {
  assert.equal(nextEditingId("item-1", null), null);
  assert.equal(nextEditingId(null, null), null);
});

test("listClass provides expected container styling tokens", () => {
  assert.ok(listClass.includes("rounded-lg"));
  assert.ok(listClass.includes("border"));
});
