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
  // F09: the customer scan route hands the job insert to this shared start.
  "src/lib/pricing/startCustomerScan.ts",
];

async function sourceFiles(root) {
  if (extensions.has(path.extname(root))) return [root];
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
  // The route reads competitors from the body and hands them to the shared
  // start as `legacy.competitors`; the start passes exactly that to the job
  // insert. Neither file may source them from project memory.
  const route = await readFile(path.join(REPO, "src/app/api/customer/scan/route.js"), "utf8");
  assert.match(route, /const\s+competitors\s*=\s*\(?\s*body\?\.competitors\s*\|\|\s*""\s*\)?\.trim\(\)/);
  const legacy = route.match(/legacy\s*:\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(legacy, "scan route must hand the body's fields to startCustomerScan as `legacy`");
  assert.match(legacy, /\bcompetitors\s*,/);
  assert.doesNotMatch(route, /projectContext|declaredCompetitors/);

  const start = await readFile(path.join(REPO, "src/lib/pricing/startCustomerScan.ts"), "utf8");
  const createScanJobCall = start.match(/createJobFn\s*\(\s*\{([\s\S]*?)\}\s*\)/)?.[1];
  assert.ok(createScanJobCall, "startCustomerScan must keep its createScanJob call");
  assert.match(createScanJobCall, /\bcompetitors\s*:\s*\(\s*args\.legacy\?\.competitors\s*\|\|\s*""\s*\)\.trim\(\)/);
  assert.doesNotMatch(createScanJobCall, /projectContext|declaredCompetitors/);
});
