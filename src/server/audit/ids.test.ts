import test from "node:test";
import assert from "node:assert/strict";
import { deterministicUuid, deterministicAuditRowId } from "./ids.ts";

test("deterministicUuid produces stable RFC 9562 v8 UUIDs", () => {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  const id1 = deterministicUuid("a", "b");
  const id2 = deterministicUuid("a", "b");
  assert.equal(id1, id2, "Must be stable for identical inputs");
  assert.match(id1, uuidRegex, "Must match RFC 9562 v8 UUID format");

  const id3 = deterministicUuid("a", "c");
  assert.notEqual(id1, id3, "Different inputs must produce different UUIDs");
  assert.match(id3, uuidRegex);

  const alias = deterministicAuditRowId("a", "b");
  assert.equal(alias, id1);
});
