import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

test("no file under src/lib/rank-tracking imports answers.ts", () => {
  const root = "src/lib/rank-tracking";
  const files: string[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if ((p.endsWith(".ts") || p.endsWith(".mjs") || p.endsWith(".js")) && !p.endsWith(".test.ts") && !p.endsWith(".test.mjs")) files.push(p);
    }
  }
  walk(root);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(!src.includes("providers/dataforseo/answers"), `${f} imports answers.ts`);
    assert.ok(!src.includes("load_async_ai_overview"), `${f} contains load_async_ai_overview`);
  }
});

test("fence: load_async_ai_overview string absent from rank-tracking sources", () => {
  const root = "src/lib/rank-tracking";
  const files: string[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (!p.endsWith(".test.ts") && !p.endsWith(".test.mjs") && !p.endsWith(".test.js")) files.push(p);
    }
  }
  walk(root);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(!src.includes("load_async_ai_overview"), `${f} contains load_async_ai_overview`);
  }
});
