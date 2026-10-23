import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function tsconfig() {
  return JSON.parse(await readFile(path.join(REPO, "tsconfig.json"), "utf8"));
}

test("tsconfig.json turns on the shared TypeScript settings", async () => {
  const config = await tsconfig();
  const options = config.compilerOptions ?? {};
  for (const flag of [
    "allowJs",
    "strict",
    "noEmit",
    "erasableSyntaxOnly",
    "allowImportingTsExtensions",
  ]) {
    assert.equal(options[flag], true, `tsconfig.compilerOptions.${flag} must be true`);
  }
  assert.deepEqual(options.paths?.["@/*"], ["./src/*"]);
});

test("jsconfig.json is kept for the existing JavaScript", () => {
  assert.equal(existsSync(path.join(REPO, "jsconfig.json")), true);
});

test("Node runs the new TypeScript modules directly", () => {
  const target = "./src/lib/http/errors.ts";
  const script = [
    "const m = await " + "import(" + JSON.stringify(target) + ");",
    "if (typeof m.toErrorResponse !== 'function') throw new Error('missing toErrorResponse');",
  ].join(" ");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: REPO,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});
