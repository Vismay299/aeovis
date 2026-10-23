import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const NOTICES = path.join(REPO, "THIRD_PARTY_NOTICES.md");
const HEADER_MARKER = "Portions ported from every-app/open-seo@c5f8db1";

async function filesUnder(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".env")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await filesUnder(full, acc);
    else acc.push(full);
  }
  return acc;
}

test("THIRD_PARTY_NOTICES.md carries OpenSEO's MIT licence verbatim", async () => {
  const notices = await readFile(NOTICES, "utf8");
  for (const required of [
    "MIT License",
    "Copyright (c) 2026 Ben Senescu",
    "Permission is hereby granted, free of charge",
    "THE SOFTWARE IS PROVIDED \"AS IS\"",
    "c5f8db19c7ca9e750836b6ed5c8a6491d4f967f4",
  ]) {
    assert.ok(notices.includes(required), `THIRD_PARTY_NOTICES.md must contain: ${required}`);
  }
});

test("every file with a ported-portion header is listed in the notices", async () => {
  const notices = await readFile(NOTICES, "utf8");
  const offenders = [];
  for (const full of await filesUnder(path.join(REPO, "src"))) {
    let text;
    try {
      text = await readFile(full, "utf8");
    } catch {
      continue;
    }
    const head = text.split("\n", 5).join("\n");
    if (!head.includes(HEADER_MARKER)) continue;
    const rel = path.relative(REPO, full).split(path.sep).join("/");
    if (!notices.includes(rel)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `these files carry a ported-portion header but are missing from THIRD_PARTY_NOTICES.md:\n  ` +
      offenders.join("\n  ")
  );
});
