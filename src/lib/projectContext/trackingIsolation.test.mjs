import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const extensions = new Set([".js", ".mjs", ".ts", ".tsx", ".jsx"]);
const trackedRoots = [
  "src/lib/workers",
  "src/lib/scoring",
  "src/lib/engines",
  "src/app/api/customer/scan",
];

async function sourceFiles(root) {
  let entries;
  try {
    entries = await readdir(path.join(REPO, root), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relative = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(relative));
    else if (extensions.has(path.extname(entry.name))) files.push(relative);
  }
  return files;
}

test("tracking and scan paths do not import project memory", async () => {
  const offenders = [];
  for (const file of (await Promise.all(trackedRoots.map(sourceFiles))).flat()) {
    const source = await readFile(path.join(REPO, file), "utf8");
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g);
    for (const [, specifier] of imports) {
      if (specifier.includes("projectContext")) offenders.push(`${file}: ${specifier}`);
    }
  }
  assert.deepEqual(offenders, [], `tracking paths must not depend on project memory:\n${offenders.join("\n")}`);
});

test("customer scan competitors come only from the request body", async () => {
  const routePath = path.join(REPO, "src/app/api/customer/scan/route.js");
  const route = await readFile(routePath, "utf8");
  assert.match(route, /const\s+competitors\s*=\s*\(?\s*body\?\.competitors\s*\|\|\s*""\s*\)?\.trim\(\)/);
  const createScanJobCall = route.match(/createScanJob\s*\(\s*\{([\s\S]*?)\}\s*\)/)?.[1];
  assert.ok(createScanJobCall, "scan route must keep a createScanJob call");
  assert.match(createScanJobCall, /\bcompetitors\s*,/);
  assert.doesNotMatch(createScanJobCall, /projectContext|declaredCompetitors/);
});
