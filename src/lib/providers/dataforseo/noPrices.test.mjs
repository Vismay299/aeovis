import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("no price constants appear in src/lib/providers/dataforseo", () => {
  const dir = "src/lib/providers/dataforseo";
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );

  assert.ok(files.length > 0, "Expected dataforseo implementation files to be present");

  const pricePattern = /\b(?:const|let|var)\s+([A-Za-z0-9_]*_USD)\s*=\s*[\d.]+/;

  const foundViolations = [];

  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(pricePattern);
      if (match) {
        foundViolations.push({
          file: `${file}:${i + 1}`,
          match: match[0],
        });
      }
    }
  }

  assert.deepEqual(
    foundViolations,
    [],
    `Found hardcoded price constants ending in _USD: ${JSON.stringify(foundViolations)}`,
  );
});
