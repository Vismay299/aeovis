#!/usr/bin/env node
import pg from "pg";
import { createSpendStore } from "../../src/lib/spend/store.ts";
import { createDataforseoClient } from "../../src/lib/providers/dataforseo/client.ts";
import { DATAFORSEO_LOCATION_BY_COUNTRY } from "../../src/lib/providers/dataforseo/locations.ts";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--brand") {
      args.brand = argv[++i];
    } else if (arg === "--max-spend-usd") {
      args.maxSpendUsd = Number(argv[++i]);
    } else if (arg === "--mode") {
      args.mode = argv[++i];
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.brand) {
  console.error("Missing --brand");
  process.exit(2);
}

if (args.maxSpendUsd === undefined || isNaN(args.maxSpendUsd) || args.maxSpendUsd !== 0.01) {
  console.error("Missing or invalid --max-spend-usd (must be 0.01)");
  process.exit(2);
}

const mode = args.mode ?? "client";

if (mode !== "client" && mode !== "engines") {
  console.error("Unknown --mode: " + mode);
  process.exit(2);
}

if (
  process.env.PGHOST &&
  process.env.PGHOST !== "127.0.0.1" &&
  process.env.PGHOST !== "localhost"
) {
  console.error("Dedicated loopback live QA ledger required (PGHOST=127.0.0.1)");
  process.exit(2);
}

for (const key of [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
]) {
  delete process.env[key];
}

async function main() {
  const pool = new pg.Pool({
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "aeovis_live_qa",
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  });

  try {
    const featureName = "providers.dataforseo.selftest";
    const controlRes = await pool.query(
      "SELECT enabled, mode, brand_allowlist FROM public.paid_feature_controls WHERE feature = $1",
      [featureName],
    );
    const control = controlRes.rows[0];
    if (!control || !control.enabled) {
      console.error(`paid_feature_controls('${featureName}') is not enabled`);
      process.exit(2);
    }
    if (
      control.mode === "allowlist" &&
      !(control.brand_allowlist || []).includes(args.brand)
    ) {
      console.error(
        `Brand ${args.brand} not admitted by paid_feature_controls('${featureName}')`,
      );
      process.exit(2);
    }

    async function rpc(name, values) {
      const entries = Object.entries(values);
      const query = `SELECT ${name}(${entries
        .map(([key], index) => `${key} => $${index + 1}`)
        .join(",")}) AS result`;
      const res = await pool.query(
        query,
        entries.map(([, v]) =>
          v && typeof v === "object" ? JSON.stringify(v) : v,
        ),
      );
      return { data: res.rows[0]?.result, error: null };
    }

    const spendStore = createSpendStore({ rpc });
    const client = createDataforseoClient({
      spendDeps: { store: spendStore },
    });

    const idempotencyKey = `live-check-${Date.now()}`;
    await client.serp.live(
      {
        brandKey: args.brand,
        idempotencyKey,
        feature: featureName,
        maxUsd: 0.01,
      },
      {
        keyword: "readiness canary",
        locationCode: DATAFORSEO_LOCATION_BY_COUNTRY.in,
        languageCode: "en",
        depth: 10,
      },
    );

    const ledgerRes = await pool.query(
      "SELECT cost_source, accounted_usd FROM public.spend_ledger WHERE brand_key = $1 AND feature = $2 ORDER BY occurred_at DESC LIMIT 1",
      [args.brand, featureName],
    );
    const row = ledgerRes.rows[0];
    if (!row) {
      console.error("No ledger row recorded");
      process.exit(1);
    }

    console.log(`cost_source: ${row.cost_source}`);
    console.log(`accounted_usd: ${row.accounted_usd}`);
  } finally {
    await pool.end();
  }
}

if (mode === "client") {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  console.error("--mode engines is deferred to Phase 5");
  process.exit(2);
}
