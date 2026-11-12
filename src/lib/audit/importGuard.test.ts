import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FORBIDDEN = [
  "providers/dataforseo/answers", "claim_probe_dispatch", "enginePipeline", "scanWorker", "gemini", "llm/",
];

function filesUnder(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(full));
    else if (/\.(?:[cm]?[jt]s|tsx?)$/.test(entry.name)) result.push(full);
  }
  return result;
}

test("audit modules and routes import no answer-engine or LLM pipeline modules", () => {
  const roots = [path.join(REPO, "src/lib/audit"), path.join(REPO, "src/app/api/customer/audit")];
  const importPattern = /(?:\bfrom\s*|\bimport\s*\()\s*["']([^"']+)["']/g;
  const problems: string[] = [];
  for (const root of roots) {
    for (const file of filesUnder(root)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1] ?? "";
        if (FORBIDDEN.some((part) => specifier.toLowerCase().includes(part.toLowerCase()))) {
          problems.push(`${path.relative(REPO, file)} imports ${specifier}`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("only the Lighthouse and rendering adapters import provider clients", () => {
  const roots = [path.join(REPO, "src/lib/audit"), path.join(REPO, "src/app/api/customer/audit")];
  const importPattern = /(?:\bfrom\s*|\bimport\s*\()\s*["']([^"']+)["']/g;
  const providers: string[] = [];
  for (const root of roots) {
    for (const file of filesUnder(root)) {
      const source = readFileSync(file, "utf8");
      if (["renderedPage.ts", "lighthouse.ts"].includes(path.basename(file))) continue;
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1] ?? "";
        if (/firecrawl|dataforseo/i.test(specifier)) providers.push(`${path.relative(REPO, file)} imports ${specifier}`);
      }
    }
  }
  assert.deepEqual(providers, []);
});
