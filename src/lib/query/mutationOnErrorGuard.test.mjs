// F05-AC-01 guard — the shared MutationCache toasts a failed mutation unless
// `useMutation({ onError })` or `meta: { errorToast: false }` handles it. An
// onError passed per call (`mutate(v, { onError })`) is stored on the
// observer, where the cache cannot see it, so the user would get the toast
// AND the component's own error. Put onError on useMutation instead, or set
// `meta: { errorToast: false }` and handle the error from mutateAsync.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCE = /\.(ts|tsx|js|jsx|mjs)$/;
const SKIP = /\.test\.(ts|tsx|js|jsx|mjs)$/;

/** The text between the call's parentheses, or null when unbalanced. */
function callArgs(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

export function perCallOnErrorOffenders(text) {
  const found = [];
  const call = /\bmutate(?:Async)?\s*\(/g;
  let m;
  while ((m = call.exec(text)) !== null) {
    const args = callArgs(text, m.index + m[0].length - 1);
    if (args !== null && /\bonError\b/.test(args)) {
      found.push(text.slice(0, m.index).split("\n").length);
    }
  }
  return found;
}

test("the guard spots a per-call onError and ignores the hook-level one", () => {
  assert.deepEqual(
    perCallOnErrorOffenders("m.mutate(v, {\n  onError: (e) => set(e),\n});"),
    [1],
  );
  assert.deepEqual(
    perCallOnErrorOffenders("mutateAsync(f(x), { onError() {} })"),
    [1],
  );
  assert.deepEqual(
    perCallOnErrorOffenders("useMutation({ mutationFn, onError });\nm.mutate(v, { onSuccess });"),
    [],
  );
});

test("GUARD (F05-AC-01) — no mutate()/mutateAsync() call under src/ passes its own onError", () => {
  const files = execSync("git ls-files src", { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => SOURCE.test(f) && !SKIP.test(f));
  const offenders = [];
  for (const rel of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(REPO, rel), "utf8");
    } catch {
      continue;
    }
    for (const line of perCallOnErrorOffenders(text)) offenders.push(`${rel}:${line}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `Per-call onError hides from the global toast rule; move it to useMutation({ onError }) or use meta: { errorToast: false }:\n${offenders.join("\n")}`,
  );
});
