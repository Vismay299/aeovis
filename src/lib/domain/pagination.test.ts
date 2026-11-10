import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeHasMore } from "./pagination.ts";

describe("computeHasMore", () => {
  const cases: Array<[number, number, number | null | undefined, number, boolean]> = [
    // offset, fetched, totalCount, pageSize, expected
    [0, 100, 250, 100, true],
    [200, 50, 250, 100, false],
    // A full last page: fetched count reaches totalCount exactly.
    [0, 100, 100, 100, false],
    // Unknown total: fall back to "was the page full".
    [0, 100, null, 100, true],
    [0, 100, undefined, 100, true],
    [100, 40, null, 100, false],
  ];

  for (const [offset, fetched, totalCount, pageSize, expected] of cases) {
    it(`computeHasMore(${offset}, ${fetched}, ${totalCount}, ${pageSize}) is ${expected}`, () => {
      assert.equal(computeHasMore(offset, fetched, totalCount, pageSize), expected);
    });
  }
});
