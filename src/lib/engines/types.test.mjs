/**
 * R1.7.3 — getEnabledEngines() deleted (dead second engine registry).
 *
 * Tests that exercised getEnabledEngines() have been removed with the function.
 * This file now tests only the Engine enum and the GUARD that keeps SERPAPI_KEY
 * out of live capability checks.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Engine } from "./types.js";
import { vendorFlags } from "../health.js";

/**
 * R0.1.9 — a stale SERPAPI_KEY must not read as "a SERP provider is configured".
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const ENGINE_ENV = [
  "ENGINES_ENABLED",
  "PROBE_MODE",
  "OPENAI_API_KEY",
  "PERPLEXITY_API_KEY",
  "BRIGHTDATA_API_KEY",
  "SERPAPI_KEY",
];

const PROCESS_START_ENV = Object.fromEntries(ENGINE_ENV.map((k) => [k, process.env[k]]));

function describeEnv(v) {
  return v === undefined ? "unset" : `set (len ${v.length})`;
}

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
        `\n  every test in this file must restore the engine vars it sets`
    );
  }
});
