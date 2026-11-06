// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/csv.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { buildCsv, buildExcelCsv } from "./csv.ts";

test("buildCsv: rounds decimal numbers to at most two places", () => {
  const csv = buildCsv(
    ["Page", "Traffic", "Keywords"],
    [["/tools", 1250.321954, 4]],
  );

  assert.ok(csv.includes('"1250.32"'));
  assert.ok(csv.includes('"4"'));
});

test("buildCsv: keeps formula-injection protection for string cells", () => {
  const csv = buildCsv(
    ["Value"],
    [['=HYPERLINK("evil")'], ["+1"], ["@SUM(A1)"], ["\tformula"]],
  );

  assert.ok(csv.includes('"\'=HYPERLINK(""evil"")"'));
  assert.ok(csv.includes('"\'+1"'));
  assert.ok(csv.includes('"\'@SUM(A1)"'));
  assert.ok(csv.includes('"\'\tformula"'));
});

test("buildExcelCsv: starts with UTF-8 BOM", () => {
  const excelCsv = buildExcelCsv(
    ["Keyword", "Volume"],
    [["seo audit", 1200]],
  );

  assert.ok(excelCsv.startsWith("\ufeff"));
  assert.equal(
    excelCsv.slice(1),
    buildCsv(["Keyword", "Volume"], [["seo audit", 1200]]),
  );
});
