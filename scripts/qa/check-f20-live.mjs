#!/usr/bin/env node
/**
 * F20 Google Analytics 4 live check (owner-run only, never in CI).
 *
 * Reads connection status, one overview (last_28_days) and one opportunities
 * request through the service functions with the service-role client.
 * Prints only row counts, hasLimitedData, cached, and quota.tokensPerHour.remaining.
 * Never prints tokens, emails, property names, or rows. Reads only, no writes.
 *
 * Usage:
 *   node scripts/qa/check-f20-live.mjs --brand <key>
 */

function parseArgs(argv) {
  let brand = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--brand") {
      brand = argv[++i] ?? null;
    }
  }
  return { brand };
}

const args = parseArgs(process.argv.slice(2));
if (!args.brand) {
  console.error("Refusing: pass --brand <key>");
  process.exit(1);
}

const { getSupabaseAdmin } = await import("../../src/shared/supabase/admin.js");
const { getGa4ConnectionState } = await import("../../src/server/ga4/connection.ts");
const { getOrganicOverview } = await import("../../src/server/ga4/overview.ts");
const { getOpportunities } = await import("../../src/server/ga4/opportunities.ts");

const admin = getSupabaseAdmin();
const ws = { brandKey: args.brand, role: "owner" };

const connectionState = await getGa4ConnectionState(admin, ws);

if (!connectionState.connected) {
  console.log(
    JSON.stringify({
      connected: false,
      configured: connectionState.configured,
    }),
  );
  process.exit(0);
}

const overview = await getOrganicOverview(admin, ws, { range: "last_28_days" });
const opportunities = await getOpportunities(admin, ws, {});

const result = {
  connected: true,
  overview: {
    rowCount: overview.trend?.length ?? 0,
    hasLimitedData: Boolean(overview.reportMetadata?.hasLimitedData),
    cached: Boolean(overview.cached),
    tokensPerHourRemaining: overview.quota?.tokensPerHour?.remaining ?? null,
  },
  opportunities: {
    rowCount: opportunities.rowCount ?? opportunities.rows?.length ?? 0,
    hasLimitedData: Boolean(opportunities.reportMetadata?.hasLimitedData),
    cached: Boolean(opportunities.cached),
  },
};

console.log(JSON.stringify(result));
