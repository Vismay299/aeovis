import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * F04-AC-11, unit half — the legacy layout classes are gone.
 *
 * The browser case proves no *rendered* element carries them. This guard
 * proves no scanned source file can reintroduce one, so a page that is not in
 * the browser route list still cannot quietly keep the old shell.
 *
 * `ui.jsx` is exempt because it is the facade: it keeps the `pv-*` hook class
 * names its callers and tests assert (F04-AC-16). It never emits a layout
 * class, which is what the banned list covers.
 */

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SCANNED_DIRS = [
  "src/app/portal",
  "src/components/portal",
  "src/app/login",
  "src/app/signup",
  "src/app/onboarding",
  "src/app/auth",
];
const LEGACY_TOKENS = [
  "pv-app",
  "pv-sidebar",
  "pv-page-header",
  "pv-auth",
  "pv-stack",
  "pv-grid",
  "pv-center",
];
const EXEMPT_BASENAMES = new Set(["ui.jsx"]);

/** Test files are excluded: they quote the tokens they assert are absent. */
function isScannedFile(name) {
  return !name.includes(".test.") && !EXEMPT_BASENAMES.has(name);
}

async function walk(rel, out) {
  for (const entry of await readdir(path.join(ROOT, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      await walk(child, out);
    } else if (isScannedFile(entry.name)) {
      out.push(child);
    }
  }
}

/**
 * The tokens in one file's text, in the banned list's order. Exported so the
 * teeth case below proves the detector fires for every token.
 */
export function legacyHitsIn(text) {
  return LEGACY_TOKENS.filter((token) => new RegExp(`\\b${token}\\b`).test(text));
}

test("no legacy pv-* layout class remains in the portal or auth sources", async () => {
  const files = [];
  for (const dir of SCANNED_DIRS) await walk(dir, files);

  // A walk that silently found nothing would make the guard vacuous.
  assert.ok(files.length > 40, `the walk found only ${files.length} scanned files`);

  const hits = [];
  for (const rel of files) {
    for (const token of legacyHitsIn(await readFile(path.join(ROOT, rel), "utf8"))) {
      hits.push(`${rel}: ${token}`);
    }
  }
  assert.deepEqual(hits, [], `legacy layout classes are still present:\n  ${hits.join("\n  ")}`);
});

test("GUARD TEETH — the detector fires for every banned token", () => {
  for (const token of LEGACY_TOKENS) {
    assert.deepEqual(
      legacyHitsIn(`<div className="${token}">`),
      [token],
      `the guard no longer detects ${token}`,
    );
  }
  assert.deepEqual(legacyHitsIn('<div className="space-y-5 pv-progress">'), []);
});
