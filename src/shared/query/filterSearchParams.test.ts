// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/filterSearchParams.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import {
  isTextField,
  filterValuesFromSearch,
  filterValuesToSearch,
  normalizeFilterValues,
} from "./filterSearchParams.ts";

test("isTextField: defaults to include and exclude", () => {
  assert.equal(isTextField("include"), true);
  assert.equal(isTextField("exclude"), true);
  assert.equal(isTextField("minVol"), false);
  assert.equal(isTextField("custom", ["custom", "other"]), true);
  assert.equal(isTextField("include", ["custom"]), false);
});

test("filterValuesToSearch: numeric parsing, text preservation, empty string becomes undefined", () => {
  const converted = filterValuesToSearch({
    minVol: "10.",
    include: " a ",
    emptyField: "   ",
    notANumber: "abc",
  });

  assert.deepEqual(converted, {
    minVol: 10,
    include: "a",
    emptyField: undefined,
    notANumber: undefined,
  });
});

test("filterValuesFromSearch: fills values from search with string conversion", () => {
  const empty = { minVol: "", include: "", missing: "" };
  const search = { minVol: 100, include: "target" };
  const values = filterValuesFromSearch(search, empty);

  assert.deepEqual(values, {
    minVol: "100",
    include: "target",
    missing: "",
  });
});

test("normalizeFilterValues: round trips properly (e.g. 10. becomes 10)", () => {
  const empty = { minVol: "", include: "" };
  const normalized = normalizeFilterValues(
    { minVol: "10.", include: "  hello  " },
    empty
  );

  assert.deepEqual(normalized, {
    minVol: "10",
    include: "hello",
  });
});
