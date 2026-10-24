import test from "node:test";
import assert from "node:assert/strict";
import { globSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R0.4.3 (finding S29) — the glob must reach every test file.
 *
 * The package.json `test:scoring` script used to list eight hand-maintained
 * directory globs. Two directories were never added: src/components and
 * src/services. Fifty-seven tests lived there, uncollected, and one of them
 * (chartMath's neutralRampVar assertion) had been FAILING since the design
 * system was ported — a red test nobody could see, because nothing ran it.
 *
 * A green suite is only evidence if the suite runs everything. This is the
 * test that makes that claim checkable, and it lives in the suite rather than
 * in the CI workflow so it fails on a developer's machine too.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Every *.test.mjs or *.test.ts under src/, found without reference to any glob. */
async function testFilesOnDisk(dir = path.join(REPO, "src"), acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await testFilesOnDisk(full, acc);
    // Normalised to forward slashes to match collectedByScript: on Windows
    // path.relative yields backslashes, so every file read as orphaned and the
    // guard failed on a suite it had in fact collected in full.
    else if (entry.name.endsWith(".test.mjs") || entry.name.endsWith(".test.ts"))
      acc.push(path.relative(REPO, full).split(path.sep).join("/"));
  }
  return acc;
}

/** The file arguments the `test:scoring` script hands to `node --test`. */
function collectedByScript(script) {
  const patterns = [...script.matchAll(/(?:"([^"]+)"|'([^']+)'|(\S*\*\S*))/g)]
    .map((m) => m[1] ?? m[2] ?? m[3])
    .filter((p) => p && p.includes("*") && !p.startsWith("-"));
  const seen = new Set();
  for (const pattern of patterns) {
    for (const file of globSync(pattern, { cwd: REPO })) seen.add(file.split(path.sep).join("/"));
  }
  return [...seen];
}

test("GUARD — the test:scoring glob collects every *.test.mjs and *.test.ts under src/", async () => {
  const pkg = JSON.parse(await readFile(path.join(REPO, "package.json"), "utf8"));
  const script = pkg.scripts["test:scoring"];
  assert.ok(script, "package.json must still define test:scoring");

  const onDisk = (await testFilesOnDisk()).sort();
  const collected = collectedByScript(script).sort();

  assert.ok(onDisk.length > 40, `the walker must find the suite, found ${onDisk.length}`);

  const orphaned = onDisk.filter((f) => !collected.includes(f));
  assert.deepEqual(
    orphaned,
    [],
    `these test files exist but the test:scoring glob (*.test.mjs, *.test.ts) does not collect them, ` +
      `so nothing runs them:\n  ` +
      orphaned.join("\n  ")
  );
});

test("GUARD — `npm test` runs the same set as `npm run test:scoring`", async () => {
  // Two entry points that disagree is how a file ends up orphaned from one of
  // them without anyone noticing.
  const pkg = JSON.parse(await readFile(path.join(REPO, "package.json"), "utf8"));
  assert.equal(
    collectedByScript(pkg.scripts.test || "").sort().join("|"),
    collectedByScript(pkg.scripts["test:scoring"]).sort().join("|")
  );
});

test("GUARD — CI runs the suite on push and never swallows a red test", async () => {
  const raw = await readFile(path.join(REPO, ".github/workflows/ci.yml"), "utf8");
  // Strip comment lines before looking for escape hatches — a comment saying
  // "no `|| true` here" must not read as an escape hatch itself.
  const workflow = raw
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.match(workflow, /^on:\s*$/m, "must declare triggers");
  assert.match(workflow, /^\s+push:\s*$/m, "must run on push");
  assert.match(workflow, /npm run test:scoring/, "must run the suite");
  assert.match(workflow, /npm run build/, "must run the build");
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/, "a red test must fail the job");
  assert.doesNotMatch(workflow, /\|\|\s*true/, "no step may swallow its own exit code");
});

test("GUARD — .gitattributes pins line endings", async () => {
  const attrs = await readFile(path.join(REPO, ".gitattributes"), "utf8");
  assert.match(attrs, /^\* text=auto eol=lf$/m);
});
