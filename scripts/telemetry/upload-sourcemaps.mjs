// F26 Phase 3: upload browser source maps to PostHog, then delete them.
// Never breaks the build: every path exits 0. Credentials travel via env only.
import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

function defaultSpawn(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(cmd, args, { ...opts, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? 1 }));
  });
}

export function resolveReleaseVersion(env, cwd) {
  const sha = String(env.VERCEL_GIT_COMMIT_SHA ?? "").trim();
  if (sha) return sha;
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
    const parsed = String(out).trim();
    if (parsed) return parsed;
  } catch {
    // fall through to unknown
  }
  return "unknown";
}

export async function deleteSourceMaps(cwd) {
  const root = path.join(cwd, ".next", "static");
  const maps = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".map")) maps.push(full);
    }
  }
  await walk(root);
  await Promise.all(maps.map((f) => rm(f, { force: true })));
  return maps;
}

export async function runSourcemapsUpload(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const spawnFn = options.spawn ?? defaultSpawn;
  const log = options.log ?? console.log;
  const getRelease = options.getRelease ?? ((e) => resolveReleaseVersion(e, cwd));

  if (env.POSTHOG_SOURCEMAPS !== "true") {
    log("[sourcemaps] skipped");
    return 0;
  }
  if (!env.POSTHOG_CLI_TOKEN || !env.POSTHOG_CLI_ENV_ID) {
    await deleteSourceMaps(cwd);
    log("[sourcemaps] skipped (no credentials)");
    return 0;
  }

  const chunksDir = ".next/static/chunks";
  const release = getRelease(env);
  let exitCode = 0;
  try {
    const inject = await spawnFn("posthog-cli", ["sourcemap", "inject", "--directory", chunksDir], {
      cwd,
      env,
    });
    if ((inject?.status ?? 0) !== 0) {
      exitCode = inject?.status ?? 1;
      log(`[sourcemaps] upload failed (exit ${exitCode})`);
      return 0;
    }
    const upload = await spawnFn(
      "posthog-cli",
      ["sourcemap", "upload", "--directory", chunksDir, "--release-version", release],
      { cwd, env },
    );
    if ((upload?.status ?? 0) !== 0) {
      exitCode = upload?.status ?? 1;
      log(`[sourcemaps] upload failed (exit ${exitCode})`);
      return 0;
    }
    log("[sourcemaps] uploaded");
    return 0;
  } catch {
    log(`[sourcemaps] upload failed (exit ${exitCode || 1})`);
    return 0;
  } finally {
    await deleteSourceMaps(cwd);
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("upload-sourcemaps.mjs");
if (invokedDirectly) {
  runSourcemapsUpload()
    .then((code) => process.exit(code))
    .catch(() => process.exit(0));
}
