// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/table/nullSafeSort.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { compareNumericNullsLast } from "./nullSafeSort.ts";

test("compareNumericNullsLast: keeps nulls and undefined last in ascending sort", () => {
  assert.ok(compareNumericNullsLast(10, null, false) < 0);
  assert.ok(compareNumericNullsLast(null, 10, false) > 0);
  assert.ok(compareNumericNullsLast(10, undefined, false) < 0);
  assert.ok(compareNumericNullsLast(undefined, 10, false) > 0);
});

test("compareNumericNullsLast: keeps nulls and undefined last in descending sort", () => {
  // When descending is true, TanStack inverts the comparison result.
  // Our comparator applies sign adjustment so nulls remain at the bottom after inversion.
  assert.ok(compareNumericNullsLast(10, null, true) > 0);
  assert.ok(compareNumericNullsLast(null, 10, true) < 0);
  assert.ok(compareNumericNullsLast(10, undefined, true) > 0);
  assert.ok(compareNumericNullsLast(undefined, 10, true) < 0);
});

test("compareNumericNullsLast: treats two nulls or undefined as equal", () => {
  assert.equal(compareNumericNullsLast(null, null, false), 0);
  assert.equal(compareNumericNullsLast(null, undefined, false), 0);
  assert.equal(compareNumericNullsLast(undefined, null, true), 0);
  assert.equal(compareNumericNullsLast(undefined, undefined, true), 0);
});

test("compareNumericNullsLast: compares normal numbers correctly", () => {
  assert.ok(compareNumericNullsLast(5, 10, false) < 0);
  assert.ok(compareNumericNullsLast(10, 5, false) > 0);
  assert.equal(compareNumericNullsLast(7, 7, false), 0);
});
