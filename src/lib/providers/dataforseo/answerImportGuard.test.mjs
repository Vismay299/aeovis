import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createDataforseoClient } from "./client.ts";

function walkDir(dir, filter, out = []) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (
      entry === "node_modules" ||
      entry === ".next" ||
      entry.startsWith(".env") ||
      entry.startsWith(".")
    ) {
      continue;
    }
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkDir(full, filter, out);
    } else if (st.isFile() && filter(full)) {
      out.push(full);
    }
  }
  return out;
}

function normalizePath(p) {
  return p.split(path.sep).join("/");
}

function isAllowedAnswerImporter(relPath) {
  const norm = normalizePath(relPath);
  if (norm.startsWith("src/lib/providers/dataforseo/")) return true;
  if (norm === "src/lib/engines/dataforseo.ts") return true;
  if (norm === "scripts/qa/check-dataforseo-bakeoff.mjs") return true;
  if (norm === "scripts/qa/check-dataforseo-live.mjs") return true;
  return false;
}

test("answer fetchers are imported only by allowed F02 engine/provider modules", () => {
  const codeFiles = [
    ...walkDir("src", (p) => /\.(ts|js|mjs|tsx|jsx)$/.test(p)),
    ...walkDir("scripts", (p) => /\.(ts|js|mjs|tsx|jsx)$/.test(p)),
  ];

  const violations = [];

  // Static `from "x"`, side-effect `import "x"` and dynamic `import("x")`.
  const importTargetRe = /(?:\bfrom\s+|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;
  const answerModule = /(?:^|\/)(?:ai-tracking|answers)(?:\.(?:ts|js|mjs))?$/;
  const fetchLlmImportRe = /\b(?:import|export)\s+[^'"]*\bfetchLlmResponse\b[^'"]*from/g;

  for (const file of codeFiles) {
    const norm = normalizePath(file);
    if (norm.endsWith("answerImportGuard.test.mjs")) continue;

    const content = readFileSync(file, "utf8");

    // Check imports from ai-tracking or answers
    let match;
    importTargetRe.lastIndex = 0;
    while ((match = importTargetRe.exec(content)) !== null) {
      const specifier = match[1];
      if (answerModule.test(specifier)) {
        if (!isAllowedAnswerImporter(norm)) {
          violations.push({ file: norm, specifier, reason: "imported answer module" });
        }
      }
    }

    // Check import of fetchLlmResponse
    fetchLlmImportRe.lastIndex = 0;
    if (fetchLlmImportRe.test(content)) {
      if (!isAllowedAnswerImporter(norm)) {
        violations.push({ file: norm, reason: "imported fetchLlmResponse" });
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Forbidden import of answer fetchers found outside allowed modules: ${JSON.stringify(violations)}`,
  );
});

test("createDataforseoClient does not expose answer fetchers", () => {
  const client = createDataforseoClient();
  const keys = Object.keys(client);
  assert.equal(keys.includes("answers"), false);
  assert.equal(keys.includes("postAiTrackingTasks"), false);
  assert.equal(keys.includes("fetchAiTrackingLiveAnswer"), false);
  assert.equal(keys.includes("fetchLlmResponse"), false);

  if ("serp" in client) {
    const serpKeys = Object.keys(client.serp);
    assert.equal(serpKeys.includes("fetchAiTrackingLiveAnswer"), false);
  }
  if ("aiSearch" in client) {
    const aiKeys = Object.keys(client.aiSearch);
    assert.equal(aiKeys.includes("fetchLlmResponse"), false);
    assert.equal(aiKeys.includes("postAiTrackingTasks"), false);
  }
});

test("no F02 files contain set_probe_rollout or probe_dispatch_control", () => {
  const f02Files = [
    ...walkDir("src/lib/providers/dataforseo", (p) => /\.(ts|js|mjs)$/.test(p)),
    ...walkDir("scripts/qa", (p) => /check-dataforseo.*\.(ts|js|mjs)$/.test(p)),
  ];

  const forbiddenRollout = "set_" + "probe_rollout";
  const forbiddenControl = "probe_" + "dispatch_control";

  const violations = [];

  for (const file of f02Files) {
    const norm = normalizePath(file);
    if (norm.endsWith("answerImportGuard.test.mjs")) continue;

    const content = readFileSync(file, "utf8");
    if (content.includes(forbiddenRollout)) {
      violations.push({ file: norm, forbidden: forbiddenRollout });
    }
    if (content.includes(forbiddenControl)) {
      violations.push({ file: norm, forbidden: forbiddenControl });
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Found forbidden rollout/dispatch-control strings in F02 files: ${JSON.stringify(violations)}`,
  );
});
