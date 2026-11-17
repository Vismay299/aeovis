import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");

const FORBIDDEN = [
  "providers/dataforseo/answers",
  "shared/engines/",
  "probeDispatch",
  "claim_probe_dispatch",
];

function filesUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...filesUnder(full));
      continue;
    }
    if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) continue;
    // The fence test names the forbidden strings; scanning itself would always fail.
    if (entry.name === "fence.test.ts") continue;
    out.push(full);
  }
  return out;
}

test("AC-28: no assistant or tool file imports the answer-engine fetcher, an engine adapter or the probe claim path", () => {
  const roots = [path.join(REPO, "src/server/assistant"), path.join(REPO, "src/server/tools")];
  const files = roots.flatMap(filesUnder);
  assert.ok(files.length >= 20, "the scan must cover both assistant and tool files");
  const violations: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const needle of FORBIDDEN) {
      if (text.includes(needle)) {
        violations.push(path.relative(REPO, file) + " references " + needle);
      }
    }
  }
  assert.deepEqual(violations, []);
});
