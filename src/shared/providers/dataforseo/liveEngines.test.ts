import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DATAFORSEO_APPROVED_ENGINES } from "../../engines/engineRoutes.ts";
import {
  LIVE_ENGINES_DEFAULT_REQUESTS,
  LIVE_ENGINES_DEFAULT_SPEND,
  assertLiveEnginesEnvironment,
  parseLiveEnginesArgs,
} from "./liveEngines.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(
  HERE,
  "../../../../scripts/qa/check-dataforseo-live.mjs",
);

function refusalCase(argv: string[]): { exitCode: number } {
  try {
    parseLiveEnginesArgs(argv);
    return { exitCode: 0 };
  } catch (error) {
    return {
      exitCode:
        error && typeof error === "object" && "exitCode" in error
          ? Number(error.exitCode)
          : 1,
    };
  }
}

test("engines mode defaults to the approved list with bounded ceilings", () => {
  const parsed = parseLiveEnginesArgs(["--mode", "engines"]);
  assert.deepEqual(parsed.engines, [...DATAFORSEO_APPROVED_ENGINES]);
  assert.deepEqual([...DATAFORSEO_APPROVED_ENGINES].sort(), [
    "aio",
    "chatgpt",
    "gemini",
  ]);
  assert.equal(parsed.maxSpend, LIVE_ENGINES_DEFAULT_SPEND);
  assert.equal(parsed.maxRequests, LIVE_ENGINES_DEFAULT_REQUESTS);
  assert.ok(parsed.reserveUsd > 0 && parsed.reserveUsd <= parsed.maxSpend);
});

test("engines arg validation refuses before any provider call", () => {
  for (const argv of [
    ["--mode", "engines", "--engines", "perplexity"],
    ["--mode", "engines", "--engines", "claude"],
    ["--mode", "engines", "--engines", "chatgpt,chatgpt"],
    ["--mode", "engines", "--engines", ""],
    ["--mode", "engines", "--engines", "chatgpt,bogus"],
    ["--mode", "engines", "--slot", "BAD SLOT"],
    ["--mode", "engines", "--slot", "short"],
    ["--mode", "engines", "--max-spend-usd", "0"],
    ["--mode", "engines", "--max-spend-usd", "26"],
    ["--mode", "engines", "--max-spend-usd", "nope"],
    ["--mode", "engines", "--max-requests", "0"],
    ["--mode", "engines", "--max-requests", "601"],
    ["--mode", "engines", "--max-requests", "2.5"],
    ["--mode", "engines", "--max-spend-usd", "0.1", "--reserve-usd", "0.2"],
    ["--mode", "engines", "--reserve-usd", "0"],
    ["--mode", "engines", "--unknown", "x"],
    ["--mode", "engines", "--engines"],
    ["--mode", "engines", "--mode", "engines", "--mode", "engines"],
    ["--mode", "client"],
    ["positional"],
  ]) {
    assert.equal(
      refusalCase(argv).exitCode,
      2,
      `expected exit 2 for ${argv.join(" ")}`,
    );
  }
  assert.deepEqual(
    parseLiveEnginesArgs(["--mode", "engines", "--engines", "chatgpt"])
      .engines,
    ["chatgpt"],
  );
});

test("engines environment guard requires a loopback QA ledger and names only", () => {
  const good = {
    PGHOST: "127.0.0.1",
    PGDATABASE: "aeovis_live_qa",
    DATAFORSEO_API_KEY: "UNIT-TEST-NOT-A-REAL-KEY",
    FEATURE_DATAFORSEO_ENGINES: "on",
  };
  assert.equal(assertLiveEnginesEnvironment({ ...good }), true);
  assert.equal(
    assertLiveEnginesEnvironment({ ...good, PGHOST: "localhost" }),
    true,
  );
  const badEnvs: Array<Record<string, string | undefined>> = [
    { ...good, PGHOST: "db.example" },
    { ...good, PGHOST: undefined },
    { ...good, PGDATABASE: "aeovis_prod" },
    { ...good, PGDATABASE: undefined },
    { ...good, NEXT_PUBLIC_SUPABASE_URL: "https://example.test" },
    { ...good, NEXT_PUBLIC_SUPABASE_ANON_KEY: "UNIT-TEST-NOT-A-REAL-KEY" },
    { ...good, SUPABASE_SERVICE_ROLE_KEY: "UNIT-TEST-NOT-A-REAL-KEY" },
    { ...good, DATABASE_URL: "postgres://example.test/db" },
    { ...good, DATAFORSEO_API_KEY: "   " },
    { ...good, DATAFORSEO_API_KEY: undefined },
    { ...good, FEATURE_DATAFORSEO_ENGINES: "off" },
    { ...good, FEATURE_DATAFORSEO_ENGINES: undefined },
  ];
  for (const env of badEnvs) {
    assert.throws(() => assertLiveEnginesEnvironment(env), (thrown: unknown) => {
      const refused = thrown as { exitCode?: unknown; message?: unknown };
      assert.equal(refused.exitCode, 2);
      assert.equal(String(refused.message).includes("UNIT-TEST"), false);
      return true;
    });
  }
});

function childEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const name of ["PATH", "SYSTEMROOT", "TEMP", "TMP", "OS", "PATHEXT"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
}

function runScript(args: string[], extraEnv: Record<string, string | undefined>) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: childEnv(extraEnv),
    encoding: "utf8",
    timeout: 60000,
  });
}

test("real script refuses without flags before any provider call", () => {
  const result = runScript([], { PGHOST: undefined });
  assert.equal(result.status, 2);
  assert.match(String(result.stderr), /Missing --brand/);
});

test("real script in engines mode refuses off-loopback before any provider call", () => {
  const result = runScript(["--mode", "engines"], {
    PGHOST: "db.example",
    PGDATABASE: "aeovis_live_qa",
  });
  assert.equal(result.status, 2);
  assert.match(String(result.stderr), /loopback/);
});

test("real script in engines mode refuses unapproved engines before any provider call", () => {
  const result = runScript(["--mode", "engines", "--engines", "perplexity"], {
    PGHOST: "127.0.0.1",
    PGDATABASE: "aeovis_live_qa",
    DATAFORSEO_API_KEY: "UNIT-TEST-NOT-A-REAL-KEY",
    FEATURE_DATAFORSEO_ENGINES: "on",
  });
  assert.equal(result.status, 2);
  assert.match(String(result.stderr), /--engines/);
});

test("real script in engines mode refuses a missing credential by name only", () => {
  const result = runScript(["--mode", "engines"], {
    PGHOST: "127.0.0.1",
    PGDATABASE: "aeovis_live_qa",
    FEATURE_DATAFORSEO_ENGINES: "on",
  });
  assert.equal(result.status, 2);
  assert.match(String(result.stderr), /DATAFORSEO_API_KEY/);
});
