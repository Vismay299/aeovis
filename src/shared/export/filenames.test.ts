import test from "node:test";
import assert from "node:assert/strict";
import { exportFilename } from "./filenames.ts";

test("exportFilename: formats lower-case parts with hyphens and perceev prefix", () => {
  assert.equal(
    exportFilename(["Acme Co", "scan", "x/y"]),
    "perceev-acme-co-scan-x-y",
  );
  assert.equal(
    exportFilename(["acme", "scan-history", "2026-10-21"]),
    "perceev-acme-scan-history-2026-10-21",
  );
});

test("exportFilename: handles empty parts", () => {
  assert.equal(exportFilename([]), "perceev");
  assert.equal(exportFilename(["", "   "]), "perceev");
});

test("exportFilename: clamps length at 120 characters without trailing hyphens", () => {
  const longPart = "a".repeat(150);
  const result = exportFilename([longPart]);
  assert.ok(result.length <= 120);
  assert.ok(result.startsWith("perceev-"));
  assert.ok(!result.endsWith("-"));
});
