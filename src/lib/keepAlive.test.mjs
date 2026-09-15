/**
 * R3.1.5 — post-response work is registered with the platform's waitUntil,
 * and no fire-and-forget call site in a route bypasses it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { keepAlive } from "./keepAlive.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const quiet = { error: () => {} };

test("keepAlive registers the work with waitUntil and the work runs", async () => {
  const registered = [];
  let ran = false;
  const held = keepAlive(async () => { ran = true; }, { waitUntil: (p) => registered.push(p), logger: quiet });
  assert.equal(registered.length, 1, "the platform must be asked to wait");
  assert.equal(registered[0], held);
  await held;
  assert.equal(ran, true);
});

test("a rejecting job is logged under its label and never rejects the held promise", async () => {
  const errors = [];
  const held = keepAlive(Promise.reject(new Error("boom")), {
    label: "scan job X",
    waitUntil: () => {},
    logger: { error: (...a) => errors.push(a.join(" ")) },
  });
  await assert.doesNotReject(held);
  assert.match(errors[0], /scan job X failed: boom/);
});

test("a job that throws synchronously is handled the same way", async () => {
  const errors = [];
  const held = keepAlive(() => { throw new Error("sync"); }, {
    waitUntil: () => {},
    logger: { error: (...a) => errors.push(a.join(" ")) },
  });
  await held;
  assert.match(errors[0], /sync/);
});

test("maxMs releases the platform hold without cancelling the work", async () => {
  let finished = false;
  const work = new Promise((r) => setTimeout(() => { finished = true; r(); }, 80));
  const t0 = Date.now();
  await keepAlive(work, { maxMs: 10, waitUntil: () => {}, logger: quiet });
  assert.ok(Date.now() - t0 < 70, "the hold must end at maxMs");
  assert.equal(finished, false);
  await work;
  assert.equal(finished, true, "the work itself keeps running");
});

test("a waitUntil that throws does not throw out of keepAlive", async () => {
  const held = keepAlive(Promise.resolve(), { waitUntil: () => { throw new Error("no ctx"); }, logger: quiet });
  await assert.doesNotReject(held);
});

test("off Vercel (no request context) the real waitUntil is a no-op and the work still runs", async () => {
  let ran = false;
  await keepAlive(async () => { ran = true; }, { logger: quiet });
  assert.equal(ran, true);
});

test("GUARD — no route or worker kicks background work with a bare .catch instead of keepAlive", () => {
  // The exact shapes R3.1.5 replaced. A new one in src/app or the scan worker
  // would be post-response work the platform can freeze mid-run.
  const pattern = "(runScanChunk|scanChunk|startContentJob|reviseContentItem|runLearn|kickChunk|start)\\([^)]*\\)\\)?\\s*\\.catch\\(";
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-n", "-E", pattern, "--", "src/app", "src/lib/workers/scanWorker.js", ":!*.test.mjs"], {
      cwd: REPO,
    }).toString("utf8");
  } catch (err) {
    if (err.status !== 1) throw err; // 1 = no match, the passing case
  }
  assert.equal(out.trim(), "", `fire-and-forget without keepAlive:\n${out}`);
});
