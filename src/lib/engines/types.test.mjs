import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Engine, getEnabledEngines } from "./types.js";
import { vendorFlags } from "../health.js";

/**
 * R0.1.9 — a stale SERPAPI_KEY must not read as "a SERP provider is configured".
 *
 * Bright Data is the SERP provider
 * (docs/decisions/2026-08-29-serp-provider-bright-data.md), credential
 * BRIGHTDATA_API_KEY. While types.js also accepted SERPAPI_KEY, a deployment
 * carrying only the superseded key looked configured at boot and failed at
 * probe time instead — the expensive place to find out.
 *
 * NOTE: this says nothing about src/lib/engines/serp.js, where the SerpAPI
 * request path is still live code. Removing that is task R1.7.3. This file
 * only pins the CAPABILITY signal.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Every env var getEnabledEngines() branches on, so each test starts from a known floor. */
const ENGINE_ENV = [
  "ENGINES_ENABLED",
  "PROBE_MODE",
  "OPENAI_API_KEY",
  "PERPLEXITY_API_KEY",
  "BRIGHTDATA_API_KEY",
  "SERPAPI_KEY",
];

/**
 * Captured at module load, before any test touches the environment: exactly what
 * this process inherited. The file-scoped after() hook at the bottom asserts
 * every var is back to this on the way out.
 */
const PROCESS_START_ENV = Object.fromEntries(ENGINE_ENV.map((k) => [k, process.env[k]]));

/** Shape of a value, never the value: assertion output must not leak a real key. */
function describeEnv(v) {
  return v === undefined ? "unset" : `set (len ${v.length})`;
}

/**
 * Run `fn` with exactly `env` set for the engine vars and every other engine
 * var deleted, then restore. serp.test.mjs sets SERPAPI_KEY in this same
 * process; without this the assertions below would be measuring leakage.
 */
function withEnv(env, fn) {
  const saved = Object.fromEntries(ENGINE_ENV.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENGINE_ENV) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    return fn();
  } finally {
    for (const k of ENGINE_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("getEnabledEngines - a stale SERPAPI_KEY alone does NOT enable Google AI Overview", () => {
  const engines = withEnv({ SERPAPI_KEY: "stale-serpapi-key" }, getEnabledEngines);
  assert.ok(
    !engines.includes(Engine.GOOGLE_AI_OVERVIEW),
    `SERPAPI_KEY is superseded and must not count as a SERP provider; got ${JSON.stringify(engines)}`
  );
  // The rest of the fallback list is untouched — this is not "everything off".
  assert.deepEqual(engines, [Engine.GEMINI]);
});

test("getEnabledEngines - BRIGHTDATA_API_KEY alone DOES enable Google AI Overview", () => {
  const engines = withEnv({ BRIGHTDATA_API_KEY: "bd-key" }, getEnabledEngines);
  assert.ok(engines.includes(Engine.GOOGLE_AI_OVERVIEW));
  assert.deepEqual(engines, [Engine.GEMINI, Engine.GOOGLE_AI_OVERVIEW]);
});

test("getEnabledEngines - SERPAPI_KEY adds nothing on top of BRIGHTDATA_API_KEY", () => {
  const withStale = withEnv(
    { BRIGHTDATA_API_KEY: "bd-key", SERPAPI_KEY: "stale" },
    getEnabledEngines
  );
  const without = withEnv({ BRIGHTDATA_API_KEY: "bd-key" }, getEnabledEngines);
  assert.deepEqual(withStale, without);
});

test("getEnabledEngines - llm_only suppresses AIO even with BRIGHTDATA_API_KEY", () => {
  // Guards the assertions above: they pass because of the credential, not
  // because PROBE_MODE happened to be doing the work.
  const engines = withEnv(
    { BRIGHTDATA_API_KEY: "bd-key", PROBE_MODE: "llm_only" },
    getEnabledEngines
  );
  assert.ok(!engines.includes(Engine.GOOGLE_AI_OVERVIEW));
});

test("getEnabledEngines - an explicit ENGINES_ENABLED list wins over key detection", () => {
  const engines = withEnv(
    { ENGINES_ENABLED: "google_ai_overview, openai, not_an_engine", SERPAPI_KEY: "stale" },
    getEnabledEngines
  );
  // The operator asked for it by name; that is a different claim from "a key
  // is present", and this branch is deliberately left alone by R0.1.9.
  assert.deepEqual(engines, [Engine.GOOGLE_AI_OVERVIEW, Engine.OPENAI]);
});

test("health vendorFlags - a deployment with only SERPAPI_KEY reports brightdata unconfigured", () => {
  const flags = vendorFlags({ SERPAPI_KEY: "stale-serpapi-key" });
  assert.equal(flags.brightdata.configured, false);
  assert.deepEqual(flags.brightdata.missing, ["BRIGHTDATA_API_KEY"]);
});

/**
 * GUARD — the three places that answer "is a SERP provider configured" must
 * not drift apart again. /api/health (via health.js) and check:secrets already
 * ignore SERPAPI_KEY; types.js was the odd one out. A mention inside a comment
 * is fine and expected — naming the superseded key is how the next reader
 * learns why it is absent — so only non-comment lines count.
 */
test("GUARD — no SERP capability check reads SERPAPI_KEY as a credential", async () => {
  const sources = [
    "src/lib/engines/types.js",
    "src/lib/health.js",
    "scripts/check-secrets.mjs",
    // R0.1.16 — /api/health and check:secrets stopped keeping their own env-var
    // lists and now share this one. Without it here the two entries above would
    // still be scanned but no longer contain the names, and this guard would
    // pass by having nothing left to look at.
    "src/lib/vendorRegistry.js",
  ];
  const offenders = [];
  for (const rel of sources) {
    const src = await readFile(path.join(REPO, rel), "utf8");
    src.split("\n").forEach((line, i) => {
      if (!line.includes("SERPAPI_KEY")) return;
      const trimmed = line.trim();
      const isComment = trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
      if (!isComment) offenders.push(`${rel}:${i + 1}: ${trimmed}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `SERPAPI_KEY is superseded by BRIGHTDATA_API_KEY; these treat it as live config:\n  ${offenders.join("\n  ")}`
  );
});

/**
 * GUARD — every engine var is restored to what the process started with.
 *
 * R6.5.5 — file-scoped after(), not a top-level test(), so it runs after EVERY
 * test in this file including ones appended later, regardless of where this
 * block sits. The positional form of this guard in serp.test.mjs was measured
 * leaving the file 8 pass / 0 fail while a test appended below it leaked
 * SERPAPI_KEY into the rest of the run.
 *
 * withEnv() restores in a finally, so it is already exception-safe; this pins
 * the OTHER failure — a test that sets an engine var directly, or a future
 * helper that forgets the finally. types.test.mjs and serp.test.mjs share one
 * process and both scrub these vars, so a leak here is measured over there.
 */
after(() => {
  const started = ENGINE_ENV.map((k) => `${k}: ${describeEnv(PROCESS_START_ENV[k])}`).join(", ");
  for (const k of ENGINE_ENV) {
    const before = PROCESS_START_ENV[k];
    const ended = process.env[k];
    assert.ok(
      ended === before,
      `${k} was not restored: started ${describeEnv(before)}, ended ${describeEnv(ended)}` +
        (describeEnv(before) === describeEnv(ended) ? " holding a different value" : "") +
        `\n  ambient at process start — ${started}` +
        `\n  every test in this file must restore the engine vars it sets;` +
        ` withEnv({...}, fn) does that for you.`
    );
  }
});
