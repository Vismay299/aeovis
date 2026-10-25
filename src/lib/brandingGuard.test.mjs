import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Line-level exemptions permitted by F04-AC-15 and §8 P2.T6.S1
const ALLOWED_LINE_PATTERNS = [
  /every-app\/open-seo/i,
  /THIRD_PARTY/i,
  /openseo:/i, // Upstream spec/repository citation format per 00-CONVENTIONS.md §1
];

// Existing non-UI foundation files from prior waves that cite upstream logic in comments or test banned lists
const ALLOWED_FILES = new Set([
  "src/lib/brandingGuard.test.mjs",
  "src/assistant/skills/skillLint.test.ts",
  "src/lib/http/safeFetch.test.ts",
  "src/lib/jobs/stepConfigs.ts",
  "src/shared/ai-visibility-pricing.ts",
]);

test("GUARD (F04-AC-15) — no source file under src/ contains OpenSEO branding or theme names", () => {
  const output = execSync("git ls-files src", { cwd: REPO, encoding: "utf8" });
  const files = output
    .trim()
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  const offenders = [];

  for (const rel of files) {
    if (ALLOWED_FILES.has(rel)) continue;
    const fullPath = path.join(REPO, rel);
    let text;
    try {
      text = fs.readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }

    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (ALLOWED_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
        return;
      }
      if (/openseo/i.test(line)) {
        offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Found forbidden OpenSEO branding or theme names in src/:\n  ${offenders.join("\n  ")}`
  );
});
