import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER = path.join(REPO, "worker");

/**
 * R1.2.1 — the fleet workspace must not import from the web app.
 *
 * The probe fleet runs on a container host with a persistent browser and
 * minutes of wall clock. Vercel functions have neither. The moment a file
 * under worker/ imports from src/app it drags in Next's runtime, and the
 * container stops booting — but only at runtime, on the host, after a deploy.
 *
 * This lives in the MAIN suite rather than worker/'s own, because CI runs the
 * main suite and an isolation rule that only fires when someone remembers to
 * run the worker's tests is not a rule.
 */

/** Every .js/.mjs file under worker/. */
async function workerFiles(dir = WORKER, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await workerFiles(full, acc);
    else if (/\.(mjs|js)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** Every module specifier a file imports, static or dynamic. */
function specifiers(src) {
  const out = [];
  for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)) out.push(m[1]);
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  for (const m of src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

test("GUARD — the worker workspace exists and has its own manifest", async () => {
  const pkg = JSON.parse(await readFile(path.join(WORKER, "package.json"), "utf8"));
  assert.equal(pkg.name, "perceev-worker");
  assert.equal(pkg.type, "module");
  assert.ok(pkg.scripts?.start, "it must be startable on its own");

  // Its dependencies are its own. Sharing the app's package.json would make
  // "runs independently of the web app" untrue in the only way that matters.
  assert.ok(pkg.dependencies?.playwright, "the fleet drives real surfaces with Playwright");
});

test("GUARD — no file under worker/ imports from src/app", async () => {
  const offenders = [];
  for (const file of await workerFiles()) {
    const src = await readFile(file, "utf8");
    for (const spec of specifiers(src)) {
      if (/(^|\/)src\/app(\/|$)/.test(spec) || spec.startsWith("next/") || spec === "next") {
        offenders.push(`${path.relative(REPO, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `the fleet must run without Next's runtime:\n  ${offenders.join("\n  ")}`
  );
});

test("GUARD — the worker reaches into the app tree not at all, by any path", async () => {
  // Broader than src/app: any relative import that climbs out of worker/ is a
  // coupling that will break the container image, which does not ship src/.
  const offenders = [];
  for (const file of await workerFiles()) {
    const src = await readFile(file, "utf8");
    for (const spec of specifiers(src)) {
      if (!spec.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      if (!resolved.startsWith(WORKER)) {
        offenders.push(`${path.relative(REPO, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these imports escape worker/, which the container image does not ship:\n  ${offenders.join("\n  ")}`
  );
});

test("GUARD — the unbuilt stages refuse rather than returning empty", async () => {
  // A stub that returns [] is indistinguishable from an empty queue, and a
  // fleet reporting "nothing to do" while its queue fills is the false success
  // this rebuild exists to remove.
  //
  // R1.2.2 built the queue, so queue.js is no longer a stub and is guarded
  // BEHAVIOURALLY in src/server/probeQueue.test.mjs instead — the version of this
  // guard that read queue.js's source text for /throw new Error/ would have
  // passed a `return new Array()`. probe.js is still a stub, and still checked
  // here by source text, which is all a not-yet-written function offers.
  const probe = await readFile(path.join(WORKER, "src/lib/probe.js"), "utf8");
  assert.match(probe, /throw new Error/, "probeBatch must refuse while unbuilt");

  // Invoked, not read: an adapter that quietly resolved to [] would score every
  // prompt as a non-mention.
  const { probeBatch } = await import(
    path.join(WORKER, "src/lib/probe.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:")
  );
  await assert.rejects(() => probeBatch([{ id: "x" }], {}), /no adapter is built yet/);
});

test("GUARD — the typed outcome vocabulary is present and closed", async () => {
  const { PROBE_OUTCOMES } = await import(
    path.join(WORKER, "src/lib/probe.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:")
  );
  // D2 of the rebuild: blocked must never be scorable as "not mentioned".
  for (const required of ["answered", "no_answer", "blocked", "captcha", "login_wall", "timeout"]) {
    assert.ok(PROBE_OUTCOMES.includes(required), `${required} must be a reportable outcome`);
  }
  assert.ok(Object.isFrozen(PROBE_OUTCOMES), "the vocabulary must be closed");
});
