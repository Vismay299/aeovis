// F02 phase 5: bounded owner-run live canary guard for the approved DataForSEO engines.
//
// Pure validation only: no network, no answer text, no prices. The owner-run
// script (scripts/qa/check-dataforseo-live.mjs --mode engines) parses and
// asserts through this module before any provider call.

import { DATAFORSEO_APPROVED_ENGINES } from "../../engines/engineRoutes.ts";

export const LIVE_ENGINES_DEFAULT_SPEND = 0.1;
export const LIVE_ENGINES_DEFAULT_REQUESTS = 10;
export const LIVE_ENGINES_DEFAULT_RESERVE = 0.02;
export const LIVE_ENGINES_DEFAULT_SLOT = "dataforseo-live-canary";
export const LIVE_ENGINES_ALLOWED_HOSTS: readonly string[] = [
  "api.dataforseo.com",
  "sandbox.dataforseo.com",
];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const SHARED_SECRET_NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
] as const;
const SLOT_PATTERN = /^[a-z0-9-]{8,60}$/;

export type LiveEnginesArgs = {
  mode: "engines";
  engines: string[];
  slot: string;
  maxSpend: number;
  maxRequests: number;
  reserveUsd: number;
};

type Refusal = Error & { exitCode: number };

function refusal(message: string): Refusal {
  return Object.assign(new Error(message), { exitCode: 2 });
}

function asNumber(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw refusal(`Invalid --${flag}`);
  return value;
}

export function parseLiveEnginesArgs(argv: string[] = []): LiveEnginesArgs {
  const values: Record<string, string | boolean | undefined> = {};
  const allowed = new Set([
    "mode",
    "engines",
    "slot",
    "max-spend-usd",
    "max-requests",
    "reserve-usd",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) throw refusal("Unexpected positional argument");
    const name = flag.slice(2);
    if (!allowed.has(name)) throw refusal(`Unknown flag: --${name}`);
    if (values[name] !== undefined) throw refusal(`Duplicate --${name}`);
    const value: string | undefined = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw refusal(`Missing value for --${name}`);
    }
    values[name] = value;
  }

  if (values.mode !== undefined && values.mode !== "engines") {
    throw refusal("Invalid --mode");
  }

  const rawEngines = values.engines;
  const engines =
    typeof rawEngines === "string"
      ? rawEngines
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean)
      : [...DATAFORSEO_APPROVED_ENGINES];
  if (
    engines.length === 0 ||
    new Set(engines).size !== engines.length ||
    engines.some((engine) => !DATAFORSEO_APPROVED_ENGINES.includes(engine))
  ) {
    throw refusal(
      `Invalid --engines (must be a comma list subset of ${DATAFORSEO_APPROVED_ENGINES.join(",")})`,
    );
  }

  const slot =
    typeof values.slot === "string" ? values.slot : LIVE_ENGINES_DEFAULT_SLOT;
  if (!SLOT_PATTERN.test(slot)) throw refusal("Invalid --slot");

  const maxSpend =
    values["max-spend-usd"] === undefined
      ? LIVE_ENGINES_DEFAULT_SPEND
      : asNumber(values["max-spend-usd"] as string, "max-spend-usd");
  if (!(maxSpend > 0 && maxSpend <= 25)) {
    throw refusal("Invalid --max-spend-usd");
  }

  const maxRequests =
    values["max-requests"] === undefined
      ? LIVE_ENGINES_DEFAULT_REQUESTS
      : asNumber(values["max-requests"] as string, "max-requests");
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 600) {
    throw refusal("Invalid --max-requests");
  }

  const reserveUsd =
    values["reserve-usd"] === undefined
      ? LIVE_ENGINES_DEFAULT_RESERVE
      : asNumber(values["reserve-usd"] as string, "reserve-usd");
  if (!(reserveUsd > 0 && reserveUsd <= maxSpend)) {
    throw refusal("Invalid --reserve-usd");
  }

  return { mode: "engines", engines, slot, maxSpend, maxRequests, reserveUsd };
}

export function assertLiveEnginesEnvironment(
  env: Record<string, string | undefined> = process.env,
): true {
  if (!env.PGHOST || !LOOPBACK_HOSTS.has(env.PGHOST)) {
    throw refusal("PGHOST must be loopback");
  }
  if (!/(?:_live_qa)$/.test(env.PGDATABASE ?? "")) {
    throw refusal("PGDATABASE must end in _live_qa");
  }
  for (const name of SHARED_SECRET_NAMES) {
    if (env[name] !== undefined) throw refusal(`${name} must be unset`);
  }
  if (!String(env.DATAFORSEO_API_KEY ?? "").trim()) {
    throw refusal("DATAFORSEO_API_KEY is not configured");
  }
  if (
    String(env.FEATURE_DATAFORSEO_ENGINES ?? "").trim().toLowerCase() !== "on"
  ) {
    throw refusal("FEATURE_DATAFORSEO_ENGINES must be on");
  }
  return true;
}
