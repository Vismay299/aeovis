import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSourcemapsUpload } from "../../../scripts/telemetry/upload-sourcemaps.mjs";

async function makeTempWithMaps() {
  const dir = await mkdtemp(path.join(tmpdir(), "f26-sourcemaps-"));
  const chunks = path.join(dir, ".next", "static", "chunks");
  await mkdir(chunks, { recursive: true });
  await writeFile(path.join(chunks, "app.js"), "console.log(1)");
  await writeFile(path.join(chunks, "app.js.map"), "{}");
  return { dir, chunks };
}

async function listMaps(dir) {
  const chunks = path.join(dir, ".next", "static", "chunks");
  try {
    return await readdir(chunks);
  } catch {
    return [];
  }
}

test("F26-AC-11 skip path does nothing when POSTHOG_SOURCEMAPS is not true", async () => {
  const { dir } = await makeTempWithMaps();
  const logs = [];
  let spawned = 0;
  const code = await runSourcemapsUpload({
    cwd: dir,
    env: { POSTHOG_SOURCEMAPS: "" },
    spawn: async () => {
      spawned += 1;
      return { status: 0 };
    },
    log: (m) => logs.push(String(m)),
  });
  assert.equal(code, 0);
  assert.deepEqual(logs, ["[sourcemaps] skipped"]);
  assert.equal(spawned, 0);
  // Skip path leaves maps alone (does nothing).
  assert.deepEqual((await listMaps(dir)).sort(), ["app.js", "app.js.map"]);
});

test("F26-AC-11 credential-less path deletes maps and exits 0", async () => {
  const { dir } = await makeTempWithMaps();
  const logs = [];
  let spawned = 0;
  const code = await runSourcemapsUpload({
    cwd: dir,
    env: { POSTHOG_SOURCEMAPS: "true" },
    spawn: async () => {
      spawned += 1;
      return { status: 0 };
    },
    log: (m) => logs.push(String(m)),
  });
  assert.equal(code, 0);
  assert.deepEqual(logs, ["[sourcemaps] skipped (no credentials)"]);
  assert.equal(spawned, 0);
  assert.deepEqual(await listMaps(dir), ["app.js"]);
});

test("F26-AC-11 success runs inject before upload then deletes maps", async () => {
  const { dir } = await makeTempWithMaps();
  const logs = [];
  const calls = [];
  const code = await runSourcemapsUpload({
    cwd: dir,
    env: {
      POSTHOG_SOURCEMAPS: "true",
      POSTHOG_CLI_TOKEN: "secret-token",
      POSTHOG_CLI_ENV_ID: "env-id",
      VERCEL_GIT_COMMIT_SHA: "abc123",
    },
    spawn: async (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      return { status: 0 };
    },
    log: (m) => logs.push(String(m)),
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cmd, "posthog-cli");
  assert.deepEqual(calls[0].args, ["sourcemap", "inject", "--directory", ".next/static/chunks"]);
  assert.equal(calls[1].cmd, "posthog-cli");
  assert.deepEqual(calls[1].args.slice(0, 4), ["sourcemap", "upload", "--directory", ".next/static/chunks"]);
  assert.ok(calls[1].args.includes("abc123"));
  // Credentials travel via env only, never on the command line or logs.
  const blob = JSON.stringify(calls) + JSON.stringify(logs);
  assert.equal(blob.includes("secret-token"), false);
  assert.equal(logs[0], "[sourcemaps] uploaded");
  assert.deepEqual(await listMaps(dir), ["app.js"]);
});

test("F26-AC-11 failure still deletes maps and exits 0", async () => {
  const { dir } = await makeTempWithMaps();
  const logs = [];
  const code = await runSourcemapsUpload({
    cwd: dir,
    env: {
      POSTHOG_SOURCEMAPS: "true",
      POSTHOG_CLI_TOKEN: "secret-token",
      POSTHOG_CLI_ENV_ID: "env-id",
      VERCEL_GIT_COMMIT_SHA: "abc123",
    },
    spawn: async (cmd, args) => {
      if (args.includes("upload")) return { status: 3 };
      return { status: 0 };
    },
    log: (m) => logs.push(String(m)),
  });
  assert.equal(code, 0);
  assert.ok(logs.some((m) => m === "[sourcemaps] upload failed (exit 3)"));
  assert.deepEqual(await listMaps(dir), ["app.js"]);
});
