import test from "node:test";
import assert from "node:assert/strict";
import { serverCsv, serverCsvCell } from "./serverCsv.ts";

test("serverCsvCell quotes every cell and doubles inner quotes", () => {
  assert.equal(serverCsvCell('say "hi"'), '"say ""hi"""');
  assert.equal(serverCsvCell(null), '""');
  assert.equal(serverCsvCell(undefined), '""');
  assert.equal(serverCsvCell(0), '"0"');
});

test("serverCsvCell guards leading whitespace before a formula character", () => {
  assert.equal(serverCsvCell("  =SUM(A1)"), `"'  =SUM(A1)"`);
  assert.equal(serverCsvCell("\t+1"), `"'\t+1"`);
  assert.equal(serverCsvCell("\r-1"), `"'\r-1"`);
  assert.equal(serverCsvCell("\n@x"), `"'\n@x"`);
});

test("serverCsv joins lines with CRLF and keeps header order", () => {
  const csv = serverCsv(["a", "b"], [[1, "x"], [null, "y"]]);
  assert.equal(csv, '"a","b"\r\n"1","x"\r\n"","y"');
  assert.equal(csv.split("\r\n").length, 3);
});
