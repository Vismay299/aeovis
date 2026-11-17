import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function getSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getSourceFiles(fullPath));
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.mjs")) {
      files.push(fullPath);
    }
  }
  return files;
}

test("F20-AC-10: Search Console untouched static analysis", () => {
  const ga4LibDir = path.join(ROOT, "src/server/ga4");
  const ga4ApiDir = path.join(ROOT, "src/app/api/customer/ga4");

  const files = [...getSourceFiles(ga4LibDir), ...getSourceFiles(ga4ApiDir)];
  assert.ok(files.length > 0, "must find ga4 source files");

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const relPath = path.relative(ROOT, file).replace(/\\/g, "/");

    // Check imports from gsc
    const importRegex = /(?:from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1] || match[2];
      if (importPath.includes("gsc/")) {
        assert.ok(
          importPath.endsWith("oauthCrypto.js") || importPath.endsWith("oauthCrypto"),
          `File ${relPath} imports banned GSC module: ${importPath}`,
        );
      }
    }

    // Check no writes to gsc tables: .from("gsc_...").insert/.update/.delete/.upsert
    const gscWriteRegex = /\.from\(\s*["']gsc_[^"']*["']\s*\)\s*\.(insert|update|delete|upsert)/;
    assert.ok(
      !gscWriteRegex.test(content),
      `File ${relPath} contains write to gsc table: ${match?.[0]}`,
    );

    // Check no calls to GSC functions
    const gscFuncRegex = /\.(rpc\(\s*["']gsc_)/;
    assert.ok(
      !gscFuncRegex.test(content),
      `File ${relPath} calls gsc RPC function`,
    );
  }
});
