import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURES } from "../features/names.ts";

const INDEXNOW_DIR = path.dirname(fileURLToPath(import.meta.url));

test("F19-AC-10: names.ts lists indexnow with spend: []", () => {
  assert.ok("indexnow" in FEATURES);
  assert.deepEqual(FEATURES.indexnow.spend, []);
});

test("F19-AC-10: no implementation file in src/lib/indexnow/ imports spend or DataForSEO client", async () => {
  const files = await readdir(INDEXNOW_DIR);
  for (const file of files) {
    if (!file.endsWith(".ts") && !file.endsWith(".js") && !file.endsWith(".mjs")) continue;
    if (file.includes(".test.")) continue;
    const content = await readFile(path.join(INDEXNOW_DIR, file), "utf8");

    // Check for banned imports or calls
    assert.ok(
      !content.includes("/spend/"),
      `${file} must not import from /spend/`
    );
    assert.ok(
      !content.includes("dataforseo"),
      `${file} must not reference dataforseo`
    );
    assert.ok(
      !content.includes("metered("),
      `${file} must not call metered()`
    );
    assert.ok(
      !content.includes("reserveSpend"),
      `${file} must not call reserveSpend`
    );
  }
});
